# Asynchronous Gremlin

Asynchronous Gremlin lets a caller submit a read query that may run for up to an hour, poll its status, and cancel it. The API writes a job row and a queue message; an EventBridge Pipe starts a Step Functions execution per message; the execution runs the query inside a Fargate task that talks to the dedicated async Neptune reader through a signed Gremlin HTTP call with a preassigned `queryId`; results land in S3 and the job row becomes terminal. This file is derived from the source code and supersedes the async-Gremlin sections of the PRD. Persist repository paths are relative to that repository.

## 1. Scope and non-goals

In scope:

- `POST /persist/gremlin-async`, `GET /persist/gremlin-async/:requestId`, `DELETE /persist/gremlin-async/:requestId` (`lambda/routes/gremlin-async.router.ts`).
- Job store (DynamoDB), result store (S3), queue message, `GremlinAsyncStateMachine`, Fargate executor, failure handler, cancel semantics.

Out of scope (see siblings):

- Synchronous `POST /persist/gremlin`, `readerTarget`, and the 30 s evaluation ceiling: `gremlin-sync-query.md`.
- Reader instance topology, the async reader's 12 h `neptune_query_timeout`, and why it is shared with the key-list export: `neptune-reader-topology.md`.
- HTTP error envelopes and status codes for every tagged error: `error-catalogue-and-responses.md`.
- Full environment variable and IAM tables: `stacks-configuration-and-iam.md`. Dashboards and alarms: `operations-dashboards-and-alerting.md`, `operations-playbook.md`.

Do not add `readerTarget` to the async submit body. The schema comment states the rule: async execution always runs through the Neptune Data API against the async reader instance, and offering a knob that is silently ignored is worse than not offering it. Note the current behaviour, though: `GremlinAsyncSubmitRequest` has no `readerTarget` field and the submit decoder runs `Schema.decodeUnknown` with only `{ errors: "all" }`, so a body that carries `readerTarget` (or any other extra property) decodes successfully and the field is dropped rather than rejected. Add `onExcessProperty: "error"` to the decoder if a `400` is wanted; no test asserts either behaviour today.

## 2. Architecture

```
client ──POST /gremlin-async──▶ PersistHandler (API Lambda)
                                  ├─ PutItem  GremlinAsyncJobsTable   status=QUEUED   (attribute_not_exists)
                                  └─ SendMessage GremlinAsyncQueue    {schemaVersion,requestId,queuedAt}
                                                   │  DLQ GremlinAsyncDlq (maxReceiveCount 5)
                                                   ▼
                                   GremlinAsyncPipe (batchSize 1, FIRE_AND_FORGET)
                                                   ▼
                                   GremlinAsyncStateMachine (STANDARD, 6000 s, X-Ray)
                                     UnwrapSqsRecord → ValidateAndSetRunning → ShouldExecute
                                        ├─ SKIP → SkipExecution (Succeed)
                                        └─ EXECUTE → ExecuteQuery (ECS RunTask, wait-for-task-token)
                                                       │ TASK_TOKEN, QUEUE_MESSAGE overrides
                                                       ▼
                                          Fargate task (1 vCPU / 2 GiB, ARM64, private subnets)
                                             ├─ signed POST https://<async-reader>:8182/  {gremlin, queryId=requestId}
                                             ├─ poll cancel intent every 5 s ── CancelGremlinQuery on intent
                                             ├─ SendTaskHeartbeat every 60 s
                                             ├─ PutObject GremlinAsyncResultsBucket/gremlin-async/results/YYYY/MM/DD/<requestId>.json
                                             └─ UpdateItem terminal state → SendTaskSuccess / SendTaskFailure
                                        any catch → HandleFailure (cancel Neptune query, then terminalise row)
client ──GET/DELETE /gremlin-async/:requestId──▶ PersistHandler ── GetItem / UpdateItem / CancelGremlinQuery
```

Timeout hierarchy. Every ceiling below is enforced by a different party; keep them ordered as shown when changing any of them.

| Ceiling | Value | Enforced by | Source |
| --- | --- | --- | --- |
| Neptune instance `neptune_query_timeout` on the async reader | 12 h | Neptune parameter group | `README.md` release validation; `neptune-reader-topology.md` |
| Gremlin HTTP watchdog (`GREMLIN_ASYNC_EXECUTION_TIMEOUT_MS`, `GREMLIN_ASYNC_MAX_EXECUTION_TIMEOUT_MS`) | 3 720 000 ms = 1 h + 2 min (`GREMLIN_ASYNC_CLIENT_TIMEOUT_MS`) | Fargate container: Node socket timeout plus `Effect.timeoutFail` | `lib/persist-stack.ts` constants at top of file, container environment |
| Config default for the same variables when unset | 840 000 ms = 14 min (`DEFAULT_EXECUTION_TIMEOUT_MS`); effective value is `min(env, max(MAX env, 14 min))` | `lambda/services/NeptuneDataApiGremlinService.ts` | used by the legacy Lambda worker and any host without the env vars |
| Cancel / status request timeout (`GREMLIN_ASYNC_CANCEL_REQUEST_TIMEOUT_MS`, falls back to `GREMLIN_ASYNC_STATUS_REQUEST_TIMEOUT_MS`) | 30 000 ms default | same service | |
| `ExecuteQuery` heartbeat timeout | 900 s (15 min) | Step Functions (`HeartbeatSeconds`) | `GREMLIN_ASYNC_HEARTBEAT_TIMEOUT_SECONDS` |
| `ExecuteQuery` task timeout | 4 800 s (1 h 20 min) | Step Functions (`TimeoutSeconds`) | `GREMLIN_ASYNC_TASK_TIMEOUT_SECONDS` |
| State machine execution timeout | 6 000 s (1 h 40 min) | Step Functions | `GREMLIN_ASYNC_STATE_MACHINE_TIMEOUT_SECONDS` |
| Fargate container `stopTimeout` | 120 s | ECS | task definition |
| SQS visibility / retention | 15 min / 4 d (DLQ 14 d) | SQS | queue definitions |
| Job row TTL (`GREMLIN_ASYNC_JOB_TTL_SECONDS`) | 7 d from `queuedAt` (604 800 s) | DynamoDB TTL on `ttlEpochSeconds` | `GremlinAsyncJobStoreService` config |
| Result object lifecycle | 7 d expiration | S3 lifecycle rule | `GremlinAsyncResultsBucket` |

The one-hour query ceiling is therefore the watchdog inside the container, not a Neptune setting; the 2 min slack exists so terminal persistence and the callback complete before Step Functions' 80 min task timeout.

## 3. Contracts

### 3.1 Routes

| Method | Path | Success | Errors (HTTP → tag) |
| --- | --- | --- | --- |
| `POST` | `/persist/gremlin-async` | `202 { requestId, status: "QUEUED", queuedAt }` | `400` invalid JSON body or `GremlinSyntaxError` (schema failure, blank query); `503 SqsEnqueueError`, `503 GremlinAsyncJobStoreError`; `500 GremlinAsyncJobSerializationError`, `500 GremlinAsyncJobConditionalConflictError` |
| `GET` | `/persist/gremlin-async/:requestId` | `200` status response | `404 GremlinAsyncRequestNotFoundError`; `503 GremlinAsyncJobStoreError`; `500 GremlinAsyncJobSerializationError` |
| `DELETE` | `/persist/gremlin-async/:requestId` | `202 { requestId, status: "RUNNING" \| "CANCELLED", canceledAt? }` | `404` not found; `503` `GremlinAsyncJobStoreError` (includes "not cancellable in status SUCCEEDED/FAILED/TIMEOUT"), `GremlinAsyncExecutionTimeoutError` (cancel request timed out), `GremlinAsyncCancelError`; `500` serialization / conditional conflict |

All bodies use the standard `{ ok, data }` / `{ ok: false, error }` envelope. The router logs `GremlinSyntaxError` and not-found as warnings and everything else as errors; anything thrown outside the Effect program returns a generic `500`.

### 3.2 Request and response schemas (`lambda/schemas/gremlin-async.ts`)

- `GremlinAsyncSubmitRequest = { gremlin: GremlinQueryText }` — the sync query text schema (1..50 000 chars). The submit service additionally trims the query and rejects a blank result with `GremlinSyntaxError("Gremlin query must not be blank")`. No other property is declared; extra properties are ignored by the decoder (section 1).
- `GremlinAsyncRequestId`: string, 1..128 chars, pattern `^[A-Za-z0-9][A-Za-z0-9._:-]*$`. The service generates UUID v4 values; the pattern exists so a path parameter can be validated and so the same value is legal as a Neptune `queryId`.
- `GremlinAsyncIsoTimestamp`: `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$`.
- `GremlinAsyncStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMEOUT" | "CANCELLED"`; `GremlinAsyncCancelStatus = "RUNNING" | "CANCELLED"`.
- `GremlinAsyncStatusResponse = { requestId, status, queuedAt, startedAt?, finishedAt?, durationMs?, resultS3Uri?, error?, neptuneQueryId? }`. `durationMs = finishedAt - startedAt` only when both exist, parse, and are ordered. `error = { type, message, details? }` is emitted only when both `errorType` and `errorMessage` are stored. The response never inlines the query text or the result body.
- `GremlinAsyncCancelResponse = { requestId, status: RUNNING | CANCELLED, canceledAt? }`.

### 3.3 Queue message

```json
{ "schemaVersion": "1", "requestId": "<GremlinAsyncRequestId>", "queuedAt": "<ISO-8601 UTC>" }
```

`GremlinAsyncQueueMessage` is decoded by `ValidateAndSetRunning`, `HandleFailure`, and the Fargate entrypoint; an undecodable body is skipped (validate) or fails the task with `INVALID_QUEUE_MESSAGE` (Fargate). The query text is not carried in the message; every consumer re-reads it from the job row.

### 3.4 Job item (`GremlinAsyncJobsTable`, partition key `requestId`, TTL attribute `ttlEpochSeconds`, PITR on, PAY_PER_REQUEST)

```ts
GremlinAsyncJobState = {
  requestId: GremlinAsyncRequestId,      // PK
  status: GremlinAsyncStatus,
  gremlinQuery: string,                  // 1..50 000, trimmed
  queryHash: string,                     // sha256 hex of gremlinQuery
  queuedAt: IsoTimestamp,
  startedAt?: IsoTimestamp,              // set by QUEUED→RUNNING CAS
  finishedAt?: IsoTimestamp,             // set by every terminal write
  updatedAt: IsoTimestamp,
  attemptCount: int >= 0,                // 0 at create, +1 per QUEUED→RUNNING
  cancelRequested: boolean,
  canceledAt?: IsoTimestamp,
  neptuneQueryId?: string,               // = requestId once RUNNING
  resultS3Uri?: "s3://...",
  resultSizeBytes?: int >= 0,
  errorType?: string, errorMessage?: string, errorDetails?: Record<string, unknown>,
  sfnExecutionArn?: string,              // owning Step Functions execution
  ttlEpochSeconds: int >= 0              // floor(queuedAt/1000) + GREMLIN_ASYNC_JOB_TTL_SECONDS (default 7 d)
}
```

Store operations (`lambda/services/GremlinAsyncJobStoreService.ts`, raw DynamoDB HTTP client, consistent reads):

| Operation | Condition expression | Notes |
| --- | --- | --- |
| `createQueuedJob` (PutItem) | `attribute_not_exists(#requestId)` | writes `status=QUEUED, attemptCount=0, cancelRequested=false, ttlEpochSeconds` |
| `compareAndSetStatus` (UpdateItem, `ALL_NEW`) | `attribute_exists(requestId) AND status IN (:expected0, …)` | SETs `status, updatedAt` and any of `startedAt, attemptCount, neptuneQueryId, sfnExecutionArn, cancelRequested, canceledAt` |
| `updateCancelIntent` | same status condition | SETs `cancelRequested=true, updatedAt`, optional `canceledAt` |
| `writeTerminalState` | status condition; for every terminal status other than `CANCELLED` also `AND cancelRequested = false` | SETs `status, finishedAt, updatedAt`; SETs or REMOVEs `resultS3Uri`, `resultSizeBytes`; REMOVEs `errorType/errorMessage/errorDetails` when no error |

`ConditionalCheckFailedException` maps to `GremlinAsyncJobConditionalConflictError`; every caller re-reads the row on conflict and reconciles instead of retrying blindly. The extra `cancelRequested = false` guard is what makes persisted cancel intent win against a concurrent `SUCCEEDED`/`FAILED`/`TIMEOUT` write.

Status transitions:

```
            submit                          validate CAS                      Fargate / HandleFailure
  (none) ──────────▶ QUEUED ──────────────────────────▶ RUNNING ──────────────▶ SUCCEEDED
                       │  enqueue failed → FAILED           │                     FAILED
                       │  DELETE, or validate with intent   │  DELETE (cancel query) TIMEOUT
                       └──────────────▶ CANCELLED ◀─────────┴──────────────────▶ CANCELLED
  HandleFailure may also move QUEUED → FAILED/TIMEOUT/CANCELLED when ValidateAndSetRunning itself fails.
```

### 3.5 Result document (`GremlinAsyncResultsBucket`, key `gremlin-async/results/YYYY/MM/DD/<requestId>.json`, `application/json`)

```jsonc
{
  "schemaVersion": "1",
  "requestId": "...",
  "storedAt": "<finishedAt>",
  "metadata": { "status": "SUCCEEDED", "queuedAt": "...", "attemptCount": 1, "cancelRequested": false,
                "startedAt": "...", "finishedAt": "...", "durationMs": 0, "neptuneQueryId": "<requestId>" },
  "payload": { /* decoded Gremlin HTTP response: requestId, status: {code, message}, result: {data}, ... */ }
}
```

The date path segments come from `storedAt` in UTC. `resultSizeBytes` is the UTF-8 byte length of the serialized document. The bucket is `GREMLIN_ASYNC_RESULTS_BUCKET`; the prefix is `GREMLIN_ASYNC_RESULTS_PREFIX` (default `gremlin-async/results`).

## 4. State machine (`GremlinAsyncStateMachine`)

Delivery: `GremlinAsyncPipe` reads `GremlinAsyncQueue` with `batchSize: 1` and starts one execution per message with `invocationType: FIRE_AND_FORGET`. The Pipe input is the SQS record array; `UnwrapSqsRecord` is a Pass state with `inputPath: $[0]`, so downstream `$.body` is the raw SQS body string (the queue message JSON). The Pipe deletes the message once `StartExecution` succeeds; the queue's `maxReceiveCount: 5` DLQ policy only covers Pipe delivery failures, not query failures.

| State | Type | Input / output | Retry / catch |
| --- | --- | --- | --- |
| `UnwrapSqsRecord` | Pass | `$[0]` | — |
| `ValidateAndSetRunning` | LambdaInvoke `GremlinAsyncValidate` (256 MB, 60 s, VPC) | payload `{ body: $.body, executionArn: $$.Execution.Id }`; `resultSelector { action: $.Payload.action }` → `$.validateResult` | retry `States.ALL` interval 2 s, backoff 2, `maxAttempts 3`; `retryOnServiceExceptions: false`; catch → `HandleFailure` with `resultPath $.errorInfo` |
| `ShouldExecute` | Choice | `$.validateResult.action == "SKIP"` → `SkipExecution`, otherwise `ExecuteQuery` | — |
| `SkipExecution` | Succeed | comment "Job was cancelled or not in QUEUED state" | — |
| `ExecuteQuery` | EcsRunTask, `WAIT_FOR_TASK_TOKEN`, Fargate `LATEST`, private-with-egress subnets, Lambda security group, no public IP | container overrides `TASK_TOKEN = $$.Task.Token`, `QUEUE_MESSAGE = $.body`; `resultPath $.ecsResult` | `HeartbeatSeconds 900`, `TimeoutSeconds 4800`; catch → `HandleFailure` with `resultPath $.errorInfo` |
| `HandleFailure` | LambdaInvoke `GremlinAsyncFailureHandler` (256 MB, 60 s, VPC) | payload `{ body: $.body, executionArn: $$.Execution.Id, retryCount: $$.State.RetryCount, maxRetryCount: 3, errorInfo: $.errorInfo }`; `resultPath $.failureResult` | retry `States.ALL` interval 2 s, backoff 2, `maxAttempts 4` (= `GREMLIN_ASYNC_FAILURE_FINAL_RETRY_COUNT + 1`) |

Execution timeout 6 000 s, `tracingEnabled: true`, STANDARD type. The CDK test asserts the state names, `$$.Execution.Id`, `$$.State.RetryCount`, `maxRetryCount`, `HeartbeatSeconds 900`, `TimeoutSeconds 4800`, `6000`, and that no `$.Payload.requestId/gremlinQuery/queuedAt` leaks into the definition.

### 4.1 `ValidateAndSetRunning` (`lambda/gremlin-async-validate/handler.ts`)

1. Decode `body` as `GremlinAsyncQueueMessage`; on failure log and return `{ action: "SKIP" }`.
2. Read the row (consistent). Missing → `SKIP`.
3. Same-execution retry path: if `status == RUNNING` and `sfnExecutionArn == executionArn`, return `EXECUTE` immediately. This is what makes the `States.ALL` retry safe when the CAS committed but the Lambda invocation failed afterwards.
4. If `status == CANCELLED` or `cancelRequested`: when the row is still `QUEUED` with intent, write terminal `CANCELLED` (`expectedStatuses [QUEUED]`, conflicts logged and ignored); return `SKIP`.
5. Any other non-`QUEUED` status → `SKIP` (a `RUNNING` row owned by another execution is never touched).
6. `compareAndSetStatus(QUEUED → RUNNING)` with `startedAt = now`, `attemptCount + 1`, `neptuneQueryId = requestId`, `sfnExecutionArn = executionArn`, `cancelRequested = false`. Conflict → `SKIP`. Success → `{ action: "EXECUTE", requestId, gremlinQuery, queuedAt }` (only `action` is kept by the state machine).

Stamping `neptuneQueryId = requestId` before the query is submitted is what lets `DELETE` and `HandleFailure` cancel by id without waiting for the container.

### 4.2 `HandleFailure` (`lambda/gremlin-async-failure/handler.ts`)

Input `{ body, executionArn, retryCount, maxRetryCount, errorInfo? }`.

1. Decode the queue message; read the row. Missing, already terminal, or `RUNNING` with a different `sfnExecutionArn` → log and return (no-op).
2. If `RUNNING`, call `CancelGremlinQuery(queryId = neptuneQueryId ?? requestId)` on the async reader. A "query not found" style failure (`isNeptuneQueryNotFoundCancellation`: `QueryNotFoundException`, `NotFoundException`, "not found", "does not exist", "no running query", "unknown query") is treated as already gone. Any other cancel failure re-throws while `retryCount < maxRetryCount` (3), so Step Functions retries the state; on the fourth attempt it proceeds regardless so a stranded `RUNNING` row is still terminalised.
3. Map the terminal status: `cancelRequested` → `CANCELLED`; otherwise `errorInfo` (JSON-stringified catch object) matching `/States\.Timeout/i` → `TIMEOUT`; otherwise `FAILED`. Error type is `GremlinAsyncWorkflowTimeout` or `GremlinAsyncWorkflowFailure`; message is the stringified `errorInfo` or "Gremlin async Fargate task failed before sending a callback".
4. `writeTerminalState` with `expectedStatuses [current status]`. On conflict: re-read; terminal → done; owned by another execution → skip; non-terminal with intent → write `CANCELLED`; non-terminal without intent → re-throw while retries remain, else best-effort cancel again and write the mapped status (`cancelRequested=false`).

Because the Fargate entrypoint reports every non-success terminal via `SendTaskFailure(error = <status>)`, `HandleFailure` runs after `FAILED`, `TIMEOUT`, and `CANCELLED` outcomes as well; step 1 makes those invocations no-ops.

## 5. Fargate executor runtime

Task definition `GremlinAsyncTaskDef`: Fargate, `cpu 1024`, `memoryLimitMiB 2048`, `ARM64 / LINUX`, cluster `GremlinAsyncCluster` (Container Insights disabled), log group `GremlinAsyncFargateLogGroup` (stream prefix `gremlin-async-fargate`, 3-month retention), `stopTimeout 120 s`. Image: `lambda/fargate/Dockerfile` builds `lambda/fargate/gremlin-async-fargate-entrypoint.ts` with esbuild into `dist/index.mjs` on `node:24-slim` (`ENTRYPOINT ["node", "index.mjs"]`), platform `LINUX_ARM64`.

Container environment: `POWERTOOLS_SERVICE_NAME=persist-gremlin-async-fargate`, `NEPTUNE_READER_HOST` (general reader; `NEPTUNE_HOST` is also set but read by nothing), `NEPTUNE_WRITER_HOST`, `NEPTUNE_ASYNC_READER_HOST` (async reader instance endpoint), `NEPTUNE_PORT`, `GREMLIN_ASYNC_JOBS_TABLE_NAME`, `GREMLIN_ASYNC_RESULTS_BUCKET`, `GREMLIN_ASYNC_RESULTS_PREFIX`, `GREMLIN_ASYNC_EXECUTION_TIMEOUT_MS=3720000`, `GREMLIN_ASYNC_MAX_EXECUTION_TIMEOUT_MS=3720000`, plus the OpenSearch environment. Per-run overrides: `TASK_TOKEN`, `QUEUE_MESSAGE`. Task role: `neptune-db:connect/ReadDataViaQuery/WriteDataViaQuery/DeleteDataViaQuery/GetQueryStatus/CancelQuery` on the cluster, `dynamodb:GetItem/UpdateItem` on the jobs table, `s3:PutObject` on `<prefix>/*`, `states:SendTaskSuccess/SendTaskFailure/SendTaskHeartbeat` on `*`, optional OpenSearch and search-sync-state reads.

`NeptuneDataApiGremlinService` resolves the endpoint as `https://<NEPTUNE_ASYNC_READER_HOST ?? NEPTUNE_READER_HOST>:<NEPTUNE_PORT>` so execution, status, and cancel all hit the same pinned instance. The query is a SigV4-signed (`service=neptune-db`) raw HTTPS `POST /` with body `{ "gremlin": <query>, "queryId": <requestId> }`, `accept: application/json`; success requires both an HTTP 2xx and a 2xx `status.code` inside the Gremlin response. Cause mapping: `CancelledByUserException` / "cancelled by user" → `GremlinAsyncQueryCancelledError`; socket timeout, `status.code 598`, `TimeLimitExceededException`, `ClientTimeoutException`, "timed out" → `GremlinAsyncExecutionTimeoutError`; anything else → `GremlinAsyncExecutionError`. Cancel uses the SDK `CancelGremlinQueryCommand` with the cancel timeout.

Entrypoint control flow (`runFargateWorker`):

1. Require `TASK_TOKEN`; a missing or invalid `QUEUE_MESSAGE` sends `SendTaskFailure(MISSING_QUEUE_MESSAGE | INVALID_QUEUE_MESSAGE)` and exits 1.
2. Read the row. Missing → `SendTaskFailure(JOB_NOT_FOUND)`; not `RUNNING` → `SendTaskFailure(INVALID_STATE)`.
3. `cancelRequested` already set → best-effort `CancelGremlinQuery`, write `CANCELLED`, callback, exit.
4. Race two fibers with `Effect.raceFirst`:
   - Heartbeat fiber: `SendTaskHeartbeat` immediately, then every 60 s. Transient failures retry up to 4 times with 2, 4, 8, 16 s delays; `TaskTimedOut`, `InvalidToken`, `TaskDoesNotExist` are permanent. A permanent failure re-reads the row, best-effort cancels Neptune (`trigger=heartbeat_failure`), and terminalises: intent → `CANCELLED`; `TaskTimedOut` → `TIMEOUT`; else `FAILED`.
   - Execution fiber: `raceFirst(executeGremlinQuery, waitForCancellation)`. `waitForCancellation` reads the row immediately and then every 5 s; once `cancelRequested` or a terminal status is seen it calls `CancelGremlinQuery(neptuneQueryId ?? requestId)`. Success → `CANCELLATION` outcome. "Not found" while the row is non-terminal means the query has not reached Neptune yet: keep polling (this closes the pre-submit race described in section 6). Other cancel errors retry after 5 s.
5. Outcomes:
   - `CANCELLATION` → terminal `CANCELLED`, `canceledAt = now`, `neptuneQueryId` from the signal.
   - Execution error → re-read row; `cancelRequested` → `CANCELLED`; `GremlinAsyncExecutionTimeoutError` → `TIMEOUT`; else `FAILED` (this includes `GremlinAsyncQueryCancelledError` when no intent is persisted). Best-effort cancel with trigger `execution_cancelled | execution_timeout | execution_failure`; `neptuneQueryId` taken from the error when present.
   - Execution success → re-read row; late intent → `CANCELLED`; otherwise write the result document, then `writeTerminalState(RUNNING → SUCCEEDED)` with `resultS3Uri`, `resultSizeBytes`, `neptuneQueryId`. If result persistence fails, terminalise `FAILED` (or `CANCELLED` on intent) keeping `neptuneQueryId`.
6. `writeTerminalAndCallback`: on a conditional conflict re-read the row; if a terminal state exists, send the callback that matches it (`SendTaskSuccess({requestId, status})` for `SUCCEEDED`, otherwise `SendTaskFailure(error = status, cause = errorMessage ?? status)`); if the state cannot be resolved send `STATE_CONFLICT`; if the reconciliation read fails send `STATE_RECONCILIATION_FAILED`. Unhandled errors send `UNHANDLED_ERROR`.

`SIGTERM` only logs; the ECS `stopTimeout` and the Step Functions timeouts bound the shutdown.

## 6. Cancel semantics

`GremlinAsyncCancelService.cancel(requestId)`:

| Row state | Action | Response |
| --- | --- | --- |
| missing | — | `404` |
| `QUEUED` | `writeTerminalState(QUEUED → CANCELLED, cancelRequested=true, canceledAt)` | `202 { status: "CANCELLED", canceledAt }` |
| `QUEUED` but CAS to `RUNNING` won first (conflict) | re-read; if `RUNNING`: `updateCancelIntent`, then `CancelGremlinQuery(neptuneQueryId)`, then terminal `CANCELLED` | `CANCELLED`, or `RUNNING` if the query is not yet visible to Neptune |
| `RUNNING` with `neptuneQueryId` (always true after validate) | `updateCancelIntent(RUNNING)` first, then `CancelGremlinQuery(queryId = requestId)` on the pinned instance, then `writeTerminalState(RUNNING → CANCELLED)` | `202 { status: "CANCELLED", canceledAt }` |
| `RUNNING` without `neptuneQueryId` | `updateCancelIntent` only (defensive fallback; unreachable with the current validate handler) | `202 { status: "RUNNING" }` |
| `CANCELLED` | echo | `202 { status: "CANCELLED", canceledAt? }` |
| `SUCCEEDED` / `FAILED` / `TIMEOUT` | fail | `503 GremlinAsyncJobStoreError` "not cancellable in status …" |

Rules that follow from the code:

- Intent is persisted before Neptune is called, so a cancel that fails half-way still leaves `cancelRequested=true`; the Fargate poll (5 s) or `HandleFailure` finishes the job.
- A "query not found" answer from Neptune while the row is `RUNNING` returns `RUNNING` with intent stored; the container's first cancellation check (which runs before the first sleep) cancels as soon as the query is registered.
- Any conditional conflict re-reads and returns the resolved state, which makes repeated `DELETE` calls idempotent.
- Cancel-timeout and cancel errors other than not-found propagate as `503`; the intent is already stored, so the caller may simply retry.
- After a cancel, expect the request id to disappear from the pinned reader's `/gremlin/status` listing before the Persist status flips to `CANCELLED`.

## 7. Observability

- Log groups / `POWERTOOLS_SERVICE_NAME`: `persist` (API), `persist-gremlin-async-validate`, `persist-gremlin-async-failure`, `persist-gremlin-async-fargate` (ECS awslogs, stream prefix `gremlin-async-fargate`), `persist-gremlin-async-worker` (legacy Lambda, no traffic). All JSON, three-month retention.
- Search keys: `requestId`, `queryId`, `executionArn`, `trigger`, `status`, `errorTag`. Useful messages: "Gremlin async request queued", "Validate: job set to RUNNING", "Validate: retry owns existing RUNNING transition", "Fargate worker starting/finished", "Fargate worker heartbeat failed", "Fargate worker execution cancelled/failed", "Fargate worker lost terminal-state race", "Gremlin async failure handler skipped job owned by another execution", "Cancelling Neptune async Gremlin query".
- X-Ray tracing is enabled on the state machine; the Step Functions console shows `ExecuteQuery` heartbeat and timeout events and the `HandleFailure` retry count.
- The async path emits no custom CloudWatch metrics and the stack defines no alarms specific to it. Use Step Functions `ExecutionsFailed`/`ExecutionsTimedOut`, ECS task stop reasons, `GremlinAsyncDlq` depth, and DynamoDB scans for rows stuck non-terminal (section 8).

## 8. Operations and release validation

Pre-flight (from `README.md` "Async Gremlin release validation"): `./scripts/start-gremlin-test.sh`, `pnpm check`, `pnpm test`, `pnpm cdk:synth`. Confirm the runtime policy in the synthesized template: async reader host pinned for Fargate and the failure handler, `3720000` for both execution timeout variables, `HeartbeatSeconds 900`, `TimeoutSeconds 4800`, execution timeout `6000`, and the `ValidateAndSetRunning`/`HandleFailure` states present (`test/cdk/persist-stack.test.ts` asserts all of these).

Deployed smoke checks (the README's four steps; run them with `awscurl -p <aws-profile>` against `https://<api-id>.execute-api.<region>.amazonaws.com/persist/...`):

1. Quick success path: `POST` `{"gremlin":"g.V().limit(1).count()"}` → `202 QUEUED`; poll `GET` until `SUCCEEDED` with `resultS3Uri` and `neptuneQueryId == requestId`.
2. Cancel a genuinely running multi-minute request with `DELETE`. From a host with VPC access confirm the request id disappears from the pinned reader's `/gremlin/status` response before the Persist status becomes `CANCELLED`. Repeat `DELETE`; it must return the same `CANCELLED` payload.
3. Soak beyond the old 65-minute heartbeat boundary with an approved long-running query; the job must stay `RUNNING` past 65 min and end as `SUCCEEDED` or `TIMEOUT` at roughly 62 min of query time, never as a heartbeat failure.
4. Poll status until terminal and verify only `SUCCEEDED` / `CANCELLED` / `TIMEOUT` appear, the status body never inlines the result, and the S3 object at `resultS3Uri` is readable.

Rollback: keep infrastructure, redeploy the last known-good revision (`git checkout <revision> && pnpm cdk:deploy`), re-run the `/persist/gremlin` and `/persist/gremlin-async` smoke checks, and confirm no rows remain in `QUEUED`/`RUNNING` without terminal updates.

Runbook — job stuck non-terminal:

1. `GET` the status; read the row directly if the API is unavailable (`aws dynamodb get-item` on `GREMLIN_ASYNC_JOBS_TABLE_NAME` with `AWS_PROFILE=<selected-profile>` and the account/region check from the AWS access flow).
2. `QUEUED` and older than a few minutes: check `GremlinAsyncDlq` and the Pipe's failure logs; a message that never started an execution can be redriven from the DLQ, or the job can be closed with `DELETE` (→ `CANCELLED`).
3. `RUNNING`: look up `sfnExecutionArn` in the Step Functions console. Execution still running → let the 4 800 s / 6 000 s ceilings and `HandleFailure` finish it, or `DELETE` to cancel now. Execution finished but row still `RUNNING` → `HandleFailure` skipped it (another execution owns it, or all four attempts failed); invoke the failure handler input manually or `DELETE`, which cancels by `queryId = requestId` and writes `CANCELLED`.
4. Confirm the query is gone from the async reader's `/gremlin/status`; cancel it there with the request id if Neptune still lists it.
5. Never edit the row to `SUCCEEDED` by hand; a `SUCCEEDED` row without `resultS3Uri` violates the contract.

Legacy: `PersistAsyncGremlinWorker` (`lambda/gremlin-async-worker/handler.ts`, `GremlinAsyncWorkerService`) is still deployed with `GREMLIN_ASYNC_EXECUTION_TIMEOUT_MS=840000`, status polling variables, and `GREMLIN_ASYNC_MAX_RECEIVE_COUNT=5`, but its SQS event source was removed; the Pipe → Step Functions → Fargate path does not read `GREMLIN_ASYNC_MAX_RECEIVE_COUNT`. Treat those variables as legacy-only and do not document them as part of the live retry policy.

## 9. Verification and acceptance

Unit and CDK tests to keep green: `test/routes/gremlin-async.router.test.ts` (202/400/404/500/503 mapping), `test/services/GremlinAsyncSubmitService.test.ts`, `GremlinAsyncStatusService.test.ts`, `GremlinAsyncCancelService.test.ts` (queued cancel, queued→running race, running with id, intent-only fallback, pre-submit not-found stays pending, not-found racing completion, idempotent repeats), `GremlinAsyncJobStoreService.test.ts`, `GremlinAsyncResultStoreService.test.ts`, `GremlinAsyncFargateWorker.test.ts` (success path, TIMEOUT, FAILED, Neptune-cancelled-without-intent → FAILED, lost terminal race callback, reconciliation failure, missing job, wrong state, pre-execution cancel, immediate intent check, stop polling when terminalised elsewhere, immediate heartbeat and cancel before TIMEOUT, intent preserved on heartbeat failure, result-persistence losing a cancel race, late cancel after success), and the async assertions in `test/cdk/persist-stack.test.ts`. There is no automated end-to-end suite for this path; the section 8 smoke checks are manual.

Acceptance criteria:

- Submit returns `202` with a UUID `requestId`, and a row exists with `status=QUEUED`, `attemptCount=0`, `cancelRequested=false`, `ttlEpochSeconds = queuedAt + 7 d`; an enqueue failure leaves the row `FAILED` and returns `503`.
- A body with `readerTarget` or any extra property is accepted with the extra field dropped; the job still runs on the async reader (section 1 explains how to turn this into a `400`).
- Exactly one state machine execution runs per queue message; the row moves `QUEUED → RUNNING` once, stamping `startedAt`, `attemptCount=1`, `neptuneQueryId=requestId`, `sfnExecutionArn`.
- The Fargate task submits `{gremlin, queryId=requestId}` to the async reader host, heartbeats every 60 s, and completes queries that run longer than 65 min.
- A query exceeding 3 720 000 ms ends as `TIMEOUT` with `errorType=GremlinAsyncExecutionTimeoutError`; a task that never calls back ends as `TIMEOUT` (`GremlinAsyncWorkflowTimeout`) via `HandleFailure` after the 4 800 s task timeout.
- `DELETE` on a `RUNNING` job persists intent before cancelling, cancels the query on the same instance, and returns `CANCELLED`; repeating it returns the same payload; `DELETE` on `QUEUED` returns `CANCELLED` without an execution running the query.
- `SUCCEEDED` rows carry `resultS3Uri`, `resultSizeBytes`, `finishedAt`; the object matches the section 3.5 document; the status response never contains the result body.
- No row remains `RUNNING` after its owning execution has finished.
- Rows and result objects expire after 7 days.

## 10. Source map

| Concern | Persist repository path |
| --- | --- |
| Routes | `lambda/routes/gremlin-async.router.ts`; HTTP mapping `lambda/http/responses.ts`; OpenAPI `docs/openapi.json` (`/persist/gremlin-async*`) |
| Schemas | `lambda/schemas/gremlin-async.ts`; errors `lambda/schemas/errors.ts` |
| Submit / status / cancel | `lambda/services/GremlinAsyncSubmitService.ts`, `GremlinAsyncStatusService.ts`, `GremlinAsyncCancelService.ts` |
| Job store / result store | `lambda/services/GremlinAsyncJobStoreService.ts`, `GremlinAsyncResultStoreService.ts` |
| Neptune Data API client (signed HTTP execute, SDK cancel/status, timeouts) | `lambda/services/NeptuneDataApiGremlinService.ts` |
| Step Functions callbacks | `lambda/services/StepFunctionsCallbackService.ts` |
| Validate / failure handlers | `lambda/gremlin-async-validate/handler.ts`, `lambda/gremlin-async-failure/handler.ts` |
| Fargate executor | `lambda/fargate/gremlin-async-fargate-entrypoint.ts`, `lambda/fargate/Dockerfile` |
| Legacy Lambda worker | `lambda/gremlin-async-worker/handler.ts`, `lambda/services/GremlinAsyncWorkerService.ts` |
| Infrastructure (constants, queue, table, bucket, state machine, Pipe, task definition, IAM) | `lib/persist-stack.ts` |
| Tests | `test/routes/gremlin-async.router.test.ts`, `test/services/GremlinAsync*.test.ts`, `test/cdk/persist-stack.test.ts` |
| Release validation and smoke commands | `README.md` "Async Gremlin release validation" |
