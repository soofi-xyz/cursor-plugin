# OpenSearch Full-Text-Search Mirror

This reference is the authoritative specification for Persist's full-text search: the `PersistSearchStack`, the FTS index model, the `Neptune#fts` policy on `POST /persist/gremlin`, the backfill workflow, the Neptune Streams to OpenSearch poller, and the FTS schemas. The PRD's sections 2.3, 3.8, 5.7, and 6.8 are stubs that point here. The feature was designed before it was built against a large graph; section 2 records the original design next to what shipped so the rationale survives: a managed OpenSearch domain instead of a Serverless collection, an opt-in code-owned FTS definition instead of "everything indexable", an explicit strict mapping with a fingerprinted registry, a count/slab/shard backfill that plans edges by source vertex, a time-bound poller that tolerates partial transactions, page-level coalescing of single-cardinality property rewrites, label-aware suppression of rehydration storms, and a bulk acknowledgement barrier ahead of every checkpoint advance. Read PRD 2.2 (NeptuneStack), 4.1 (`POST /persist/gremlin` read-only policy), 5.6.2 (derived-index stream indexer), and 6.6 (derived-index checkpoint item) first; this file shares those foundations and does not restate them.

## 1. Purpose and scope

- Mirror **selected** Persist vertices and edges into one OpenSearch index shaped for Neptune's `Neptune#fts` integration, so callers get full-text, typed range, and sort predicates through the existing Gremlin read surface (PRD 1.3, 4.1) and compose relationships with ordinary traversals.
- Selection is deliberate, not derived from the lexicon: a code-owned definition lists the labels and the canonical or derived-index fields that may appear as predicates. The full graph is dominated by dense communication-event edges (orders of magnitude more edges than vertices); mirroring every label would multiply domain cost and backfill time without a query that needs it. New lexicon properties are ignored until opted in.
- Keep Neptune the authority. The mirror is rebuildable from Neptune plus the stream checkpoint; nothing reads the mirror except Neptune itself while executing `Neptune#fts`.

Non-goals: a direct application search API or raw OpenSearch access (PRD 1.3); denormalizing related entities onto one document (FTS narrows elements, Gremlin joins); Gremlin FTS hard-gating on *both* stream pollers being caught up (only the optional freshness gate in §4.6 applies); the derived-index writer (`derived-index-maintenance.md`, with its discovery control plane in `derived-index-discovery-and-catchup.md`), which is the producer of the materialized fields this mirror patches; the raw stream export (`neptune-stream-export.md`).

## 2. Original design versus what shipped

The left column is the pre-implementation design (it used to live in the PRD); the middle column is the contract this file specifies.

| Original design | What shipped | Why |
|---|---|---|
| 2.3: OpenSearch **Serverless** `SEARCH` collection, network + data-access policies, `aoss:APIAccessAll`, managed VPC endpoint | A **managed OpenSearch domain** inside the Persist VPC; authorization is a resource policy delegating to IAM for account principals plus `es:ESHttp*` grants; reachability is a security group admitting the Lambda SG and the VPC CIDR on 443. The client still signs `aoss` when the endpoint hostname says so, so a collection can be swapped back in | Serverless offered no search slow logs (the only way the `.keyword` subfield failure in 4.3 was diagnosed), shed load with 429s while scaling indexing capacity during backfills, and was never validated end-to-end with `Neptune#fts`; the domain was |
| 2.3: outputs `OpenSearchVpcEndpointId`; endpoint/ARN consumed as stack outputs | No VPC endpoint output. Endpoint, ARN, index name, and workflow ARN are published to SSM (`/persist/opensearch/*`); the API stack reads the endpoint from SSM and grants `es:ESHttp*` on an account-scoped `domain/*` wildcard | CloudFormation exports would deadlock replacing the search target; SSM lets the search stack swap domains without a two-phase export dance |
| 3.8: "vertices and edges are both indexable unless a lexicon contract excludes them"; lexicon-known scalars indexed | Opt-in only: `lambda/config/opensearch-fts-definition.json` lists labels and fields; everything else is dropped at transform time | Scope control on a graph dominated by dense edges; a clear seam for a future lexicon-owned definition |
| 3.8: non-string indexing "when the mapping supports it"; document model only | Explicit `dynamic: "strict"` mapping generated from lexicon type/format, every string-backed field with a `keyword` subfield (`ignore_above: 256`), a SHA-256 mapping registry with additive-only evolution | Neptune resolves internal filter/sort fields through `.keyword` subfields; a missing one compiles the whole query to `match_none` and returns zero results silently |
| 3.8 / 5.7.1: stable document IDs "derived from `entity_id`" | `_id` is the raw graph element id | Neptune resolves hits through `entity_id`; the reference implementation's hashed id adds nothing |
| 5.7.1: `Prepare -> CaptureWatermark -> BuildShardManifest -> IndexShards -> VerifySamples -> RecordCheckpoint`; enumerate with `g.V().id()` / `g.E().id()`; `SEARCH_BACKFILL_SHARD_SIZE=1000` ids | `Prepare -> PlanShardsPerLabel (Map) -> ExtractSlabs (Distributed Map) -> IndexShards (Distributed Map) -> Finalize loop`. Per-label count, 250,000-element offset slabs, exact-id shard files, edges planned by OUT-vertex adjacency. **No sample verification step**; `sampleMismatches` is always `0` | A global label scan or count of the largest edge label cannot finish inside a 15-minute Lambda; offset pagination is quadratic; parity is proven operationally (section 7) rather than by a sampled step that would add a second full read |
| 5.7.1 input: `indexGeneration`, `costCeilingUsd`, `documentTypes`, `labels`, `maxConcurrency` | Added `resumeExecutionId`, `resetIndex`, `shardSize`, `executionId`; `costCeilingUsd` and `maxShards` are accepted but unused; `indexGeneration` is the execution id; `labels` can only *narrow* the definition | Resume after partial failure without re-planning; reset is the only way to move a stale checkpoint |
| 5.7.1: continuous replication always starts from the backfill watermark | Explicit `checkpointAction`: `INITIALIZE` only for a first full-scope backfill or a full-scope `resetIndex`; `PRESERVE` for every additive or scoped run; scoped write with no checkpoint, and scoped reset, fail closed | The checkpoint is a global cursor over the whole definition; a scoped run must not skip the stream window for labels it did not rebuild |
| 5.7.2: checkpoint item `pk="opensearch"`, `sk="checkpoint"` with `indexName`, `indexGeneration` | `pk="stream"`, `sk="checkpoint"` (same shape as the derived-index item, PRD 6.6) without `indexName`/`indexGeneration`; a second item `pk="mapping"`, `sk="fingerprint"` holds the mapping registry | One checkpoint-store implementation shared by both pollers; the index is fixed at `amazon_neptune` |
| 5.7.2: "process only complete transactions" | Prefer the complete-transaction prefix; fall back to processing a partial-transaction page when no `isLastOp` is on the page | Neptune caps pages at 100,000 records; a CSV bulk-load commit is often larger, and prefix-only paging deadlocked on `no_complete_transactions` |
| 5.7.2: merge property changes "by reading the affected element when the record alone is insufficient" | Partial `update` for selected property ADDs; rehydrate only on `document_missing` (404) or a page-final REMOVE; page-local label learning drops out-of-scope property noise; REMOVE/ADD pairs coalesce | Single-cardinality writes appear as REMOVE+ADD pairs; rehydrating each REMOVE multiplied drain cost during bulk loads |
| 2.5 defaults: `SEARCH_STREAM_POLL_LIMIT=10000`, `SEARCH_STREAM_LEASE_TTL_SECONDS=120`, `GREMLIN_FTS_MAX_RESULTS=1000`, `SEARCH_STREAM_LAG_WARN_FRACTION` | Poll limit 100,000 (Neptune max), lease TTL 360 s (> the 300 s poller timeout), `GREMLIN_FTS_MAX_RESULTS=40000` with index `max_result_window=40000`; no lag-warn fraction variable (a fixed 1,800 s alarm instead) | Lease shorter than the invocation caused a `ConditionalCheckFailedException` livelock; 40k lets callers page realistic result sets |
| 7.5: `gremlin_fts_*`, `opensearch_documents_*`, `opensearch_stream_*`, `opensearch_backfill_*`, `opensearch_write_failures` metrics | Not emitted. The lag probe publishes `OpenSearchFtsStreamOldestUnprocessedRecordAgeSeconds` and `OpenSearchFtsStreamCommitBacklog`; everything else is structured logs | Probe-derived lag is the operational signal (`operations-dashboards-and-alerting.md`) |

## 3. Architecture

```
PersistSearchStack
  OpenSearch domain (VPC, 2.x engine)              SearchSyncStateTable (DynamoDB, PITR)
    4 x r6g.2xlarge data nodes, 2-AZ zone aware      pk="stream"  sk="checkpoint"   commitNum/opNum/lease/lastCommitTimestamp
    gp3 500 GiB, 12k IOPS, 500 MB/s per node         pk="mapping" sk="fingerprint"  fingerprint + canonical mappingJson
    encryption at rest, node-to-node, HTTPS only
    index "amazon_neptune": 4 shards, 0 replicas, refresh 30 s (client defaults), max_result_window 40000 (pinned)
    SG: 443 from LambdaSg + VPC CIDR (Neptune)     Maintenance bucket (14-day expiry): manifest, slabs, shards, summaries
    resource policy: account root -> IAM decides
                                                   SSM /persist/opensearch/{collection-endpoint,collection-arn,index-name,backfill-workflow-arn}

  PersistOpenSearchBackfillWorkflow (STANDARD, 12 h timeout)
    Prepare (15 min) ─ decode input, LATEST watermark, checkpointAction, [resetIndex: delete index + mapping registry],
      │                bootstrap mapping (additive check), write manifest.json, emit one label plan per selected label
      ▼
    PlanShardsPerLabel  Map(maxConcurrency 6) ── count label (or its OUT-vertex label) ── write slab files (250k offsets)
      ▼
    ExtractSlabs        Distributed Map over slabs/ ── one `range(a,b).id()` per slab ── exact-id shard files (shardSize ids)
      ▼
    IndexShards         Distributed Map over shards/ (maxConcurrency from input; retry States.TaskFailed x6, 30 s, x2, jitter)
      │                 shard worker (15 min, 2 GB): read by id or by adjacency, transform, bulk 1000, write summary
      ▼
    Finalize (5 min) ◄──┐ aggregate ≤500 summaries per invocation ── finalizeComplete? ──no──┘
      │ yes: write summary.json; INITIALIZE -> putCheckpoint(watermark) | PRESERVE -> log
      ▼ Succeed

  EventBridge Scheduler
    rate(1 min), DISABLED at deploy ──► OpenSearchStreamPoller (5 min, 4 GB, reserved concurrency 1)
                                          getCheckpoint ── acquireLease(360 s) ── loop: getAfter(limit 100k, halving on timeout)
                                          ── planFromStreamRecords ── bulkWithOutcomes ── rehydrate(404 / REMOVE) ── advanceCheckpoint
                                          ── stop on time_low (<15 s) | deadline_guard (5 s margin) | no_records | lease_lost
    rate(5 min) ──► OpenSearchStreamLagProbe (1 min) ── checkpoint vs first unprocessed record and LATEST ── 2 metrics

NeptuneStack
  the external (peered / cross-account) IAM DB-auth roles that may run Neptune#fts get es:ESHttp{Get,Post,Put,Head,Delete}
  on arn:<partition>:es:<region>:<account>:domain/<fts-domain-prefix>-* and /*; in-account handlers get es:ESHttp* on domain/* from the API stack

PersistStack (API)
  Gremlin handler: OPENSEARCH_COLLECTION_ENDPOINT from SSM, es:ESHttp* on domain/*, dynamodb:GetItem on the sync table
  GremlinFtsPolicyService.prepareQuery ── inject endpoint ── optional freshness gate ── reader submit
```

Placement rules: every search Lambda runs inside the VPC (it needs the Neptune reader, the Streams REST endpoint, and the domain) and receives both `SEARCH_*` and mirrored `INDEX_STREAM_*` variables because the stream client is shared with the derived-index poller. Neptune signs outbound `Neptune#fts` calls as the *connecting* IAM identity, so the grant lives on the caller's role, not on Neptune; VPC reachability alone is not authorization.

## 4. Contracts

### 4.1 FTS definition (`lambda/config/opensearch-fts-definition.json`)

```jsonc
{ "vertices": [{ "label": "person", "fields": ["id", "first_name", "last_name", "person_identifier", …] }, …],
  "edges":    [{ "label": "phone_call", "fields": ["status", "duration", "transcript_text", "effective_at", …] }, …] }
```

Resolution (cached 5 min) loads the canonical lexicon and the derived-index catalog and fails closed, whole definition, when: a label is not a lexicon vertex/edge type; a field is neither a canonical property of that label nor a derived index declared for it; or the same field name is selected under two labels with different mapping signatures (`format|type|enum?`). The resolved definition exposes `schemaByLabel` (per document type), `schemaByField` (per document type, so label-less `vp`/`ep` stream records resolve by field name), and `edgeSourceByLabel` (selected edge label -> lexicon `from` vertex label, used by backfill planning). Shipped scope: six vertex labels (person, contact vertices, address, debt, payment) and four edges (one interaction edge and three status-change edges).

### 4.2 Document and id

OpenSearch is a derived read index for Neptune full-text search, never an authority for graph state. Documents follow Neptune's documented model for Gremlin data:

```json
{
  "entity_id": "<vertex-or-edge-id>",
  "entity_type": ["<vertex-or-edge-label>"],
  "document_type": "vertex",
  "predicates": {
    "property_name": [{ "value": "property value" }]
  }
}
```

Indexing rules: only labels and fields named in the FTS definition (§4.1) are mirrored; `blob` properties are indexed as the persisted S3 URI string, never as raw blob text; server-managed `created_at`, hashed ids, and lexicon-derived index properties may be mirrored because callers can read them through Gremlin; non-string scalars are typed in the mapping (§4.3) so `Neptune#fts` can sort and filter on `predicates.<field>.value`, and sorting by a non-string field must use that `.value` suffix; the index is eventually consistent with Neptune, the lag is observable (§6), and FTS queries may fail closed on lag (§4.6).

`document_type` is `"vertex" | "edge"`, `entity_type` is the list of selected labels present on the element (multi-label vertices split on `::`), `predicates.<field>` is an array of `{ value }` and is omitted entirely when no selected field has a value. `_id` = element id. Value typing: `string` passes strings (numbers/booleans stringified); `blob` mirrors the S3 URI string only; `integer`/`number` accept numbers, safe bigints, and strictly numeric strings (legacy writers), else fail; `boolean` accepts only a boolean and silently drops any other value (no failure); `array` is unsupported; `format: date` normalizes to `YYYY-MM-DD` and `format: date-time` to a UTC ISO instant from ISO strings, JS `Date`, GraphSON `g:Date`/`g:Timestamp`, or stream `dataType: "Date"` epoch values, and **rejects bare epoch numbers and non-ISO strings** rather than guessing.

### 4.3 Index mapping

`dynamic: "strict"` at root and under `predicates`. `entity_id`, `entity_type`, `document_type` are `keyword` + `keyword` subfield. Per predicate `value`: `format: date` -> `date` (`strict_date`); `date-time` -> `date` (`strict_date_optional_time`); enum -> `keyword`; `string` -> `text`, except `id`, `*_id`, `*_identifier` -> `keyword`; `integer` -> `long`; `number` -> `double`; `boolean` -> `boolean`; `blob` -> `keyword`. Every string-backed value carries `fields.keyword` (`ignore_above: 256`). Field names are shared across labels in one flat mapping (hence the 4.1 conflict rule). Bootstrap: build mapping, compare its SHA-256 over canonicalized JSON with the registry; a changed fingerprint is allowed only if every previously mapped field is unchanged (additive), else `OpenSearchFtsMappingError`; then `PUT /<index>` with settings, or on `resource_already_exists` `PUT _settings` (result window) and `PUT _mapping`; persist the registry only when the fingerprint changed.

### 4.4 Sync-state items

```ts
{ pk: "stream", sk: "checkpoint", commitNum, opNum, updatedAt, lastCommitTimestamp?: epochSeconds,
  leaseOwner?, leaseExpiresAtEpochSeconds?, sourceExecutionArn? }          // no indexName / indexGeneration
{ pk: "mapping", sk: "fingerprint", fingerprint: sha256hex, mappingJson: string, updatedAt }
```

Operations and conditions are identical to the derived-index store (`derived-index-discovery-and-catchup.md` 3.7): `acquireLease` requires the item to exist and the lease to be absent, expired, or self-owned; `advanceCheckpoint` and `releaseLease` are conditioned on `leaseOwner = me`; `putCheckpoint` replaces the item; `deleteMappingState` exists for `resetIndex`. A `ConditionalCheckFailedException` nested in the wrapped error's `cause` must be recognized as `lease_held`, otherwise contention surfaces as a handler error.

### 4.5 Backfill input and artifacts

```ts
{ schemaVersion: "1", mode: "WRITE" | "DRY_RUN", executionId?, resumeExecutionId?, documentTypes?: ["vertex","edge"],
  labels?: string[] /* narrows the definition */, maxConcurrency?, shardSize?, resetIndex?: boolean,
  costCeilingUsd?, maxShards? /* accepted, unused */ }
```

Artifacts under `s3://<maintenance-bucket>/opensearch-backfill/<executionId>/`: `manifest.json` (the prepared input incl. `checkpointAction`, `streamWatermark`, `labelPlans`), `slabs/<type>-<label>-slab-<n>.json`, `shards/<type>-<label>-shard-<n>.json` (`ids`, optional `sourceVertexLabel`), `summaries/<type>-<label>-shard-<n>.json` (`documentsPlanned/Written/Skipped`, `validationFailures`, `dryRun`), `summaries/summary.json`. `resumeExecutionId` cannot be combined with `resetIndex`.

```ts
// summaries/summary.json
{
  schemaVersion: "1",
  executionId: string,
  mode: "WRITE" | "DRY_RUN",
  indexName: string,
  indexGeneration: string,              // = executionId
  streamWatermark?: { commitNum: number, opNum: number },
  documentTypes: Array<"vertex" | "edge">,
  labels?: string[],
  counters: { documentsPlanned: number, documentsWritten: number, documentsSkipped: number,
              validationFailures: number, sampleMismatches: number /* always 0 */ },
  startedAt: ISO8601 UTC,
  finishedAt: ISO8601 UTC
}
```

### 4.6 Gremlin FTS policy

`POST /persist/gremlin` (PRD 4.1) rejects every bare `sideEffect(...)` step and every parseable `withSideEffect(...)` except the `Neptune#fts.*` hints below. Allowed keys:

- `Neptune#fts.endpoint` — injected by Persist from `OPENSEARCH_COLLECTION_ENDPOINT` when absent. If supplied by the caller it must exactly match the configured endpoint and `GREMLIN_FTS_ALLOW_CALLER_ENDPOINT` must be true; production keeps this false.
- `Neptune#fts.queryType` — must be in `GREMLIN_FTS_ALLOWED_QUERY_TYPES`; defaults to `GREMLIN_FTS_DEFAULT_QUERY_TYPE`.
- `Neptune#fts.maxResults` and `Neptune#fts.batchSize` — integers in `1..GREMLIN_FTS_MAX_RESULTS`.
- `Neptune#fts.minScore` — non-negative number.
- `Neptune#fts.sortBy` — any non-empty string (property names are not validated against the lexicon); non-string sort fields must use Neptune's `.value` suffix.
- `Neptune#fts.sortOrder` — `ASC` or `DESC`, case-insensitive.
- `Neptune#noReordering` — optional boolean hint for the rare case where the caller needs Neptune to preserve traversal order around FTS.

Any other `withSideEffect` key, any bare `sideEffect(...)` step, or a caller-supplied endpoint that fails validation returns `GremlinFtsPolicyError` (400) before the query reaches Neptune. Example:

```gremlin
g.withSideEffect("Neptune#fts.queryType", "match")
 .V()
 .has("company_name", "Neptune#fts acme")
 .limit(25)
```

Response: the PRD 4.1 envelope plus `fts?: { used: boolean, indexName?: string, syncLagSeconds?: number }`. Error tags and HTTP status, sharing the PRD 3.6 mapping:

| HTTP | Tag(s) |
| --- | --- |
| 400 | `GremlinFtsPolicyError` |
| 500 | `OpenSearchSyncStateError` |
| 503 | `OpenSearchIndexUnavailable`, `OpenSearchIndexLagExceeded`, `OpenSearchSyncCheckpointMissing` |

Implementation precisions: the policy runs only when the query contains `Neptune#fts` or any `.withSideEffect(`; a bare `sideEffect(` step anywhere is rejected first; `withSideEffect` without the FTS token is rejected as an unsupported key when its key parses as a quoted literal (an unparseable `withSideEffect` with no FTS token passes through untouched; with the token it fails "Unable to parse"); the endpoint is injected by rewriting the leading `g.` (a query not starting with `g.` cannot be injected and is rejected); `maxResults`/`batchSize` are integers in `1..40000`; a missing endpoint configuration fails with `OpenSearchIndexUnavailable`, not a policy error. With `SEARCH_FRESHNESS_MAX_LAG_SECONDS` set (the API stack sets 300 when the sync table is wired in), lag is `now - checkpoint.lastCommitTimestamp` in seconds; a missing checkpoint is `OpenSearchSyncCheckpointMissing`. The poller advances `lastCommitTimestamp` to *now* on an idle stream so a quiet graph does not trip the gate.

### 4.7 Environment and IAM (generalized)

| Component | Env vars (CDK pin / code default) | IAM |
|---|---|---|
| All search Lambdas | Pinned: `OPENSEARCH_COLLECTION_ENDPOINT`, `OPENSEARCH_COLLECTION_ARN`, `OPENSEARCH_INDEX_NAME` (`amazon_neptune`), `OPENSEARCH_INDEX_MAX_RESULT_WINDOW` (40000 / 40000), `SEARCH_SYNC_STATE_TABLE_NAME`, `LEXICON_DATA_URI`, `NEPTUNE_HOST`/`NEPTUNE_WRITER_HOST`/`NEPTUNE_READER_HOST`/`NEPTUNE_PORT`. Code default only, not pinned: `OPENSEARCH_INDEX_SHARDS` (4), `OPENSEARCH_INDEX_REPLICAS` (0), `OPENSEARCH_REQUEST_TIMEOUT_MS` (30000), `OPENSEARCH_BULK_MAX_ATTEMPTS` (6), `OPENSEARCH_BULK_RETRY_BASE_MS` (1000) | `neptune-db:connect`, `ReadDataViaQuery`, `GetStreamRecords` on the cluster; `es:ESHttp*` on the domain and `/*`; sync table read/write; maintenance bucket read/write; `s3:GetObject` on any object (lexicon read) |
| Backfill | Pinned: `OPENSEARCH_MAINTENANCE_BUCKET`, `OPENSEARCH_BACKFILL_PREFIX` (`opensearch-backfill`), `SEARCH_BACKFILL_SHARD_SIZE` (1000 / 2000), `SEARCH_BACKFILL_MAX_CONCURRENCY` (20 / 20), `SEARCH_BACKFILL_MAX_SHARDS` (200 / 200, read into config and unused). Code default only: `SEARCH_BACKFILL_SLAB_SIZE` (250000), `SEARCH_BACKFILL_FINALIZE_PAGE_SIZE` (500) | state machine: bucket read/write, `s3:ListBucket` for the item readers |
| Poller | Pinned: `SEARCH_STREAM_POLL_LIMIT` (100000; no code reads it directly, it is mirrored into `INDEX_STREAM_POLL_LIMIT` for the shared stream client, code default 100000), `SEARCH_STREAM_LEASE_TTL_SECONDS` (360 / 120; also mirrored into `INDEX_STREAM_LEASE_TTL_SECONDS`), `SEARCH_STREAM_MIN_REMAINING_MS` (15000 / 15000), `SEARCH_STREAM_MAX_LOOPS_PER_INVOCATION` (100000 / 100000), `SEARCH_STREAM_MAX_TRANSACTIONS_PER_POLL` (250, read by no code). Code default only: `INDEX_STREAM_REQUEST_TIMEOUT_MS` (30000) | as above |
| API Gremlin handler | `OPENSEARCH_COLLECTION_ENDPOINT`, `OPENSEARCH_COLLECTION_ARN`, `OPENSEARCH_INDEX_NAME` (`amazon_neptune`), `GREMLIN_FTS_ALLOWED_QUERY_TYPES` (`simple_query_string,match,prefix,fuzzy,term,query_string`), `GREMLIN_FTS_DEFAULT_QUERY_TYPE` (`simple_query_string`), `GREMLIN_FTS_MAX_RESULTS` (40000), `GREMLIN_FTS_ALLOW_CALLER_ENDPOINT` (`false`), `SEARCH_SYNC_STATE_TABLE_NAME`, `SEARCH_FRESHNESS_MAX_LAG_SECONDS` (300, optional; set together with the sync table name) | `es:ESHttp*` on `domain/*`; `dynamodb:GetItem` on the sync table (when the table is wired in) |
| External DB-auth roles | — | `es:ESHttpGet/Post/Put/Head/Delete` on `domain/<fts-domain-prefix>-*` |

## 5. Runtime behaviour

### 5.1 Backfill planning, slabs, and dense edges

1. **Prepare** reads the LATEST watermark (or the resumed manifest's), resolves `checkpointAction` (2: `resetIndex` + full scope -> `INITIALIZE`; existing checkpoint -> `PRESERVE`; no checkpoint + full scope -> `INITIALIZE`; anything else fails; `DRY_RUN` is treated as having a checkpoint, so a scoped dry run never fails closed), in WRITE mode optionally deletes index and registry, bootstraps the mapping, then emits one label plan per `(documentType, label)` in scope. Edge plans carry `sourceVertexLabel`.
2. **Plan per label** counts `g.V().hasLabel(L).count()` for vertices, or the OUT-vertex label for edges, and writes slabs of 250,000 offsets covering the full count. There is no shard budget; the count is the plan.
3. **Extract slab** runs exactly one `…range(a, b).id()` per slab (one deep offset skip each, linear total) and writes exact-id shard files of `shardSize` ids with globally disjoint `shardIndex` (`firstShardIndex + offset`).
4. **Index shard** skips itself if a summary for the same `executionId` exists (resume). Vertex/exact shards read `g.V(ids…).project(id,label,valueMap)` in batches of 500, concurrency 2. Edge-by-source shards read `g.V(sources…).outE(L).range(o, o+2000)` for 100 sources at a time, paging until a short page: each edge is reachable from exactly one OUT vertex, so adjacency covers every edge once without a global edge scan. Rows are transformed (concurrency 16) and bulk-written in batches of 1,000 **per page**, never buffered per shard; a dense source batch can carry very many edges. Non-transformable legacy elements (and, on exact-id shards, ids missing from Neptune) are logged and counted as `validationFailures`; they do not abort the shard.
5. **Finalize** aggregates up to 500 summaries per invocation and loops through a `Choice` until complete, then writes the summary and applies the checkpoint action. `DRY_RUN` reads and transforms but never writes documents, registry, or checkpoint (the manifest and per-shard summaries are still written).
6. **Resume** (`resumeExecutionId`) reuses the manifest, watermark, and checkpoint action verbatim, deletes `slabs/` (empty slab map), emits no label plans (no recount), and lets the shard map walk the existing shard files. Re-planning is forbidden: graph writes since the original run shift offsets and would desync shard files from completed summaries. Operators can also hand-write executionId-scoped shard files for targeted repairs.

### 5.2 Poller loop, time-bounding, and lease

- Fail closed with `OpenSearchSyncCheckpointMissing` when no checkpoint exists. Acquire the 360 s lease; `lease_held` returns success with zero work.
- Per iteration: stop if remaining time < 15 s (`time_low`) or the loop budget is hit (`loop_budget`, an emergency brake only); renew the lease (loss -> `lease_lost`, no release); fetch a page with `AFTER_SEQUENCE_NUMBER` at limit 100,000, halving the limit down to a 5,000 floor on fetch timeouts and restoring it next call; plan, write, advance the checkpoint to the last processed record's event id without releasing the lease; repeat. The whole iteration runs under a `remaining - 5 s` timeout so a slow in-flight fetch or bulk cannot hit the hard Lambda timeout and abandon a held lease (`deadline_guard`).
- An empty page (`no_records`) advances `lastCommitTimestamp` to now with the same watermark, then stops. The lease is released in `onExit` on every path except `lease_lost`.
- Reserved concurrency 1 serializes invocations: after a pause, the scheduler backlog would otherwise fire concurrent polls that steal each other's lease and livelock on `advanceCheckpoint` conditions.

### 5.3 Drain during CSV bulk loads and mass deletes

- `pageForProcessing` cuts the page at the last `isLastOp`; if none exists (a bulk-load commit larger than a page) it processes the partial transaction. This is safe because every planned operation is an idempotent full-document index, an idempotent delete, or a patch whose 404 path repairs the document.
- Neptune `vp`/`ep` records carry no label, and field names such as `created_at`, `status`, `effective_at`, `id` are selected on several labels. The planner first builds a per-page `(documentType, id) -> {labels, addedLabels, removedLabels}` map from **all** `vl`/`e` records. An entity whose in-page ADD labels include no selected label is out of scope: its property records are dropped without an update or rehydration. An edge with only an out-of-scope REMOVE label is likewise definitive (edges have one label); a vertex REMOVE label is not (another selected label may remain), so that path stays conservative. Property-only pages with no in-page label keep the safe `update -> 404 -> rehydrate` path.

### 5.4 Plan semantics per record

| Record | Plan |
|---|---|
| ADD label, selected | Collect subsequent in-page property ADDs into a full `index` document (also when properties precede the label) |
| ADD property, selected field, entity not being created | Partial `update` merging into any existing update for the entity |
| REMOVE property, selected field | If the page-final op for `(entity, field)` is ADD: drop the REMOVE (coalesced), keep the ADD's update. Otherwise queue a defensive rehydration (`derived_property_removed`) which supersedes partial updates |
| REMOVE label, selected | Idempotent `delete`; cancels pending rehydration for the entity |
| Any record, entity proven out of scope in-page | Dropped; a REMOVE of a selected property is counted as `rehydrationsSuppressedByRemoveLabel` when a REMOVE label did the proving (dropped ADD-property records are not counted) |
| Unselected field | Ignored |

Coalescing is counted (`rehydrationsCoalesced`) only when no full index or delete already supersedes the pair, and a page-final ADD that yields no usable update falls back to rehydration.

### 5.5 Rehydration and bulk acknowledgement

- After the page bulk, `update` failures with 404/`document_missing` become `document_missing` rehydration requests; `delete` 404s are success; any other item failure fails the page (checkpoint unchanged). Rehydration reads Neptune in exact-id batches of 500 per document type through the pooled reader, re-indexes the full document, and **skips** entities that vanished or whose label is out of scope (logged with five samples) instead of wedging the checkpoint.
- Bulk HTTP 200 is transport success only. Before a page may advance, the response must carry a boolean top-level `errors`, exactly one item per submitted operation in order, each with the same action and `_id` and an integer status; `errors: true` with no identifiable failed item is also a failure. Any gap fails the page so it replays. This closed a silent loss where complete, fully planned status-event edges were missing from the mirror while the checkpoint had moved on.
- Client retries: request-level 429/502/503, timeouts, and aborted sockets, and item-level 429/502/503 or circuit-breaker/throttle reasons, retry only the failed subset up to 6 attempts with exponential backoff (1 s base, 30 s cap, jittered to 50-100% of the exponential delay; the Step Functions shard retry is the one with full jitter). Permanent item failures stop retrying immediately.

### 5.6 Failure modes

| Situation | Behaviour |
|---|---|
| Checkpoint missing | Poller and freshness gate fail closed (`OpenSearchSyncCheckpointMissing`); only a full-scope backfill writes a new watermark (`resetIndex`, or a first run when no checkpoint exists) |
| Checkpoint aged out of stream retention | Undetected, exactly as for the derived-index poller (`derived-index-maintenance.md` 5.6): the shared stream client maps the end-of-stream 404 to an empty page, the poller stops on `no_records` and advances `lastCommitTimestamp` to now, so the freshness gate stays open; detect it as `OpenSearchFtsStreamCommitBacklog` growing while the age metric stays `0`, then run a full-scope `resetIndex` backfill |
| Domain saturated by a concurrent backfill | Bulk retries, then page failure and replay; lower backfill `maxConcurrency` (stack default `SEARCH_BACKFILL_MAX_CONCURRENCY`, 20) while the poller is live, keep the lease TTL above the poller timeout |
| Shard worker failure | Step Functions retries the idempotent shard 6 times; a still-failing shard fails the map; redrive with `resumeExecutionId` |
| Incompatible mapping change | Prepare fails; either revert the definition or run a full-scope `resetIndex` |
| Checkpoint fast-forwarded past unmirrored commits | Vertices can be repaired by any later backfill; edges created in the window and attached to already-read sources are lost by both paths unless adjacency is re-read after the window; use a targeted resume (7) |

## 6. Observability and alarms (deltas only)

- Metrics, namespace `persist`, dimension `service=persist-opensearch-fts`: `OpenSearchFtsStreamOldestUnprocessedRecordAgeSeconds` and `OpenSearchFtsStreamCommitBacklog`, emitted every 5 minutes by the lag probe (it reads one page after the checkpoint and the LATEST watermark); nothing is emitted before the first backfill (`checkpoint_missing` is logged, not errored).
- Alarms in the search stack, visibility-only: poller Lambda errors `>= 1` (1 min), backfill `ExecutionsFailed >= 1`, stream lag `>= 1800 s` for 2 of 2 five-minute periods. Paging wiring, the shared indexing dashboard, and probe semantics are in `operations-dashboards-and-alerting.md`.
- The poller logs one structured "poll complete" record with `recordsRead`, `operationsWritten`, `documentsRepaired`, `removalDrivenRebuilds`, `missingDocumentRepairs`, `rehydrationsSkipped`, `rehydrationsCoalesced`, `rehydrationsSuppressedByRemoveLabel`, `loops`, `partialTransactionPages`, `checkpointAdvanced`, `stopReason`. A sustained `deadline_guard`/`time_low` with backlog growth means the domain or Neptune reader is the bottleneck, not the poller; `lease_held` on every tick means a stuck lease (7). Backfill logs "Planned … slabs for label" with `entityCount` and "Extracted … slab ids"; use them to prove coverage.
- Search slow logs on the domain are the only way to see the queries Neptune compiles; the stack does not configure domain logging, so enable them on the domain manually when validating new mapped fields.

## 7. Operations and runbook

1. **Deploy**: search stack before the API stack (SSM handoff). Confirm outputs: endpoint, collection ARN, index name, sync table, backfill workflow ARN, three alarm ARNs. The poller schedule deploys `DISABLED`; keep it so until the initial backfill finalizes.
2. **Initial backfill**: start the workflow with `{ schemaVersion: "1", mode: "WRITE" }` (optionally `DRY_RUN` first). Labels come from the definition. Use `resetIndex: true` only for an explicit fresh rebuild. Watch prepare, per-label planning, slab extraction, shard indexing, then the finalize loop until `finalizeComplete`. Confirm the mapping registry item exists and the checkpoint was initialized (first run) or preserved (additive run).
3. **Enable sync**: enable the poller schedule; watch FTS time lag and commit backlog fall to zero or a stable baseline. Derived-index lag clears first, FTS lag second, because FTS patches follow derived writes through the stream.
4. **Query validation** through `/persist/gremlin` only: text search on selected text fields; `date`/`date-time` ranges via `predicates.<field>.value` query-string syntax; numeric filter and sort on selected balance/amount fields; exact identifier lookups; status-event edge searches ordered by effective time with current-state selection done in Gremlin; `Neptune#fts.sortBy`/`sortOrder` on typed fields; FTS narrows, Gremlin traverses.
5. **Synthetic inserts**: ingest a uniquely namespaced in-scope element and confirm it appears after lag clears; trigger a selected derived-index change on an existing mirrored owner and confirm the document is patched without a backfill. Never delete synthetic data from the graph; namespace it.
6. **Exit criteria**: backfill succeeded; poller advances from the initialized/preserved checkpoint; dashboard shows lag and backlog; existing data, synthetic insert, and synthetic patch all return through FTS; no mapping incompatibility errors.
7. **Add a field or label**: edit the definition, deploy, run a backfill scoped with `labels` to the affected labels (`PRESERVE` is automatic). The mapping is added first; the poller patches existing documents from the derived-index rebuild's stream records.
8. **Reindex from scratch / stale checkpoint**: disable the poller, run full-scope `WRITE` with `resetIndex: true`, wait for finalize, re-enable. A backfill that finds an existing checkpoint never moves it unless `resetIndex` is set.
9. **Resume a failed run**: rerun with `resumeExecutionId: "<executionId>"` and the same mode; completed shards are skipped. To repair a known window, enumerate affected source vertices (for example by indexed hourly `effective_at` windows), write shard files under that execution's `shards/` prefix with `sourceVertexLabel`, and resume with `checkpointAction` preserved, without pausing the poller. Gate any repair on lag below five minutes so parity measurements are stable.
10. **Replace the domain**: deploy the search stack with the new domain (SSM updates), full-scope `resetIndex` backfill, then deploy the API stack so handlers pick up the endpoint. Domain sizing is context-driven (`searchInstanceType`, `searchInstanceCount`, `searchVolumeGib`, `searchVolumeIops`, `searchVolumeThroughput`); node count must be a multiple of the 2-AZ zone awareness.
11. **Query failures**: inspect the Gremlin router and poller logs for `requestId`, `indexName`, `queryType`, and sync lag. A 403-like failure on FTS queries while plain Gremlin succeeds means the caller's IAM role lacks the `es:ESHttp*` grant on the domain (§3); a `match_none`/zero-result query on a field that has data means a missing `.keyword` subfield (§4.3), visible only in search slow logs.
12. **Stuck lease**: with reserved concurrency 1 this is rare; if `lease_held` persists past the TTL with no running invocation, remove `leaseOwner`/`leaseExpiresAtEpochSeconds` from the checkpoint item.

## 8. Verification and acceptance criteria

- Definition tests: unknown field fails closed; conflicting schemas across labels fail closed; derived-index fields for the selected label resolve; the packaged definition covers the intended status-event labels.
- Mapping tests: explicit mapping from lexicon type/format; stable fingerprint that changes only with the selected mapping; additive change persists a new registry; unchanged fingerprint still reapplies index settings.
- Client tests: create sets `max_result_window` 40,000 and an existing index gets `_settings` before `_mapping`; bulk fails closed on a missing acknowledgement, wrong action, wrong id, missing `errors` flag, or `errors` without an identifiable item; complete ordered acknowledgements for update and delete pass.
- Transform/planner tests: typed documents; out-of-scope labels yield no document; non-ISO temporal and bare epoch values fail; numeric strings coerce; creation transactions (including property-before-label order and a full status-event burst) plan complete `index` operations; in-page out-of-scope label+property records produce no ops; unknown-label property pages still update; split-page out-of-scope label falls back safely; derived-index patches to in-scope owners are never dropped; multi-label vertices with any selected label stay in scope; REMOVE+ADD pairs coalesce per entity and property (vertex and edge), are not counted when superseded, and a lone/final REMOVE still rehydrates once; in-scope label removes plan idempotent deletes that supersede rehydration; out-of-scope edge REMOVE labels suppress rehydration without being attributed to earlier ADD-label suppression.
- Poller tests: rehydration batches ids into one query per document type and preserves mixed outcomes; delete-not-found is success; empty id batches are rejected (never a full-graph traversal); a slow fetch stops at the deadline guard and releases the lease; a timed-out page halves and restores the limit.
- Backfill tests: checkpoint action matrix (scoped preserve; scoped write without checkpoint fails; scoped reset fails; first full scope initializes; full reset reinitializes; legacy manifests default to initialize); full-definition coverage detection; label narrowing per document type; slabs cover the full count with disjoint shard ranges; edge slabs carry `sourceVertexLabel`.
- Checkpoint store tests: `ConditionalCheckFailedException` detected top-level and nested in `cause`.
- CDK assertions: VPC-resident managed domain with the codified shape; checkpoint table, poller, probe, and workflow present; poller 4 GB with reserved concurrency 1 and lease TTL > timeout; prepare timeout long enough to bootstrap and plan; per-label map and finalize loop; VPC CIDR and Lambda SG ingress on 443; lexicon read grant; stack outputs (the SSM parameters are not asserted); external DB-auth roles hold the five `es:ESHttp*` actions on the FTS domain pattern (the API handler's `es:ESHttp*` on `domain/*` is not asserted).
- Release validation in a deployed environment: (1) run the backfill in `DRY_RUN`, then `WRITE`, and confirm the summary reports written documents and `finalizeComplete`; (2) submit a signed `Neptune#fts` query through `POST /persist/gremlin`, confirm the endpoint is injected, expected ids return, and `fts.used=true`; (3) ingest a graph fact with a mirrored property, wait for the poller, and confirm the same query returns it and stream lag is below one poll interval; (4) submit a query with an unsafe `withSideEffect` or a caller-supplied endpoint and confirm `GremlinFtsPolicyError` without reaching Neptune; (5) in non-prod, mark the sync checkpoint stale and confirm FTS queries fail with `OpenSearchIndexLagExceeded` while plain Gremlin reads and ingest still succeed.
- OpenSearch outages or lag never block GraphSON ingest, CSV ingest, derived-index maintenance, or non-FTS Gremlin reads; a missing checkpoint fails FTS closed and requires a rebuild rather than silently starting from `LATEST`; a retention-expired checkpoint is the undetected trim gap in 5.6 and is repaired the same way.
- Acceptance: after a full-scope backfill and an enabled poller, an FTS query for a namespaced synthetic insert returns it within a few poll intervals; a derived-index change patches the existing document without a backfill; a scoped backfill leaves the checkpoint untouched; a bulk-load day drains without the poller stalling on partial transactions or rehydration storms; a bulk response with a missing acknowledgement never advances the checkpoint.

## 9. Design decisions

- **ADR 0006, managed domain, not Serverless**: the same documents and queries returned results on a domain and nothing on a collection; the eventual root cause (missing `.keyword` subfields, section 4.3) was only diagnosable through search slow logs, which Serverless lacks. The domain also avoids indexing-capacity throttling during backfills. The client keeps `aoss` signing by hostname so the decision is reversible.
- **Direct index, no alias**: Neptune FTS can return wrong results through an alias. Index name is fixed at `amazon_neptune`.
- **Code-owned opt-in definition**: fails closed on lexicon drift, keeps the FTS surface reviewable, and leaves a seam for a lexicon-owned definition later. Shared field names must map identically because the mapping is flat and stream property records are label-less.
- **Explicit strict mapping with additive registry**: adding a derived index should not force a full-index backfill; the mapping is added first and the independent stream reader patches documents. Identifier-like strings are `keyword` because once selected the fingerprint guard would freeze a wrong `text` mapping.
- **ISO-only temporal values**: guessing epoch units silently corrupts date ranges; fail before write instead.
- **Count/slab/shard backfill with adjacency for edges**: offset pagination is quadratic and the largest edge label cannot even be counted within a Lambda, but its OUT-vertex label can; adjacency reads cover each edge once. Streaming transform+bulk per page keeps shard memory constant for dense sources. Finalize loops because a single Lambda cannot read every summary.
- **Global checkpoint with explicit action**: snapshot/restore of the cursor around scoped backfills was rejected; scoped runs preserve, full-scope runs initialize, everything ambiguous fails closed.
- **Resume without re-planning**: offset drift would desync shard files from completed summaries; reuse artifacts verbatim and skip by summary presence.
- **Time-bound poller, count knobs as emergency brakes**: a fixed loop budget silently became the binding limit once per-page cost dropped; wall clock, per-loop lease renewal, and a deadline guard are the real limits. Lease TTL must exceed the invocation timeout, and reserved concurrency 1 prevents scheduler-backlog livelock.
- **Partial-transaction pages**: prefix-only paging deadlocks on bulk-load commits larger than a page; every mirror operation converges under replay or split.
- **Page-local label learning and REMOVE/ADD coalescing**: single-cardinality writes appear as REMOVE+ADD pairs, and unselected labels share field names; without both, drain fell behind real time with most writes being redundant rebuilds, and mass deletes of an unselected edge label produced whole pages of unpaired REMOVEs. Vertex REMOVE labels stay conservative because multi-label vertices can keep a selected label.
- **Acknowledgement barrier**: HTTP 200 with an incomplete item list must not advance the cursor; proving one ordered acknowledgement per operation is cheaper than any parity audit.
- **Eventual consistency, no double gate**: the mirror trails the derived-index pipeline by design; expose lag and alarm on it, optionally gate freshness against a single threshold, but never block FTS on both pollers being current.

## 10. Source map (persist repo, relative paths)

| Path | Responsibility |
|---|---|
| `lib/persist-search-stack.ts` | Domain, security group, sync table, maintenance bucket, seven Lambdas, backfill state machine, schedules, alarms, SSM parameters, outputs |
| `lib/persist-stack.ts` | SSM endpoint read, FTS env block, `es:ESHttp*` and sync-table grants for Gremlin handlers |
| `lib/neptune-stack.ts` | `es:ESHttp*` grants on the FTS domain pattern for IAM DB-auth roles (including peered accounts) |
| `lib/indexing-dashboard-stack.ts` | FTS lag and backlog widgets |
| `lambda/config/opensearch.ts` | Gremlin-side FTS config (`GREMLIN_FTS_*`, freshness, sync table) |
| `lambda/config/opensearch-fts-definition.json` | Opt-in labels and fields |
| `lambda/schemas/opensearch-fts.ts` | Definition, document, bulk operation/outcome, checkpoint, backfill input/plan/slab/shard/summary schemas |
| `lambda/services/FtsDefinitionService.ts` | Definition decode, lexicon/catalog resolution, conflict rule, `edgeSourceByLabel`, 5-minute cache |
| `lambda/services/OpenSearchMappingService.ts` | Mapping generation, fingerprint, additive check, bootstrap |
| `lambda/services/OpenSearchClientService.ts` | SigV4 (`es`/`aoss`), bulk with retry and acknowledgement validation, index create/settings/mapping/delete |
| `lambda/services/OpenSearchDocumentTransformService.ts` | Typed value conversion, document build, stream page planner (scope learning, coalescing, suppression) |
| `lambda/services/OpenSearchCheckpointStoreService.ts` | `pk="stream"` checkpoint and `pk="mapping"` registry operations, condition-failure detection |
| `lambda/services/OpenSearchBackfillService.ts` | Prepare, plan-label, slab extraction, shard processing, finalize, checkpoint-action rules |
| `lambda/services/OpenSearchStreamPollerService.ts` | Poll loop, time and deadline guards, lease lifecycle, page processing, rehydration |
| `lambda/services/OpenSearchStreamLagProbeService.ts`, `lambda/opensearch-stream-lag-probe/handler.ts` | Lag and backlog measurement and metric emission |
| `lambda/services/IndexStreamClientService.ts` | Shared Streams client: `LATEST`, `AFTER_SEQUENCE_NUMBER`, timeout page halving |
| `lambda/services/GremlinFtsPolicyService.ts`, `lambda/services/GremlinService.ts` | `Neptune#fts` side-effect policy, endpoint injection, freshness gate, `fts` response block |
| `lambda/utils/gremlinEntity.ts` | `project(id,label,valueMap)` projection shared by backfill and poller; the exact-id read query used by the poller (backfill builds its own) |
| `lambda/opensearch-backfill-{prepare,plan-label,slab-worker,shard-worker,finalize}/handler.ts`, `lambda/opensearch-stream-poller/handler.ts` | Thin handlers |
| `lambda/index-stream-lag-probe/metrics.ts` | Metric and dimension names |
| `docs/adr/0006-opensearch-fts-mirror.md`, `docs/opensearch-fts-dev-validation.md` | Decision record and validation runbook condensed in sections 7 and 9 |
| `test/services/FtsDefinitionService.test.ts`, `OpenSearchMappingService.test.ts`, `OpenSearchClientService.test.ts`, `OpenSearchDocumentTransformService.test.ts`, `OpenSearchStreamPollerService.test.ts`, `OpenSearchBackfillService.test.ts`, `OpenSearchCheckpointStoreService.test.ts`, `GremlinFtsPolicyService.test.ts`, `test/cdk/persist-search-stack.test.ts` | Behaviour the acceptance criteria in section 8 are drawn from |
