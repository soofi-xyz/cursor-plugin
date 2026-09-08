# Neptune CSV Bulk-Load Workflow (`PersistNeptuneCsvWorkflow`)

This reference replaces PRD 5.4 (5.4.1–5.4.6), 5.5, the CSV-batch part of 6.1, 6.2, the workflow rows of the compute table, the Glue IAM bullet, and the workflow rows of the 8.5 runbook. It is written from the code, not from the PRD. Where the PRD and this file disagree, this file wins: there is no `PersistWorkflowItemRoute` or `PersistWorkflowItemProcessor` Lambda, no `WORKFLOW_DIRECT_LOAD_THRESHOLD_BYTES` env var, no `candidate_lexicon_s3_uri` input, the cost ceiling defaults to 25 USD, the loader retries a full queue once in-Lambda (not 40 times), and the state machine does not end at `ProcessEdges`.

The workflow takes a prefix of Neptune-format CSVs, optionally validates and rehashes them with a Glue job, deduplicates every object against the graph on a reader endpoint, stages only net-new rows, loads each staged object either through an aggregated Neptune bulk load (small objects, shared loader slot, task-token callback) or through its own bulk load (large objects, polled by the state machine), publishes a "loaded" EventBridge event carrying the Neptune stream position, and optionally blocks until the derived-index checkpoint passes that position.

## 1. Scope and non-goals

In scope: the Step Functions definition and every state name; the Lambdas it invokes and their sizes, env vars and IAM; the input, prepared-input, item, queue-message, summary and event schemas; dedup and staging semantics; the aggregate and direct load branches; the Neptune bulk loader client; the post-load tail; metrics; runbook.

Out of scope (owned by siblings): the catch-up loop internals and checkpoint store (`derived-index-discovery-and-catchup.md`); what consumes the loaded stream target (`neptune-stream-export.md`); the export triggered by this workflow's `SUCCEEDED` status (`athena-debt-index-export.md`); the `*:Blob` column transformation, blob validation and type widening rules (`identity-hashing-and-blobs.md`); the aggregate worker's GraphSON branch (`async-graphson-ingest-and-graph-facts.md`); the CSV ingest dashboard and the metrics Lambda's operational detail (`operations-dashboards-and-alerting.md`); the full env var table (`stacks-configuration-and-iam.md`); reader endpoint selection (`neptune-reader-topology.md`).

## 2. Architecture

### 2.1 State machine

`PersistNeptuneCsvWorkflow` is a STANDARD state machine with `LogLevel.ALL` logging and X-Ray tracing, no execution timeout, and a dedicated role. Its ARN is published as SSM parameter `persist-neptune-csv-workflow-arn` and as CloudFormation output `NeptuneCsvWorkflowArn`.

```
PrepareWorkflowInput (PersistWorkflowStart, payload {executionId: $$.Execution.Id, input: $})
  → ResolveWorkflowLexiconUri (Choice: isPresent $.lexiconDataUri)
      ├── present → PredictWorkflowCost
      └── absent  → UseDefaultWorkflowLexiconUri (Pass: $.lexiconDataUri = stack LEXICON_DATA_URI) → PredictWorkflowCost
  → PredictWorkflowCost (PersistWorkflowCostPredictor, resultPath $.costEstimate)
  → IsWorkflowCostApproved (Choice: $.costEstimate.status == "APPROVED")
      ├── otherwise → WorkflowCostCeilingExceeded (Fail, error "WorkflowCostCeilingExceeded")
      └── APPROVED  → ShouldRunPersistSparkRehash (Choice: $.glue.shouldRun == true)
            ├── true  → ValidateWorkflowCsvObjects (Distributed Map over $.glue.inputBucket/$.glue.inputPrefix)
            │             item: ValidateWorkflowCsvObject (PersistWorkflowValidate)
            │           → RunPersistSparkRehash (GlueStartJobRun, RUN_JOB, resultPath $.rehashResult)
            │           → ProcessVertices
            └── false → ProcessVertices
  → ProcessVertices (Distributed Map over $.phases.vertices.{bucket,prefix}, maxConcurrencyPath $.maxConcurrency)
  → ProcessEdges    (Distributed Map over $.phases.edges.{bucket,prefix},    maxConcurrencyPath $.maxConcurrency)
       item processor (X = Vertex | Edge):
       StageXCsvObject (PersistWorkflowItemStage, resultPath $.stageResult)
         → ShouldSkipXItem (Choice: $.stageResult.skipped == true)
             ├── true → SkipXItem (Succeed)
             └── else → ShouldAggregateXItem (Choice: <size path> <= 16777216)
                   ├── true → EnqueueXAggregate (PersistWorkflowItemDispatch, action "enqueue", WAIT_FOR_TASK_TOKEN, result discarded)
                   └── else → StartXDirectLoad  (PersistWorkflowItemDispatch, action "start-load", resultPath $.startResult)
                              → WaitForXLoad (Wait 1 min)
                              → CheckXLoadStatus (PersistWorkflowItemStatusSimple, inputPath $.startResult, resultPath $.statusResult)
                              → IsXLoadComplete (Choice: $.statusResult.done == true)
                                    ├── true → CompleteXDirectItem (Succeed)
                                    └── else → WaitForXLoad
  → CaptureLoadedStreamTarget (PersistWorkflowIndexCatchup, action "capture", resultPath $.loadedStreamTarget)
      ├── ok    → EmitCsvWorkflowMetricsEvent (EventBridge PutEvents, detail incl. streamTarget)
      └── catch → EmitCsvWorkflowLoadedWithoutTarget (EventBridge PutEvents, detail without streamTarget)
  → ShouldWaitForIndexCatchup (Choice: $.waitForIndexCatchup == true)
      ├── true → CaptureIndexCatchupTarget → WaitForIndexCatchup → CheckIndexCatchup → IsIndexCatchupComplete
      │            (loop until caughtUp; see derived-index-discovery-and-catchup.md §4.6) → WorkflowSucceeded
      └── else → WorkflowSucceeded (Succeed)
```

`<size path>` is `$.stageResult.stagedBytes` by default and `$.objectSize` when the CDK context `workflowRouteSizeBasis=raw` is set (see §8). The 16 MiB threshold (`16 * 1024 * 1024`) is a CDK constant compiled into the Choice; no Lambda knows it.

Both phase maps use a custom item reader (`DynamicS3ObjectsItemReader`) that renders `Bucket.$` and `Prefix.$` from JSON paths so the listed bucket and prefix come from the prepared input. The maps run as STANDARD child executions with `resultPath: DISCARD`.

### 2.2 Lambdas

All are `NodejsFunction` on Node 24 / ARM64 with ESM bundling and JSON logs, three-month log retention.

| Function | Memory | Timeout | VPC | Invoked by | Role |
| --- | --- | --- | --- | --- | --- |
| `PersistWorkflowStart` | 512 MB | 30 s | no | `PrepareWorkflowInput` | Decode and normalise the start input into the prepared input |
| `PersistWorkflowCostPredictor` | 512 MB | 60 s | no | `PredictWorkflowCost` | List input prefixes, estimate USD, APPROVED/REJECTED |
| `PersistWorkflowValidate` | 1024 MB | 15 min | no | `ValidateWorkflowCsvObject` (map item) | Lexicon-validate one raw CSV object before Glue |
| `PersistWorkflowItemStage` | 4096 MB, 10240 MiB ephemeral | 15 min | yes | `Stage{Vertex,Edge}CsvObject` | Dedup against the reader, materialise blobs, upload the filtered CSV, report `stagedBytes` |
| `PersistWorkflowItemDispatch` | 512 MB | 5 min | yes | `Enqueue*Aggregate`, `Start*DirectLoad` | Enqueue a staged item to `FilteredBatchQueue` or start its own bulk load |
| `PersistWorkflowItemStatusSimple` | 1024 MB | 180 s | yes | `Check{Vertex,Edge}LoadStatus` | Poll one direct load; on terminal success record metrics and write the summary |
| `PersistWorkflowItemStatus` | 1024 MB | 180 s | yes | none (deployed, not referenced by any state) | Effect-based equivalent of the simple checker (`WorkflowItemStatusService`) |
| `PersistWorkflowIndexCatchup` | 512 MB | 60 s | yes | `CaptureLoadedStreamTarget`, `CaptureIndexCatchupTarget`, `CheckIndexCatchup` | Read the LATEST stream watermark; compare the index checkpoint against it |
| `PersistCsvWorkflowMetrics` | 1024 MB | 15 min | no | EventBridge rule `PersistCsvWorkflowMetricsRule` | Recount net-new rows from summaries and staged CSVs; publish dashboard metrics |
| `PersistAsyncBulkAggregateWorker` | 1024 MB | 15 min | yes | `FilteredBatchQueue` SQS event source | Merge aggregated items per `<executionId>:<phase>`, run one bulk load, call back task tokens |

### 2.3 Queues, buckets, parameters

- `FilteredBatchQueue`: visibility 30 min, retention 2 days, DLQ `FilteredBatchDlq` (retention 4 days) after `maxReceiveCount=5`. Event source on the aggregate worker: `batchSize=6`, `maxBatchingWindow` 1 min (3 s in the dev account), `maxConcurrency=4`, `reportBatchItemFailures`.
- `NeptuneBulkLoadBucket` (`NEPTUNE_BULK_BUCKET`): holds `workflow-rehash/` (Glue output), `bulk-load/` (staged per-item CSVs), `bulk-load-aggregate/` (merged CSVs), `workflow-summaries/`. The Neptune bulk-load IAM role has read on this bucket.
- SSM: `/persist-spark/glue/neptune-csv-rehash/job-name` (read at synth for the Glue job name), `persist-neptune-csv-workflow-arn`, `persist-csv-workflow-metrics-log-group`.
- EventBridge: custom event `source=persist.csv-workflow`, `detail-type=Persist CSV Workflow Loaded` on the default bus; rule `PersistCsvWorkflowMetricsRule` targets the metrics Lambda. The export stack separately subscribes to `Step Functions Execution Status Change` with `status=SUCCEEDED` for this state machine (see `athena-debt-index-export.md`).

## 3. Contracts

All schemas live in `lambda/schemas/workflow.ts` unless stated.

### 3.1 Start input (three accepted shapes, `NeptuneCsvWorkflowAnyStartInput`)

```jsonc
// Shared prefix (runs Glue rehash)
{ "s3_uri": "s3://bucket/prefix", "lexicon_s3_uri"?: "s3://bucket/key.json",
  "costCeilingUsd"?: 10, "maxConcurrency"?: 2, "waitForIndexCatchup"?: true, "schemaVersion"?: "1" }
// Alias for the same shape
{ "input_prefix_s3_uri": "s3://bucket/prefix", ...same optional fields }
// Legacy sibling prefixes (skips Glue, validates inline during staging)
{ "vertices_s3_uri": "s3://bucket/root/vertices/", "edges_s3_uri": "s3://bucket/root/edges/", ...same optional fields }
```

Normalisation (`WorkflowInputService`):

- `maxConcurrency`: `Math.floor` of a positive finite number, else 60.
- `costCeilingUsd`: a positive finite number, else `WORKFLOW_COST_CEILING_USD` (default 25).
- `waitForIndexCatchup`: `=== true`, else false.
- `lexicon_s3_uri`: trimmed; must be `s3://bucket/key` with a non-empty key. A blank or non-`s3://` value fails with `WorkflowInputValidationError("Invalid Lexicon S3 URI")`, a bucket-only URI with `"Lexicon S3 URI must include an object key"`. Emitted as `lexiconDataUri`; omitted when absent.
- Legacy: both URIs must share one bucket, end in `/vertices` and `/edges`, and share the same parent, else `WorkflowInputValidationError`.

### 3.2 Prepared input (`NeptuneCsvWorkflowPreparedInput`, output of `PrepareWorkflowInput`)

```jsonc
{ "schemaVersion": "1", "executionId": "<$$.Execution.Id>", "lexiconDataUri"?: "s3://…",
  "maxConcurrency": 60, "waitForIndexCatchup": false, "cost": { "costCeilingUsd": 25 },
  "glue": { "shouldRun": true, "inputPrefixS3Uri": "s3://bucket/prefix", "inputBucket": "bucket",
            "inputPrefix": "prefix/", "outputPrefixS3Uri": "s3://<PERSIST_SPARK_OUTPUT_BUCKET>/workflow-rehash/<sanitized executionId>" }
         // or { "shouldRun": false }
  "phases": { "vertices": { "bucket", "prefix": ".../vertices/", "validationMode": "skip" | "required" },
              "edges":    { "bucket", "prefix": ".../edges/",    "validationMode": "skip" | "required" } } }
```

Shared-prefix input sets phase buckets to `PERSIST_SPARK_OUTPUT_BUCKET`, prefixes to `<PERSIST_SPARK_OUTPUT_PREFIX>/<sanitized executionId>/{vertices,edges}/`, and `validationMode: "skip"` (the validation map already ran). Legacy input keeps the caller's bucket/prefixes and sets `validationMode: "required"`. The execution id is sanitised to `[A-Za-z0-9._-]` with runs of `-` collapsed (fallback `execution`). After `ResolveWorkflowLexiconUri`, `$.lexiconDataUri` is always present on the state input; `$.costEstimate`, `$.rehashResult`, `$.loadedStreamTarget` and `$.indexCatchupStatus` are added as the run proceeds.

### 3.3 Cost estimate (`NeptuneCsvWorkflowCostEstimate`)

`{ schemaVersion: "1", status: "APPROVED" | "REJECTED", estimatedCostUsd, costCeilingUsd, totalObjects, totalBytes }`.

### 3.4 Validation map items

Item selector: `{ schemaVersion: "1", executionId, sourceBucket: $.glue.inputBucket, sourceKey, objectSize, itemIndex, lexiconDataUri }`. Result (discarded by the map): `{ schemaVersion, executionId, sourceS3Uri, skipped: true, skipReason }` or `{ ..., phase, rowCount, skipped: false }`.

### 3.5 Phase map item chain

- Item input (`NeptuneCsvWorkflowItemInitialInput`, from the item selector): `{ schemaVersion: "1", executionId, phase, sourceBucket, sourceKey, validationMode, objectSize ($$.Map.Item.Value.Size), itemIndex ($$.Map.Item.Index), lexiconDataUri? }`.
- Stage result (`$.stageResult`), one of:
  - Skipped: `{ schemaVersion, executionId, phase, sourceS3Uri, rowsRead, rowsExisting, rowsNew, skipped: true, skipReason? }`.
  - Staged: `{ ...same counters, itemIndex, skipped: false, stagedPrefix: "s3://<bulk bucket>/bulk-load/<yyyy>/<mm>/<dd>/<batchId>/", stagedBytes }`.
- Dispatch input (built by the state machine from `$.stageResult`): the staged fields plus `action: "enqueue"` and `taskToken: $$.Task.Token` (aggregate) or `action: "start-load"` (direct).
- Dispatch result: queued `{ ...staged fields minus stagedBytes, queued: true, requestId: "<executionId>:<phase>:<itemIndex>", queueMessageId }` (discarded; the state resumes on the callback) or started `{ ..., loadId, startedAtEpochMs }` (`$.startResult`).
- Status result (`$.statusResult`): `{ schemaVersion: "1", done: false, loadId, loaderStatus }` or `{ schemaVersion: "1", done: true, item: <completed> }`.
- Completed item (`NeptuneCsvWorkflowItemCompletedResult`, also what the aggregate worker sends with `SendTaskSuccess`): `{ schemaVersion, executionId, phase, sourceS3Uri, rowsRead, rowsExisting, rowsNew, itemIndex, skipped: false, stagedPrefix, loadId, loaderStatus }`.
- `WorkflowProcessingMode` (`"aggregate" | "direct"`) is declared in the schema file but unused.

### 3.6 CSV-batch queue message (`AsyncCsvWorkflowFilteredBatchQueueMessage`, `lambda/schemas/async-bulk.ts`)

```jsonc
{ "schemaVersion": "2", "batchId": "<executionId>:<phase>", "executionId", "phase": "vertices" | "edges",
  "source_prefix": "<stagedPrefix>",   // s3://<bulk bucket>/bulk-load/<yyyy>/<mm>/<dd>/<executionId>-<phase>-<itemIndex>/
  "requests": [ { "requestId": "<executionId>:<phase>:<itemIndex>", "itemIndex", "sourceS3Uri",
                  "rowsRead", "rowsExisting", "rowsNew", "task_token"? } ] }
```

One message per item; `schemaVersion: "2"` distinguishes it from the GraphSON message (`"1"`) on the same queue. The `<executionId>-<phase>-<itemIndex>` batch id is sanitised to `[A-Za-z0-9_-]` by `buildNeptuneBulkKeyPrefix`, so colons in the execution id become `-`.

### 3.7 S3 layouts and summaries

- Staged item: `bulk-load/<yyyy>/<mm>/<dd>/<executionId>-<phase>-<itemIndex>/{vertices,edges}.csv` (`WORKFLOW_BULK_PREFIX`).
- Aggregated load: `bulk-load-aggregate/<yyyy>/<mm>/<dd>/<batchRequestId>-<executionId>-<phase>/<phase>.csv` (`NEPTUNE_FILTERED_BULK_PREFIX`), where `batchRequestId` is the aggregate worker's Lambda request id for that SQS batch.
- Summaries: `workflow-summaries/<executionId>/<phase>/item-<itemIndex>.json` (`WORKFLOW_SUMMARY_PREFIX`), body = skipped result or completed item (`NeptuneCsvWorkflowItemResult`). The execution id is used unsanitised here. Written by the stage Lambda (skipped items), the status-simple Lambda (direct items) or the aggregate worker (aggregated items).
- Glue output: `workflow-rehash/<sanitized executionId>/{vertices,edges}/` (`PERSIST_SPARK_OUTPUT_PREFIX`).

### 3.8 Loaded event (`PersistCsvWorkflowLoadedEvent`)

`{ source: "persist.csv-workflow", "detail-type": "Persist CSV Workflow Loaded", detail: { schemaVersion: "1", executionId, streamTarget?: { commitNum, opNum } } }`. `streamTarget` is absent when `CaptureLoadedStreamTarget` failed. The metrics Lambda ignores it; a stream-export consumer refuses to publish without it (`neptune-stream-export.md`). The metrics Lambda also accepts a direct `{ executionId }` invocation.

### 3.9 Environment variables specific to this workflow (code default → CDK pin)

| Variable | Lambda | Default → CDK |
| --- | --- | --- |
| `PERSIST_SPARK_OUTPUT_BUCKET` / `PERSIST_SPARK_OUTPUT_PREFIX` | Start | required / `workflow-rehash` → bulk bucket / `workflow-rehash` |
| `WORKFLOW_COST_CEILING_USD` | Start | 25 → `25` |
| `WORKFLOW_COST_PREDICTOR_REQUEST_TIMEOUT_MS` | CostPredictor | 10000 → `10000` |
| `WORKFLOW_COST_PER_GB_USD` / `WORKFLOW_COST_PER_1000_OBJECTS_USD` | CostPredictor | 0.12 / 0.0004 → same |
| `LEXICON_DATA_URI` | Validate, Stage | stack lexicon URI (per-execution override arrives in the payload) |
| `WORKFLOW_VALIDATION_REQUEST_TIMEOUT_MS` | Validate | 30000 → `30000` |
| `WORKFLOW_MAX_OBJECT_SIZE_BYTES` | Stage | 524288000 → `524288000` |
| `NEPTUNE_CSV_DEDUP_BATCH_SIZE` | Stage | 1000 → `1000` |
| `NEPTUNE_CSV_DEDUP_BATCH_CONCURRENCY` / `NEPTUNE_CSV_EDGE_DEDUP_BATCH_CONCURRENCY` | Stage | 100 / 100 → `110` / `8` |
| `GREMLIN_BATCH_EXISTS_CHUNK_SIZE` / `GREMLIN_BATCH_EXISTS_CONCURRENCY` | Stage | 1000 / 100 → `1000` / `110` (hard cap 110 in `GremlinService`) |
| `NEPTUNE_RETRY_MAX_ATTEMPTS` / `NEPTUNE_RETRY_BASE_DELAY_MS` | Stage | 5 / 1000 → `10` / `1000` (other Lambdas pin 2–3 attempts) |
| `WORKFLOW_BULK_PREFIX` | Stage | `bulk-load` → same |
| `WORKFLOW_SUMMARY_PREFIX` | Stage, Status*, Metrics, aggregate worker | `workflow-summaries` → same |
| `PERSIST_BLOB_*` | Stage | shared blob env (`identity-hashing-and-blobs.md`) |
| `INGEST_FILTERED_BATCH_QUEUE_URL` | Dispatch | required → `FilteredBatchQueue` URL |
| `NEPTUNE_BULK_IAM_ROLE_ARN` / `NEPTUNE_BULK_REGION` | Dispatch, Status*, aggregate worker | required / stack region |
| `NEPTUNE_BULK_START_REQUEST_TIMEOUT_MS` / `NEPTUNE_BULK_STATUS_REQUEST_TIMEOUT_MS` / `NEPTUNE_BULK_REQUEST_TIMEOUT_MS` | Dispatch, Status*, aggregate worker | 120000 / 30000 / legacy fallback → `120000` / `30000` / `30000` |
| `BULK_POLL_INTERVAL_MS` / `BULK_MAX_WAIT_MS` / `NEPTUNE_BULK_STATUS_LOG_EVERY_POLLS` | Dispatch, aggregate worker (Status* pin the poll interval and log cadence but not `BULK_MAX_WAIT_MS`) | 5000 / 840000 / 12 → same |
| `NEPTUNE_FILTERED_BULK_PREFIX` / `INGEST_FILTERED_BATCH_MAX_RECEIVE_COUNT` | aggregate worker | `bulk-load-aggregate` / 5 |
| `WORKFLOW_INDEX_CATCHUP_POLL_INTERVAL_SECONDS` / `WORKFLOW_INDEX_CATCHUP_MAX_ATTEMPTS` | IndexCatchup | 60 / 180 → same |
| `CSV_WORKFLOW_METRICS_COUNT_CONCURRENCY` | Metrics | 8 → `8` |

### 3.10 IAM

- State machine role: `s3:ListBucket` on all buckets (item readers), and `glue:StartJobRun`, `glue:GetJobRun`, `glue:GetJobRuns`, `glue:BatchStopJobRun` on `*` (the optimised Glue integration requires wildcard resources). CDK adds Lambda invoke, child-execution and `events:PutEvents` grants.
- Stage: `neptune-db:connect` + `neptune-db:ReadDataViaQuery` on the cluster; `s3:GetObject` on any object and `s3:ListBucket` on any bucket (inputs may live anywhere); read/write on `bulk-load/*` and `workflow-summaries/*`; put/read on the blob prefix. Staging never starts a load.
- Dispatch: `neptune-db:connect`, `StartLoaderJob`, `GetLoaderJobStatus`, `ListLoaderJobs`; read `bulk-load/*`; `sqs:SendMessage` on `FilteredBatchQueue`.
- Status and StatusSimple: `neptune-db:GetLoaderJobStatus`; read/write `workflow-summaries/*`.
- Validate: `s3:GetObject` any object, `s3:ListBucket` any bucket. CostPredictor: `s3:ListBucket` any bucket.
- Metrics: read `workflow-summaries/*` and `bulk-load/*`. IndexCatchup: `neptune-db:GetStreamRecords`; read on the derived-index state table.

### 3.11 Error catalogue (tagged errors, `lambda/schemas/errors.ts`)

| Error | Raised by | Effect on the run |
| --- | --- | --- |
| `WorkflowInputValidationError` | Start (bad shape, bad URIs, legacy prefix rules), any handler on payload decode, Validate (key outside `/vertices/` or `/edges/`) | Fails the state; not retried |
| `WorkflowCostPredictionError` | CostPredictor (`ListObjectsV2` failure or timeout) | Fails `PredictWorkflowCost` |
| `NeptuneCsvObjectValidationError` / `NeptuneCsvLexiconValidationError` | Validate; Stage when `validationMode == "required"` | Fails the item; message carries the first five issues |
| `NeptuneCsvDedupError` | Stage (oversize object, missing header, missing `~id`/`~from`/`~to`/`~label`, S3 read failure) | Fails the item |
| `PersistBlobStoreError` | Stage (blob materialisation) | Retried by the state machine (§4.11), then fails the item |
| `NeptuneCsvUploadError` | Stage (staged upload), aggregate worker (merged upload) | Fails the item / the group |
| `WorkflowSummaryError` | Stage, StatusSimple, aggregate worker | Stage/StatusSimple: fails the item (after the load succeeded on the direct branch; rerun re-dedups). Aggregate worker: group redelivered or terminal by receive count, and a redelivery re-merges and re-loads (§4.8) |
| `SqsEnqueueError` | Dispatch (`enqueue`) | Fails the item |
| `NeptuneBulkLoadQueueFullError` | Dispatch (`start-load`), aggregate worker | Retried by the state machine on the direct branch; redelivered on the aggregate branch |
| `NeptuneBulkLoadError` | Dispatch (start failure), StatusSimple/Status (non-success terminal, non-transient status failure), aggregate worker | Fails the item / the group |
| `NeptuneBulkLoadTimeoutError` | Aggregate worker (`waitForLoad` past `BULK_MAX_WAIT_MS`) | Group redelivered or terminal by receive count |
| `AsyncFilteredCsvReadError` / `AsyncFilteredCsvParseError` | Aggregate worker (staged CSV missing, malformed, or empty merge) | Group redelivered or terminal by receive count |
| `StepFunctionTaskCallbackError` | Aggregate worker (`SendTaskSuccess`/`SendTaskFailure`) | Message redelivered |
| `WorkflowIndexCatchupError` | IndexCatchup (`GetStreamRecords` failure, no LATEST id, attempts exhausted) | Caught on `CaptureLoadedStreamTarget`; fails the run inside the catch-up loop |
| `CsvWorkflowMetricsError` | Metrics Lambda (summary listing/decoding, staged CSV read) | Per-item errors are counted as `itemsErrored`; listing failures fail the Lambda only |

## 4. Runtime behaviour

### 4.1 Concurrency fencing

The CSV workflow holds no execution lock. `lambda/services/WorkflowLock.ts` (DynamoDB conditional lease with TTL and owner-checked release) exists and is used by the stream-export lock handler only (`neptune-stream-export.md` §4.2). Two concurrent CSV executions run independently; the only cross-execution protection is dedup against the graph at staging time, so two runs loading the same rows can both stage them (the second load then hits `created_at` conflicts, §4.10).

### 4.2 Prepare and lexicon resolution

`PrepareWorkflowInput` passes `{ executionId: $$.Execution.Id, input: $ }`; the Lambda decodes the union schema and normalises as in §3.1. `ResolveWorkflowLexiconUri` then guarantees `$.lexiconDataUri`: a per-execution `lexicon_s3_uri` wins, otherwise `UseDefaultWorkflowLexiconUri` writes the stack's lexicon URI into `$.lexiconDataUri`. Every downstream item selector forwards it, and the validate and stage Lambdas build their layers with `makeWorkflowValidationLayer(lexiconDataUri)` / `makeWorkflowItemStageLayer(lexiconDataUri)`.

### 4.3 Cost gate

`PredictWorkflowCost` receives the whole prepared input. `WorkflowCostPredictorService` pages `ListObjectsV2` (each request bounded by `WORKFLOW_COST_PREDICTOR_REQUEST_TIMEOUT_MS`, both as SDK `requestTimeout` and an Effect timeout) over `glue.inputPrefix` when Glue runs, otherwise over both legacy phase prefixes, summing counts and sizes. `estimatedCostUsd = round4(totalBytes / 2^30 * WORKFLOW_COST_PER_GB_USD + totalObjects / 1000 * WORKFLOW_COST_PER_1000_OBJECTS_USD)`. `status = APPROVED` when `<= costCeilingUsd`, else `REJECTED` and `IsWorkflowCostApproved` routes to the `WorkflowCostCeilingExceeded` Fail state. The handler publishes Powertools metric `CostPredicted` (namespace `persist`, dimension `service=persist`).

### 4.4 Validation map (shared-prefix input only)

`ValidateWorkflowCsvObjects` lists the raw input prefix and invokes `PersistWorkflowValidate` per object with the payload in §3.4 (`maxConcurrencyPath $.maxConcurrency`). Per item:

- Non-`.csv` keys (for example Spark `_metadata.json`) return `skipped: true, skipReason: "Skipping non-CSV workflow object"`.
- Phase is inferred from the key (`vertices/` or `/vertices/`, else `edges/`); anything else fails with `WorkflowInputValidationError`.
- The object is downloaded (timeout `WORKFLOW_VALIDATION_REQUEST_TIMEOUT_MS`) and streamed through the CSV parser; a missing header row is `NeptuneCsvObjectValidationError`.
- `NeptuneCsvLexiconValidationService.prepareValidation(header)` checks structural columns (`MissingStructuralColumn`), header syntax (`InvalidPropertyHeader`), server-managed derived-index properties (`DerivedIndexServerManagedPropertyColumn`), non-ingestable external properties (`ExternalPropertyNotIngestableColumn`), duplicates (`DuplicatePropertyColumn`) and unknown properties (`UnknownPropertyColumn`). `validateRow` per row checks `MissingLabel`, `UnknownVertexLabel` / `UnknownEdgeLabel`, `UnknownProperty`, `DerivedIndexServerManagedProperty`, `CardinalityMismatch` (multi-value `a;b` cells with `\;` escapes on `(single)` columns), `MissingRequiredProperty`, `TypeMismatch`, `EnumMismatch`, `FormatMismatch`, `InvalidCsvValue`, and blob rules `BlobTypeMismatch` / `BlobTooLarge` (`identity-hashing-and-blobs.md`). Errors are rethrown with the first five issues in the message so the Step Functions console shows them.

Because the map validates the raw input, the prepared phases carry `validationMode: "skip"` and staging does not validate again. Legacy input has no validation map; staging validates inline (`validationMode: "required"`).

### 4.5 Rehash (Glue)

`RunPersistSparkRehash` is a `GlueStartJobRun` with `RUN_JOB` (synchronous) and arguments `--input_prefix = $.glue.inputPrefixS3Uri`, `--output_prefix = $.glue.outputPrefixS3Uri`. The job name is resolved at synth time from SSM `/persist-spark/glue/neptune-csv-rehash/job-name`. The job writes Neptune-ready CSVs under `<output>/vertices/` and `<output>/edges/` in the bulk-load bucket; the phase maps list those prefixes.

### 4.6 Phase maps and the per-item chain

`ProcessVertices` runs to completion before `ProcessEdges` starts, so every edge load sees its endpoints. Each item runs `Stage{X}CsvObject` first because the routing basis (`stagedBytes`) does not exist until staging finishes; there is no HeadObject step, since the item reader already supplies `Size` as `objectSize`. `ShouldSkip{X}Item` sends skipped items straight to the `Skip{X}Item` Succeed state, so a skipped object never reaches routing or dispatch. `ShouldAggregate{X}Item` compares the size path against 16 MiB: at or under goes to `Enqueue{X}Aggregate`, over goes to `Start{X}DirectLoad`.

### 4.7 Staging and dedup (`WorkflowItemStageService` → `NeptuneCsvDedupService` → `NeptuneBulkStageService`)

1. `objectSize > WORKFLOW_MAX_OBJECT_SIZE_BYTES` (500 MiB) fails the item with `NeptuneCsvDedupError`. `objectSize == 0` or a key ending in `/` skips with `NO_NEW_ROWS`; a key not ending in `.csv` (case-insensitive) skips with `UNSUPPORTED_KEY`.
2. The object is streamed from S3 into a temp dir `os.tmpdir()/persist-workflow-*/{vertices,edges}.csv`. No header row is an error. The header must contain `~id`; edges must also contain `~from`, `~to`, `~label`.
3. Output header: every inbound `created_at` column (any type suffix) is stripped; `*:Blob` columns are rewritten to `*:String` (their cardinality kept); `created_at:Datetime(single)` (vertices) or `created_at:Datetime` (edges) is appended. One ISO-8601 second-precision timestamp, taken once per object, fills that column for every kept row.
4. Rows are read sequentially, blank lines dropped, a missing `~id` value is an error. Within one object the first occurrence of an id wins; later duplicates count as `rowsExisting`. Rows are batched `NEPTUNE_CSV_DEDUP_BATCH_SIZE` at a time and batches are processed with concurrency `NEPTUNE_CSV_DEDUP_BATCH_CONCURRENCY` (110) for vertices or `NEPTUNE_CSV_EDGE_DEDUP_BATCH_CONCURRENCY` (8) for edges; the lower edge cap protects the reader from edge fan-out. Output order is preserved.
5. Per batch: lexicon row validation when `validationMode == "required"` (sequential); then `GremlinService.findExisting{Vertex,Edge}IdsOnReader`, which chunks ids by `GREMLIN_BATCH_EXISTS_CHUNK_SIZE` and runs `g.V()|g.E().has(id, P.within(...chunk)).id().toList()` on `NEPTUNE_READER_HOST` with up to `GREMLIN_BATCH_EXISTS_CONCURRENCY` (110) chunks in flight, each wrapped in the Gremlin retry policy (`NEPTUNE_RETRY_MAX_ATTEMPTS=10`, base 1000 ms). The reader is the general reader endpoint (autoscaled reader class, `db.r8g.8xlarge`), not the async reader. Existing ids are dropped; surviving rows have `*:Blob` cells materialised to content-addressed S3 URIs (recording `blobs_materialized` and related metrics with `ingest_method=async_csv_upload`) before serialisation.
6. `rowsNew == 0` → skipped `NO_NEW_ROWS`; the stage Lambda writes the skipped summary itself (the only record a skipped item leaves). Otherwise `NeptuneBulkStageService.uploadFilteredCsv` measures the temp file (`stagedBytes`) and puts it at the staged prefix (§3.7). Temp files are removed on success and failure.

Counters: `rowsRead` (data rows seen), `rowsExisting` (in-file duplicates + ids found in Neptune), `rowsNew` (rows written).

### 4.8 Aggregate branch (`action: "enqueue"`)

1. `PersistWorkflowItemDispatch` builds the §3.6 message with `task_token = $$.Task.Token`, sends it to `FilteredBatchQueue` (`SqsEnqueueError` if SQS returns no `MessageId`), and returns the queued result. The `Enqueue{X}Aggregate` state discards that result and waits for the callback; no task timeout or heartbeat is configured.
2. `PersistAsyncBulkAggregateWorker` receives up to six messages per invocation (mixed with GraphSON messages, which take the other branch in `async-graphson-ingest-and-graph-facts.md`), decodes each, and groups CSV-workflow records by `<executionId>:<phase>`. Messages from different executions or phases in one batch form separate groups and separate loads.
3. Per group: read `<source_prefix><phase>.csv` for each unique staged prefix (concurrency 5); merge into one CSV, unioning property columns and widening column types (`identity-hashing-and-blobs.md`); a merged CSV with zero rows is a failure.
4. Upload the merged CSV to `bulk-load-aggregate/<yyyy>/<mm>/<dd>/<batchRequestId>-<executionId>-<phase>/<phase>.csv` and run `NeptuneBulkLoaderService.startAndWait` with `edgeOnlyLoad = phase == "edges"` (poll every `BULK_POLL_INTERVAL_MS`, `NeptuneBulkLoadTimeoutError` after `BULK_MAX_WAIT_MS`).
5. On load success, for each request in order: record `vertices_ingested`/`edges_ingested` (`ingest_method=async_csv_upload`, `phase`) from the message's `rowsNew`, then write the completed summary. Then call `SendTaskSuccess` per token with `{ requestId, ...completed item }`; a callback failure marks that message for redelivery.
6. On any failure before callbacks: a loader queue-full cause redelivers every message in the group (batch item failures); otherwise records with `ApproximateReceiveCount < INGEST_FILTERED_BATCH_MAX_RECEIVE_COUNT` (5) are redelivered and the rest receive `SendTaskFailure("AsyncCsvWorkflowAggregateFailure")` and are consumed. Redelivery re-merges and re-loads the whole group; already-loaded rows then surface as tolerated `created_at` conflicts (§4.10).

### 4.9 Direct branch (`action: "start-load"`) and polling

1. `PersistWorkflowItemDispatch` calls `startLoad(stagedPrefix, { edgeOnlyLoad: phase == "edges" })` and returns the started result (`loadId`, `startedAtEpochMs`) into `$.startResult`.
2. The state machine loops `WaitFor{X}Load` (1 min) → `Check{X}LoadStatus` (input `$.startResult`) → `Is{X}LoadComplete`; there is no maximum poll count, so a load that sits in `LOAD_IN_QUEUE` for hours keeps polling.
3. `PersistWorkflowItemStatusSimple` is a dependency-light handler (plain SDK clients, no Effect layers, module-cached clients) that calls `GetLoaderJobStatus` with `details: true`, up to 5 attempts with 200 ms doubling backoff and a per-request `NEPTUNE_BULK_STATUS_REQUEST_TIMEOUT_MS` abort. `LOAD_NOT_STARTED`, `LOAD_IN_QUEUE`, `LOAD_IN_PROGRESS` return `done: false`.
4. Transient status errors (`getaddrinfo EBUSY`, `EAI_AGAIN`, `ECONNRESET`, `ETIMEDOUT`, or a status request timeout) return `done: false, loaderStatus: "STATUS_CHECK_RETRY_PENDING"` instead of failing the item.
5. On terminal success (§4.10 resolution applies, including the tolerated `created_at` status) it records `vertices_ingested`/`edges_ingested` (`ingest_method=async_csv_upload`) before writing the completed summary, then returns `done: true, item`. The ordering is asserted by `WorkflowItemStatusService.test.ts` for the Effect twin.
6. A non-success terminal status throws `NeptuneBulkLoadError`, which is not retried by the state machine; the map iteration, the map, and the execution fail.

### 4.10 Neptune bulk loader (`NeptuneBulkLoaderService`)

- **Start**: SigV4-signed `POST https://<NEPTUNE_WRITER_HOST>:<NEPTUNE_PORT>/loader` with `{ source, format: "csv", iamRoleArn, region, mode: "NEW", updateSingleCardinalityProperties: false, queueRequest: true, failOnError: false, parallelism: "OVERSUBSCRIBE", edgeOnlyLoad }`. Each attempt is bounded by the start timeout (120 s). Generic send failures retry up to 4 times (5 attempts, 200 ms × 2^n). A response containing `Max load task queue size limit breached` is retried once after a jittered 5–15 s delay; the second failure throws `NeptuneBulkLoadQueueFullError { sourcePrefix, attempts, cause }`.
- **Status**: `GetLoaderJobStatusCommand` with `details: true`; on a non-success terminal status it re-queries with `errors: true`, 25 errors per page, up to 400 pages.
- **Terminal resolution** (`resolveLoaderTerminalResolution`): `LOAD_COMPLETED` is success. `LOAD_FAILED` is treated as success with `loaderStatus = "LOAD_COMPLETED_WITH_TOLERATED_CREATED_AT_CONFLICTS"` (raw status kept in `loaderStatusRaw`, count in `toleratedCreatedAtConflictCount`) only when error logs are non-empty, `parsingErrors` and `datatypeMismatchErrors` are both 0, and every error is `SINGLE_CARDINALITY_VIOLATION` naming property `created_at`. Anything else fails with `NeptuneBulkLoadError` carrying a status summary and a five-entry error sample.
- **Wait**: `waitForLoad` polls every `BULK_POLL_INTERVAL_MS` (5 s), logs progress on status change or every `NEPTUNE_BULK_STATUS_LOG_EVERY_POLLS`, and throws `NeptuneBulkLoadTimeoutError` after `BULK_MAX_WAIT_MS` (14 min). Only the aggregate worker uses the in-Lambda wait; the direct branch is polled by the state machine at one-minute intervals.

### 4.11 Step Functions retry policies

- Every `LambdaInvoke` in this workflow (`addWorkflowLambdaRetry`): errors `Lambda.ServiceException`, `Lambda.AWSLambdaException`, `Lambda.SdkClientException`, `Lambda.ClientExecutionTimeoutException`, `Lambda.TooManyRequestsException`, `Lambda.Unknown`, `Sandbox.Timedout`, `Runtime.ExitError`; 2 s interval, ×2, 6 attempts. `Check{X}LoadStatus` overrides to 1 min interval, 4 attempts, backoff 1.
- `Stage{X}CsvObject` additionally retries `PersistBlobStoreError`: 10 s, ×2, 5 attempts, max delay 300 s, full jitter (blob materialisation happens during staging).
- `Start{X}DirectLoad` additionally retries `NeptuneBulkLoadQueueFullError`: 60 s, ×2, 12 attempts, max delay 600 s, full jitter. `Enqueue{X}Aggregate` deliberately has no such retry; loader contention for aggregated items is absorbed by SQS redelivery.
- `EmitCsvWorkflowMetricsEvent` / `EmitCsvWorkflowLoadedWithoutTarget`: retry `States.ALL` 3 attempts (2 s, ×2) and catch everything to `ShouldWaitForIndexCatchup`, so event emission can never fail the run.
- Typed application errors (`NeptuneCsvDedupError`, `NeptuneCsvLexiconValidationError`, `NeptuneBulkLoadError`, `WorkflowInputValidationError`, ...) are not retried; the Lambda handlers rewrite them into `Error` instances named after the tag so the failure cause is readable in the console.

### 4.12 Post-load tail

After `ProcessEdges`, `CaptureLoadedStreamTarget` invokes the catch-up Lambda with `action: "capture"` and stores `{ targetWatermark: { commitNum, opNum }, waitSeconds, maxAttempts, ... }` at `$.loadedStreamTarget`. This is read here, not by consumers, because only this point means "everything this run loaded is in the stream". Success emits `EmitCsvWorkflowMetricsEvent` with `streamTarget`; a caught failure emits `EmitCsvWorkflowLoadedWithoutTarget` without it (two states because Step Functions resolves every parameter path and would fail on the missing one). Both continue to `ShouldWaitForIndexCatchup`. With `waitForIndexCatchup: true`, `CaptureIndexCatchupTarget` captures a fresh watermark and the loop `WaitForIndexCatchup` (`secondsPath $.indexCatchupStatus.waitSeconds`, 60 s) → `CheckIndexCatchup` → `IsIndexCatchupComplete` runs until the derived-index checkpoint reaches it or `WORKFLOW_INDEX_CATCHUP_MAX_ATTEMPTS` (180) is exhausted, which fails the execution; internals are in `derived-index-discovery-and-catchup.md` §3.6 and §4.6. Otherwise the run goes straight to `WorkflowSucceeded`.

## 5. Observability

- Ingest counters (namespace `persist`): `vertices_ingested` / `edges_ingested` with dimensions `ingest_method=async_csv_upload` and `phase`, emitted on terminal load success by the status-simple Lambda (direct) and the aggregate worker (aggregate); `blobs_materialized`, `blob_bytes_materialized`, `blob_objects_created`, `blob_objects_reused` from staging; `CostPredicted` from the cost predictor.
- Dashboard metrics: `PersistCsvWorkflowMetrics` lists `workflow-summaries/<executionId>/<phase>/*.json`, decodes each summary, counts skipped items, and for loaded items streams `<stagedPrefix><phase>.csv` and counts data rows (header excluded) with concurrency `CSV_WORKFLOW_METRICS_COUNT_CONCURRENCY`; unreadable summaries or expired CSVs are logged and counted as `itemsErrored` rather than failing the run. It publishes `CsvWorkflowVerticesInserted` and `CsvWorkflowEdgesInserted` (namespace `persist`, dimension `service=persist-csv-workflow`) and logs `Published CSV workflow ingest metrics` with `executionId`, `verticesInserted`, `edgesInserted`, `verticesItemsLoaded`, `edgesItemsLoaded`. The `persist-csv-ingest` dashboard (`CsvIngestDashboardStack`, daily sums) and its operational handling are in `operations-dashboards-and-alerting.md` §3.4–3.5.
- Logs: every workflow Lambda annotates `workflowExecutionId`, `workflowPhase`, `workflowItemIndex`, `workflowSourceS3Uri`, `workflowStagedPrefix` or `workflowLoadId`. Key lines: `Workflow item dedup completed`, `Workflow item uploaded filtered CSV`, `Workflow item started its own Neptune load`, `Workflow item joined an aggregated load group`, `Workflow item load still in progress`, `Neptune bulk load queue is full, retrying start request`, `Neptune bulk load completed with tolerated created_at conflicts`, `Neptune bulk load completed with non-success status`.
- The state machine logs at `ALL` level to `PersistWorkflowStateMachineLogGroup`; Distributed Map child executions are visible from the map run.

## 6. Operations and runbook

| Symptom | Cause | Action |
| --- | --- | --- |
| `WorkflowCostCeilingExceeded` | Estimate above `costCeilingUsd` | Re-run with a higher `costCeilingUsd` in the input, or raise `WORKFLOW_COST_CEILING_USD` (25) for the default. The estimate is a size/object-count proxy, not a Neptune bill. |
| `NeptuneBulkLoadQueueFullError` on `Start*DirectLoad` after 12 retries | Too many concurrent direct loads for the Neptune loader queue | The in-Lambda retry is only 2 attempts (5–15 s); the Step Functions retry (12 retries: 60 s, 120 s, 240 s, 480 s, then the 600 s cap, all with full jitter) rides out contention for up to about 95 min of backoff. Lower `maxConcurrency` (default 60), or prefer aggregated loads (they never start a load from the workflow). Retry the failed execution; already-loaded items are deduped away on rerun. |
| Reader connection storms / Gremlin timeouts during staging | `maxConcurrency` stage Lambdas × up to 110 concurrent existence chunks each on the general reader endpoint | Reduce `maxConcurrency`, or lower `NEPTUNE_CSV_DEDUP_BATCH_CONCURRENCY` / `GREMLIN_BATCH_EXISTS_CONCURRENCY` (CDK pins 110, code defaults 100, hard cap 110). The pins were tuned for autoscaled `db.r8g.8xlarge` general readers; the async reader (`db.r8g.12xlarge`) is not on this path. Check the reader endpoint mode (`neptune-reader-topology.md`), since `cluster` mode exposes dedup lookups to the 30 s dedicated-reader ceiling. |
| Load reports `LOAD_COMPLETED_WITH_TOLERATED_CREATED_AT_CONFLICTS` | Rows staged by two overlapping runs, or a rerun racing an in-flight load: the second load hits `created_at(single)` on vertices that now exist | Benign; the item is complete. Sustained noise means concurrent executions over the same input; serialise them (no lock exists, §4.1). |
| `LOAD_FAILED` with parsing or datatype errors | Bad CSV reaching the loader | Read the error sample in the failure cause; fix input; lexicon validation only covers declared properties and types. |
| `Enqueue*Aggregate` never resumes | Message reached the DLQ without the worker running for it (throttling, or a worker crash before callbacks) | Inspect `FilteredBatchDlq`; replay the message or stop the execution. The worker sends `SendTaskFailure` on the fifth receive only when it actually runs. |
| `NeptuneBulkLoadTimeoutError` in the aggregate worker | Merged load exceeded `BULK_MAX_WAIT_MS` (14 min) inside a 15-min Lambda | Message is received up to 5 times (four redeliveries), each starting a new load; raise the threshold only with care, or reduce aggregate size by lowering the SQS `batchSize`. |
| Dashboard shows zero for a run | Event not consumed, or summaries missing | Invoke `PersistCsvWorkflowMetrics` with `{ "executionId": "<execution ARN>" }`; check `PersistCsvWorkflowMetricsRule` and `workflow-summaries/<executionId>/`. Metric counts come from re-reading staged CSVs, so objects deleted by lifecycle rules count as `itemsErrored`. |
| Stage fails with `CSV object exceeds maximum supported size` | Object over 500 MiB | Split the input; the threshold is `WORKFLOW_MAX_OBJECT_SIZE_BYTES`. |
| Route decision looks wrong after a deploy | `workflowRouteSizeBasis` context | Default `staged`; `--context workflowRouteSizeBasis=raw` restores raw-object-size routing without code change. |

## 7. Verification and acceptance

Unit tests (run without AWS): `test/services/WorkflowInputService.test.ts` (all three shapes, alias, lexicon override, catch-up flag, cost override), `WorkflowCostPredictorService.test.ts` (APPROVED/REJECTED, Glue vs legacy prefixes), `NeptuneCsvDedupService.test.ts` (concurrent batches with order preserved, blob column rewrite, String URI pass-through, edge concurrency, first-seen semantics, existing-row filtering, `created_at` override/append, prevalidated skip, lexicon failures), `WorkflowItemStageService.test.ts` (stage-only, skip without dispatch), `WorkflowItemDispatchService.test.ts` (enqueue with token, edge-only direct load, no edge-only for vertices), `WorkflowItemStatusService.test.ts` (pending without side effects, metrics before summary, long-queued polling), `NeptuneBulkLoaderService.test.ts` (timeouts, queue-full detection, retriable status errors, tolerated `created_at` resolution), `NeptuneCsvWorkflowValidationService.test.ts`, `CsvWorkflowMetricsService.test.ts`, `WorkflowLock.test.ts`.

CDK assertions (`test/cdk/persist-stack.test.ts`): item-processor state set is exactly `Stage*`, `ShouldSkip*`, `Skip*`, `ShouldAggregate*`, `Enqueue*Aggregate`, `Start*DirectLoad`, `WaitFor*Load`, `Check*LoadStatus`, `Is*LoadComplete`, `Complete*DirectItem`; `Stage* → ShouldSkip*`; the Choice compares `$.stageResult.stagedBytes <= 16777216` (or `$.objectSize` with raw basis); `Enqueue*` uses `waitForTaskToken` and has no queue-full retry; `Start*DirectLoad` has the `NeptuneBulkLoadQueueFullError` retry and no token; `Stage*` has the `PersistBlobStoreError` retry; no `WORKFLOW_DIRECT_LOAD_THRESHOLD_BYTES`, no route Lambda, no `FinalizeWorkflow`, no synchronous metrics task; `CaptureLoadedStreamTarget → EmitCsvWorkflowMetricsEvent`, catch → `EmitCsvWorkflowLoadedWithoutTarget`, both → `ShouldWaitForIndexCatchup`; stage env pins (4096 MB, 15 min, 110/8/110/10); dispatch env carries the queue URL and loader role but no lexicon, dedup or blob config; SSM parameters present.

E2E (`test/e2e/csv-workflow-metrics.e2e.test.ts`, `pnpm run e2e:csv-metrics`, not part of `pnpm run e2e`): uploads a self-contained lexicon and unique-id CSVs, starts a legacy-shape execution, waits for `SUCCEEDED`, asserts the metrics log line for that execution reports the exact counts, then asserts the CloudWatch datapoints. Takes tens of minutes and writes to the graph.

Acceptance criteria for changes in this area:

- Every state name in §2.1 exists and the item-processor set is unchanged unless the CDK test is updated with it.
- A skipped item leaves exactly one summary and never invokes dispatch.
- An item at or under 16 MiB staged is loaded by the aggregate worker and resumes only through `SendTaskSuccess`; an item over it starts its own load and completes through `done: true`.
- Loader queue saturation never fails an item before the 12-attempt jittered retry is exhausted.
- `created_at`-only single-cardinality conflicts are reported as success with the tolerated status; any parsing or datatype error is a failure.
- The loaded event is emitted before any catch-up wait, with `streamTarget` whenever the watermark read succeeded, and its failure never fails the run.
- Prod defaults: cost ceiling 25, `maxConcurrency` 60, 500 MiB object cap, 1000-row dedup batches, 110/8 batch concurrency, 1000-id chunks at ≤110 concurrency, 10 Gremlin retry attempts.

## 8. Design decisions

- **Staged-size routing.** The aggregate/direct decision measures the staged CSV (`stagedBytes`), the artifact the loader actually reads, not the raw object; an object that is mostly duplicates shrinks to a few rows and should share a loader slot. The raw `objectSize` stays on the state input, so `workflowRouteSizeBasis=raw` rolls back with no extra S3 call and no Lambda change. The former HeadObject route step was removed because the item reader already provides the size.
- **Stage and dispatch are separate Lambdas.** Staging carries the whole dedup cost (4 GB, 10 GiB scratch, VPC reader access, lexicon and blob config); dispatch needs only the loader endpoint and the queue (512 MB, 5 min). Splitting them keeps the routing Choice in the state machine, lets the dispatch Lambda be retried cheaply on loader contention, and keeps the aggregate branch's task token out of the expensive step.
- **Direct-load retry lives in Step Functions.** Only `start-load` calls `StartLoaderJob`, so only it can breach the loader queue. The in-Lambda retry is deliberately short (2 attempts, 5–15 s) to surface a typed `NeptuneBulkLoadQueueFullError`; the state machine then backs off for up to ten minutes per attempt with full jitter, which de-synchronises the `maxConcurrency` concurrent items. Aggregated items instead ride SQS redelivery (queue-full causes are always redelivered, never terminal).
- **Skip before route.** `ShouldSkipItem` precedes `ShouldAggregateItem` so both branches share one skip path and the routing Choice never reads a missing `stagedBytes`.
- **Metrics out of band.** Counting net-new rows re-reads staged CSVs, which can take minutes for large runs; it is triggered by a fire-and-forget EventBridge event emitted before the catch-up wait so it neither delays nor can fail the workflow, and it can be rerun by direct invocation.
- **Watermark captured in-workflow.** A consumer asking Neptune for LATEST when it happens to start would include writes from unrelated runs; the workflow reads it at the only point that means "this run's loads are in the stream" and ships it on the event. A missing watermark is signalled by omission rather than guessed.
- **No execution lock.** Overlapping executions are tolerated at the cost of `created_at` conflict noise; correctness comes from dedup and `mode: NEW` loads, not from fencing.

## 9. Source map (persist repo, relative paths)

- `lib/persist-stack.ts`: Lambda definitions (`PersistWorkflowStart` … `PersistCsvWorkflowMetrics`), `workflowDirectLoadThresholdBytes`, `workflowRouteSizePath`, retry helpers (`addWorkflowLambdaRetry`, `addNeptuneBulkLoadQueueRetry`, `addPersistBlobStoreRetry`), `createWorkflowDispatchPayload`, `createWorkflowPhaseMap`, `DynamicS3ObjectsItemReader`, the validation map, `RunPersistSparkRehash`, the emit states, the catch-up tail, `PersistNeptuneCsvWorkflowRole`, `PersistCsvWorkflowMetricsRule`, SSM parameters; `FilteredBatchQueue` and the aggregate worker event source.
- `bin/app.ts`: `workflowRouteSizeBasis` context validation.
- `lambda/schemas/workflow.ts`, `lambda/schemas/async-bulk.ts`, `lambda/schemas/errors.ts`.
- `lambda/services/WorkflowInputService.ts`, `WorkflowCostPredictorService.ts`, `NeptuneCsvWorkflowValidationService.ts`, `NeptuneCsvLexiconValidationService.ts`, `WorkflowItemStageService.ts`, `NeptuneCsvDedupService.ts`, `NeptuneBulkStageService.ts`, `NeptuneCsvService.ts` (`buildNeptuneBulkKeyPrefix`), `GremlinService.ts` (existence lookups), `WorkflowItemDispatchService.ts`, `AsyncFilteredBatchEnqueueService.ts`, `NeptuneBulkLoaderService.ts`, `WorkflowItemStatusService.ts`, `WorkflowSummaryService.ts`, `WorkflowIndexCatchupService.ts`, `CsvWorkflowMetricsService.ts`, `AsyncBulkAggregateWorkerService.ts` (`processCsvWorkflowGroup`, `handleGroupFailure`), `WorkflowLock.ts` (not used here).
- `lambda/workflow-start/`, `workflow-cost-predictor/`, `workflow-validate/`, `workflow-item-stage/`, `workflow-item-dispatch/`, `workflow-item-status/`, `workflow-item-status-simple/` (`handler.ts`, `status.ts`), `workflow-index-catchup/`, `csv-workflow-metrics/` (`handler.ts`, `metrics.ts`).
- `lib/csv-ingest-dashboard-stack.ts`; `lib/neptune-configuration.ts` (reader instance classes); `lib/debt-index-export-stack.ts` (SUCCEEDED trigger).
- `README.md` "Neptune CSV workflow", "CSV ingest dashboard", "CSV ingest metrics E2E test".
- Tests: `test/cdk/persist-stack.test.ts`, `test/services/*Workflow*.test.ts`, `NeptuneBulkLoaderService.test.ts`, `NeptuneCsvDedupService.test.ts`, `NeptuneBulkStageService.test.ts`, `CsvWorkflowMetricsService.test.ts`, `test/e2e/csv-workflow-metrics.e2e.test.ts`.
