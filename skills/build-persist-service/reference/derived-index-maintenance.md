# Derived Index Maintenance Core

This reference is the code-derived contract for how Persist materialises and maintains the lexicon's derived `indexes`: the index rule and catalog shapes, the idempotent index writer, the `PersistIndexRebuildWorkflow` state machine exactly as deployed, and the Neptune Streams incremental indexer (`IndexStreamPoller`) with its checkpoint semantics. It replaces the PRD's 3.3 `indexes` paragraph, 5.6/5.6.1/5.6.2, 6.6, the index rows of the compute table, the `INDEX_*` environment rows, and the index runbook and smoke steps; treat those PRD sections as superseded.

Split with `derived-index-discovery-and-catchup.md`: that file owns the control plane *around* these mechanisms: the hourly discovery poller, the `pk="index"` definition state store and fingerprints, the `REBUILDING -> ACTIVE / FAILED` claim lifecycle, sparse (trigger-first) enumeration internals, direct owner resolution rationale (ADR 0003/0005/0007/0008), the checkpoint store operation table, and the CSV-workflow catch-up barrier. This file owns the data contracts, the writer, the rebuild data path, and the stream poller loop. Alarms and dashboards are in `operations-dashboards-and-alerting.md`; consumers of the materialised values are `opensearch-fts-mirror.md` and `athena-debt-index-export.md`; the ingest-side rejection codes are detailed in `graphson-ingest-contract.md`; the full environment table is in `stacks-configuration-and-iam.md`.

## 1. Scope and non-goals

In scope:

- The `indexes` rule shape a lexicon may declare and the `IndexCatalogEntry` it compiles to, including the runtime-only `ownerDiscoveryQuery`.
- Rejection of caller-supplied index properties at every ingest boundary.
- The index writer: single-cardinality idempotent writes, null-as-remove, value validation, batching and concurrency knobs, and the IAM this implies.
- `PersistIndexRebuildWorkflow`: states, input, artifacts, result schemas, Lambda sizing, failure rule.
- `IndexStreamPoller`: schedule, lease, per-invocation limits, trigger matching, owner resolution lanes, `on_remove` handling, checkpoint semantics and their known gap.
- The shared `services/neptune-stream/` polling core, the checkpoint item schema, emitted metrics, IAM, runbook items, and acceptance criteria.

Non-goals: discovery scheduling and definition state (sibling file), sparse candidate query construction beyond what the rebuild input needs (sibling file), alarm thresholds (ops file), and the OpenSearch stream consumer, which reuses the polling core but has its own checkpoint and reference file.

## 2. Lexicon index contract and catalog

### 2.1 Index rule (`lambda/schemas/lexicon.ts`)

An index lives under `vertices[].indexes.<index_name>` or `edges[].indexes.<index_name>`. The rule base is a struct extended with a pass-through record, so unknown keys are tolerated and ignored.

```jsonc
"<index_name>": {
  "type": "string" | "integer" | "number" | "boolean",          // required; array/blob are NOT index types
  "enum": ["a", 1, true],                                        // optional; mixed scalars (string|number|boolean)
  "format": "date", "pattern": "^…$", "minLength": 1,           // optional string validators
  "items": { "type": "…" },                                      // optional; accepted for schema symmetry, unused by the writer
  "comment": "free text",                                        // optional; never enters the fingerprint
  "change_trigger": {                                            // required
    "type": "vertex" | "edge", "label": "…",
    "when": [{ "property": "…", "operator": "eq", "value": "…" | 1 | true }]   // optional NonEmptyArray, ANDed
  },
  "additional_change_triggers": [                                // optional NonEmptyArray
    { "type": "…", "label": "…", "when": [...], "subject_query": { "gremlin": "g.E(__ID__)….id()" } }
  ],
  "absent_value": { "value": "…" | 0 | false },                  // optional reader semantic for a missing property
  "sparse_rebuild": {                                            // optional; opt-in trigger-first rebuild
    "candidates": [{ "source": "change_trigger" }, { "source": "existing_non_default" }],   // NonEmptyArray
    "range_size": 0, "batch_file_owner_ids": 0, "owner_query_batch_size": 0, "max_candidate_elements": 0
  },
  "on_remove": { "recompute_owner": true },                      // optional; literal true only
  "subject_query": { "gremlin": "g.E(__ID__).outV().id()" },     // required: trigger element -> owner id
  "value_query":   { "gremlin": "g.E(__ID__).outV().…" }         // required: owner-rooted value read
}
```

Rules enforced when the catalog loads (`IndexCatalogService.getCatalog`, in order: change triggers, absent values, sparse rebuilds, `on_remove`, owner-rootability). Any failure is a `DerivedIndexCatalogError` for the whole catalog; prepare, the poller, and discovery all refuse to run on it. The individual validations are listed in the sibling file section 3.4; the one this file depends on most is owner-rootability: `value_query` must start with `subject_query` minus its trailing `.id()`, so the writer can re-root the value read at the owner.

### 2.2 `IndexCatalogEntry` (`lambda/schemas/derived-index.ts`)

```ts
{
  ownerType: string, ownerKind: "vertex" | "edge", indexName: string,
  valueSchema: { type: "string"|"integer"|"number"|"boolean", enum?: (string|number|boolean)[], format?: string, pattern?: string, minLength?: number },
  changeTrigger: { type: "vertex"|"edge", label: string, when?: NonEmptyArray<{ property: string, operator: "eq", value: string|number|boolean }> },
  additionalChangeTriggers?: NonEmptyArray<{ type, label, when?, subjectQuery?: { gremlin } }>,
  absentValue?: { value: string|number|boolean },
  sparseRebuild?: { candidates: NonEmptyArray<{ source: "change_trigger"|"existing_non_default" }>, rangeSize?, batchFileOwnerIds?, ownerQueryBatchSize?, maxCandidateElements? },
  onRemove?: { recomputeOwner: true },
  subjectQuery: { gremlin: string },
  ownerDiscoveryQuery?: { gremlin: string },   // runtime-only, see below
  valueQuery: { gremlin: string }
}
```

`items` and `comment` are dropped at compile time. `ownerDiscoveryQuery` is never declared in the lexicon and never fingerprinted: when a multi-trigger index is expanded into one single-trigger view per trigger for stream planning (`buildTriggerLookup`), each view carries its own trigger as `changeTrigger` and, if that trigger's subject differs from the index's canonical `subjectQuery`, the trigger's traversal as `ownerDiscoveryQuery`. `subjectQuery` stays canonical because `valueQuery` is rooted at it. The catalog is the ordered list of entries built from vertices first, then edges, in lexicon order; `getSelected([{ owner_type, index_name }])` fails with "Selected derived index is not declared in the lexicon" for any unknown selection.

### 2.3 Server-managed property rejection at ingest boundaries

Index names are server-managed on their owner label. Every ingest boundary rejects a caller-supplied value:

- GraphSON (sync and async): `GraphSONSemanticValidationService` emits `DerivedIndexServerManagedProperty` (path to the vertex or edge property, `expected: "server-managed derived index"`, `actual: <key>`) and skips value validation for that key.
- CSV bulk load: `NeptuneCsvLexiconValidationService` emits `DerivedIndexServerManagedPropertyColumn` for a header column and `DerivedIndexServerManagedProperty` for a row property.
- Identity: `GraphSONPersistTransform` strips derived index keys, alongside `id` and `created_at`, before hashing and from response payloads, so an index value can never change an element's hashed id.

`IndexCatalogService.isDerivedIndexProperty(ownerKind, ownerType, key)` and `getIndexNamesForOwner` are the lookups these boundaries use.

## 3. Index writer contract

`IndexWriterService` is the only component that mutates index properties. Both the rebuild and the poller go through it.

- **Owner-rooted recompute**: the value tail is `value_query` minus the `subject_query` prefix, re-rooted at each owner (`g.V(owner)<tail>` / `g.E(owner)<tail>`). Batched owner reads use `g.inject(0).union(__.V(id).project('ownerElementId','values').by(constant).by(<tail>.fold()), …)` in chunks of `INDEX_WRITER_OWNER_READ_BATCH_SIZE`. An index whose `value_query` is not rooted at its subject fails with "Derived index value query is not rooted at its subject traversal".
- **Null-as-remove**: a missing, `null`, `undefined`, or empty traversal result plans a `Remove` (`properties(<name>).drop()`); any other value is validated then planned as a `Write` (`property(single, <name>, <literal>)`). Single cardinality makes the write a replacement, so replaying any window or batch converges on the same state. Literals are inlined with the Gremlin literal encoder; no bindings.
- **Type validation** (`IndexValueValidationService`, reads only `{ ownerType, indexName, valueSchema }`): date coercion first (a `Date` or ISO date-time for a `string` + `format: "date"` index is cut to the date part), then `type` (`integer` accepts bigint and integral numbers, `number` requires finite, `boolean` exact), then `enum`, `format`, `pattern`, `minLength`. A failure is `DerivedIndexValidationError { ownerType, indexName, ownerElementId?, path?, expected?, actual?, message }` and fails the whole window before any mutation is submitted.
- **Mutation batching**: actions are chunked into `g.inject(0).sideEffect(__.V(id).property(single, …)).sideEffect(__.V(id).properties(k).drop())….iterate()` scripts of `INDEX_WRITER_MUTATION_BATCH_SIZE` and submitted on the writer endpoint with `INDEX_WRITER_MUTATION_CONCURRENCY`; concurrency above 1 borrows pooled writer connections (`GREMLIN_WRITER_POOL_SIZE` must be at least that concurrency), 1 uses the single cached connection.
- **Result** (`IndexWriteResult`): `ownerElementIds`, `propertiesWritten`, `propertiesRemoved`, `validationFailures`, `recomputations`, `conditionedTriggeringRecords`, `matchedConditions`, `filteredIndexTriggers`, `missingTriggerElements`. `dryRun: true` plans reads and validation but submits no mutation script.

| Env var | Code default | CDK pin (all index Lambdas) | Meaning |
|---|---|---|---|
| `INDEX_WRITER_MUTATION_BATCH_SIZE` | 25 | 250 | actions per mutation script |
| `INDEX_WRITER_MUTATION_CONCURRENCY` | 1 | 8 | parallel mutation scripts |
| `INDEX_WRITER_OWNER_READ_BATCH_SIZE` | 50 | 250 | owners per batched value read |
| `GREMLIN_READER_POOL_SIZE` / `GREMLIN_WRITER_POOL_SIZE` | 1 / 1 | 8 / 8 (poller: 200 / 32) | connection pools backing pooled modes |

IAM consequence: a single-cardinality `property(single, …)` replacement and `properties(k).drop()` bill as deletes on Neptune, so index Lambdas need `neptune-db:DeleteDataViaQuery` in addition to `ReadDataViaQuery` and `WriteDataViaQuery` (section 8.2).

## 4. Rebuild workflow (`PersistIndexRebuildWorkflow`)

### 4.1 States as deployed

```
PrepareIndexRebuild (Lambda IndexRebuildPrepare, retry maxAttempts 2, 2 s, backoff 2 on States.TaskFailed / Lambda.ServiceException / Lambda.TooManyRequestsException)
  → EnumerateIndexRebuildRanges   Distributed Map, STANDARD, itemsPath $.ranges, maxConcurrencyPath $.rangeMapMaxConcurrency, resultPath DISCARD
        item: EnumerateIndexRebuildRange (Lambda IndexRebuildRangeEnumerator, same retry)
  → RecomputeIndexBatchFiles      Distributed Map, STANDARD, S3 ItemReader over bucket $.bucket prefix $.batchPrefix,
                                  itemSelector { schemaVersion:"1", executionId, bucket, key: $$.Map.Item.Value.Key },
                                  maxConcurrencyPath $.batchMapMaxConcurrency, resultPath DISCARD
        item: RecomputeIndexBatchFile (Lambda IndexRebuildShardWorker, same retry)
  → FinalizeIndexRebuild (Lambda IndexRebuildFinalize)
State machine: STANDARD, timeout 6 h, X-Ray tracing, no Catch anywhere.
EventBridge rule PersistIndexRebuildFailureRule: source aws.states, "Step Functions Execution Status Change",
  status in [FAILED, TIMED_OUT, ABORTED] for this state machine → Lambda IndexRebuildFail (has states:DescribeExecution for oversized inputs).
```

Neither map has a `ResultWriter`; every artifact is written by the Lambdas under `s3://<INDEX_MAINTENANCE_BUCKET>/<INDEX_REBUILD_PREFIX>/<executionId>/` (`INDEX_REBUILD_PREFIX` is pinned to `index-rebuild`). A Lambda `IndexRebuildListBatches` (`listBatchFiles`, 512 MB / 1 min) and a `processShard` path over `IndexRebuildShardRecord` exist and are granted permissions, but neither is a state of the deployed machine; the S3 ItemReader replaced the listing step. `INDEX_REBUILD_SHARD_SIZE` (1000) is read into config and unused.

### 4.2 Accepted input (`IndexRebuildInput`)

```jsonc
{
  "schemaVersion": "1",
  "mode": "WRITE" | "DRY_RUN",                 // WRITE with candidate_lexicon_s3_uri is rejected
  "indexes": [{ "owner_type": "…", "index_name": "…" }],   // REQUIRED and non-empty: "Index rebuild requires at least one selected index"
  "executionId": "…",                          // optional; sanitized to [A-Za-z0-9._-]; defaults to a random UUID. Set it (discovery always does) so a Prepare retry re-claims its own lock
  "initializeStreamCheckpoint": false,         // optional; only true + WRITE + a captured watermark writes the stream checkpoint at finalize
  "rangeSize": 500000,                         // optional; owner ids per range (owner-scan and sparse lanes; a per-index sparse_rebuild.range_size wins)
  "batchFileTriggerIds": 25000,                // optional; owner ids per batch file (per-index sparse_rebuild.batch_file_owner_ids wins)
  "rangeMapMaxConcurrency": 25,                // optional; falls back to maxConcurrency, then INDEX_REBUILD_RANGE_MAP_MAX_CONCURRENCY
  "batchMapMaxConcurrency": 25,                // optional; falls back to maxConcurrency, then INDEX_REBUILD_BATCH_MAP_MAX_CONCURRENCY
  "workerConcurrency": 25,                     // optional; carried on every range/batch record; INDEX_REBUILD_WORKER_CONCURRENCY
  "maxConcurrency": 20,                        // optional; ONLY a fallback for the two map knobs (INDEX_REBUILD_MAX_CONCURRENCY)
  "costCeilingUsd": 10,                        // accepted by the schema, not read by any stage
  "candidate_lexicon_s3_uri": "s3://…",        // DRY_RUN only; propagated to every range/batch record
  "root_vertices_to_rebuild_indexes": { "<vertex owner label>": "s3://…/ids.csv" }   // optional; scopes owner-scan vertex owners to a CSV `vertex_id` column
}
```

All numeric knobs are floored and clamped to at least 1. `root_vertices_to_rebuild_indexes` fails prepare when a key is not a selected vertex index owner, targets an owner that has a selected sparse index, or is not a valid S3 URI.

### 4.3 Data path

1. **Prepare** decodes input, resolves `getSelected`, and partitions the selection into owner-scan groups (one per `ownerKind:ownerType`, all of that owner's selected non-sparse indexes together) and sparse lanes (one per index per candidate source). Sparse lanes are counted first with a bounded `limit(max+1).count()`; a count above `max_candidate_elements` (per-index, else `INDEX_REBUILD_SPARSE_MAX_CANDIDATE_ELEMENTS`) fails prepare and never falls back to an owner scan. In `WRITE` mode prepare then claims every selected index (`markRebuilding`), reads the `LATEST` stream watermark, and plans ranges: owner-scan groups use `g.V|E().hasLabel(owner).count()` and `range(a, b)` windows of `rangeSize`; CSV-scoped groups get one synthetic range; sparse lanes get ranges over the candidate population (an `existing_non_default` lane's ids are enumerated eagerly at prepare and stored on the range item). Each range is written as `ranges/<ownerKind>-<ownerType>[/<indexName>/<sourceId>]/range-<i>.json` as soon as it is built, then `manifest.json` (the `IndexRebuildPreparedInput`) is written and returned. Prepare is 1024 MB / 15 min because it reads Neptune.
2. **EnumerateIndexRebuildRange** receives a range pointer `{ schemaVersion, executionId, bucket, key }` (or an inline range item), enumerates owner ids (`g.V|E().hasLabel(owner).range(a, b).id()`, a candidate range query, the stored ids, or the CSV column), dedupes sparse ids within the range only, and writes `batches/<same segment>/range-<i>/batch-<j>.json` (`IndexRebuildBatchRecord`) files of `batchFileTriggerIds` ids. It returns `{ schemaVersion: "1", executionId, batchFiles: [pointers] }`; the map discards it.
3. **RecomputeIndexBatchFile** reads one batch record, and for each index in the owner group chunks the owner ids by `candidatePlan.ownerQueryBatchSize` or `INDEX_REBUILD_OWNER_QUERY_BATCH_SIZE` (50) and calls `writer.recomputeForOwnerBatch(index, chunk, { dryRun })`. A failed chunk counts its whole size as `validationFailures` and continues. It writes `summary/<ownerKind>-<ownerType>-<uuid>.json` (`IndexRebuildBatchResult`) and returns it.
4. **Finalize** decodes the manifest: in `WRITE` mode, if `initializeStreamCheckpoint` and a watermark exist, `putCheckpoint(watermark, sourceExecutionArn = executionId)`; then `markActive` for every selected index with the watermark (0/0 when none). `DRY_RUN` touches neither. Finalize writes **no summary document**; the per-batch `summary/` objects are the only counters, and its return value is the manifest.

Idempotency: every recompute is a full owner-rooted replacement, so overlapping ranges, duplicate ids across ranges, retries, and redrives converge. A `FAILED` execution is redrivable; `IndexRebuildFail` releases the `REBUILDING` claims (sibling file section 4.2).

### 4.4 Lambda sizing (all in VPC, ARM64, Node 24, JSON logs, 3-month retention)

| Function | Memory | Timeout | Service name |
|---|---|---|---|
| `IndexRebuildPrepare` | 1024 MB | 15 min | `persist-index-rebuild-prepare` |
| `IndexRebuildRangeEnumerator` | 1024 MB | 15 min | `persist-index-rebuild-range-enumerator` |
| `IndexRebuildShardWorker` (state `RecomputeIndexBatchFile`) | 1024 MB | 15 min | `persist-index-rebuild-shard` |
| `IndexRebuildListBatches` (not in the machine) | 512 MB | 1 min | `persist-index-rebuild-list-batches` |
| `IndexRebuildFinalize` | 512 MB | 1 min | `persist-index-rebuild-finalize` |
| `IndexRebuildFail` (EventBridge target) | 512 MB | 1 min | `persist-index-rebuild-fail` |

### 4.5 Rebuild environment (code default / CDK pin)

`INDEX_MAINTENANCE_BUCKET` (required), `INDEX_REBUILD_PREFIX` (`index-rebuild`), `INDEX_REBUILD_RANGE_SIZE` (500000 / 500000), `INDEX_REBUILD_BATCH_FILE_TRIGGER_IDS` (25000 / 25000), `INDEX_REBUILD_OWNER_QUERY_BATCH_SIZE` (50 / 50), `INDEX_REBUILD_SPARSE_MAX_CANDIDATE_ELEMENTS` (5000000 / 5000000), `INDEX_REBUILD_MAX_CONCURRENCY` (20 / 20), `INDEX_REBUILD_RANGE_MAP_MAX_CONCURRENCY` (25 / 25), `INDEX_REBUILD_BATCH_MAP_MAX_CONCURRENCY` (25 / 25), `INDEX_REBUILD_WORKER_CONCURRENCY` (25 / 25), `INDEX_REBUILD_SHARD_SIZE` (1000 / 1000, unused). Precedence for `rangeSize` and `batchFileTriggerIds`: per-index `sparse_rebuild` value, then execution input, then environment.

## 5. Stream indexer (`IndexStreamPoller`)

### 5.1 Schedule, sizing, lease

- EventBridge Scheduler `IndexStreamPollSchedule`: `rate(1 minute)`, Lambda target with `retryAttempts: 0`. There is no `INDEX_STREAM_POLL_INTERVAL_SECONDS`; the cadence is a CDK constant.
- Lambda: 4096 MB, 3 min timeout, `reservedConcurrentExecutions: 1`, in VPC, service name `persist-index-stream-poller`, pools `GREMLIN_READER_POOL_SIZE=200`, `GREMLIN_WRITER_POOL_SIZE=32`, `INDEX_STREAM_RECOMPUTE_CONCURRENCY=200`.
- Lease: the polling core computes `leaseTtlSeconds = ceil((remainingMs + INDEX_STREAM_LEASE_SAFETY_SECONDS * 1000) / 1000)` and calls `acquireLease` on the `pk="stream"` item with `leaseOwner = awsRequestId`. `INDEX_STREAM_LEASE_TTL_SECONDS` (120) is the store's fallback only when a caller passes no TTL. A held lease returns `stopReason: "lease_held"` with zero work. The lease is released on both the success and the failure path; a hard Lambda timeout relies on TTL expiry.

### 5.2 Per-invocation limits

| Env var | Code default | CDK pin | Effect |
|---|---|---|---|
| `INDEX_STREAM_POLL_LIMIT` | 100000 | 50000 (lag probe 1, catch-up Lambda 10000) | `limit` per stream fetch, clamped to [1, 100000]; on a fetch timeout the client halves the limit down to `min(limit, 5000)` for that position only |
| `INDEX_STREAM_REQUEST_TIMEOUT_MS` | 30000 | (default) | per-fetch abort timeout |
| `INDEX_STREAM_MAX_TRANSACTIONS_PER_POLL` | 2500 | 250 | transactions planned per page; a longer safe prefix is checkpointed and the rest re-read |
| `INDEX_STREAM_MAX_LOOPS_PER_INVOCATION` | 700 | 500 | page fetches per invocation (`loop_budget`) |
| `INDEX_STREAM_MIN_REMAINING_MS` | 15000 | 10000 | stop before a new loop when less remains (`time_low`); each iteration also runs under a `remaining - 5000 ms` timeout (`NEPTUNE_STREAM_DEADLINE_SAFETY_MARGIN_MS`), reported as `deadline_guard` |
| `INDEX_STREAM_LEASE_SAFETY_SECONDS` | 5 | 5 | added to the lease TTL |
| `INDEX_STREAM_MAX_RECOMPUTATIONS_PER_INVOCATION` | 40000 | 60000 | owner/index recompute units per invocation (`recompute_budget`, `page_recompute_budget`); one oversized first transaction is always allowed |
| `INDEX_STREAM_RECOMPUTE_BATCH_SIZE` | 25 | 250 | trigger or owner ids per recompute job |
| `INDEX_STREAM_RECOMPUTE_CONCURRENCY` | 50 | 1500 (poller override 200) | parallel owner-discovery/read units in a window |

Stop reasons reported in the poll summary: `completed_page`, `lease_held`, `no_records`, `no_complete_transactions`, `time_low`, `deadline_guard`, `loop_budget`, `recompute_budget`, `page_recompute_budget`.

### 5.3 Trigger matching

Records are PG_JSON from `GET /propertygraph/stream?iteratorType=AFTER_SEQUENCE_NUMBER&commitNum&opNum&limit`. A record is a trigger candidate only when it is a **label** record: `op="ADD"`, `data.type` `"e"` (edge trigger) or `"vl"` (vertex trigger), `data.key="label"`, string `data.value.value` equal to a trigger label. `vp`/`ep` property records never match, so the poller's own writes cannot re-trigger it. The lookup has three maps built from the catalog views: `vertex[label]`, `edge[label]`, and `deleteEdge[label]` (only edge views with `onRemove.recomputeOwner`). Matching is by label and trigger type; `when` conditions are not evaluated against the stream record (endpoint metadata cannot prove them) but during batched owner discovery, where `.has(property, value)` steps follow the trigger root; a non-matching element counts as `filteredIndexTriggers`, a vanished element as `missingTriggerElements`, and both advance the checkpoint. Additional triggers match under their own label with their own conditions and traversal, and work is grouped per `(index, trigger type, trigger label)`.

### 5.4 Owner resolution lanes

- **Direct**: `resolveStreamOwnerField` returns `from` for an unconditioned edge trigger whose effective subject (`ownerDiscoveryQuery ?? subjectQuery`) is exactly `g.E(__ID__).outV().id()` and `to` for `g.E(__ID__).inV().id()`; the owner id is read from `record.data.from`/`.to`, deduped per index per window, with no Gremlin discovery read.
- **Fallback**: every other shape, and any direct-eligible record missing its endpoint, contributes its trigger element id to a `RecomputeJob`; the writer discovers owners with the bound trigger-rooted traversal, refusing traversals not rooted at `g.V('<id>')`/`g.E('<id>')`.

### 5.5 Transactions, pages, and remove handling

- Records are grouped by `eventId.commitNum` and closed on `isLastOp=true`. A page containing a single spanning transaction with no complete prefix is finalised partially; its tail is safely rescanned because recomputes are idempotent.
- A page with no trigger match takes an allocation-free fast path and plans a single `CheckpointSafeRecord` to the response `lastEventId` (or the last record). Otherwise `planIndexStreamPage` emits an ordered action list: safe-prefix checkpoints and `RecomputeWindow`s, each carrying the watermark of its last transaction.
- Plain `REMOVE` records are counted as `skippedRemoveRecords` and logged ("Skipped REMOVE stream records for derived index maintenance"). A `REMOVE` edge-label record whose label is in `deleteEdge` resolves the pre-delete owner directly from `from`/`to` and is recomputed like an add. If that endpoint is absent, planning stops **at** that transaction: actions before it are executed and checkpointed, then the invocation fails with `DerivedIndexExecutionError` ("… removed element … without the owner endpoint required to recompute it"), the lease is released, and the next minute retries the same record. The checkpoint is global, so this halts every index until the lexicon drops `on_remove` for that index or an operator fast-forwards and rebuilds.

### 5.6 Checkpoint semantics

- `executeCheckpointedActions` runs each action then `advanceCheckpoint(watermark, lastCommitTimestamp, releaseLease=false)`, so the checkpoint always equals the last fully processed transaction (or the last safe record), never the page's `lastEventId` when work remains. A recompute failure leaves the checkpoint at the previous action.
- Missing checkpoint: `getCheckpoint` is consistent-read; `None` fails closed with `IndexStreamCheckpointMissing` ("run a WRITE rebuild before enabling stream polling") before any lease or fetch. There is no `LATEST` bootstrap.
- **Undetected trim gap (state this honestly)**: `IndexStreamClientService` maps an HTTP 404 whose body matches `StreamRecordsNotFoundException` or "Reached the end of the stream" to an empty page, and the poller reports `no_records` and stops without advancing. A checkpoint that has aged out of Neptune's stream retention produces the same 404, so an expired checkpoint is indistinguishable from a caught-up stream: the poller does not fail, no metric is emitted by the poller, and only the lag probe (which reads the same client and sees the same empty page) reports `0` age. Detect it by comparing `IndexStreamCommitBacklog` (LATEST minus checkpoint) growing while `IndexStreamOldestUnprocessedRecordAgeSeconds` stays `0`, or by the stream's own expiry setting versus `checkpoint.updatedAt`. Recovery is the fast-forward plus full-rebuild playbook (sibling file section 6).

### 5.7 Shared polling core (`lambda/services/neptune-stream/`)

`runNeptuneStreamPoll` owns the loop: read checkpoint, fail on missing, compute lease TTL from remaining time, acquire, loop `fetchPage`/`processPage` under `maxLoopsPerInvocation`, `minRemainingMs`, and a per-iteration `timeoutFail` with `NEPTUNE_STREAM_DEADLINE_SAFETY_MARGIN_MS = 5000`, release the lease on error (logging a release failure without masking the poll error) and on success. `executeCheckpointedActions` is the "execute then advance, remember last watermark" primitive. `NeptuneStreamTypes` holds the `{ commitNum, opNum }` watermark. The OpenSearch stream poller reuses this core with its own checkpoint store.

## 6. Schemas

### 6.1 Stream checkpoint item (`DerivedIndexStateTable`, key `pk`/`sk`)

```ts
{ pk: "stream", sk: "checkpoint", commitNum: number, opNum: number, updatedAt: ISO8601,
  lastCommitTimestamp?: number, leaseOwner?: string, leaseExpiresAtEpochSeconds?: number, sourceExecutionArn?: string }
```

`getCheckpoint` decodes `None` when `commitNum`, `opNum`, or `updatedAt` is missing. `putCheckpoint` replaces the item (used by finalize with `initializeStreamCheckpoint` and by operators); `advanceCheckpoint` and `releaseLease` are conditioned on `leaseOwner`. The `pk="index"` definition items share the table (sibling file section 3.1).

### 6.2 Rebuild records

- `IndexRebuildPreparedInput` (manifest): `schemaVersion, executionId, mode, bucket, prefix, manifestKey, shardPrefix, rangePrefix, batchPrefix, summaryPrefix, maxConcurrency, rangeMapMaxConcurrency, batchMapMaxConcurrency, batchFileTriggerIds, workerConcurrency, initializeStreamCheckpoint, candidateLexiconS3Uri?, streamWatermark?, selectedIndexes: IndexDefinitionRef[], indexes?, ownerGroups?, ranges: pointer[], shards?, batchFiles?`.
- `IndexOwnerGroup`: `ownerKind, ownerType, indexes: IndexCatalogEntry[], estimatedCount, csvSourceS3Uri?, candidatePlan?`.
- `IndexRebuildRangeItem`: manifest-derived fields plus `ownerGroup, rangeStart, rangeEnd, rangeIndex, candidateOwnerElementIds?`.
- `IndexRebuildBatchRecord`: `schemaVersion, executionId, mode, bucket, prefix, batchKey, summaryPrefix, workerConcurrency, candidateLexiconS3Uri?, streamWatermark?, ownerGroup, ownerElementIds`.
- Pointers (`IndexRebuildRangeFilePointer`, `IndexRebuildBatchFilePointer`): `{ schemaVersion: "1", executionId, bucket, key }`.

### 6.3 Result records (written under `summary/`)

```ts
IndexRebuildShardResult  { schemaVersion: "1", executionId, ownerType, indexName,
                           ownerElementsRead, ownerElementsTouched, propertiesWritten, propertiesRemoved, validationFailures, dryRun }
IndexRebuildBatchResult  { schemaVersion: "1", executionId, ownerKind, ownerType, batchKey,
                           ownerElementsRead, indexesComputed /* ids x indexes in group */, ownerElementsTouched,
                           propertiesWritten, propertiesRemoved, validationFailures, dryRun }
```

There is no `IndexRebuildSummary`, no `triggerElementsRead`, and no `streamWatermark` counter document; sum the `summary/` objects per execution when a total is needed.

## 7. Observability

- **Rebuild metrics** (`IndexRebuildMetricsService`, namespace `persist`, dimension `service=persist-index-rebuild` pinned across all rebuild functions, buffered per invocation and flushed in each handler's `finally`): `index_rebuild_candidate_elements` and `index_rebuild_owner_candidates` (dimensions `owner_type`, `index_name`, `candidate_source`; emitted only by sparse lanes: elements at prepare, owner candidates per range), `index_rebuild_properties_written` and `index_rebuild_properties_removed` (dimensions `owner_type`, `index_name`; emitted per batch file in both modes as planned actions). Zero values are not published.
- **Poller**: emits no CloudWatch metrics. Its structured "Index stream poll complete" log carries `recordsRead, transactionsProcessed, triggeringTransactions, nonTriggeringTransactions, labelRecordsScanned, triggeringRecords, recomputationCandidates, recomputations, conditionedTriggeringRecords, matchedConditions, filteredIndexTriggers, missingTriggerElements, checkpointAdvanced, checkpointAdvances, loops, fastPathPages, streamFetchMs, decodeMs, analyzeMs, stopReason, remainingTimeMs`, plus per-page "Planned index stream page" and per-window "Derived index recompute window complete" records.
- **Lag probe** (`IndexStreamLagProbe`, 512 MB / 30 s, `rate(1 minute)`, `INDEX_STREAM_POLL_LIMIT=1`, table read-only): emits `IndexStreamOldestUnprocessedRecordAgeSeconds` (age of the first record after the checkpoint, `0` when none) and `IndexStreamCommitBacklog` (`max(0, latestCommitNum - checkpointCommitNum)`) under `service=persist`; fails with `IndexStreamCheckpointMissing` when no checkpoint exists. Alarm wiring and thresholds: `operations-dashboards-and-alerting.md`.
- Errors are tagged: `DerivedIndexCatalogError`, `DerivedIndexValidationError`, `DerivedIndexExecutionError { operation, ownerType?, indexName?, triggerElementId?, … }`, `DerivedIndexStateStoreError`, `DerivedIndexStreamError { operation }`, `IndexStreamCheckpointMissing`, `IndexRebuildInputError`, `IndexRebuildStorageError { bucket, key }`; handlers rethrow them with the tag as the error name and the owner/index/trigger context in the message.

## 8. Operations and runbook

### 8.1 Runbook items

- **`IndexStreamCheckpointMissing` (poller and lag probe every minute)**: never seed from `LATEST`. Start `PersistIndexRebuildWorkflow` with `mode="WRITE"`, all indexes you need, and `initializeStreamCheckpoint: true`; finalize writes the checkpoint at the prepare-time watermark and polling resumes on the next minute. The schedule does not need disabling, because a missing checkpoint fails before any lease.
- **Stream lag**: read `IndexStreamCommitBacklog` and the poller's `stopReason`. `recompute_budget`/`time_low` back to back with a healthy Neptune means throughput: raise `INDEX_STREAM_MAX_RECOMPUTATIONS_PER_INVOCATION` or recompute concurrency within the reader pool, not the schedule (reserved concurrency 1 and the lease already serialise polls). `lease_held` on every run means a stuck lease: wait out the TTL. Lower `INDEX_STREAM_POLL_LIMIT` only when fetch timeouts appear in the logs.
- **Suspected trimmed checkpoint** (backlog grows, age stays `0`): apply the fast-forward plus full-rebuild playbook in the sibling file; do not delete the checkpoint item.
- **Delete-aware poll failing every minute**: the error names the index and trigger element. Remove `on_remove` from that index in the lexicon or fast-forward past the record and rebuild.
- **Validation failures in a rebuild**: `validationFailures` in `summary/` objects plus `DerivedIndexValidationError` logs with `ownerElementId`, `expected`, `actual`; fix the `value_query` or the schema and rerun in `DRY_RUN`.
- **Rebuild redrive**: redrive the failed execution (no Catch, so the failed map or finalize resumes) once the cause is fixed; a retried Prepare re-claims its own lock only when the input carries `executionId`.

### 8.2 IAM for index Lambdas

Rebuild Lambdas and the poller each get `AWSLambdaVPCAccessExecutionRole`; `neptune-db:connect`, `GetStreamRecords`, `ReadDataViaQuery`, `WriteDataViaQuery`, `DeleteDataViaQuery` on the cluster; `s3:GetObject` on any object (lexicon and candidate lexicon reads); read/write on `DerivedIndexStateTable`. The six rebuild Lambdas (not the poller) also get read/write on `IndexMaintenanceBucket` under `index-rebuild/*`; the state machine role gets read/write on the bucket for the ItemReader. The lag probe gets `connect` + `GetStreamRecords` and table read only. `IndexRebuildFail` additionally gets `states:DescribeExecution` on the state machine. None can invoke API Gateway routes.

## 9. Verification and acceptance

- Unit (`test/services/IndexWriterService.test.ts`): mixed-index windows in one bounded mutation chunk; chunking by `INDEX_WRITER_MUTATION_BATCH_SIZE`; bounded mutation concurrency over a reused writer pool; exactly `ceil(owners / INDEX_WRITER_OWNER_READ_BATCH_SIZE)` owner reads; direct-owner windows skip discovery; unrooted traversals refused; validation failure aborts before any write; legacy `Date` coerced to `YYYY-MM-DD`; local Gremlin server clears a stale value and writes a live one.
- Unit (`test/services/IndexStreamPollerService.test.ts`): no-trigger and REMOVE-only pages fast-forward to `lastEventId`; safe prefix over `maxTransactionsPerPoll` checkpoints and re-reads; direct `outV`/`inV` from `from`/`to`; conditioned or endpoint-less records fall back; delete-aware REMOVE recomputes the pre-delete owner; unresolvable delete drains the prefix, fails, never checkpoints past itself, releases the lease; missing checkpoint fails without lease or fetch; lease TTL derived from Lambda time; recompute budget stops with the fitting sub-window checkpointed; deadline guard releases the lease.
- Unit (`test/services/IndexRebuildService.test.ts`, `IndexRebuildMetricsService.test.ts`, `IndexStreamLagProbeService.test.ts`): owner-scan groups, range counts and S3 keys unchanged without `sparse_rebuild`; sparse ceiling fails before claiming; knob precedence; CSV root-vertex sourcing and its rejections; `markFailed` no-op without indexes; candidate metrics aggregate per source under one dimension set and clear on flush; lag probe zero/age/backlog cases and checkpoint-missing failure.
- Integration (`IndexRebuildService.integration.test.ts`, `IndexWriterService` local-server cases): sparse rebuild against a real Gremlin server.
- CDK (`test/cdk/persist-stack.test.ts`): state names exactly `PrepareIndexRebuild, EnumerateIndexRebuildRanges, RecomputeIndexBatchFiles, FinalizeIndexRebuild`, no `Catch`, retries on both item tasks; poller 4096 MB / 180 s / reserved concurrency 1 with the pinned `INDEX_STREAM_*` and `INDEX_WRITER_*` values; lag probe 512 MB / 30 s with `INDEX_STREAM_POLL_LIMIT=1`; failure rule targets `IndexRebuildFail`; the sparse ceiling ships without moving other defaults.
- Release smoke: run `PersistIndexRebuildWorkflow` in `DRY_RUN` for one index and confirm `summary/` objects with `dryRun: true` and no Neptune writes; run `WRITE` with `initializeStreamCheckpoint: true` and confirm the `pk="stream"` item and `ACTIVE` state; ingest a graph fact that creates a trigger edge, then within two poll intervals confirm the owner property, `checkpointAdvanced: true` in the poll log, and `IndexStreamOldestUnprocessedRecordAgeSeconds` back to `0`; send a payload carrying an index property and confirm `DerivedIndexServerManagedProperty`.
- Acceptance: only lexicon-declared indexes can be selected; no ingest path accepts an index property; every write is single-cardinality and replayable; the checkpoint never passes unrecomputed trigger work; a missing checkpoint pages rather than bootstrapping; the rebuild finishes without a summary document but with per-batch results and an `ACTIVE` state.

## 10. Source map (persist repo, relative paths)

| Path | Responsibility |
|---|---|
| `lambda/schemas/lexicon.ts` | `LexiconIndexRule` and nested trigger, condition, sparse, absent-value, `on_remove` schemas |
| `lambda/schemas/derived-index.ts` | `IndexCatalogEntry`, `IndexRebuildInput`, prepared/range/batch/pointer records, shard/batch results, checkpoint item, stream record/response schemas |
| `lambda/schemas/errors.ts` | Tagged errors listed in section 7 |
| `lambda/services/IndexCatalogService.ts` | `buildIndexCatalog`, load-time validations, `getSelected`, `isDerivedIndexProperty`, `resolveStreamOwnerField`, trigger bindings |
| `lambda/services/IndexValueValidationService.ts` | Value coercion and validation order |
| `lambda/services/IndexWriterService.ts` | Owner reads, mutation batching, `recomputeForOwnerBatch`, `recomputeForPlannedWindow`, writer config |
| `lambda/services/IndexRebuildService.ts` | `prepare`, `processRange`, `processBatchFile`, `finalize`, `markFailed`, artifact keys, rebuild config |
| `lambda/services/IndexRebuildMetricsService.ts` | Rebuild metric names, dimensions, buffering and flush |
| `lambda/services/IndexStreamPollerService.ts` | Trigger lookup, page analysis and planning, budgets, poll lifecycle wiring |
| `lambda/services/IndexStreamClientService.ts` | Signed stream fetch, limit clamp and adaptive halving, end-of-stream 404 mapping, `getLatestWatermark` |
| `lambda/services/IndexCheckpointStoreService.ts` | `pk="stream"` item decode, lease TTL fallback, conditional advance/release |
| `lambda/services/IndexStreamLagProbeService.ts`, `lambda/index-stream-lag-probe/{handler,metrics}.ts` | Lag and backlog measurement and metric names |
| `lambda/services/neptune-stream/*` | `runNeptuneStreamPoll`, `executeCheckpointedActions`, watermark type |
| `lambda/index-rebuild-{prepare,range-enumerator,shard-worker,list-batches,finalize,fail}/handler.ts`, `lambda/index-stream-poller/handler.ts` | Lambda entry points and error surfacing |
| `lambda/services/GraphSONSemanticValidationService.ts`, `NeptuneCsvLexiconValidationService.ts`, `GraphSONPersistTransform.ts` | Server-managed index property rejection and hash stripping |
| `lib/persist-stack.ts` | `indexLambdaEnvironment`, Lambda definitions, state machine, failure rule, schedules, IAM grants |
| `docs/adr/0003, 0004, 0005, 0007, 0008` | Owner-rootability, alerting, direct owner resolution, fingerprint scope, trigger-first rebuilds and delete awareness |
| `README.md` "Derived index maintenance and alerting" | Operator-facing summary of conditions, alarms, and lag semantics |
