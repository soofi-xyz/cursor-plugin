# Athena Index Stream Consumer

The Athena index stream consumer is the incremental path from Neptune Streams to an Athena-queryable, debt-grain derived-index table. A scheduled Lambda tick reads committed graph changes after its own checkpoint, writes them as vertex-keyed delta Parquet, then uses Athena itself to translate vertex ids into debt identifiers through two Iceberg dimension tables (a debt map and an owner map), MERGEs the result into a wide Iceberg table typed from the lexicon, verifies the merge, and publishes an applied-status row that direct readers gate on. It is seeded once from a full snapshot export build and from the key list that build produced, and it exists so that readers see graph changes within minutes instead of waiting for the next multi-hour snapshot export. This document covers only that consumer; the derived-index mechanism it observes is `derived-index-maintenance.md` (stream indexer in its section 5), the snapshot export it seeds from is `athena-debt-index-export.md`, and the verbatim stream buffer is `neptune-stream-export.md`.

## 1. Purpose & scope

- Maintain `debt_index_stream_wide` (one row per `debt_identifier`, one typed column per lexicon-declared debt-grain index) continuously from Neptune Streams, at a cadence of minutes.
- Publish a machine-readable freshness contract (`debt_index_stream_applied_status`) so a reader can decide whether to trust the table without inspecting the consumer.
- Seed the wide table and the two map tables from artifacts the snapshot export already produces, never from a second graph scan.
- Reach person-grain columns (indexes stored on the owning person and projected onto every debt that person owes) through an owner map, with a correctness gate that only fans out to sole-owned debts.

Non-goals and boundaries:

- Not a replacement for the snapshot export (`athena-debt-index-export.md`). The snapshot is the immutable, lineage-stamped baseline; this consumer keeps a live successor of it moving. The consumer has no `exported_at` / `run_id` columns and must never fabricate them.
- Not the raw stream buffer (`neptune-stream-export.md`). That path captures stream pages verbatim for later assembly; this path interprets records against an allowlist and writes only what the lexicon declares at debt grain.
- Not the derived-index maintainer (`derived-index-maintenance.md` section 5, `IndexStreamPoller`). Both read the same stream endpoint with the same client, but this consumer keeps its own checkpoint on S3, never writes to the graph, never opens a Gremlin traversal, and never touches the poller's DynamoDB lease.
- Does not maintain person-grain values on jointly owned debts incrementally; those keep their last seeded value and are counted (see 4.4).

## 2. Architecture

Resources (all in the debt-index export stack, sharing its bucket, Glue database, and Athena workgroup):

| Resource | Role |
|---|---|
| `AthenaIndexStreamSmoke` Lambda (Node, ARM, 10 min, 2 GB, VPC private subnets) | Runs every action: `bootstrap`, `seedFromExport`, `seedVertexMap`, `poll`, `mergeAthenaWide`, `pollThenMergeAthenaWide`. |
| EventBridge Scheduler rate(5 minutes) -> Lambda, input `{ "action": "pollThenMergeAthenaWide" }`, `retryAttempts: 0` | The tick. Ships `DISABLED`; armed only by explicit CDK context `athenaIndexStreamScheduleEnabled=true`. Arming also sets `reservedConcurrentExecutions: 1`. |
| S3 prefix `athena-index-stream-smoke/` in `<bucket>` | `checkpoint.json`, `deltas/gen-NNNNNN.parquet`, `staging/{wide,vertex-map,person-map}/data.tsv`, `carry/person-map.tsv`, `carry/person-rows.json`, `iceberg/<table>/` per Iceberg table. Only `staging/` carries a lifecycle expiry. |
| Iceberg tables in `<database>` | `debt_index_stream_wide`, `debt_vertex_map`, `debt_person_map`, `debt_index_stream_applied_status`. |
| External TEXTFILE staging tables | `debt_index_stream_wide_staging`, `debt_vertex_map_staging`, `debt_person_map_staging` — dropped and recreated over a prefix every merge. |
| Log group, 3-month retention | JSON structured logs via Powertools. |

Data flow of one scheduled tick:

```
Neptune Streams (propertygraph/stream, AFTER_SEQUENCE_NUMBER from checkpoint)
   |  poll loop: whole pages until caught up / deadline / brake
   v
delta Parquet  deltas/gen-000123.parquet  (vertex_id, column_name, value) + manifest
   |  checkpoint.json advances ONLY after the object is written
   v
mergeAthenaWide (oldest generations first, up to a row budget)
   |-- fold deltas per (vertex, column); overlay carried person rows
   |-- staging/vertex-map/data.tsv --> MERGE debt_vertex_map      (1st)
   |-- staging/person-map/data.tsv --> MERGE debt_person_map      (2nd)  + write carry files
   |-- staging/wide/data.tsv       --> MERGE debt_index_stream_wide (3rd)
   |       USING (debt arm JOIN debt_vertex_map
   |              UNION ALL person arm JOIN debt_person_map [sole owners only]
   |              UNION ALL orphaned-debt arm) GROUP BY debt_identifier
   |-- verify: every mapped source row matches the table as typed values
   v
delete merged/stale delta objects; keep deferred ones
   v
MERGE debt_index_stream_applied_status (singleton row status_key='wide')
```

Dependencies: the shared Neptune stream client (`derived-index-maintenance.md` section 5), the lexicon-derived export schema service (same one the snapshot export's CTAS uses; index catalog in `derived-index-maintenance.md` section 2), a completed key-list build carrying `map/` and `person-map/` page artifacts (`athena-debt-index-export.md`), and a full-export build table to seed from.

## 3. Contracts

### 3.1 Wide table

```sql
CREATE TABLE IF NOT EXISTS <database>.debt_index_stream_wide (
  debt_identifier string,
  <one column per lexicon debt-grain index, typed boolean|int|double|date|timestamp|string>,
  updated_at timestamp
) LOCATION 's3://<bucket>/athena-index-stream-smoke/iceberg/debt_index_stream_wide/'
TBLPROPERTIES ('table_type'='ICEBERG','format'='parquet','write_compression'='zstd')
```

Column names and types come from the same lexicon-derived schema the snapshot export uses, so the two tables cannot drift. `CREATE TABLE IF NOT EXISTS` does not evolve a table, so before every wide MERGE the consumer reads `information_schema.columns` and issues one `ALTER TABLE ... ADD COLUMNS` for lexicon columns that are absent (never for present ones; Athena rejects that). Iceberg cannot promote a column type, so a type change requires a new table name and a reseed.

### 3.2 Map tables

- `debt_vertex_map (vertex_id string, debt_identifier string, updated_at timestamp)` — Iceberg, one row per debt vertex. Seeded from the key list's `map/` pages; topped up from the stream because `debt_identifier` is a vertex property whose ADD arrives in the same page as the new vertex's other properties. Two vertices may share one `debt_identifier`; the MERGE groups its source by `vertex_id`.
- `debt_person_map (person_vertex_id string, debt_identifier string, updated_at timestamp)` — Iceberg, keyed by the pair (joint debts have several owners; a person owns several debts). Seeded from the key list's `person-map/` pages (current ownership in full, ADD-only) with a replace semantic: MERGE first, then delete pairs absent from staging. Stream pairs are a delta that carries `REMOVE` and never clear the map.
- Staging shapes: `debt_vertex_map_staging (vertex_id, debt_identifier)`; `debt_person_map_staging (person_vertex_id, debt_identifier, debt_vertex_id, op)` where exactly one of the two debt fields is set and the MERGE resolves `debt_vertex_id` through `debt_vertex_map`.

### 3.3 Delta Parquet

One object per poll, `deltas/gen-<6-digit generation>.parquet`, EAV columns `vertex_id`, `column_name`, `value` (all string; null = stream REMOVE). Key-value metadata `smoke_manifest`:

```json
{ "schemaVersion": "2", "grain": "vertex_id", "generation": 123, "deltaEpoch": 4,
  "writtenAt": "...", "fromPosition": {"commitNum":..,"opNum":..}, "toPosition": {...},
  "recordCount": .., "matchedCount": .., "vertexCount": .., "mapPairCount": .., "ownerPairCount": .. }
```

Rules: refuse `schemaVersion` other than `"2"` at decode (a debt-keyed v1 object was never vouched for by the map); filter by `deltaEpoch` before judging schema; later generation wins per (vertex, column). Owner edges ride inside the delta as a reserved pseudo-column `__owns:<debtVertexId>` on the person's row whose value is `ADD`/`REMOVE` — the colon in the pseudo-column name is rejected by the column-name rule (`^[a-z_][a-z0-9_]*$`) every lexicon column must pass, so no collision is possible.

### 3.4 Staging cell encoding (wide)

Tab-delimited text, one row per vertex, one field per declared column: `''` = column not mentioned by this delta (leave the target untouched); `__NULL__` = stream REMOVE (write the lexicon fallback, which is what the snapshot export writes for absence); `__EMPTY__` = explicit empty string, legal only for `string` columns. Every other value is canonicalised and validated against the column's lexicon type at write time (`canonicalAthenaText`), so a malformed value fails naming the vertex and column rather than failing the whole MERGE anonymously. The MERGE applies types with an ordered `CASE` so a strict `CAST` never runs on a sentinel.

### 3.5 Applied-status row (contract v1, consumed outside the repo)

```sql
CREATE TABLE IF NOT EXISTS <database>.debt_index_stream_applied_status (
  status_key string, status_contract_version string,
  applied_commit_num bigint, applied_op_num bigint, applied_at timestamp,
  last_verified_at timestamp, caught_up boolean, pending_delta_files int,
  polled_commit_num bigint, polled_op_num bigint, seed_status string, delta_epoch string,
  consumer_request_id string, applied_delta_files int, applied_wide_rows bigint)
```

Exactly one row, `status_key='wide'`. `applied_*` is the newest `toPosition` among the delta manifests the verified wide MERGE consumed — never the poll checkpoint, which advances before anything is merged — and is left unchanged by a tick that applied no wide rows. `caught_up = pollCaughtUp AND pending_delta_files = 0`. Readers gate on `seed_status='ready' AND caught_up AND pending_delta_files=0 AND date_diff('second', last_verified_at, current_timestamp) < <threshold>`; the age is computed by Athena so no second clock is involved. Adding a column is compatible; renaming one bumps `status_contract_version`.

### 3.6 Checkpoint

`checkpoint.json`: `{ schemaVersion:"1", consumer:"athena-index-stream-smoke", commitNum, opNum, updatedAt, lastDeltaKey, deltaEpoch, seedStatusWide }`. `seedStatusWide` is `ready | partial | seeding | failed`; anything but `ready` (including a missing field) fails poll and merge closed. `deltaEpoch` increments on every bootstrap and successful seed; delta objects from another epoch are never merged, and the scheduled tick deletes them after its merge (a manual `mergeAthenaWide` only reports them as stale).

### 3.7 Seed semantics

`seedFromExport` requires an explicit `sourceTable` naming a full-export build table (must carry `debt_identifier`, `exported_at`, `run_id`), refuses views, refuses the consumer's own tables and the published reader names, refuses if the live view currently resolves to the wide table, and performs no mutation until every check passes. It records P_start = stream LATEST before the INSERT, marks the checkpoint `seeding`, deletes all rows (default `resetIceberg=true`), inserts `SELECT debt_identifier, <columns>, current_timestamp FROM <sourceTable>` with no casts (both sides are typed from the same lexicon), requires a non-zero count, then seals the checkpoint at P_start with `seedStatusWide` = `ready` (only when `seedAll=true`) or `partial` (any `seedLimit`, default 1,000), bumps `deltaEpoch`, and clears deltas and carry files. `seedVertexMap` registers the key list's `map/` and `person-map/` prefixes as staging tables, gates each MERGE on the staging count equalling the marker's declared row count, and refuses a key list lacking either artifact.

### 3.8 Event schema

`{ action, maxRecords?, columns?, behindCommits?, startFrom?{commitNum,opNum}, sourceTable?, seedLimit?, seedAll?, resetIceberg?, keyListId?, maxPolls? }`. `columns` narrows to a subset of lexicon-declared columns and fails on an undeclared name. `seedAll` and `seedLimit` together are refused.

### 3.9 Environment and IAM (generalized)

Env: `DEBT_INDEX_EXPORT_BUCKET`, `DEBT_INDEX_EXPORT_DATABASE`, `DEBT_INDEX_EXPORT_ATHENA_WORKGROUP`, lexicon URI, `NEPTUNE_READER_HOST`/`NEPTUNE_PORT` (reader endpoint; `NEPTUNE_HOST` and `NEPTUNE_WRITER_HOST` are set to the same endpoint but unread), `INDEX_STREAM_POLL_LIMIT=10000`. IAM: `neptune-db:connect` + `GetStreamRecords` only (no query actions); Athena start/get/stop/workgroup; Glue writes scoped to the seven tables the consumer owns (names imported from the SQL modules so a rename cannot orphan the grant), Glue reads database-wide (the seed guard resolves arbitrary catalog names); S3 read/write on `athena-index-stream-smoke/*` and `athena-results/*`, read-only on the export `runs/*` and `debt-keys/*` prefixes, unconditioned `s3:ListBucket` and `s3:GetBucketLocation` on `<bucket>` (Athena scans S3 as the caller; a prefix condition on ListBucket becomes a silent no-delta merge). Lexicon object read-only.

## 4. Runtime behaviour

### 4.1 Tick and poll loop

`pollThenMergeAthenaWide` first requires `seedStatusWide=ready`. It then polls whole pages of `INDEX_STREAM_POLL_LIMIT` records from `AFTER_SEQUENCE_NUMBER(checkpoint)` until one of: the page is empty (`caught_up`), the remaining invocation time is below `TICK_MERGE_RESERVE_MS (180 s) + TICK_POLL_BUDGET_MS (60 s)` (`deadline`), or the poll brake (`maxPolls`, capped at 2,000) trips. Each poll keeps only `vp` records whose key is an allowlisted column, collects `vertex_id -> debt_identifier` pairs (page-final value per vertex; a vertex whose page ends on REMOVE keeps its old mapping), collects `person_owes_debt` edge ADD/REMOVE pairs (page-final op), writes the delta object, and only then advances the checkpoint. The page size is the ceiling on catch-up speed: size it so one tick absorbs more commits than production writes in one schedule interval, and size memory for a full page.

### 4.2 Idle-tick guard

If every poll in the tick consumed nothing, compare the checkpoint's `commitNum` to the stream's LATEST. A checkpoint strictly beyond the newest commit means the graph was reset, restored, or replaced; fail the tick rather than publish `caught_up`, because the frozen table would otherwise keep reporting a fresh `last_verified_at`.

### 4.3 Merge

Load delta objects in generation order until `TICK_MERGE_ROW_BUDGET` (500,000 vertex rows) is spent — always at least one, so an oversized delta cannot stall forever; the rest stay for the next tick. Objects from a retired epoch are marked stale. Fold to current value per (vertex, column), overlay carried person rows underneath (this tick's values win), then split: `debt_identifier` -> map lines, `__owns:` columns -> owner pairs, declared columns -> wide lines. Order is fixed: MERGE `debt_vertex_map`, then `debt_person_map` (with carried pairs re-staged and this tick's op winning), then the wide table. The map MERGE must leave a non-empty map or the tick fails (an empty map would resolve every delta to nothing and "succeed"). A tick with no wide lines and no owner removals returns without a wide MERGE and without advancing the applied watermark.

### 4.4 Person-grain fan-out

The wide MERGE's source is three arms folded per `debt_identifier` with `COALESCE(MAX(CASE WHEN col <> '' ...), '')` so an untouched sentinel loses to any real value: the debt arm (staging JOIN `debt_vertex_map`, debt-sourced columns only), the person arm (staging JOIN `debt_person_map`, person-sourced columns only, restricted to debts with exactly one owner), and the orphaned-debt arm (a debt that just lost its last owner gets `__NULL__` for every person column so it falls to the lexicon fallback). The snapshot export reads person columns existentially across all owners; restricting fan-out to sole owners is what makes the incremental value provably equal to the export's. Skipped joint-debt changes are counted per tick.

### 4.5 Carry-forward

Owner pairs whose debt vertex the map cannot resolve yet (the debt's own identifier record is still ahead in the stream) are written to `carry/person-map.tsv` (bounded at 20,000, exact count logged) and the staged index values of exactly those persons to `carry/person-rows.json`; both are rewritten by every merge that loaded at least one delta object, including as empty (a tick with nothing to load returns before touching them). A carry line that cannot be parsed fails the tick, because the file is the only record of that ownership.

### 4.6 Idempotency and failure modes

- Every MERGE is an upsert; replaying a delta converges to the same table. An Athena `ICEBERG_COMMIT_ERROR` (lost catalog commit race) is resubmitted once for the three upsert MERGEs, the person-map seed's `DELETE … WHERE NOT EXISTS` replace step, and the status MERGE only — never for an `INSERT INTO`.
- Athena waits stop `ATHENA_WAIT_MARGIN_MS` (20 s) before the invocation deadline and cancel the query, so a long statement fails naming itself instead of the Lambda timing out mid-flight; the deltas stay on S3 and the work repeats.
- Pre-merge check: staging count equals the lines written. Post-merge verify: `matched_count == mapped_count` comparing typed values with `IS NOT DISTINCT FROM`; a mismatch fails the tick, leaves the deltas, and writes no status row (the row goes stale, which is the signal).
- A failed tick deletes nothing; the next tick starts from the same checkpoint and the same delta prefix.
- Unmapped rows (neither map knows the vertex) are counted and logged, never dropped silently or failed on; a count that stays high means a stale map.

## 5. Observability & alarms

- Structured logs per tick: the handler's completion line (`action`, `pollCount`, `stopReason`, `merged`, `wideRows`) and the published applied-status row with `consumerRequestId` (the Lambda request id, so a freshness value traces to one invocation's logs). Conditional warnings carry `mapCount`/`personMapCount`/`unmappedCount` (only when unmapped rows exist), `personFanoutSkipped` (only when non-zero), `unresolvedCount` for owner pairs the map could not resolve, and `pendingFiles` for deltas deferred past the row budget. The MERGE and verify query execution ids are returned in the action result, not logged.
- Warnings worth a log-metric filter: deltas deferred past the row budget, unmapped deltas, unresolved owner pairs (with `truncatedByLimit`), person changes skipped on joint debts, Iceberg commit race resubmits, seed refusals.
- The status row is itself the primary health signal: readers and dashboards should query `buildAppliedStatusReadSql`'s projection (`caught_up`, `pending_delta_files`, `seed_status`, `last_verified_age_seconds`).
- The reference deployment wires no CloudWatch alarm for this Lambda. Add at minimum: Lambda errors >= 1 over two consecutive ticks, and an Athena-driven or log-driven check that `last_verified_age_seconds` exceeds several schedule intervals (an absence-of-progress alarm, since a frozen consumer emits no error).

## 6. Operations / runbook

1. Deploy with the schedule disabled (default). Arm a stage only with explicit context `athenaIndexStreamScheduleEnabled=true` in that stage's CI variables; never derive it from the stage name (the stack falls back to a default stage on a bare synth).
2. Seed order: run a snapshot export so a full-export build table and a key list with `map/` and `person-map/` artifacts exist -> `action=bootstrap` (sets the cursor at LATEST, or `behindCommits`/`startFrom`; clears deltas and carry files; never flips `seedStatusWide` to ready) -> `action=seedVertexMap` (optionally `keyListId`) -> `action=seedFromExport` with `seedAll=true` and `sourceTable=<full-export build table>` -> arm the schedule.
3. Smoke on a non-production stage: `seedFromExport` with the default `seedLimit` produces a `partial` baseline that exercises the SQL but keeps poll/merge closed; invoke `pollThenMergeAthenaWide` manually with `maxPolls` to bound a run; invoke `poll` and `mergeAthenaWide` separately to isolate a failure.
4. Catch-up after downtime: leave the schedule armed; each tick polls until its deadline and merges up to its row budget, so a backlog drains over successive ticks while `pending_delta_files > 0` and `caught_up=false` tell readers to wait. If the checkpoint has fallen outside stream retention, or the idle-tick guard fires, reseed (steps 2) rather than fast-forward unless the discarded window is acceptable.
5. Reseeding while readers are live: the seed refuses if the public view resolves to the wide table; repoint the view to a build table first. Direct readers are not protected by the status row's `seed_status` during the seed: only the S3 checkpoint's `seedStatusWide` flips to `seeding` before the DELETE, and the status row is rewritten solely by a successful tick, which `requireBaselineReady` blocks while the seed is in flight. Their protection is `last_verified_at` going stale until the first post-seed tick publishes.
6. Lexicon adds a debt-grain index: the next tick adds the column; backfill it by reseeding from a snapshot export that includes it. A type change requires a new table name.

## 7. Verification & acceptance criteria

- Unit tests cover: SQL builders (DDL, MERGE arms, verify, unmapped/skipped counts, identifier and literal validation), delta Parquet encode/decode and epoch/schema refusal, vertex and owner pair collection (page-final semantics), delta split routing, carry overlay rules, seed scope and source validation with an ops-recording double proving no mutation before refusal, applied-status row construction and SQL, catalog helpers (view vs table, Iceberg vs external), tick budget arithmetic, checkpoint-beyond-stream predicate, and stack assertions (schedule state, concurrency reservation only when armed, Glue grant naming every owned table).
- The in-memory stand (`AthenaIndexStreamStand/`) proves the bootstrap -> full sync -> catch-up -> parity protocol and the "checkpoint only after write" invariant independently of AWS.
- Acceptance on a real stage: after seeding, one manual tick reports `merged=true`, `matched_count == mapped_count`, and a status row with `seed_status='ready'`; a property change on a debt vertex appears in the wide table within two schedule intervals; a person-grain change on a sole-owned debt appears; the same change on a joint debt increments `personFanoutSkipped` and leaves the row unchanged; a debt created after the seed acquires a map row and a wide row from the same tick or the next; an idle tick against a reset graph fails with the beyond-stream message rather than publishing `caught_up`.

## 8. Design decisions

- Resolve vertices in Athena, not in the consumer: an in-memory side map had to be complete before the first delta and turned every miss into a graph query on the tick's path; a JOIN against an Iceberg dimension table adds no reader load and counts what it cannot resolve.
- Keep deltas vertex-keyed and let the map ride in the same object as the properties it explains, so a merge can never see a new debt's values without its identifier.
- Map MERGE before wide MERGE, always; the case the stream exists for (a debt created since the last snapshot) resolves to nothing otherwise.
- Types from the lexicon end to end, validated where the delta is written; a string-typed table forced every reader to cast differently from the snapshot export.
- Applied watermark from merged manifests, published after verify, untouched on idle ticks; `MAX(updated_at)` and the poll checkpoint both lie about freshness in different directions.
- Sole-owner fan-out only: correctness over coverage for compliance flags; staleness is counted, never guessed.
- Time-bounded polling with a fixed merge reserve, and a row-budgeted merge, replace record-count knobs that could never keep pace with production write rates.
- Seed requires an explicit immutable source and refuses movable views and its own outputs; a default that pointed at the live view once read from the table it had just emptied.
- Person-map seed replaces via MERGE-then-DELETE-absent rather than DELETE-first, because Athena has no multi-statement transaction and the scheduled consumer keeps running through a seed.
- Schedule armed only by explicit opt-in, and the concurrency reservation only where armed, because a reservation costs the account's pool whether or not the function runs.
- No lifecycle expiry on `deltas/`: the checkpoint has already advanced past them and a successful merge deletes them itself; a timer would drop coverage with nothing to replay from.

## 9. Source map

| Path (persist repo) | Responsibility |
|---|---|
| `lambda/athena-index-stream-smoke/handler.ts` | Lambda entry: decode event, pass deadline and request id, log summary. |
| `lambda/services/AthenaIndexStreamSmokeService.ts` | All actions; poll loop, budgets, delta load, staging writes, merge orchestration, carry files, applied-status publish, idle-tick guard. |
| `lambda/services/AthenaIndexStreamIcebergSql.ts` | Wide Iceberg DDL, additive column migration, seed INSERT, staging sentinels, identifier guard. |
| `lambda/services/AthenaIndexStreamVertexMapSql.ts` | Debt map and person map DDL/MERGE/replace/count SQL; wide-by-vertex staging, three-arm MERGE, verify, unmapped and skipped counts, row encoders. |
| `lambda/services/AthenaIndexStreamVertexMap.ts` | Collect vertex->debt pairs and owner pairs from stream records; `__owns:` pseudo-column. |
| `lambda/services/AthenaIndexStreamDeltaParquet.ts` | Delta Parquet EAV encode/decode, manifest, epoch filter, generation fold. |
| `lambda/services/AthenaIndexStreamAppliedStatusSql.ts` | Status table DDL, singleton MERGE, reader SQL, watermark from manifests, row builder. |
| `lambda/services/AthenaIndexStreamSeed.ts` | Checkpoint model, seed scope/status, source validation, live-view guard, seed protocol over injected ops. |
| `lambda/services/AthenaCatalogSql.ts` | Catalog introspection through Athena (table type, storage kind, columns, view definition, repoint view). |
| `lambda/services/AthenaColumnSql.ts` | Lexicon type -> DDL type, typed cast, fallback literal, write-time value canonicalisation. |
| `lambda/services/AthenaIndexStreamStand/` | In-memory stand: stream model, graph, table with checkpoint and compaction, bootstrap/incremental jobs, parity verify. |
| `lib/debt-index-export-stack.ts` | Lambda, schedule, prefixes, lifecycle rules, scoped IAM. |
| `lib/debt-index-export-trigger.ts` | `resolveAthenaIndexStreamScheduleEnabled` (explicit opt-in, no stage default). |
| `test/services/AthenaIndexStream*.test.ts`, `test/services/AthenaCatalogSql.test.ts`, `test/services/AthenaColumnSql.test.ts`, `test/cdk/debt-index-export-stack.test.ts` | Unit and stack coverage listed in section 7. |
