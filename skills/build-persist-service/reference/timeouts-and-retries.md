# Timeouts and Retries — Decision Guide

This file decides how to bound a Neptune operation in time and when a failed attempt may be repeated. It does not restate constants: every ceiling, indicator list and env var lives in the fact files named in §8, and a number is quoted here only where the decision turns on it. Read `neptune-reader-topology.md` §3.4 for the ceiling table, `gremlin-sync-query.md` §8 for the classifier, `async-gremlin.md` §2 for the async ladder and `error-catalogue-and-responses.md` §3 for status codes; use this file to choose between them. Reader roles are named `portal` and `agency` as in the topology file; the shipped literals are deployment-specific.

## 1 Scope

- Covers every path that holds a Neptune query, transaction, loader job or stream fetch open: sync Gremlin, explain, GraphQL, sync and async GraphSON ingest, async Gremlin, the CSV workflow, the two stream pollers and the stream export.
- Decides four things: which ceiling bounds a given query, how the ceilings must nest, whether a failure may be retried and by whom, and what a caller does with each outcome.
- Out of scope: OpenSearch client retry internals (`opensearch-fts-mirror.md` §5.5), Athena export retry (`neptune-stream-export.md` §4.8), and vendor HTTP retry inside GraphQL adapters (`graphql-read-surface.md` §6.3). They are cited where the same rule applies.

## 2 The ceilings and how they nest

Invariant: every outer ceiling must exceed the inner one plus the overhead spent outside the query (retry back-off, connection open, result serialisation, callback). When it does not, the party enforcing the outer ceiling gives up while the inner work continues: a Gremlin client that disconnects does not stop the query, so Neptune keeps the reader busy until the innermost ceiling that is still running fires. Each ladder below reads innermost first; the caller's deadline is the outermost rung and is recommended practice, not enforced by Persist.

**Sync Gremlin (`POST /persist/gremlin`)**

```
neptune_query_timeout on the target: 1 h general pool | 30 s portal / agency reader
  └─ evaluationTimeout per request, clamped 10–30,000 ms (default = ceiling)
       └─ withRetry budget on the REST handler: 2 retries, 1 s base (1 + 2 s back-off)
            └─ Lambda 30 s
                 └─ HTTP API integration 29 s
                      └─ caller deadline ≥ 30 s; treat a gateway timeout as a 504
```

**Explain (`POST /persist/gremlin/explain`)**

```
neptune_query_timeout on the target (as above)
  └─ request timeout 25 s (also the maximum), SDK maxAttempts 1, Effect timeout around the call
       └─ Lambda 30 s  └─ HTTP API 29 s  └─ caller deadline ≥ 26 s
```

**GraphQL (`POST /persist/graphql`)**

```
neptune_query_timeout: 1 h general pool (readerTarget is always default)
  └─ graph fields: evaluationTimeout 30 s + 3 retries at 1 s base (1 + 2 + 4 s)
  └─ DynamoDB and vendor fields: GRAPHQL_FIELD_TIMEOUT_MS 5 s each
       └─ Lambda 30 s  └─ HTTP API 29 s  └─ caller deadline ≥ 30 s
```

Graph fields are **not** bounded by the field timeout: nothing inside the request stops a slow graph traversal before Neptune's 30 s evaluation ceiling or the Lambda does, and a timeout there surfaces as a field error, never as a 504.

**Sync ingest (`POST /persist/ingest`) and the fact handler's sync route**

```
writer neptune_query_timeout 1 h (upserts carry no evaluationTimeout)
  └─ ref lookup on the general reader: 10 s per attempt inside withRetry
  └─ blob materialisation: 10 s per object, 120 s total, 8 attempts
  └─ transaction: whole batch inside withRetry, commit last
       └─ two retry units per request: 2 retries (API) | 3 retries (fact handler)
            └─ Lambda 30 s (API) | 60 s (fact handler, EventBridge redelivers 3 times over 2 h)
                 └─ HTTP API 29 s (API only)  └─ caller deadline ≥ 30 s
```

**Async Gremlin**

```
neptune_query_timeout on the async reader: 12 h
  └─ HTTP watchdog in the container: 1 h + 2 min (legacy Lambda worker: 14 min inside a 15 min Lambda)
       └─ Step Functions heartbeat 15 min (container sends one every 60 s)
            └─ Step Functions task timeout 1 h 20 min
                 └─ state machine 1 h 40 min  └─ container stopTimeout 120 s on the way down
                      └─ job row TTL 7 d; the caller polls status and never holds a connection
```

**Workflows and pollers**

```
bulk loader:   start request 120 s → status request 30 s → in-Lambda wait 14 min → worker Lambda 15 min → SQS visibility 30 min
               (direct branch: state machine polls every 1 min instead of waiting in the Lambda)
index poller:  stream fetch 30 s → iteration budget remaining − 5 s → stop below INDEX_STREAM_MIN_REMAINING_MS → Lambda 3 min → lease TTL = remaining + 5 s
search poller: same core → Lambda 5 min → fixed lease 360 s (must stay above the Lambda timeout)
item stage:    withRetry 10 retries (back-off capped at 30 s per sleep) → Lambda 15 min → Step Functions Lambda-fault retry
```

What happens when the nesting breaks, and which knob to move:

- **API ceiling equals the runtime ceiling (sync Gremlin, GraphQL).** The `evaluationTimeout` is 30 s and so is the Lambda, so a query that reaches the boundary may return API Gateway's timeout instead of the typed 504. This is shipped and accepted: the ceiling cannot go higher because a dedicated reader rejects any per-query value above its 30 s parameter. Lower `GREMLIN_SYNC_EVALUATION_TIMEOUT_MS` if you want the typed 504 to always win; never raise the Lambda timeout, the integration cannot follow it.
- **Retry back-off outside the window.** The budget is what shrinks when the window is fixed: the API handler keeps 2 retries because one ingest request pays the budget twice (ref lookup, then transaction); GraphQL keeps 3; the fact handler keeps 3 inside 60 s because no client waits on it. The five-retry code default sleeps 31 s and is killed by a 30 s Lambda before its last attempt, so pin `NEPTUNE_RETRY_MAX_ATTEMPTS` per function and never inherit the default on a request/response handler.
- **Async: heartbeat versus task timeout.** The heartbeat (15 min) catches a dead container; the task timeout (1 h 20 min) catches a live container whose query outlived the 1 h + 2 min watchdog; the state machine (1 h 40 min) catches everything else. Keep this order. Raising the query watchdog requires raising the task and state-machine timeouts by the same amount plus the 2 min persistence slack, and it still must stay under the async reader's 12 h.
- **Lambda killed mid-transaction (sync ingest).** `withTransaction` commits last and rolls back in its release step; a hard Lambda timeout skips the release, so nothing is committed and the session dies with the connection. The request is safe to resubmit because every upsert is a content-hash no-op on replay. Move the payload to `POST /persist/ingest-async` rather than raising the API Lambda timeout, which the integration would not honour.
- **Poller iteration outrunning the invocation.** The deadline guard fails the in-flight iteration at `remaining − 5 s`, releases the lease and leaves the checkpoint at the last completed action. If `deadline_guard` recurs, reduce the page or transaction limits, not the Lambda timeout: the lease TTL is derived from remaining time and the search poller's fixed lease must stay above its Lambda timeout or the next invocation steals it mid-work.
- **Instance timeout changed without the API ceiling.** Lowering a reader's `neptune_query_timeout` below the sync `evaluationTimeout` makes Neptune reject every sync request with a validation error; raising it changes nothing for sync callers but lengthens how long an abandoned background read (poller, dedup lookup) can hold that instance. Change the two together and keep the dedicated-reader parameter equal to the sync ceiling.

## 3 Choosing a timeout for a query

Decide by query class, then by channel. The effective ceiling on the sync surfaces is fixed at 30 s and can only be lowered; the only way to run longer is the async channel.

| Query class | Channel and target | Effective ceiling | Set by | Move to async when |
| --- | --- | --- | --- | --- |
| Point lookup or bounded traversal (`g.V(id)`, one or two hops with `limit`) | `POST /persist/gremlin`, `readerTarget` = the consumer's role, else `default` | 30 s server-side on any target | `GREMLIN_SYNC_EVALUATION_TIMEOUT_MS` (lower only) | never; a lookup that approaches 30 s is a defect, run explain (`gremlin-explain.md` §3) |
| Interactive read for a latency-sensitive consumer | `POST /persist/gremlin`, `readerTarget: "portal"` (or the consumer's role) | 30 s on the dedicated instance itself; recommended budget is a few seconds | same env var; the instance ceiling is the role's parameter group | never; shape the query or add an index instead |
| Analytical multi-hop read | `POST /persist/gremlin`, `readerTarget: "default"` | still 30 s sync even though the general pool allows 1 h | same | expected runtime exceeds roughly 20 s (30 s minus retry back-off and serialisation), or the result may exceed the response size limit |
| Full scan, export, aggregation over a label | `POST /persist/gremlin-async` (no `readerTarget`; always the async reader) | 1 h + 2 min watchdog, 12 h instance | `GREMLIN_ASYNC_EXECUTION_TIMEOUT_MS` on the Fargate task | always; never on a sync surface or a dedicated reader |
| GraphQL field | `POST /persist/graphql`, `default` hard-coded | 30 s per graph traversal, 5 s per non-graph field | `GREMLIN_SYNC_EVALUATION_TIMEOUT_MS`, `GRAPHQL_FIELD_TIMEOUT_MS` | not available; reduce depth, `first`, or complexity (`graphql-read-surface.md` §7) |
| Write transaction | `POST /persist/ingest` (small, reference-bearing) or the fact handler's sync route | writer 1 h; the request window is the bound | Lambda timeout (30 s / 60 s) | element count exceeds `SYNC_INGEST_MAX_ELEMENTS` or the request cannot finish inside 29 s; use `POST /persist/ingest-async` |

Rules:

- Choose sync only when the query is expected to finish well inside the 30 s ceiling with back-off included; the sync path exists for request/response consumers, not for long work. Choose async whenever the runtime or result size is unknown. This is the recommended practice the ceilings are built to enforce.
- A long sync timeout on a shared reader is paid by every other consumer of that reader: a disconnected caller does not stop the query, so a burst of 30 s traversals on the general pool holds replicas for up to 30 s each, and on a dedicated reader it is that consumer's own single instance that stalls. That is why the sync ceiling is a clamp, not a setting.
- Send a `readerTarget` role only from that role's consumer. General or batch traffic on a dedicated reader competes with the latency-sensitive consumer the reader exists to isolate, and background readers (pollers, dedup lookups, ref verification) must stay on the general pool (`neptune-reader-topology.md` §4.3, §4.6).

## 4 When to retry

The service retries only what the classifier in `gremlin-sync-query.md` §8 marks retriable, with the budget in `neptune-reader-topology.md` §3.3. The rules and the reason for each:

- **Transient connection loss and signature freshness: retry with reconnect.** A closed websocket, a reset socket or an expired SigV4 signature says nothing about the query; a fresh connection (new signature) is the fix. The reset is global on the sync path and slot-only on pooled background paths, and the reader connection is acquired inside the retry so the next attempt sees the new connection.
- **Concurrent modification and throttling on background writes: retry without reconnect, bounded.** `ConcurrentModificationException` and `ThrottlingException` mean the connection is fine and the server is busy; back off (linear, capped at 10 s for throttling) and repeat. Index writers, dedup lookups, staging and the fact handler take this path.
- **Query timeout: terminal, never retry the same query.** Neptune stopped the traversal at a ceiling; the same traversal on the same host hits the same ceiling, and a retry doubles the load the server already rejected. The classifier matches the timeout code before the generic `timed out` reconnect indicator for exactly this reason. Fix the query or resubmit it on the async channel.
- **Sync-path throttling: 429 to the caller, no service retry.** While a caller holds a request open, re-queuing at a reader that just refused work spends the response window on work likely to be refused again and adds to the overload. The caller owns the back-off, and `Retry-After` is omitted so throttled clients do not synchronise. The typed tag is listed as terminal so the retry wrapper cannot overturn the decision; raw throttling stays retriable for background callers.
- **Policy, syntax and validation rejections: terminal.** Mutation and FTS policy, syntax, GraphSON validation, missing vertex references and PII denials are decided before or independent of load; repeating them yields the same answer.
- **Write retries require idempotency, and Persist's writes qualify.** Vertex and edge ids are content hashes and every upsert is `fold().coalesce(unfold(), addV/addE)`, so a replayed transaction is a no-op; blob puts use `IfNoneMatch: "*"` and verify metadata on 412, so a replayed put either creates or confirms. The sync ingest transaction is retried as a whole (`withTransaction` wraps the entire batch, not each statement), which is safe only because of that idempotency.
- **One retry budget per surface; callers must not stack on top of it.** The service already retries transient failures within its window. A client retry loop around a 503 `NeptuneRetriableError` multiplies the load that exhausted the budget; retry once with back-off after the response, not in a tight loop. Recommended practice: jittered exponential back-off, one to three attempts, and no retry at all on 4xx or 504.
- **Step Functions retries only idempotent items.** Lambda invocation faults are retried on every workflow task; `PersistBlobStoreError` and `NeptuneBulkLoadQueueFullError` are retried because staging and load-start are idempotent; typed application errors are not. `ExecuteQuery` in the async machine has no retry: a query is never re-run by the machine, and `HandleFailure` retries only its own cancel-and-terminalise step.
- **SQS redelivery and the DLQ are the retry mechanism for async ingest.** A record is redelivered while `ApproximateReceiveCount` is under the max receive count and dead-lettered after it; queue-full is redelivered regardless of count. A failure after Neptune accepted the load is **not** redelivered, because the load is in flight and a second one would duplicate it (`async-graphson-ingest-and-graph-facts.md` §4.1).
- **Pollers do not retry; they replay.** A failed recompute or bulk page leaves the checkpoint at the previous action, releases the lease, and the next scheduled invocation re-reads from there; the scheduler itself has zero retry attempts and reserved concurrency 1. Idempotent recomputes and full-document indexes make the replay safe.
- **Never retry after a partial non-transactional write.** Transactional: the sync ingest and fact-handler upsert batch (one session transaction, commit last). Non-transactional: index recomputes (per-owner writes, replay-safe by design), bulk loads (a load id, replayed only by a new load), OpenSearch bulk pages (per-item, replay-safe), blob puts (content-addressed). Where a path is non-transactional and not idempotent, there is nothing safe to repeat; that is why every write path in Persist is built to be one or the other.

## 5 Caller guidance per outcome

| Status and tag | Meaning | Correct caller action |
| --- | --- | --- |
| 400 `GremlinMutationNotAllowedError`, `GremlinFtsPolicyError`, `GremlinSyntaxError`, `BadRequest` | rejected before or by Neptune for the query text | fix the query; do not retry |
| 400 `GraphSONPayloadValidationError`, `GraphSONIntegrityError`, `PersistBlobValidationError` | payload fails validation | fix the payload; do not retry |
| 404 `MissingVertexRef` | referenced vertex absent or label mismatched on the general reader | wait for the producer's commit to propagate (replica lag), then resubmit; do not loop |
| 404 `GremlinAsyncRequestNotFoundError` | unknown or expired job id | do not retry; resubmit the query if still needed |
| 429 `GremlinQueryThrottledError`, `GremlinExplainThrottledError` | reader has no capacity now | retry with jittered back-off, bounded; reduce concurrency |
| 503 `NeptuneRetriableError` | service retry budget exhausted on a transient fault | one retry after back-off; if it persists, stop and check reader health |
| 503 `NeptuneConnectionError`, `PersistBlobStoreError`, `S3PayloadStoreError`, `SqsEnqueueError`, `GremlinAsyncJobStoreError` | a store or connection failed | retry with back-off; the ingest routes are idempotent so a duplicate submit is safe |
| 503 `OpenSearchIndexLagExceeded`, `OpenSearchSyncCheckpointMissing`, `OpenSearchIndexUnavailable` | FTS freshness gate closed | wait for lag to recover; do not retry in a loop |
| 504 `GremlinQueryTimeoutError`, `GremlinExplainTimeoutError`, or an API Gateway timeout | Neptune or the gateway gave up at the sync ceiling | do not retry the same query; shape it or resubmit via `POST /persist/gremlin-async` |
| Async job `TIMEOUT` | query outlived the 1 h + 2 min watchdog or the heartbeat | do not resubmit unchanged; split the scan or export it |
| Async job `CANCELLED` | cancel intent honoured (caller, heartbeat failure or failure handler) | none; resubmit only if the cancel was not yours |
| Async job `FAILED` | execution, result persistence or callback failed | read `errorMessage`; resubmit once if the cause was transient |
| GraphQL field error, `retriable: true` | vendor 5xx/429, credential read, DynamoDB timeout | retry the request with back-off |
| GraphQL field error, `retriable: false` (all graph failures, PII denial, missing context) | terminal for that field | do not retry; fix the query or the access policy |

## 6 Configuration knobs

| Knob | Layer moved (§2) | Safe range or clamp | Documented in |
| --- | --- | --- | --- |
| `neptune_query_timeout` per parameter group | innermost | dedicated reader must equal the sync ceiling; async reader ≥ the watchdog | `neptune-reader-topology.md` §2.1 |
| `GREMLIN_SYNC_EVALUATION_TIMEOUT_MS` | API-side, sync and GraphQL | clamped 10–30,000; lower only | `gremlin-sync-query.md` §4 |
| `GREMLIN_EXPLAIN_TIMEOUT_MS` | API-side, explain | ≤ 25,000 (clamped) | `gremlin-explain.md` §3 |
| `GRAPHQL_FIELD_TIMEOUT_MS` | API-side, non-graph fields | keep well under the 30 s Lambda; several fields run per request | `graphql-read-surface.md` §5.4 |
| `NEPTUNE_RETRY_MAX_ATTEMPTS` / `NEPTUNE_RETRY_BASE_DELAY_MS` | back-off inside the runtime window | API 2, GraphQL 3, fact handler 3, item stage 10, default 5; total sleep must fit the function timeout | `neptune-reader-topology.md` §3.3, `stacks-configuration-and-iam.md` §7 |
| `GREMLIN_ASYNC_EXECUTION_TIMEOUT_MS`, `GREMLIN_ASYNC_MAX_EXECUTION_TIMEOUT_MS` | async watchdog | effective `min(env, max(MAX env, 14 min))`; task and machine timeouts must follow | `async-gremlin.md` §2 |
| Heartbeat, task, state-machine timeouts (CDK constants) | async runtime ceilings | heartbeat < task < machine; task ≥ watchdog + 2 min | `async-gremlin.md` §2 |
| `PERSIST_BLOB_*` timeouts and attempts | sync ingest side effect | total ≥ object timeout; on the API Lambda the 30 s window is the real bound | `identity-hashing-and-blobs.md` §3.3 |
| `BULK_MAX_WAIT_MS`, `NEPTUNE_BULK_*_TIMEOUT_MS` | loader wait | wait < worker Lambda 15 min < SQS visibility 30 min | `csv-bulk-load-workflow.md` §4.10 |
| `INDEX_STREAM_MIN_REMAINING_MS`, `INDEX_STREAM_REQUEST_TIMEOUT_MS`, page and transaction limits | poller iteration | fetch timeout < iteration budget; lease > Lambda timeout | `derived-index-maintenance.md` §5.2 |
| `INGEST_ASYNC_MAX_RECEIVE_COUNT`, `INGEST_FILTERED_BATCH_MAX_RECEIVE_COUNT` | SQS redelivery | mirror the DLQ `maxReceiveCount` | `async-graphson-ingest-and-graph-facts.md` §4.1 |

The retry attempt count differs per function because the window differs: the two HTTP handlers cannot outlive the 29 s integration, so their budgets are cut to what fits after the query itself (and halved again on the API handler because ingest pays twice); the fact handler and the item-stage Lambda have no integration in front of them, so they buy patience with a longer function timeout instead of redelivery.

## 7 Anti-patterns

- **Retry storm through reader pool exhaustion.** A client that loops on 429 or 503 against the general pool, combined with the service's own retries, keeps every replica busy with work it already refused. Bound client retries, honour the absent `Retry-After` by jittering, and never retry inside the same request window.
- **Raising a sync timeout instead of using async.** The clamp makes it impossible above 30 s; below that, every second added is a second an abandoned query can hold a shared reader. Long work belongs on the async reader.
- **Retrying a timed-out query.** A 504 or async `TIMEOUT` is a statement about the traversal, not about the moment; repeating it is the load Neptune just shed.
- **Changing an instance timeout without the API ceiling.** A dedicated reader below 30 s rejects every sync request; a general reader above 1 h lengthens what a background read can hold. Move both or neither.
- **Stacking client retries on the service's.** The 503 `NeptuneRetriableError` already means the budget is spent; wrapping it in another loop multiplies attempts by the product of both budgets.
- **Redelivering after an accepted load.** A retry after `startLoad` succeeded enqueues a duplicate load; the worker deliberately sends failure callbacks instead.
- **Pointing batch traffic at a role reader.** It defeats the isolation the role exists for and inherits a 30 s instance ceiling that batch work cannot meet.

## 8 Source map

- Classifier, budgets, delays: `lambda/services/GremlinRetry.ts`, `lambda/config/neptune.ts`; documented in `gremlin-sync-query.md` §8.
- Sync ceiling clamp, throttling mapped to 429 without retry, `withRetry` sites (query, existence chunks): `lambda/services/GremlinService.ts`; documented in `gremlin-sync-query.md` §4 and §5.
- Whole-transaction retry and rollback: `lambda/services/GremlinTx.ts`; documented in `gremlin-sync-query.md` §9.1 and `graphson-ingest-contract.md` §6.
- Ref lookup per-attempt timeout: `lambda/services/GraphSONVertexRefVerifierService.ts`; documented in `neptune-reader-topology.md` §4.6.
- Instance timeouts: `lib/neptune-configuration.ts`, `lib/neptune-stack.ts`; documented in `neptune-reader-topology.md` §2.1 and §3.4.
- Lambda timeouts, per-function retry pins with rationale, SQS visibility and DLQ, state-machine retry policies, async ceilings: `lib/persist-stack.ts`; documented in `stacks-configuration-and-iam.md` §7, `csv-bulk-load-workflow.md` §4.11, `async-gremlin.md` §2.
- Async watchdog and cause mapping, executor control loop: `lambda/services/NeptuneDataApiGremlinService.ts`, `lambda/fargate/gremlin-async-fargate-entrypoint.ts`, `lambda/gremlin-async-failure/handler.ts`; documented in `async-gremlin.md` §5 and §6.
- Blob retry and timeouts: `lambda/services/PersistBlobService.ts`, `lambda/config/blob.ts`; documented in `identity-hashing-and-blobs.md` §3.3.
- Loader retries and wait: `lambda/services/NeptuneBulkLoaderService.ts`, `lambda/services/AsyncBulkWorkerService.ts`; documented in `csv-bulk-load-workflow.md` §4.10 and `async-graphson-ingest-and-graph-facts.md` §4.1.
- Field timeout and `retriable` flag: `lambda/services/GraphQlDynamoDbResolverService.ts`, `lambda/services/InterproseClientService.ts`; documented in `graphql-read-surface.md` §5.4 and §6.3.
- Poller deadline guard, lease, checkpoint-then-advance: `lambda/services/neptune-stream/NeptuneStreamPollerCore.ts`, `lambda/services/IndexStreamClientService.ts`; documented in `derived-index-maintenance.md` §5.6 and §5.7, `opensearch-fts-mirror.md` §5.2 and §5.6.
- Status codes: `error-catalogue-and-responses.md` §3.
