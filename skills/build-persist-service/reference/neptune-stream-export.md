# Persist — Neptune Stream Export to Athena Tables (Architecture Reference)

Persist turns the Neptune change stream into a queryable star schema in Athena without asking any consumer to interpret stream records on the five-minute tick. A capture Lambda copies raw Neptune Streams pages, byte-for-byte as the graph stated them, into a `waiting-for-export/` S3 buffer and advances a durable cursor only after each page is safe. Once per Persist orchestration (the CSV load workflow of `csv-bulk-load-workflow.md`), a Step Functions workflow fences itself with a lease, captures up to the stream position that load reached, runs a PySpark Glue job that splits the buffered pages into a typed "waiting lake", assembles ~150 configured tables from graph facts on the executors, and writes a run manifest; a second Glue job publishes those tables (Iceberg `MERGE` for entity/index tables, delete-first copy for append-only event tables), proves the rows are visible, and writes a verdict object; a cleanup Lambda reads that verdict and deletes exactly the pages the manifest names. A daily compaction job rewrites fragmented published partitions under the same lease. Every deletion in the pipeline is licensed by a document a previous step wrote, never by a listing or a flag on an event.

## 1. Purpose & scope

- Deliver graph facts (payments, debts, persons, status changes, derived-index values, …) as Athena tables keyed by content hash (`identity-hashing-and-blobs.md` §2), with types drawn from the lexicon (`graphson-ingest-contract.md` §4), for reporting consumers that must not hold a Neptune connection.
- Land records **raw before interpretation**. Every earlier stream consumer (the `derived-index-maintenance.md` §5 indexer, the FTS poller in `opensearch-fts-mirror.md`) decides what a record means while reading it and advances a cursor, so a vertex and its edge on different pages force a Neptune round-trip, and a wrong consumer can only be repaired by a full graph scan because the records are gone. Buffering the raw pages lets a batch job hold both halves as two files in one place and lets a bug be replayed from evidence.
- Keep every destructive step gated: the buffer has no lifecycle rule; pages are deleted only by a cleanup step that has read a verified publish verdict and a run manifest naming those pages.
- Bound every run: a hard 1,000-page window per export, a two-hour lease that is also the workflow timeout, and a per-run Glue capacity chosen from the measured window.

Non-goals: no lexicon-driven derived-index maintenance (`derived-index-maintenance.md`), no OpenSearch replication (`opensearch-fts-mirror.md`), no business-identifier deduplication (two vertices with one business id are two visible rows), no applying `REMOVE` records (counted, never applied), no atomic re-publish for readers of append-only tables (a re-exported window is briefly missing, never doubled).

## 2. Architecture

### 2.1 Resources (provisioned by the export stack, alongside the debt-index export)

| Resource | Shape | Responsibility |
| --- | --- | --- |
| `AthenaRawStreamCapture` Lambda | Node 24 ARM64, 2048 MB, 10 min timeout, in VPC | `bootstrap` / `capture` / `status` over Neptune Streams; writes pages + checkpoint |
| `StreamExportLock` Lambda | 256 MB, 30 s | DynamoDB conditional-put lease, key `stream-export`, TTL 2 h |
| `StreamExportCleanup` Lambda | 512 MB, 5 min | Verdict + manifest gated deletion, waiting-pointer promotion |
| `StreamExportTablesJob` Glue job | `glueetl`, Glue 5.0 (Python 3.11 / Spark 3.5), default G.4X × 8, 60 min, `maxConcurrentRuns: 1`, `maxRetries: 0` | Split pages → waiting lake → assemble tables → manifest |
| `StreamExportPublishJob` Glue job | `glueetl`, G.1X × 2 (no SparkSession started), 20 min, no Glue retry | Athena DDL/MERGE, event copy, verification, verdict, metrics |
| `StreamExportCompactionJob` Glue job | G.2X × 4, Glue timeout 90 min, internal deadline 60 min | Daily EVENT partition rewrite + Iceberg `OPTIMIZE` |
| `PersistStreamExportWorkflow` | Step Functions STANDARD, timeout 120 min | Lease → capture loop → capacity choice → export → publish → cleanup → release → continuation |
| Lock table | DynamoDB `pk`, TTL attribute `ttl` | Shared lease primitive (separate keys per workflow) |
| Export bucket | S3, SSE-S3, retained, lifecycle rules only on reproducible prefixes | Buffer, lake, staging, published tables, compaction state |
| Glue database `<export-database>` | Retained | Published tables, staging twins, compat views |
| EventBridge rules ×3 | Load event, capture continuation, post-cleanup continuation | Start the workflow |
| Package asset | Zip of `glue/` staged from repo root, tests excluded | `--extra-py-files` shared by all three jobs |

### 2.2 Data flow

```text
PersistNeptuneCsvWorkflow (csv-bulk-load-workflow.md §4.12)
  … ProcessVertices → ProcessEdges → CaptureLoadedStreamTarget → emit "Persist CSV Workflow Loaded"
                                                                     detail.streamTarget = {commitNum, opNum}
        │ EventBridge rule (own rule; ingest-metrics consumer has its own)
        ▼
PersistStreamExportWorkflow
  HasTarget? ──no──▶ Succeed(skipped)
  AcquireLock ──held──▶ Succeed(already running)
  Parallel(StreamExportWork)  ┐ catch States.ALL → ReleaseLockOnError → Fail
    Capture loop: Wait 30s ⇄ CaptureStreamPages(through=streamTarget, captureStartedAt)
        stopReason target_reached → ChooseExportCapacity (small G.1X×4 | large G.4X×8) → cost gate ≤ $15
        stopReason deadline       → request capture continuation (new execution, same target)
        otherwise                 → keep waiting
    RunExportStreamTables (Glue .sync, --max_pages 1000)
        waiting-for-export/pages/*  +  stream-export/state/waiting/<gen>/  ──▶  events/, updates/, quarantine/, reaped/
                                                                            ──▶  state/waiting/<candidate-gen>/
                                                                            ──▶  runs/<runId>/manifest.json   (LAST)
    PublishStreamTables (Glue .sync, 2 attempts, 30 s apart)
        reconcile catalog → MERGE entity/index → copy event window (delete-first) → verify → markers
        → runs/<runId>/publish-result.json {publishVerified:true} (LAST) → metrics → compat views
    DeleteConsumedPages (Lambda)
        read verdict → read manifest → promote waiting pointer (conditional PUT) → delete pages, staging, superseded gens
  ReleaseLock
  rawPagesRemain && no continuation marker → emit "Persist Stream Export Continue" (one hop)

EventBridge cron 07:00 UTC (prod only) ──▶ StreamExportCompactionJob (takes the same lease)
```

### 2.3 Dependencies

Neptune reader endpoint (streams only, `neptune-db:GetStreamRecords`, no query permission), the `IndexStreamClientService` page reader shared with the derived-index poller (`derived-index-maintenance.md` §5.7) (`INDEX_STREAM_POLL_LIMIT=10000`), the lexicon object for drift reporting (read, never a type source), Athena workgroup, Glue Data Catalog, CloudWatch metrics namespace `persist`, the paging adapter Lambda the export stack already routes alarms to.

## 3. Contracts

### 3.1 Capture contract (four properties, all unit-tested without AWS)

1. **The page is durable before the cursor moves.** `putPage` then `writeCheckpoint`; a checkpoint that advanced first would skip bytes the stream cannot re-serve past retention.
2. **A page's key names only where it starts.** `event_date`/`event_hour` and `page-<commit18>-<op10>.parquet` derive from the page's first record. A retry re-reads from the same cursor while the stream client halves page size after a slow fetch, so a key that also named the end would create a second object and archive records twice. Commit and op numbers are zero-padded (18 and 10 digits) so keys sort in stream order.
3. **The run is bounded by a target.** `through` is the orchestration's own end position. The run reports how it stopped — `target_reached`, `caught_up`, `deadline`, `page_brake` — because Neptune answers a position past its tip exactly as it answers the tip (nothing), so "caught up" cannot be told from "target not yet visible". Only `target_reached` licenses the export.
4. **A missing cursor is a failure, not a default.** `capture` without a checkpoint fails. `bootstrap` alone writes one, refuses to move an existing cursor unless `force: true`, accepts `startFrom`, defaults to the stream tip, and lifts `opNum` to ≥ 1. An idle tick additionally fails when the cursor's commit is strictly beyond the stream's `LATEST` (a cursor from a reset or replacement cluster).

Event schema: `{action: bootstrap|capture|status, startFrom?, force?, through?, maxPages?, captureStartedAt?}`. Capture output: `{action: "capture", bucket, pages, records, stopReason, reachedTarget, durableProgressSinceCaptureStart, bufferedPageCount?, capacityRecordUpperBound?, checkpoint}`. `bufferedPageCount` is stated only on `target_reached` (one listing, never per iteration); an absent count is read downstream as "assume large".

Page row schema (Parquet, one row per stream record): `commit_num INT64, op_num INT64, commit_timestamp INT64, op (ADD|REMOVE), record_type (vl|vp|e|ep), element_id, key, value_json (JSON text, keeps `Double` vs `"500"` distinct), value_data_type, from_id?, to_id?, is_last_op?`; key-value metadata `raw_stream_manifest = {schemaVersion:"1", fromPosition, toPosition, recordCount, writtenAt}`.

Checkpoint: `waiting-for-export/capture-checkpoint.json` = `{schemaVersion:"1", consumer:"athena-raw-stream-capture", commitNum, opNum, updatedAt, lastPageKey?}` — outside `pages/` so the page sweep cannot delete it.

### 3.2 S3 prefix layout (all under `<bucket>`)

| Prefix | Writer | Deleter | Lifecycle |
| --- | --- | --- | --- |
| `waiting-for-export/pages/event_date=…/event_hour=…/page-<from>.parquet` | capture | cleanup (manifest-named keys only) | none |
| `waiting-for-export/capture-checkpoint.json` | capture | nobody | none |
| `stream-export/state/waiting/<generation>/{vertices,edges}/label=<label>/` | export job (candidate) | cleanup (superseded gens) | none |
| `stream-export/state/waiting/<generation>/transaction-tail/` | export job | cleanup | none |
| `stream-export/state/waiting-current.json` | cleanup only (conditional PUT) | nobody | none |
| `stream-export/events/<runId>/<table>/year=/month=/day=/` | export job | cleanup | none |
| `stream-export/updates/<runId>/<table>/` | export job | cleanup | 14 days |
| `stream-export/quarantine/<runId>/<table>/` | export job | nobody (only copy of refused rows) | none (TODO: own scope) |
| `stream-export/reaped/<runId>/<edge-label>/` | export job | nobody | none |
| `stream-export/runs/<runId>/manifest.json` | export job (last, success only) | nobody | none |
| `stream-export/runs/<runId>/publish-result.json` | publish job (last, success only) | nobody | none |
| `stream-export/runs/<runId>/published/<table>.json`, `_event_window.json`, `_metrics.json` | publish job | nobody | none |
| `stream-export/tables/<table>/…` | publish job (copy / Iceberg), compaction | publish (window-named keys), compaction | none |
| `stream-export/windows/<version>/publish-manifest.json` | publish job | publish job (superseded windows) | none |
| `stream-export/compaction/{staging,backups}/` | compaction | compaction | 14 days |
| `stream-export/compaction/runs/` | compaction | nobody | none |
| `stream-export/compaction/active/` (in-flight swap marker) | compaction | compaction (after a verified swap or a rollback) | none |

Grant EMRFS directory markers (`<prefix>_$folder$`, a sibling key) one by one for every prefix Spark writes; a prefix wildcard never matches them, and broadening to `stream-export*` would reach `tables/`.

### 3.3 Position, page, window semantics

- A **position** is `{commitNum, opNum}`; `cursorHasReached(cursor, target)` is `cursor >= target` lexicographically; no cursor means not reached.
- A **page** is one `getAfter(position)` response (≤ 10,000 records) and one S3 object.
- A **window** is the set of pages one export run consumed: the oldest ≤ `--max_pages` (1,000) objects listed in stream order across partitions. Its **version** is a 16-hex digest of the sorted page keys — stateless, so two executions of one window agree on published object names.
- A transaction is complete exactly where `is_last_op=true`. Records of the one transaction crossing the window boundary are carried raw in `transaction-tail/` (uninterpreted, so a property without its label is not counted as a drop) until its last op arrives. A single transaction exceeding the 1,000-page cap fails the run before any state moves; raising capacity is an operator decision.
- Capacity upper bound for sizing = `waitingRowCount + transactionTailRowCount + min(bufferedPages, 1000 − transactionTailPageCount) × 10,000`.

### 3.4 Waiting lake records (frozen)

Two schemas for the whole lake, never one per label. Vertex: `hash, label, properties_json map<string,string>, commit_num, op_num, commit_timestamp_millis, first_seen_run, carried_runs`. Edge: the same plus `from_id, to_id` (both always stated). `properties_json` holds the JSON the graph stated, or the raw sentinel `__NULL__` for a cleared property; readers test for the sentinel **before** decoding, because a graph string `__NULL__` arrives quoted. Folding two records of one hash: properties merge key by key (later position wins), position fields from the later record, `carried_runs` = max, `first_seen_run` from the older copy. Run-owned columns live behind the reserved prefix `__`; the config refuses any lexicon property that collides with `export_run_id`, `updated_at`, `year`, `month`, `day`, or `__*`.

Waiting pointer `waiting-current.json` (schema v2): `{runId: <generation>, schemaVersion: 2, waitingRowCount, transactionTailRowCount, transactionTailPageCount}`. A legacy pointer may omit all three capacity fields (capacity unknown → large profile); stating only some is a refusal. A retry never writes to the generation it reads: `next_generation` appends `--attempt-N`.

### 3.5 Run manifest (`runs/<runId>/manifest.json`)

Required keys (only ever gain members): `runId, consumedPages[], tables{name→{kind,rowCount,uri,partitions[]}}, waitingRowCount, transactionTailRowCount, transactionTailPageCount, waitingCountsByLabel, waitingOldestAgeRuns, waitingOldestAgeRunsByKind{vertex,edge}, droppedFactCount, droppedLabels, indexFactCount, removedElementCount, quarantineRowCount, throughCommitTimestampMillis, waitingGeneration, waitingExpectedPointer{state: absent | present+generation+content}, waitingCandidatePointer{generation, content}`. Optional: `quarantineUri, quarantineCountsByReason, reapedUri, reapedRowCount, reapedCountsByReason, excludedRowCount, waitingOldestAgeRunsByLabel, lexiconDriftProblems[]`. Doctrine: an absent optional key is a default; a present unreadable value is a refusal by name (a `"7"` published as 0 is a flat dashboard over a pipeline losing rows). A run that published rows may not state clock 0. The TypeScript cleanup decodes only the subset it acts on.

Publish verdict `runs/<runId>/publish-result.json`: `{publishVerified: true, …counters}`; the delete branches on the **literal** `true` only.

### 3.6 Tables config schema and label → table mapping

Source of truth: `glue/config/tables.py` (hand-written `Table` declarations). Rendered by `just render-tables-config` (`python -m glue.config.render`) against a sha-pinned lexicon fixture into two byte-identical copies — `config/stream-export-tables.json` (reviewed, read by the DDL approval and the stack test) and `glue/config/stream-export-tables.json` (package data, the only copy the jobs may read, via `importlib.resources`, because Glue zip-imports `--extra-py-files` without unpacking). Rendered shape per table:

```json
{"name":"payment","kind":"event","subjectKind":"vertex","subjectLabel":"payment",
 "hashColumn":"payment_hash","mergeKey":null,
 "partition":{"kind":"ny_date","source":"effective_at","columns":["year","month","day"],"yearRange":[2000,2035]},
 "admission":{"propertyValues":[],"absentProperties":[],"forbiddenEdges":[]},
 "edges":[{"label":"debt_has_payment","subjectEnd":"to","required":true,"fkColumn":"debt_hash","properties":[],"multiplicity":"single"}],
 "endpointColumns":[{"end":"from","column":"…"}], "indexProperties":[],
 "columns":[{"name":"…","type":"decimal(18,2)","source":"hash|property|index|edge|endpoint|run|partition"}]}
```

- **Kinds**: `event` (append-only, immutable facts, carries `export_run_id`, day-partitioned, external Parquet with partition projection); `entity` (dimension merged by hash, Iceberg, `updated_at`); `index` (mutable derived-index properties merged by hash, Iceberg; facts routed by property **name**, need no label, no edges, no waiting — this is how a vertex created before the buffer existed gets a current status with no backfill).
- **Mapping**: a table is rooted at `(subjectKind, subjectLabel)` — always both, because one label can be a vertex and an edge. A `vl`/`e` record whose (kind, label) any table names becomes a typed waiting record; `vp`/`ep` for a hash the window or lake knows folds into it; a `vp` whose key an index table claims goes straight to that table's staging; everything else is dropped and counted by label. Several tables may root at one label; `admission` (property values, absent properties, forbidden edges) decides which applies to a subject.
- **Edges**: `required` is a waiting rule (subject waits until the edge arrives); `subjectEnd` says which end the subject sits on so `fkColumn` holds the other end's hash; `multiplicity: single` — several edges naming the same far hash are one relation restated (latest wins), different far hashes quarantine the subject with both edge hashes as evidence; `many` is refused beside an FK (use an edge-rooted table).
- **Types** come from the lexicon (`string→string`, `number→double`, `integer→bigint`, `boolean`, `format date-time→timestamp`, `date→date`); the config overrides only money (`decimal(18,2)`). Validation (`lexicon_validation.py`) refuses undefined labels/edges/properties, deprecated types, wrong edge ends, two index tables claiming one property name, column name collisions, and FKs with no entity table to join to.
- **Partitioning**: `ny_date` derives `year/month/day` from an ISO-8601 instant (or the stream clock `__commit_timestamp_millis`) in the business IANA timezone; `none` for entity/index. `yearRange` defaults to [2000, 2035] (historical status tables [1900, 2035]) and is declared as projection in the DDL; a row outside it is unfileable (written to S3, readable by nobody) and is quarantined.
- **Published naming**: one prefix per table `stream-export/tables/<table>/`; event objects `year=Y/month=M/day=D/<windowVersion>-<NNNN>.parquet` (unpadded ints); compacted objects `compact-<runId>-<NNNN>.parquet`; staging twins `<table>_stream_export_staging`; approved DDL snapshots per table in `glue/tests/approved/*.sql`.

### 3.7 Stream status for direct readers

- Every merged row carries `updated_at` = the window's stream clock (`throughCommitTimestampMillis`, the greatest commit timestamp the window held, stated by the manifest, never derived from a page key). Every event row carries `export_run_id`. Window records under `windows/` name exactly which objects a page set produced.
- The sibling Athena index-stream consumer publishes a one-row status register `<wide-table>_applied_status` (`status_key, status_contract_version, applied_commit_num, applied_op_num, applied_at, last_verified_at, caught_up, pending_delta_files, polled_commit_num, polled_op_num, …`) after its merges verify, so a reader can gate freshness on the stream position rather than on `MAX(updated_at)`. Adding a column is compatible; renaming is not.

### 3.8 Environment and IAM (generalized)

| Component | Env / args | IAM scope |
| --- | --- | --- |
| Capture Lambda | `ATHENA_RAW_STREAM_BUCKET`, `NEPTUNE_READER_HOST`, `NEPTUNE_PORT`, `INDEX_STREAM_POLL_LIMIT=10000` (`NEPTUNE_HOST` and `NEPTUNE_WRITER_HOST` are set to the reader endpoint but nothing on the capture path reads them); `RAW_STREAM_MIN_REMAINING_MS` (code default 20000) and `RAW_STREAM_MAX_PAGES_PER_INVOCATION` (code default 10000) are read if present but not set by the stack | `neptune-db:connect,GetStreamRecords`; `s3:ListBucket` (unconditioned — needed for 404 on missing checkpoint); `s3:Get/PutObject,AbortMultipartUpload` on `waiting-for-export/*`; `s3:GetObject` on the waiting pointer key only; **no Delete** |
| Lock Lambda | `STREAM_EXPORT_LOCK_TABLE` | table read/write |
| Cleanup Lambda | `POWERTOOLS_METRICS_NAMESPACE=persist` | bucket read; `s3:DeleteObject` on `pages/*, events/*, updates/*, state/waiting/*`; `s3:PutObject` on the pointer key only; never quarantine |
| Export job | `--run_id --pages_uri --state_uri --output_uri(bucket root) --max_pages` required per run; `--lexicon_uri` optional; defaults `--extra-py-files`, `--enable-s3-parquet-optimized-committer`, `--conf spark.driver.maxResultSize=4g`, metrics on | logs; `PutMetricData` only in `Glue*` namespaces; bucket list; `GetObject` on `pages/*` and `state/*`; Put/Delete on `state/waiting/*`, `events/*`, `updates/*`, `quarantine/*`, `reaped/*`; Put (no delete) on `runs/*`; markers by exact key; lexicon object read |
| Publish job | `--run_id --bucket(bare) --database --workgroup --timeout_seconds` all required | `PutMetricData` only in `persist`; Athena on one workgroup; Glue catalog write on `<export-database>` by wildcard (an enumerated list outgrew the inline-policy quota); bucket list + `GetBucketLocation`; read `events/*`,`updates/*`; read/write `runs/*`, `tables/*`, `athena-results/*`, `windows/*`; delete only `tables/*` and `windows/*` |
| Compaction job | `--bucket --database --workgroup --lock_function_name --target_file_bytes --small_file_bytes --min_files --closed_lag_days --max_event_partitions --max_iceberg_tables --internal_timeout_seconds --shutdown_reserve_seconds --table_names` | Athena workgroup; catalog read + `UpdateTable`; RW+delete on `tables/*`, `compaction/*`, `athena-results/*`; read `windows/*`; invoke lock Lambda; `glue:GetJobRun` on itself |
| Workflow | — | `glue:StartJobRun/GetJobRun/GetJobRuns/BatchStopJobRun` on `*` (required by the optimized integration) |

## 4. Runtime behaviour

### 4.1 Capture continuation without operator restarts

Run the loop as `Wait 30 s → CaptureStreamPages` with no task-level timeout; each invocation resumes from the durable cursor. Pass `captureStartedAt` so every invocation shares one aggregate 10-minute phase budget; the effective deadline is `min(phase remaining, invocation remaining)` with a 20 s reserve. On `deadline`, end the branch normally, release the lease, and emit a capture-continuation event carrying the same target and `streamCaptureContinuation = n+1`; refuse past 5 continuations (`StreamCaptureContinuationLimitExceeded`), refuse a continuation that cannot prove it released the lease, and fail `StreamCaptureStalled` when a budget expired with no page archived — reading the checkpoint's `updatedAt` as durable progress in case a Lambda response was lost. `caught_up` keeps waiting inside the budget (the target may not be visible yet). Retry the capture task twice on `States.ALL`.

### 4.2 Lock semantics

Acquire with a DynamoDB conditional put (`lockKey=stream-export`, owner = execution id, TTL 2 h = workflow timeout). A loser **Succeeds** (`StreamExportSkippedRunCount`), because overlapping orchestrations are ordinary. Release on both the success path and a `Parallel` catch; a release that finds the lease not its own emits `StreamExportLeaseStolen` and pages. The one uncatchable failure is the execution's own timeout, so every step expires inside it: capture 10 min + Glue startup 3 min + export 60 min + 2 publish attempts × 23 min + 30 s wait = 119.5 min. Retry lock tasks 3× (2 s, ×2). The compaction job takes the same lease through the lock Lambda with owner `stream-compaction-<runId>` and reports `SKIPPED_LOCK_HELD` rather than failing.

### 4.3 Export run steps (`export_stream_tables.py`)

1. Resolve arguments; refuse missing or empty ones by name (Glue drops empty values); `max_pages` must be 1–1,000.
2. `open_window`: read the current pointer (refuse an unreadable one or a named generation that is missing — never read a denied prefix as empty), read the carried lake and transaction tail, list `pages/` in stream order, take the oldest ≤ `max_pages`, split at the last complete transaction, persist three frames (vertices, edges, index facts) at `MEMORY_AND_DISK`.
3. Refuse a table kind with no write path; report lexicon drift (never raise on it).
4. Stage all three kinds beside the records: index (fold by position → coerce → pivot per hash), entity (vertex is the row, flat text), event (edges keyed by the subject's end, gathered per subject, sorted by `(commit_num, op_num, hash)`, one subject at a time through the pure `take_event_subject`). Submit ≤ 14 tables' Spark work at once; only tables whose label the window holds are evaluated.
5. Write per run, per table: events as typed Parquet (Decimal/datetime) partitioned by business day; updates as flat text (hash first, absent = untouched, sentinel = clear); quarantine and reaped frames. File count per key = `ceil(rows / 1,000,000)`, never the task count.
6. Reap: an edge older than 50 runs whose subject exists nowhere leaves the lake — to `reaped/` if its label is optional in every table, to `quarantine/` if any table requires it. Anti-join every consumed hash out of the lake; age survivors by one; write the candidate generation (vertices, edges, transaction tail) and count it.
7. Write the manifest last. Never touch the pointer. Refuse a window whose unfileable rows exceed 1% of a table's subjects **and** 10 rows.

### 4.4 Capacity and cost

Choose small (G.1X × 4, ~$2.35) when `capacityRecordUpperBound ≤ 3,000,000`; otherwise or when absent, large (G.4X × 8, ~$14.67, one driver + seven executors). Fail `StreamExportCostCeilingExceeded` above $15 per run. Keep the job default at G.4X × 8 so manual invokers stay safe. Do not rely on `spark.scheduler.mode=FAIR` (a core conf Glue sets before the script).

### 4.5 Publish run steps (`publish_stream_tables.py` → `publish_run.py`)

Decode the manifest (refuse another run's, refuse non-numeric counters); plan table URIs; reconcile the catalog (one full `GetTables` listing, `CREATE IF NOT EXISTS` for missing names at concurrency 14, re-list, refuse a name of the wrong storage kind, ALTER stale year projections and read back); read markers; read any existing verdict (unreadable → stop). Merge entity/index tables **first** (drop + create staging, profile, `MERGE` cast column by column with `CASE` for absent/sentinel/stated, verify applied count, drop staging, write marker) at concurrency 14, resubmitting only the `MERGE` once on an Iceberg commit conflict. Then publish the event window as one phase: delete every object named by superseded window records (refuse a partial overlap), copy at concurrency 12 under an aggregate deadline, verify same-size copies and `SELECT COUNT(*) … WHERE partitions AND export_run_id` (≤ 100 partition clauses), replace the window record, write `_event_window` marker. Write the verdict, then emit metrics, then `_metrics` marker; restate compat views. Poll Athena once a second, cancel abandoned or over-deadline statements, keep a 60 s shutdown reserve.

### 4.6 Cleanup and page deletion

Read the verdict first (missing, empty, or non-literal-`true` → refuse with the buffer whole). Decode the manifest; refuse a manifest from another run, any page outside `waiting-for-export/pages/`, any table output outside the run's own `events/` and `updates/`, any unsafe run id (`^[A-Za-z0-9_.-]+$`). Resolve the pointer transition: promote with `If-None-Match:*` when the transform saw no pointer, with `If-Match: <ETag>` when the live document equals the expected content, treat an already-promoted candidate as a replay, and fail closed on anything else before deleting. Then delete pages, then each staging prefix, then superseded generations, in 1,000-key batches, reading the `Errors` array of every response. Report `rawPagesRemain` for the one-hop continuation.

### 4.7 Daily compaction (`compact_stream_tables.py`)

Refuse to start if `compaction/active/` holds an unfinished swap. Plan closed EVENT day partitions (≥ 2 days old) with ≥ 8 files where ≥ 50% are < 16 MB, at most 50 partitions per run and 24 source files → ≤ 2 target files per chunk, targeting 256 MB. Skip partitions whose source window still has a consumed page in the buffer (replay-blocked). Stage, fingerprint, back up, take the lease, delete old files, copy compacted files into the same path, verify, restore the backup on failure. Then `OPTIMIZE … REWRITE DATA USING BIN_PACK` on ≤ 10 Iceberg tables whose inventory shows fragmentation. Anchor the 60-minute internal deadline to Glue's `StartedOn`; stop new mutations 15 minutes before it. Retain staging and backups 14 days.

### 4.8 Failure modes and retries

- Neptune stream fetch: the shared client halves page size after a slow fetch; capture retried by the workflow; cursor beyond stream → fail, re-bootstrap with `force`.
- Export job failure: no manifest, no pointer move, pages untouched; the next orchestration repeats the window. Never add a Glue retry or a workflow `Retry` (a second attempt under one run id re-copies event rows).
- Publish failure: one workflow retry on `States.TaskFailed` (not `States.Timeout`); markers make the retry converge. Iceberg commit conflict → one resubmit of the `MERGE` only.
- S3 `SlowDown`: publish ports retry throttled copies/deletes with jittered backoff; compaction uses one shared botocore config, `adaptive` retry mode, 5 total attempts, 20 s max backoff, sized so a throttled rollback fits inside the shutdown reserve.
- Cleanup: 2 retries; idempotent deletes and pointer replay detection.

## 5. Observability & alarms

Namespace `persist`, dimension `service=persist-stream-export`. Emitters never overlap: publish job emits the run's counters (`StreamExportWaitingRowCount`, `WaitingOldestAgeRuns` (vertex kind only), `DroppedFactCount`, `IndexFactCount`, `RemovedElementCount`, `QuarantineCount`, `ExcludedRowCount`, `LexiconDriftProblemCount`, `PublishedRowCount`, `StatedRowsZeroCount`); cleanup emits `DeletedPageCount`; lock emits `SkippedRunCount`, `LeaseStolen`; capture emits `BufferedPageCount` (EMF, only on `target_reached`, cleared after publish); compaction emits `CompactionRunReported/RunFailed/LeaseSkippedCount/PartitionsCompacted/FilesRemoved/PartitionsEligible/ReplayBlockedCount/IcebergTablesOptimized`. Pin the Python spellings to `StreamExportMetrics.ts` with a test that reads the file.

| Alarm | Condition | Missing data |
| --- | --- | --- |
| Workflow failures | `ExecutionsFailed + ExecutionsAborted` (math expression, 5 min sums) ≥ 1 in any of 144 periods (12 h, `datapointsToAlarm: 1`, held through an outage) | not breaching |
| Workflow timeouts | `ExecutionsTimedOut` ≥ 1 | not breaching |
| Lease stolen | `LeaseStolen` ≥ 1 / 5 min | not breaching |
| Waiting age | max `WaitingOldestAgeRuns` > 20 runs / 1 h | missing (stay in last state) |
| Quarantine | sum `QuarantineCount` > 10 / 1 h | not breaching |
| Liveness | `PublishedRowCount` SampleCount < 1 for 8 consecutive hours | **breaching** (the only alarm a dead pipeline trips) |
| Buffer depth | max `BufferedPageCount` > 2,000 (2 × window cap) | missing |
| Compaction failed | `CompactionRunFailed` ≥ 1 / 24 h | not breaching |
| Compaction liveness (scheduled stage only) | `CompactionRunReported` absent 26 h | breaching |
| Compaction lease skips (scheduled stage only) | 3 consecutive daily skips | not breaching |

Route every alarm and OK action to the paging adapter; re-scan active alarms hourly. Log JSON via Powertools (`engineering-conventions-and-testing.md` §3); log the reason a capture stopped as the error name.

## 6. Operations / runbook

- **Open the cursor** (once per stage): resolve the function name from the SSM parameter the stack publishes, invoke `{"action":"bootstrap"}`; `{"action":"bootstrap","startFrom":{…},"force":true}` to replay a window the stream still holds.
- **Fill the buffer**: `{"action":"capture","through":{"commitNum":N,"opNum":M}}`; omit `through` only for a manual catch-up to the tip.
- **Check progress**: `{"action":"status"}`; `BufferedPageCount` on the dashboard; `runs/<runId>/manifest.json` and `publish-result.json` for a run; execution history of the workflow (ERROR-level logs, X-Ray).
- **Manual export**: start the workflow with `{"detail":{"streamTarget":{"commitNum":N,"opNum":M}}}`; never start the Glue jobs by hand with a reused run id (event rows would double). To re-export a window, delete its `windows/<version>/` record only after understanding which objects it names.
- **Cursor past stream** alarm: decide between reseeding and fast-forwarding, then `bootstrap` with `force`.
- **Waiting-age alarm**: inspect `waitingCountsByLabel` / `waitingOldestAgeRunsByLabel` in the latest manifest; usually a config claiming a required edge the producer never emits.
- **Quarantine alarm**: read `quarantine/<runId>/<table>/` (contains PII; no logging); repair the producer; rows never age out.
- **Compaction failure**: inspect `compaction/active/`; restore from `compaction/runs/<runId>` + `backups/` (exact source keys) before the next run; a DEV canary can pass `--table_names a,b`.
- **Rendering tables config**: edit `glue/config/tables.py`, run `just render-tables-config`, re-approve DDL with `python -m glue.config.athena_ddl`, commit both JSON copies; CI fails on drift.

## 7. Verification & acceptance criteria

- TS unit tests (`test/services/AthenaRawStreamCapture*.test.ts`, `RawStreamTarget`, `StreamExportCleanup`, `StreamExportContract`, handler tests): page durable before checkpoint; key depends only on start position; event-time partitioning; refuse capture without checkpoint; refuse moving a cursor without `force`; idle tick beyond stream fails; stop reasons; aggregate deadline; durable progress after lost response; buffer count only on target; capacity bound arithmetic; cleanup refuses any key outside the page prefix, another bucket, another run, non-literal verdict, event-carried licence; pointer promotion ETag/create-only/replay/conflict; lock skip vs. stolen metrics.
- CDK stack tests: no schedule on capture; capture IAM has no delete; one Glue run per window; every required argument passed; capacity chosen from the measured bound; `maxRetries: 0`, `maxConcurrentRuns: 1`; publish retried in the workflow not in Glue; every attempt fits the lease; buffer whole on failure; pages deleted only after success; no-target event skips; lease released on both paths; continuation events; lifecycle rules only on `updates/` and compaction staging/backups; all alarms routed and clearing.
- Glue tests (`glue/tests/`, several hundred collected cases, `uv run pytest` via `just test`): contract spellings and prefixes; splitter routing (every fact lands in exactly one counter, index facts route by name, last value wins by position, retry never writes the live generation); table assembly (required edge waits, single-multiplicity conflict quarantines, money exact cents, unfileable year refused, sentinel handling); window assembly equals pure assembly (`window_equivalence.json` snapshot) and driver budget is bounded by config not records; part files = `ceil(rows/1M)` regardless of task count; end-to-end window from pages to published tables with a publish failure leaving typed waiting intact; publish order (merged before appended), markers converge a retry, verdict literal `true` written last, metrics after verdict, catalog preamble refuses wrong-kind tables, event window delete-first with partial-overlap refusal; compaction planner, swap/restore, deadline and reserve, adaptive retry arithmetic, metric names pinned to the TS file; publish modules import on Python 3.9 and out of a zip.
- Acceptance: a load event with a target produces, within one lease, a manifest, a verified publish, deleted pages, and a promoted pointer; a load event without a target skips; two overlapping loads produce one export and one skip; a backlog drains in 1,000-page windows with at most one continuation per cleanup; a killed publish leaves the buffer and prior generation intact and the retry converges; a dead pipeline pages within 8 hours.

## 8. Design decisions

- **Raw before typed**: interpretation moves to a batch job that can hold both halves of a transaction; consumers stop carrying schema and joins.
- **Every delete licensed by a document**: manifest + verdict + window record; never a listing, never a flag on an event. Objects written last and only on success make their existence the claim.
- **Window-versioned, delete-first event publish** rather than write-in-place or run-versioned: idempotent across executions of one page set without a stored counter.
- **Generations + single-PUT pointer** for the lake: the carry set has no other copy; delete-then-write in place would lose it on a mid-run death; cleanup alone promotes, conditionally.
- **Window cap (1,000 pages) and executor-side assembly** replaced an ever-growing driver-collected window whose failures ratcheted the next attempt larger; the driver now holds counters only.
- **Per-run capacity** because a flat G.4X × 8 costs ~13× the small profile on an ordinary tick while G.1X OOM-kills the driver on a backlog; the job default stays large for safety.
- **Publish as a Spark job that starts no Spark**: Python Shell caps at 3.9, drops package data from wheels, and ships a 2022 boto3; `glueetl` keeps the tested interpreter and the packaged config at ~$1.76/day extra.
- **Bounded file counts** (`ceil(rows/1M)`) because Spark's one-file-per-task left tens of thousands of objects per backlog window for the publish to copy.
- **Budget divided inside the lease** because an execution timeout runs no catcher; the stack test holds the sum.
- **Optional orphan edges to `reaped/`, required ones to quarantine**, so routine late enrichment never pages while a row a consumer never received still does.
- **Adaptive S3 retries with a small attempt budget** after a production drain failed on `SlowDown` under standard mode's three attempts.
- **Liveness alarm on metric absence** after an outage in which every value-based alarm sat silent for days.

## 9. Source map (persist repo, relative paths)

| Path | Responsibility |
| --- | --- |
| `docs/neptune-stream-waiting-for-export.md` | Original capture design note (predates the lock and in-repo Glue jobs) |
| `lambda/athena-raw-stream-capture/handler.ts` | Capture entrypoint, readable error names |
| `lambda/services/AthenaRawStreamCapture.ts` | Pure capture contract: keys, Parquet codec, checkpoint, bootstrap, page/run loops |
| `lambda/services/AthenaRawStreamCaptureService.ts` | S3/Neptune I/O, aggregate deadline, buffer count, capacity bound, EMF metric |
| `lambda/services/AthenaIndexStreamStand/model.ts` | `cursorHasReached`, `checkpointIsBeyondStream` |
| `lambda/services/neptune-stream/*` | Lease + deadline-guarded polling core used by the derived-index and FTS pollers; NOT imported by the capture path, which runs its own page/run loop in `AthenaRawStreamCapture.ts` |
| `lambda/services/IndexStreamClientService.ts` | Neptune Streams HTTP client (`getAfter`, `getLatestWatermark`) |
| `lambda/services/StreamExportContract.ts` | TS twin of prefixes, field names, caps, continuation constants |
| `lambda/services/StreamExportMetrics.ts` | Metric name registry (cross-language pin) |
| `lambda/services/StreamExportCleanup.ts` | Manifest/verdict schemas, deletable-key and pointer-promotion resolvers |
| `lambda/stream-export-cleanup/handler.ts` | Cleanup Lambda I/O and ordering |
| `lambda/stream-export-lock/handler.ts`, `lambda/services/WorkflowLock.ts` | Lease acquire/release |
| `lambda/schemas/workflow.ts` | Loaded event schema incl. optional `streamTarget` |
| `lib/persist-stack.ts` (`CaptureLoadedStreamTarget`) | Reads the stream position after both load phases, puts it on the load event |
| `lib/debt-index-export-stack.ts` | Bucket, jobs, roles, workflow, alarms, schedule, budgets |
| `lib/glue-package-asset.ts` | Allow-list excludes for the `glue/` package zip |
| `glue/config/tables.py` | Table declarations (source of truth) |
| `glue/config/render.py`, `glue/config/stream-export-tables.json`, `config/stream-export-tables.json` | Rendered config, two byte-identical copies |
| `glue/config/lexicon_validation.py` | Config-vs-lexicon validation |
| `glue/config/athena_ddl.py` | DDL builder, identifier/location guards, approval snapshots |
| `glue/jobs/stream_export_contract.py` | Frozen seam: record schemas, prefixes, manifest keys, pointer, sentinel |
| `glue/jobs/stream_facts.py` | Page listing, transaction window, split/routing, lake read and candidate sink |
| `glue/jobs/split_result.py` | Spark-free record shapes |
| `glue/jobs/table_assembly.py` | Pure per-subject rules: event/entity/index/reap, coercion, quality |
| `glue/jobs/window_assembly.py` | Same rules run beside the records; consumed sets, carry, counts |
| `glue/jobs/partitioning.py` | ISO instant parsing, business-day partition, projection range |
| `glue/jobs/part_files.py` | `gathered_by` / `bounded_parts`, 1M rows per file |
| `glue/jobs/export_stream_tables.py` | Export job entrypoint and manifest |
| `glue/jobs/publish_stream_tables.py`, `publish_run.py` | Publish entrypoint and ordered run |
| `glue/jobs/publish_catalog.py`, `publish_tables.py`, `publish_events_sql.py`, `publish_merge_sql.py`, `publish_compat_sql.py` | Catalog preamble, config decode, DDL/COUNT SQL, MERGE SQL, legacy views |
| `glue/jobs/publish_event_window.py` | Window digest, delete-first copy, verification, window records |
| `glue/jobs/publish_markers.py`, `publish_metrics.py`, `publish_ports.py` | Convergence markers, counters, Athena/S3/Glue/CloudWatch ports with retries |
| `glue/jobs/compact_stream_tables.py` | Daily compaction planner, swap, rollback, Iceberg OPTIMIZE, reporting |
| `glue/tests/` | Pytest suites, approved DDL, window-equivalence snapshot, lexicon fixture |
| `pyproject.toml`, `justfile` (`render-tables-config`, `test`) | Python 3.11 / Spark 3.5 pin, uv tooling |
| `test/services/*Stream*`, `test/handlers/stream-export-*`, `test/cdk/debt-index-export-stack.test.ts`, `test/e2e/raw-stream-capture.e2e.test.ts` | TypeScript and CDK verification |
