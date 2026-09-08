# Asynchronous GraphSON ingest and EventBridge graph-fact ingest

Persist accepts large GraphSON payloads asynchronously through `POST /persist/ingest-async` and accepts producer-emitted `GraphFactProduced` events from an EventBridge bus. Both paths validate fully before any side effect, store the normalized payload in S3, hand a pointer message to an SQS queue, and let a batching Lambda worker load Neptune through the bulk loader. Small or ref-bearing graph facts bypass the queue and reuse the synchronous ingest transaction. This file is the code-derived contract for those paths; everything below is read from the Persist repository, not from the PRD.

## 1. Scope and non-goals

In scope:

- `POST /persist/ingest-async`: request, validation order, S3 payload store, SQS pointer, response, failure semantics.
- Stage-1 `PersistAsyncBulkWorker`: event source, batch processing, retry and DLQ semantics, task-token callbacks, metric attribution.
- Stage-2 `PersistAsyncBulkAggregateWorker`: queue, who feeds it today, the unreachable legacy GraphSON branch.
- `PersistGraphFactHandler`: bus, rule, event schema, sync-vs-async routing, missing-ref skip, retries, DLQ.
- Queue message and event schemas, metrics, IAM, Lambda sizing for these three roles.

Out of scope (see siblings): the GraphSON validation pipeline and issue codes (`graphson-ingest-contract.md`), deterministic ID hashing and blob materialization (`identity-hashing-and-blobs.md`), Neptune CSV format, bulk loader tolerances and the CSV workflow that produces stage-2 messages (`csv-bulk-load-workflow.md`), the full environment-variable table (`stacks-configuration-and-iam.md`), and HTTP error envelopes (`error-catalogue-and-responses.md`).

## 2. Architecture

```text
HTTP client                                   EventBridge producer
   |  POST /persist/ingest-async                 |  PutEvents(GraphFactProduced)
   v                                             v
PersistHandler (API)                     <bus>: GraphFactProducedRule
   |  validate -> blobs -> normalize              |  retry 3x, maxEventAge 2h -> GraphFactEventDlq
   |                                              v
   |                                     PersistGraphFactHandler
   |                                        | refs or (V+E) <= SYNC_INGEST_MAX_ELEMENTS
   |                                        |----> GraphSONService.ingest (sync writer txn)
   |                                        | else
   v                                        v
S3 IngestAsyncPayloadBucket  <---  GraphSONAsyncIngestService
   ingest-async/YYYY/MM/DD/<requestId>.json
   +
SQS IngestAsyncQueue  --(maxReceiveCount 5)-->  IngestAsyncDlq
   |  batch <= 400, window 1 min (3 s dev), maxConcurrency 4
   v
PersistAsyncBulkWorker (stage 1)
   fetch payloads -> net-new counts (reader) -> CSV -> S3 bulk-load/... -> Neptune StartLoaderJob -> wait
   -> metrics + Step Functions callbacks per task_token

SQS FilteredBatchQueue  --(maxReceiveCount 5)-->  FilteredBatchDlq
   |  fed ONLY by PersistWorkflowItemDispatch (CSV workflow), not by stage 1
   v
PersistAsyncBulkAggregateWorker (stage 2)
```

Queue and target settings (`lib/persist-stack.ts`):

| Resource | Setting | Value |
| --- | --- | --- |
| `IngestAsyncQueue` | visibility timeout / retention | 30 min / 2 days |
| `IngestAsyncQueue` | DLQ | `IngestAsyncDlq`, `maxReceiveCount` 5, DLQ retention 4 days |
| stage-1 event source | `batchSize` / `maxBatchingWindow` / `maxConcurrency` | 400 / 1 min (3 s in the dev account) / 4, `reportBatchItemFailures: true` |
| `FilteredBatchQueue` | visibility timeout / retention | 30 min / 2 days |
| `FilteredBatchQueue` | DLQ | `FilteredBatchDlq`, `maxReceiveCount` 5, DLQ retention 4 days |
| stage-2 event source | `batchSize` / `maxBatchingWindow` / `maxConcurrency` | 6 / 1 min (3 s in the dev account) / 4, `reportBatchItemFailures: true` |
| `GraphFactProducedRule` target | `retryAttempts` / `maxEventAge` / DLQ | 3 / 2 h / `GraphFactEventDlq` (retention 14 days) |
| `IngestAsyncPayloadBucket` | lifecycle | objects expire after 2 days |

All queues use SQS-managed encryption and `enforceSSL`. The batching window is selected by the deploying account: 3 s when the account is the dev account, 1 min otherwise. Both DLQ receive counts are CDK constants that are also exported to the workers as `INGEST_ASYNC_MAX_RECEIVE_COUNT` and `INGEST_FILTERED_BATCH_MAX_RECEIVE_COUNT`; keep them equal so the worker's "last attempt" logic matches the queue's redrive policy.

## 3. Contracts

### 3.1 `POST /persist/ingest-async`

Request: the same GraphSON body accepted by `POST /persist/ingest` (`{"@type":"tinker:graph","@value":{vertices,edges,vertexRefs?}}`). Optional header `x-task-token`; when present and non-blank after trimming, its value is forwarded as `task_token` and the stage-1 worker calls Step Functions `SendTaskSuccess`/`SendTaskFailure` for it.

Processing order in `GraphSONAsyncIngestService.ingestAsync` (every step before the S3 PUT is side-effect free on S3/SQS):

1. `validatePayload` runs the full validation pipeline (schema, integrity, lexicon semantics).
2. If `vertexRefs` is non-empty, fail with `GraphSONIntegrityError` carrying `issues: [{ type: "VertexRefsNotSupportedForAsyncIngest" }]` (HTTP 400). Refs require the reader-side verifier that only the sync paths run.
3. Read the ingest epoch from the injectable `Clock`; `queuedAt` is that instant as ISO-8601.
4. Materialize blobs (content-addressed S3 objects) and record blob metrics with `ingest_method` = `async_ingest` (HTTP) or `eventbridge_graph_fact` (when EventBridge metadata is present).
5. Normalize temporal properties and stamp `created_at` at the captured epoch (`normalizeAtEpoch`, persist shape).
6. `requestId` = caller-supplied `options.requestId` or a fresh UUID v4.
7. PUT `AsyncPayloadDocument` as `application/json` to `s3://<INGEST_ASYNC_PAYLOAD_BUCKET>/ingest-async/YYYY/MM/DD/<requestId>.json` (UTC date from `queuedAt`). Failure: `S3PayloadStoreError` (HTTP 503).
8. `SendMessage` an `AsyncQueueMessage` to `INGEST_ASYNC_QUEUE_URL`. Failure, or a response without `MessageId`: `SqsEnqueueError` (HTTP 503).

Response `202`: `{ "ok": true, "data": { requestId, s3Uri, queueMessageId, queuedAt } }`.

There is no job or status store on this path. An enqueue failure returns 503 and leaves only the S3 object, which the bucket lifecycle deletes after 2 days; nothing transitions to a `FAILED` state and nothing is loaded. The client must resubmit. (The `QUEUED`/`FAILED` job states belong to the async Gremlin pipeline, not to async ingest.)

Malformed JSON bodies return 400 `Invalid JSON body` before the service is invoked. Validation-class failures are logged at `warn`, everything else at `error`.

### 3.2 Async-bulk queue message schemas (`lambda/schemas/async-bulk.ts`)

```ts
// Shared EventBridge provenance, all fields optional
AsyncIngestMetadata = {
  eventId?: string, source?: string, factType?: string,
  entityTypes?: string[], idempotencyKey?: string
}

// IngestAsyncQueue message (API and graph-fact handler -> stage 1)
AsyncQueueMessage = {
  schemaVersion: "2", requestId: string, s3_uri: string,
  task_token?: string, metadata?: AsyncIngestMetadata
}

// S3 payload document referenced by s3_uri
AsyncPayloadDocument = {
  schemaVersion: "2", requestId: string,
  graph: GraphSONIngestBody,          // { vertices, vertexRefs?, edges } in persist shape
  metadata?: AsyncIngestMetadata
}

// FilteredBatchQueue messages (stage 2). Decoded as a union on schemaVersion.
AsyncGraphsonFilteredBatchQueueMessage = {          // legacy, no producer today
  schemaVersion: "1", batchId: string, source_prefix: string,
  requests: Array<{ requestId: string, task_token?: string }>
}
AsyncCsvWorkflowFilteredBatchQueueMessage = {      // produced by the CSV workflow
  schemaVersion: "2", batchId: string, executionId: string,
  phase: "vertices" | "edges", source_prefix: string,
  requests: Array<{ requestId: string, itemIndex: number, sourceS3Uri: string,
                    rowsRead: number, rowsExisting: number, rowsNew: number,
                    task_token?: string }>
}
```

### 3.3 `GraphFactProduced` event contract (`lambda/schemas/eventbridge/graph-fact.ts`)

```ts
GraphFactProducedEvent = {
  id: string (non-empty),            // EventBridge event id; required by the schema
  source: string (non-empty),        // producing product namespace
  "detail-type": "GraphFactProduced",
  detail: {
    schema_version: "1.0",
    graphson_format: "graphson-v3",
    fact_type: string (non-empty),   // e.g. "<domain>.<verb>"
    entity_types: Array<string (non-empty)>,
    idempotency_key: string (non-empty),
    graphson: { vertices: GVertex[], vertexRefs?: GVertexRef[], edges: GEdge[] }
  }
}
```

Rules:

- Bus: `props.graphFactEventBusName`, read in `bin/app.ts` from CDK context key `graphFactEventBusName`, defaulting to the `DEFAULT_GRAPH_FACT_EVENT_BUS_NAME` constant (`<default-bus-name>`). The stack imports the bus by name; it does not create it.
- Rule `GraphFactProducedRule` pattern: `{ "detail-type": ["GraphFactProduced"], "detail": { "graphson_format": ["graphson-v3"] } }`. The rule does not filter on `source`; the schema only requires it to be non-empty.
- The handler decodes the whole envelope with `errors: "all"`; a malformed event fails with `GraphFactEventValidationError` before any Neptune, S3, or SQS call.
- `detail.graphson` is wrapped into `{"@type":"tinker:graph","@value":detail.graphson}` and then goes through the same validation as HTTP ingest. `entity_types` is logged and carried as metadata only; labels inside the GraphSON remain authoritative.
- `idempotency_key` is not used for lookups or deduplication. It is carried into logs, `AsyncPayloadDocument.metadata`, and `AsyncQueueMessage.metadata`. Replay safety comes from deterministic element IDs (sync path upserts; stage 1 counts and loads only against existing IDs).

### 3.4 Sync-vs-async routing rule (`GraphFactEventService`)

```text
elementCount   = detail.graphson.vertices.length + detail.graphson.edges.length
hasVertexRefs  = (detail.graphson.vertexRefs ?? []).length > 0
useSync        = hasVertexRefs || elementCount <= SYNC_INGEST_MAX_ELEMENTS   // default 50, CDK sets "50"
```

Refs always force the sync path regardless of size; the practical upper bound is the EventBridge 256 KB entry limit, which is why the handler timeout is 60 s. The async path is reached only for ref-free facts larger than the threshold.

## 4. Runtime behaviour

### 4.1 Stage 1: `PersistAsyncBulkWorker`

Handler (`lambda/async-bulk-worker/handler.ts`): reset metric buffers, attach `batchRequestId` = Lambda request id, call `AsyncBulkWorkerService.processBatch(records, batchId)`, always flush metrics in `finally`. If the service throws (as opposed to returning), every record in the event is reported as a batch item failure.

`processBatch`:

1. Preprocess records with concurrency 5: decode `AsyncQueueMessage` -> GET the S3 object -> decode `AsyncPayloadDocument`. `canRetry` = `ApproximateReceiveCount < INGEST_ASYNC_MAX_RECEIVE_COUNT` (default 5). A preprocessing failure that can retry is returned as a batch item failure; on the last attempt, a record with a `task_token` gets `SendTaskFailure("AsyncIngestPayloadFailure")` and is dropped (it goes to the DLQ if the callback itself fails), while a record without a token is returned as a failure so SQS moves it to the DLQ.
2. Resolve net-new counts through `NeptuneCsvDedupService.resolveNetNewCounts` (existing vertex and edge IDs are looked up on the reader endpoint).
3. Build one CSV pair for the whole batch and upload to `s3://<NEPTUNE_BULK_BUCKET>/bulk-load/YYYY/MM/DD/<batchId>/vertices.csv` and `edges.csv` (`NEPTUNE_BULK_PREFIX` = `bulk-load`; `batchId` is the Lambda request id, sanitized).
4. `startLoad(sourcePrefix)`. On `NeptuneBulkLoadQueueFullError`, every record is returned for redelivery regardless of receive count. On any other start failure, retryable records are redelivered and terminal records receive `SendTaskFailure` with code `NeptuneLoadTimeout`, `NeptuneLoadFailed`, or `AsyncIngestPayloadFailure`.
5. `waitForLoad(loadId)`. A failure after Neptune accepted the load sends failure callbacks to every record and does not redeliver any of them: the load is already in flight and a retry would enqueue a duplicate load.
6. On success, record `vertices_ingested` / `edges_ingested` with the net-new counts and then send one `SendTaskSuccess` per distinct `task_token` with `{ requestIds, loadId, loaderStatus, sourcePrefix, processedAt }`. Callback failures are logged and do not redeliver records; metrics are kept.

Attribution rule for `ingest_method` is per batch, not per payload: the batch is `eventbridge_graph_fact` only when every successfully preprocessed record has both `metadata.source` and `metadata.factType`; any HTTP-originated record in the batch attributes the whole batch to `async_ingest`.

Stage 1 does not enqueue anything to `FilteredBatchQueue`. The `INGEST_FILTERED_BATCH_QUEUE_URL` variable and the `grantSendMessages` on that queue are still present on this role but unused.

Bulk-load poll and timeout settings (`BULK_POLL_INTERVAL_MS` 5000, `BULK_MAX_WAIT_MS` 840000, `NEPTUNE_BULK_*_TIMEOUT_MS`), the CSV header format, and the tolerated `created_at` single-cardinality conflict are documented in `csv-bulk-load-workflow.md`.

### 4.2 Stage 2: `PersistAsyncBulkAggregateWorker`

Handler mirrors stage 1 (reset, process, flush, fail-whole-batch on throw). `processBatch` preprocesses with concurrency 5 and `canRetry` from `INGEST_FILTERED_BATCH_MAX_RECEIVE_COUNT`; undecodable records that can retry are redelivered, exhausted ones are dropped without a callback (no token is known). Decoded records are split by `schemaVersion`:

- `"2"` (CSV workflow): grouped by `executionId:phase`, merged, uploaded under `bulk-load-aggregate/`, loaded once per group, then `vertices_ingested`/`edges_ingested` are recorded with `ingest_method=async_csv_upload` and `phase`, summaries are written, and callbacks are sent per token. Details live in `csv-bulk-load-workflow.md`.
- `"1"` (GraphSON): `processGraphsonRecords` reads `vertices.csv`/`edges.csv` under each `source_prefix`, merges them, uploads `<batchId>-graphson`, loads vertices then edges (`edgeOnlyLoad: true` for edges), sends `{ skipped: true, sourcePrefixes, processedAt }` to all tokens when both merged sets are empty, and records no ingest metrics. This branch has no producer: the only caller of `AsyncFilteredBatchEnqueueService` is `WorkflowItemDispatchService`, which emits `schemaVersion: "2"`. Treat the v1 branch as legacy and unreachable; do not design new features on it.

Group failures use `handleGroupFailure`: queue-full redelivers every record in the group; otherwise retryable records are redelivered and terminal records get failure callbacks.

### 4.3 Graph-fact handling: `PersistGraphFactHandler`

Handler (`lambda/graph-fact-event/handler.ts`): append `graphFactEventId`, `graphFactSource`, `graphFactType` to every log line, run `GraphFactEventService.ingestGraphFact(event)`, log the returned `route`, flush metrics. Any error is logged and rethrown, so the invocation fails and EventBridge retries it (3 retries, up to 2 h of event age) before delivering the original event to `GraphFactEventDlq`. Note that this includes deterministic failures such as `GraphFactEventValidationError`, integrity errors, and lexicon violations: they are retried three times and then dead-lettered, because the handler does not distinguish them from transient errors.

`ingestGraphFact` returns one of:

- `{ route: "sync", response }` after `GraphSONService.ingest(graph, { metricsMethod: "eventbridge_graph_fact_sync" })` succeeds; `graph_facts_accepted` is incremented with `ingest_method=eventbridge_graph_fact_sync`.
- `{ route: "skipped_missing_ref", issues }` when the sync path fails with `MissingVertexRef`: `graph_facts_skipped_missing_ref` is incremented, a warning `Graph fact event skipped for missing vertex reference` is logged with `eventId`, `source`, `factType`, `idempotencyKey`, `issueCount`, and the invocation succeeds. No retry, no DLQ, nothing written. Issue codes are `VertexNotFoundForRef`, `LabelMismatchForRef`, `MalformedRefId`.
- `{ route: "async", accepted }` after `GraphSONAsyncIngestService.ingestAsync(graph, { metadata })` with `metadata = { eventId: id, source, factType, entityTypes, idempotencyKey }`; `graph_facts_accepted` is incremented with `ingest_method=eventbridge_graph_fact`. The queued payload is then processed by stage 1 exactly like an HTTP async request (no `task_token`).

Neptune connection retries on the sync path are pinned to `NEPTUNE_RETRY_MAX_ATTEMPTS=3` and `NEPTUNE_RETRY_BASE_DELAY_MS=1000` on this function only (two retry units, worst case about 14 s of backoff inside the 60 s timeout); longer outages are left to EventBridge redelivery.

## 5. Observability

Metrics are Powertools EMF, namespace `persist` (`POWERTOOLS_METRICS_NAMESPACE`), buffered in-process by `IngestMetricsService` and flushed once per invocation in the handler's `finally`. Zero-valued counters are not emitted, and a flush publishes graph-fact counters even when no ingest counts were buffered. Service names: `persist-graph-fact`, `persist-async-worker`, `persist-async-aggregate-worker` (the API path reports under the API handler's service name).

| Metric | Unit | Dimensions | Emitted by |
| --- | --- | --- | --- |
| `vertices_ingested`, `edges_ingested` | Count | `ingest_method`, plus `phase` only when the caller passes one (stage-2 CSV path) | sync graph fact (`eventbridge_graph_fact_sync`, request counts), stage 1 (`async_ingest` or `eventbridge_graph_fact`, net-new counts) |
| `blobs_materialized`, `blob_objects_created`, `blob_objects_reused` | Count | `ingest_method`, plus `phase` only on the CSV staging path (`async_csv_upload`, `csv-bulk-load-workflow.md` §4.7) | `/ingest-async` and graph-fact async path at enqueue time; sync graph fact at ingest time |
| `blob_bytes_materialized` | Bytes | `ingest_method` | same as above |
| `graph_facts_accepted` | Count | `ingest_method` in `{eventbridge_graph_fact, eventbridge_graph_fact_sync}` | graph-fact handler |
| `graph_facts_skipped_missing_ref` | Count | none | graph-fact handler |

Key log lines to alert or search on:

- API: `GraphSON async ingest request queued` (`requestId`, `bucket`, `key`, `queueUrl`, `queueMessageId`, `source`, `factType`, `idempotencyKey`); `GraphSON async ingest failed` (warn for validation, error otherwise).
- Stage 1: `Async bulk worker received SQS batch`, `... completed preprocessing` (`successfulRecordCount`, `preprocessingFailureCount`), `... uploaded Neptune CSV` (`vertexCount`, `edgeCount`, `netNewVertexCount`, `netNewEdgeCount`), `... Neptune load failed` (`stage: "start"`, `queueFull`), `... Neptune load failed after acceptance` (`stage: "wait"`), `... Neptune load completed`, `... finished batch processing` (`callbackFailureCount`, `batchItemFailureCount`), and `Async bulk worker failed to process batch` for a thrown error.
- Graph fact: `Graph fact event received`, `Graph fact event ingested synchronously`, `Graph fact event queued for async ingest`, `Graph fact event skipped for missing vertex reference` (warn), `Graph fact event failed` (error, followed by a retry).

Log groups: `PersistGraphFactHandlerLogGroup`, `PersistAsyncBulkWorkerLogGroup`, `PersistAsyncBulkAggregateWorkerLogGroup`, JSON format, 3-month retention.

## 6. Operations

DLQ redrive for async ingest:

1. Inspect `IngestAsyncDlq` messages; each body is an `AsyncQueueMessage`. Check that the object at `s3_uri` still exists: the payload bucket expires objects after 2 days while the DLQ keeps messages for 4 days, so a stale message will fail `fetchPayload` again on every redelivery.
2. If the object exists, start an SQS DLQ redrive back to `IngestAsyncQueue`. Receive counts restart, so the worker gets five fresh attempts.
3. If the object is gone, resubmit the original request through `POST /persist/ingest-async` (or, for a graph fact, re-emit the event) and purge the stale message.
4. Messages that carried a `task_token` have usually already received `SendTaskFailure` on their last attempt; check the owning Step Functions execution before redriving so a stale token is not called twice.

Replaying a graph fact: `GraphFactEventDlq` stores the original event envelope. Re-emit it with `aws events put-events` on the same bus using the original `source`, `detail-type`, and `detail`; EventBridge assigns a new `id`, and the unchanged `idempotency_key` plus deterministic element IDs keep the replay safe. Fix the producer or the lexicon first when the failure was a validation error, otherwise the replay will fail again after three retries.

Changing the bus: pass `-c graphFactEventBusName=<bus-name>` at `cdk deploy` (or set it in `cdk.json` context). The bus must already exist in the deploying account and region; the stack only attaches `GraphFactProducedRule` and its target to it. Producers in other accounts need a resource policy on that bus, which is outside this stack.

Tuning knobs: `SYNC_INGEST_MAX_ELEMENTS` (graph-fact handler env, CDK pins `"50"`); `ingestAsyncMaxReceiveCount` and `filteredBatchMaxReceiveCount` CDK constants (change both the queue policy and the worker env together); `batchSize`, `maxBatchingWindow`, `maxConcurrency` on the two `SqsEventSource`s. Keep stage-1 `maxConcurrency` low: each invocation holds a Neptune bulk-loader slot for up to `BULK_MAX_WAIT_MS`.

## 7. Verification and acceptance

Run from the Persist repo: `pnpm test -- test/services/GraphSONAsyncIngestService.test.ts test/services/GraphFactEventService.test.ts test/services/AsyncBulkWorkerService.test.ts test/services/AsyncBulkAggregateWorkerService.test.ts test/services/IngestMetricsService.test.ts`.

Acceptance criteria (each is covered by a named unit test or the stack):

- `/ingest-async` fails semantically invalid payloads and ref-bearing payloads before any S3 PUT or SQS send; ref rejection is `GraphSONIntegrityError` with `VertexRefsNotSupportedForAsyncIngest`.
- A valid request writes `AsyncPayloadDocument` (`schemaVersion: "2"`) to `ingest-async/YYYY/MM/DD/<requestId>.json` and enqueues `AsyncQueueMessage` with `task_token` when `x-task-token` was sent; EventBridge metadata is persisted in both the document and the message.
- Graph facts with `vertices + edges <= 50` and no refs go sync; larger ref-free facts go async with metadata `{eventId, source, factType, entityTypes, idempotencyKey}`; ref-bearing facts go sync regardless of size.
- A `MissingVertexRef` on a graph fact returns `route: "skipped_missing_ref"`, increments `graph_facts_skipped_missing_ref` with no dimension, and never calls async ingest.
- Malformed events fail before ingest is called.
- Stage 1 does not send preprocessing or loader failure callbacks while retries remain; redelivers every record on queue-full regardless of receive count; sends failure callbacks once retries are exhausted; never redelivers after Neptune accepted the load; keeps exhausted no-token failures in `batchItemFailures`; records net-new counts as `async_ingest`, or as `eventbridge_graph_fact` only when every record is a graph fact; keeps metrics when success callbacks fail.
- Stage 2 groups `schemaVersion: "2"` records by execution and phase.
- The synthesized stack has stage-1 `batchSize` 400 / `maxConcurrency` 4, stage-2 `batchSize` 6 / `maxConcurrency` 4, both queues with `maxReceiveCount` 5 and 30 min visibility, and the EventBridge target with `retryAttempts` 3, `maxEventAge` 2 h, and a DLQ. The CDK test asserts the batch sizes, the 60 s window, 30 min visibility, retention and the target's retry/age; `maxReceiveCount` and `maxConcurrency` are only stated in `lib/persist-stack.ts` (the test matches `RedrivePolicy` with `Match.anyValue()`).

Manual smoke: POST a ref-free graph with more than 50 elements to `/persist/ingest-async`, confirm 202 with `queueMessageId`, then watch the stage-1 log group for `Neptune load completed` and the `vertices_ingested{ingest_method=async_ingest}` metric. Emit one `GraphFactProduced` event with a single vertex and confirm `Graph fact event ingested synchronously` and `graph_facts_accepted{ingest_method=eventbridge_graph_fact_sync}`.

## 8. Lambda sizing and IAM

| Function | Entry | Memory / timeout | Notable env |
| --- | --- | --- | --- |
| `PersistGraphFactHandler` | `lambda/graph-fact-event/handler.ts` | 512 MB / 60 s | `SYNC_INGEST_MAX_ELEMENTS=50`, `NEPTUNE_RETRY_MAX_ATTEMPTS=3`, `NEPTUNE_RETRY_BASE_DELAY_MS=1000`, `INGEST_ASYNC_PAYLOAD_BUCKET`, `INGEST_ASYNC_QUEUE_URL`, `LEXICON_DATA_URI`, blob env |
| `PersistAsyncBulkWorker` | `lambda/async-bulk-worker/handler.ts` | 1024 MB / 15 min | `INGEST_ASYNC_MAX_RECEIVE_COUNT=5`, `INGEST_ASYNC_PAYLOAD_BUCKET`, `NEPTUNE_BULK_BUCKET`, `NEPTUNE_BULK_PREFIX=bulk-load`, `NEPTUNE_BULK_IAM_ROLE_ARN`, `BULK_*`, reader and writer hosts, blob env |
| `PersistAsyncBulkAggregateWorker` | `lambda/async-bulk-aggregate-worker/handler.ts` | 1024 MB / 15 min | `INGEST_FILTERED_BATCH_MAX_RECEIVE_COUNT=5`, `NEPTUNE_FILTERED_BULK_PREFIX=bulk-load-aggregate`, `WORKFLOW_SUMMARY_PREFIX=workflow-summaries`, `NEPTUNE_BULK_*` |

All three run Node 24 on ARM64 inside the VPC (private subnets with egress, shared Lambda security group) with `AWSLambdaVPCAccessExecutionRole`. The API handler additionally gets `s3:PutObject` on `ingest-async/*` and `sqs:SendMessage` on `IngestAsyncQueue`.

| Role | Neptune | S3 | Other |
| --- | --- | --- | --- |
| graph-fact handler | `neptune-db:connect`, `ReadDataViaQuery`, `WriteDataViaQuery` on the cluster | `s3:GetObject` on `*/*` (lexicon read, wildcard), put `ingest-async/*` on the payload bucket, put/read `<blob-prefix>/*` on the blob bucket | `sqs:SendMessage` on `IngestAsyncQueue` |
| stage-1 worker | `connect`, `ReadDataViaQuery`, `StartLoaderJob`, `GetLoaderJobStatus`, `ListLoaderJobs` | read `ingest-async/*`, put `bulk-load/*`, put/read `<blob-prefix>/*` | consume `IngestAsyncQueue`; send `FilteredBatchQueue` (unused); `states:SendTaskSuccess`/`SendTaskFailure` on `*` |
| stage-2 worker | same as stage 1 | read `bulk-load/*`, read/write `bulk-load-aggregate/*` and `workflow-summaries/*` | consume `FilteredBatchQueue`; `states:SendTaskSuccess`/`SendTaskFailure` on `*` |

The Neptune bulk loader itself assumes `NEPTUNE_BULK_IAM_ROLE_ARN` to read the bulk-load bucket; that role is provisioned by the Neptune stack.

## 9. Source map

| Concern | Persist repo path |
| --- | --- |
| Route, header parsing, 202 response | `lambda/routes/graphson.router.ts`, `lambda/http/responses.ts` |
| Async ingest pipeline, S3 key, queue message | `lambda/services/GraphSONAsyncIngestService.ts` |
| Queue message and payload decoding | `lambda/services/AsyncIngestPayloadService.ts` |
| Message and payload schemas | `lambda/schemas/async-bulk.ts`, `lambda/schemas/graphson/ingest.ts` |
| Event schema | `lambda/schemas/eventbridge/graph-fact.ts` |
| Routing, skip-on-missing-ref, metadata | `lambda/services/GraphFactEventService.ts`, `lambda/graph-fact-event/handler.ts` |
| Stage 1 | `lambda/services/AsyncBulkWorkerService.ts`, `lambda/async-bulk-worker/handler.ts`, `lambda/services/NeptuneCsvService.ts`, `lambda/services/NeptuneCsvDedupService.ts`, `lambda/services/NeptuneBulkLoaderService.ts` |
| Stage 2 and its only producer | `lambda/services/AsyncBulkAggregateWorkerService.ts`, `lambda/async-bulk-aggregate-worker/handler.ts`, `lambda/services/AsyncFilteredBatchEnqueueService.ts`, `lambda/services/WorkflowItemDispatchService.ts` |
| Metrics | `lambda/services/IngestMetricsService.ts`, `lambda/services/GraphSONService.ts` (`metricsMethod`) |
| Errors | `lambda/schemas/errors.ts` (`MissingVertexRef`, `S3PayloadStoreError`, `SqsEnqueueError`, `GraphFactEventValidationError`, `AsyncQueueMessageDecodeError`, `AsyncPayloadFetchError`, `AsyncPayloadDecodeError`) |
| Queues, DLQs, event sources, rule, target, IAM, sizing | `lib/persist-stack.ts` (buckets and queues near the top; graph-fact handler, rule and target; the two workers and their event sources), `lib/deployment-environment.ts` (dev-account batching window), `bin/app.ts` (`graphFactEventBusName` context) |
| Ref contract statement | `CONTEXT.md` ("Vertex Reference Contract"), `README.md` (vertexRefs section) |
| Tests | `test/services/GraphSONAsyncIngestService.test.ts`, `test/services/GraphFactEventService.test.ts`, `test/services/AsyncBulkWorkerService.test.ts`, `test/services/AsyncBulkAggregateWorkerService.test.ts`, `test/services/IngestMetricsService.test.ts` |
