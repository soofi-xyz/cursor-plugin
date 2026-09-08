# Neptune Reader Topology and Per-Consumer Dedicated Readers

> **Naming note.** `portal` and `agency` are role names used throughout this file for the two dedicated readers that exist today. They stand in for whatever consumer-specific identifiers a deployment chooses; the `readerTarget` literals, env var names, CDK context keys, SSM parameter names and endpoint/instance identifiers derived from them follow the patterns written here as `<role>`, `<Role>` and `<ROLE>` (lower-snake, UpperCamel and UPPER_SNAKE renderings of the same name). The shipped literals are deployment-specific identifiers.

Persist serves graph reads from one Neptune cluster whose replicas are split by consumer rather than pooled behind the built-in `cluster-ro` endpoint. The model is: **one writer**; **one permanent async reader** with a 12-hour server-side query timeout for the async Gremlin pipeline and other multi-hour scans; a **general reader pool** of auto-scaled replicas plus one held "headroom" replica behind a custom `READER` endpoint that excludes every dedicated instance; and **one dedicated reader per latency-sensitive consumer role**, each a small single instance with a 30-second server-side timeout behind its own custom `ANY` endpoint, selectable only on `POST /persist/gremlin` and `POST /persist/gremlin/explain` through the `readerTarget` field. Two roles are instantiated today (`portal`, `agency`). The shipped code encodes each role as a member of a closed set of literals repeated across CDK, runtime and tests, so adding a role is a code change at every site listed in §6.4; a list-driven implementation where one role table drives all of those sites is the target pattern described in §8, not what ships. A one-word CDK context flag (`neptuneReaderEndpointMode=cluster`) moves general traffic back to `cluster-ro` without a code change. This file extends PRD §2.2 (NeptuneStack), §4.1 (`POST /persist/gremlin`), §5.2 (async Gremlin), §7.2 (connection management) and §7.3 (retry classification); the recovery cluster that can replace the whole topology is in `neptune-recovery-and-persistence-target.md`.

## 1. Purpose and scope

- Isolate consumers whose latency budget is measured in hundreds of milliseconds from batch and analytical readers, so a runaway scan on the general fleet cannot degrade them and a runaway consumer query cannot hold a general replica for the cluster-wide hour.
- Keep multi-hour async work off the general fleet so it never competes with request/response traffic and never dies at the general 1-hour ceiling.
- Make every reader's server-side timeout explicit per instance and give every synchronous API surface its own evaluation ceiling, because a disconnecting Gremlin client does not stop the query.
- Make the per-consumer reader a repeatable pattern: one contract (§2.3) that every role satisfies identically, so a new consumer is added by instantiating the contract rather than designing a topology.
- Keep the topology reproducible in non-prod at low cost so an endpoint cutover or a new role can be rehearsed.
- Non-goals: per-tenant sharding, cross-region readers, routing writes anywhere except the cluster writer endpoint, letting async submitters or GraphQL callers choose a reader, and read-after-write guarantees on any reader (replica lag is accepted; §4.6).

## 2. Architecture

### 2.1 Reader classes

| Class                         | Count                           | Default class     | Parameter group                                   | `neptune_query_timeout` |
| ----------------------------- | ------------------------------- | ----------------- | ------------------------------------------------- | ----------------------- |
| Writer                        | 1                               | `db.r8g.8xlarge`  | cluster group (`neptune1.4`)                      | 3,600,000 ms (1 h)      |
| Async reader (permanent)      | 1                               | `db.r8g.12xlarge` | instance group `<prefix>AsyncReaderParameterGroup`| 43,200,000 ms (12 h)    |
| General pool (auto-scaled)    | floor..7 (§2.4)                 | `db.r8g.8xlarge`  | cluster group (inherits 1 h)                      | 3,600,000 ms (1 h)      |
| Dedicated consumer reader     | 0 or 1 **per role**             | `db.r8g.xlarge`   | one instance group per role                       | 30,000 ms               |

- Auto-scaled replicas are class-pinned through the cluster parameter `neptune_autoscaling_config` (`{ "dbInstanceClass": ..., "tags": [...] }`); it is a static parameter, so replicas created before the next reboot default to the writer's class, which is why the two are kept equal.
- Every dedicated reader carries a **pinned `DBInstanceIdentifier`** (`persist-<role>-reader`). The identifier feeds endpoint membership lists as a string, so a CDK-generated name would rewrite the general endpoint's exclusion list on every instance replacement.
- `lib/neptune-configuration.ts` is the single source for classes, per-class timeouts, parameter family and the replica floor/ceiling; the primary stack and the recovery stack both import it. It holds one instance-class constant per role.

### 2.2 Endpoints

| Endpoint                      | Kind                     | Type     | Membership                                          | Exposed as (env var)                                   |
| ----------------------------- | ------------------------ | -------- | --------------------------------------------------- | ------------------------------------------------------ |
| cluster writer                | built-in                 | WRITER   | primary                                             | `NEPTUNE_WRITER_HOST`                                  |
| cluster-ro                    | built-in                 | READER   | every replica, round-robin, cannot exclude          | `NEPTUNE_READER_HOST` in `cluster` mode or when no dedicated reader exists |
| `persist-general-readers`     | custom (custom resource) | `READER` | `ExcludedMembers` = every dedicated instance        | `NEPTUNE_READER_HOST` in `custom` mode                 |
| `persist-<role>` (one per role) | custom                 | `ANY`    | `StaticMembers` = `[persist-<role>-reader]`         | `NEPTUNE_<ROLE>_READER_HOST`                           |
| async reader instance         | instance endpoint        | n/a      | the permanent async reader only                     | `NEPTUNE_ASYNC_READER_HOST`                            |

- Neptune custom endpoints have no CloudFormation resource, so they are created by a provider-backed custom resource (`Custom::NeptuneClusterEndpoint`, `neptune-recovery-and-persistence-target.md` §3.3) with an `isComplete` handler that polls `DescribeDBClusterEndpoints` every 30 s (up to 15 min) until `Status === "available"`; a bare `AwsCustomResource` would report success while DNS is still `creating`. The `onEvent` handler converges membership on Update instead of calling `ModifyDBClusterEndpoint` unconditionally, because a membership modify makes the endpoint unusable for minutes; a changed `EndpointIdentifier` is a replacement (it is the DNS name). The provider's role gets `rds:Create/Modify/DeleteDBClusterEndpoint` and `rds:AddTagsToResource` scoped to the cluster and `cluster-endpoint:*`, and `rds:DescribeDBClusterEndpoints` on `*`.
- The general endpoint exists only when at least one dedicated reader is deployed; its exclusion list is exactly the deployed dedicated instance identifiers, never the async reader (excluding it too would leave the endpoint with zero members whenever auto-scaling is at zero). It is `READER` so general reads never land on the writer; each dedicated endpoint is `ANY` so it keeps answering if its instance is promoted during failover. Every custom endpoint depends on the instances it names.
- Every custom endpoint hostname is written to SSM (`/persist/neptune/general-reader-endpoint`, `/persist/neptune/<role>-reader-endpoint`), emitted as a stack output and exported with `exportValue` when present; the cluster-ro, writer, async reader and cluster resource id values stay exported as CloudFormation exports even when nothing imports them (§8).

### 2.3 The per-consumer reader contract

A role `<role>` is fully instantiated when every artefact in this table exists. Each row is a site the shipped code encodes as a literal; §6.4 walks them in build order.

| Artefact                        | Pattern for `<role>`                                                                                                   | Where it lives |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------- |
| Instance identifier             | `persist-<role>-reader`, exported constant `NEPTUNE_<ROLE>_READER_INSTANCE_IDENTIFIER`                                 | `lib/neptune-stack.ts` |
| Instance class default          | constant `NEPTUNE_<ROLE>_READER_INSTANCE_CLASS = "db.r8g.xlarge"`, overridable per deploy                              | `lib/neptune-configuration.ts` |
| Instance parameter group        | construct `Neptune<Role>ReaderParameterGroup`, family `neptune1.4`, `neptune_query_timeout` = `NEPTUNE_DEDICATED_READER_QUERY_TIMEOUT_MS` (30,000) | `lib/neptune-stack.ts` |
| Instance construct              | `Neptune<Role>ReaderInstance`, depends on cluster and its parameter group                                              | `lib/neptune-stack.ts` |
| Custom endpoint                 | id `persist-<role>` (constant `NEPTUNE_<ROLE>_ENDPOINT_IDENTIFIER`), construct `Neptune<Role>CustomEndpoint`, type `ANY`, `StaticMembers = [instance id]` | `lib/neptune-stack.ts` |
| General-endpoint exclusion      | instance id appended to `persist-general-readers` `ExcludedMembers`; endpoint depends on the instance                  | `lib/neptune-stack.ts` (via the `dedicatedReaders` array) |
| Scaling floor                   | permanent replica count (`1 + roles`) plus 1 with headroom; scaling target depends on the instance                     | `lib/neptune-stack.ts`; fixed prod constant in `lib/neptune-configuration.ts` used by the recovery stack |
| Stack prop and output           | `<role>Reader?: NeptuneDedicatedReaderProps` (`enabled`, optional `instanceClass`); public `neptune<Role>ReaderEndpoint?: string` | `lib/neptune-stack.ts` |
| Stack output and export         | `CfnOutput` `Neptune<Role>ReaderEndpoint`; `exportValue` when present                                                  | `lib/neptune-stack.ts` |
| SSM parameter                   | `Neptune<Role>ReaderEndpointParameter` at `/persist/neptune/<role>-reader-endpoint`                                    | `lib/neptune-stack.ts` |
| Recovery-stack mirror           | `<recovery-prefix>-<role>` endpoint and `<recovery-prefix>-<role>-reader` instance, always created, non-optional `neptune<Role>ReaderEndpoint`, output `Recovery<Role>ReaderEndpoint` | `lib/neptune-recovery-stack.ts` |
| CDK context keys                | `neptune<Role>Reader` (bool, default on in prod), `neptune<Role>ReaderInstanceClass` (string)                          | `bin/app.ts` |
| API-stack prop and env var      | `neptune<Role>ReaderEndpoint?: string` -> `NEPTUNE_<ROLE>_READER_HOST` on the REST handler (`PersistHandler`) only     | `bin/app.ts`, `lib/persist-stack.ts` |
| `readerTarget` literal          | `"<role>"` in the closed literal set                                                                                   | `lambda/schemas/gremlin.ts`, `docs/openapi.json` (generated) |
| Runtime host key                | `Config.option("NEPTUNE_<ROLE>_READER_HOST")` as `<role>ReaderHost`; entry in the target-to-key record                | `lambda/config/neptune.ts` |
| Client endpoint role            | `"<role>_reader"` in the endpoint-role union, the target-to-role record, the label record and the reverse switch        | `lambda/services/GremlinClient.ts` |
| Alarm coverage                  | none per instance; covered by the reader-role **Maximum** CPU alarm (§5)                                               | `lib/persist-stack.ts` |
| Deploy plumbing                 | `NEPTUNE_<ROLE>_READER`, `NEPTUNE_<ROLE>_READER_INSTANCE_CLASS` forwarded as context when set                          | `justfile`, `.github/workflows/ci-cd-dev.yml` |
| Tests                           | one assertion group per role in each suite named in §7                                                                 | `test/**` |

Consumers that receive the role's host: only the REST API handler. GraphQL, ingest, workers, pollers, the search stack and the export stack receive the general host (and, where they need it, the async reader host); giving them a dedicated host would be dead configuration (§8).

### 2.4 Instantiated roles today

| Role     | Instance class | Server-side timeout | Consumer                                            | Default deployment       |
| -------- | -------------- | ------------------- | --------------------------------------------------- | ------------------------ |
| `portal` | `db.r8g.xlarge`| 30 s                | a customer-facing portal issuing short interactive queries | prod on; other stages opt in |
| `agency` | `db.r8g.xlarge`| 30 s                | a partner-facing integration issuing short lookups  | prod on; other stages opt in |

Both roles are identical instances of the §2.3 contract; they differ only in name. With both roles and headroom on, the scaling floor is `min 4 / max 7` (async + 2 roles + 1 held); one role gives `min 3`; none gives `min 1`. `ReadReplicaCount` counts every replica, which is why the floor is derived from the permanent count. Auto Scaling target-tracks `NeptuneReaderAverageCPUUtilization` at 65 %, scale-out cooldown 15 min, scale-in cooldown 10 min; only auto-scaled replicas are ever removed. `generalReaderHeadroom` (default true, forced off in retention mode, passed `false` by the app outside prod) adds `+1` to the floor whenever any role exists, because the tracked metric is an unweighted average that idle dedicated readers dilute: the held replica, not the metric, is the capacity guarantee. The scaling target depends on the writer, the async reader and every dedicated instance.

### 2.5 Routing diagram

```
                     +---------------------------- Neptune cluster ----------------------------+
                     |  writer (8xl, 1h)                                                        |
 POST /ingest,       |     ^                                                                    |
 index writers  -----+-----+                                                                    |
                     |                                                                          |
 POST /gremlin       |  persist-general-readers (READER, ExcludedMembers = every <role> reader) |
   readerTarget=     |     |-- async reader (12xl, 12h)  <---- async Fargate / worker via       |
   default  ---------+---->|-- headroom replica (8xl, 1h)      Neptune Data API                 |
 GraphQL, search     |     |-- auto-scaled replicas (8xl, 1h)  (NEPTUNE_ASYNC_READER_HOST)      |
 poller, index       |     |                                   export key-list Fargate scan     |
 pollers, vertexRef  |                                                                          |
 verification -------+---->|  (NEPTUNE_READER_HOST; cluster-ro in `cluster` mode)              |
                     |                                                                          |
   readerTarget=     |  persist-portal (ANY) --> portal reader (xl, 30s)                        |
   portal -----------+---->                                                                     |
   readerTarget=     |  persist-agency (ANY) --> agency reader (xl, 30s)                        |
   agency -----------+---->                                                                     |
   readerTarget=     |  persist-<role> (ANY) --> <role> reader (xl, 30s)      [next role]       |
   <role> -----------+---->                                                                     |
                     +--------------------------------------------------------------------------+
```

Stack wiring (`bin/app.ts`): the API stack receives writer, general, async and every present dedicated host; only the REST handler gets the dedicated hosts as env vars. The GraphQL handler is read-only and receives the general host as both writer and reader. The search stack receives writer + general. The export stack receives the general host for short Lambda extractions and the async reader host for its multi-hour Fargate key-list scan. The REST handler also receives the async reader host because `DELETE /persist/gremlin-async/:requestId` cancels on the pinned instance. The recovery stack exposes the same endpoint properties (writer, cluster-ro, async, general, one per role) so the app can swap the whole topology at once.

## 3. Contracts

### 3.1 CDK context keys

| Key                                  | Values                  | Default                                                      | Guard                                                                 |
| ------------------------------------ | ----------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------- |
| `neptune<Role>Reader` (per role)     | `true` / `false`        | `true` when `stage=prod`, else `false`                       | any other value throws (`resolveDedicatedReaderEnabled`)              |
| `neptune<Role>ReaderInstanceClass`   | Neptune instance class  | the role's constant (`db.r8g.xlarge`)                        | none (use `db.t4g.medium` for rehearsal)                              |
| `neptuneReaderEndpointMode`          | `custom` / `cluster`    | `custom` if the active cluster has a general custom endpoint, else `cluster` | other values throw; `custom` with no role deployed throws |
| `generalReaderHeadroom` (stack prop) | boolean                 | `true`; app passes `false` outside prod                      | forced `false` in retention mode                                      |

`resolveDedicatedReaderEnabled(contextKey)` is the one shared guard; each role calls it with its own key. The deploy recipes forward each key only when its shell variable is set (`NEPTUNE_<ROLE>_READER`, `NEPTUNE_<ROLE>_READER_INSTANCE_CLASS`, `NEPTUNE_READER_ENDPOINT_MODE`), so an unset variable is indistinguishable from the committed default and cutover/rollback stays a CI-workflow edit. The dev workflow sets every role on with `db.t4g.medium`; the prod workflow sets nothing and takes the defaults.

### 3.2 `readerTarget`

- Schema: `readerTarget: "default" | "<role>"...` (today `"default" | "portal" | "agency"`), optional, default `"default"`; accepted by `POST /persist/gremlin` and `POST /persist/gremlin/explain`. Unknown values fail decoding (400). Existing callers are unaffected.
- Response: both endpoints echo `readerTarget` as requested, even when the runtime fell back to the general host; the fallback is visible only in logs. Sync response is `{ results, durationMs, readerTarget, requestId?, fts? }`; explain response is `{ report, durationMs, readerTarget, requestId? }`. `docs/openapi.json` carries the same enum in the request and response schemas and is regenerated from the schema module (`engineering-conventions-and-testing.md` §6.4).
- `POST /persist/gremlin-async` declares no `readerTarget` field: async execution always runs on the async reader. The submit decoder does not enable `onExcessProperty: "error"`, so a body carrying `readerTarget` is accepted with the field dropped, not rejected (`async-gremlin.md` §1).
- Explain resolves the target through the same host resolver and keeps one Neptune Data API HTTPS client per target (`gremlin-explain.md` §4). GraphQL resolvers call the query service with `readerTarget: "default"` hard-coded; there is no GraphQL-level selector.
- Adding a literal is a compile-time change: the schema literal, the target-to-host-key record, the target array, the endpoint-role union, the target-to-role and target-to-label records and the role-to-target reverse switch must all be extended or the build fails (§6.4).

### 3.3 Runtime environment variables

| Variable                              | Set on                                                                                  | Meaning |
| ------------------------------------- | --------------------------------------------------------------------------------------- | ------- |
| `NEPTUNE_READER_HOST`                 | every reader                                                                            | general pool (custom endpoint or cluster-ro per mode) |
| `NEPTUNE_ASYNC_READER_HOST`           | REST handler (async cancel), async worker, async Fargate, async failure handler, export scan | async reader instance endpoint; optional, falls back to `NEPTUNE_READER_HOST` |
| `NEPTUNE_<ROLE>_READER_HOST`          | REST handler only, only when the role is deployed                                       | the role's custom endpoint; optional |
| `GREMLIN_SYNC_EVALUATION_TIMEOUT_MS`  | REST and GraphQL handlers                                                               | per-query `evaluationTimeout`; default and hard ceiling 30,000, floor 10 |
| `GREMLIN_EXPLAIN_TIMEOUT_MS`          | not set in CDK (read by the REST handler)                                               | explain request timeout; code default and max 25,000 |
| `GREMLIN_ASYNC_EXECUTION_TIMEOUT_MS` / `GREMLIN_ASYNC_MAX_EXECUTION_TIMEOUT_MS` | async Fargate                                                 | client-side wait on `ExecuteGremlinQuery`; 3,720,000 (1 h query + 2 min margin) |
| `GREMLIN_READER_POOL_SIZE`            | pooled readers                                                                          | lazy per-target reader pool size (8 for index Lambdas, 200 for the stream poller) |
| `NEPTUNE_RETRY_MAX_ATTEMPTS` / `NEPTUNE_RETRY_BASE_DELAY_MS` | per handler                                                      | retry budget sized to the surface (REST 2 / 1000, GraphQL 3 / 1000, EventBridge fact handler 3 / 1000) |

### 3.4 Timeout hierarchy

| Surface                                   | Server-side ceiling (instance)   | API-side ceiling                                                   | Outer bound                                  |
| ----------------------------------------- | -------------------------------- | ------------------------------------------------------------------ | -------------------------------------------- |
| `POST /persist/gremlin`, any target       | 1 h general / 30 s dedicated     | `evaluationTimeout` 30 s sent with every request                   | Lambda 30 s, HTTP API integration 29 s       |
| `POST /persist/gremlin/explain`           | same                             | 25 s request timeout, SDK `maxAttempts: 1`, 4 MiB report cap       | Lambda 30 s                                  |
| GraphQL resolvers                         | 1 h general                      | `evaluationTimeout` 30 s; `GRAPHQL_FIELD_TIMEOUT_MS` 5 s per field | Lambda 30 s                                  |
| Async Gremlin (Fargate)                   | 12 h async reader                | 1 h query, 1 h 2 min client wait                                   | heartbeat 15 min, task 1 h 20 min, state machine 1 h 40 min |
| Async Gremlin (Lambda worker path)        | 12 h async reader                | 14 min (840,000 ms)                                                | Lambda 15 min                                |
| Vertex-reference verification (§4.6)      | 1 h general                      | 10 s per attempt                                                   | ingest handler 30 s / fact handler 60 s      |
| Export key-list scan                      | 12 h async reader                | multi-hour                                                         | Fargate task                                 |

The sync evaluation ceiling is 30 s because Neptune's strict timeout validation rejects a per-query value above the instance's `neptune_query_timeout`, and 30 s is the smallest ceiling in the cluster; it also equals the Lambda/HTTP API window, so a query that reaches the boundary may surface API Gateway's timeout instead of Persist's typed 504. Every new role inherits the same 30 s constant, so the ceiling never needs to move when a role is added.

## 4. Runtime behaviour

### 4.1 Endpoint selection (sync Gremlin)

1. Decode the body; `readerTarget` defaults to `default`.
2. Apply the read-only policy and FTS policy (PRD §4.1).
3. Inside the retry wrapper, obtain the reader connection **for the target**. The client keeps a registry keyed by target that builds a state manager and a bounded pool on first request, so a target nobody asks for costs no websocket, credential fetch or DNS lookup. Host resolution (`resolveNeptuneReaderHost`): `default` -> `NEPTUNE_READER_HOST`; `<role>` -> `NEPTUNE_<ROLE>_READER_HOST` via the target-to-key record, else **fall back to `NEPTUNE_READER_HOST`** with `usedFallback: true` and log `Dedicated reader host is not configured, using the cluster reader endpoint` with `readerTarget` and `fallbackHost`.
4. Submit the query string with `{ evaluationTimeout: <clamped GREMLIN_SYNC_EVALUATION_TIMEOUT_MS> }`.
5. Normalise results (PRD §4.1) and return `readerTarget` in the response; annotate all logs with `gremlinReaderTarget`.

Connection resets are routed back to the state manager that owns the failed connection via the endpoint role (`reader`, `<role>_reader`) and the reverse switch `readerTargetForRole`; a global reset drains only targets that were instantiated. Explain uses the same resolver but a per-target Neptune Data API HTTPS client (`maxAttempts: 1`) memoised in a map keyed by target.

### 4.2 Async Gremlin

The Neptune Data API service resolves `NEPTUNE_ASYNC_READER_HOST` and falls back to `NEPTUNE_READER_HOST` when unset. Execution is a SigV4-signed HTTPS `POST /` carrying `gremlin` and `queryId` so the job's `requestId` doubles as the Neptune query id for status and cancel (PRD §5.2). Timeouts map `TimeLimitExceededException`, `ClientTimeoutException`, HTTP status 598 and client request timeouts to a terminal `TIMEOUT` job state.

### 4.3 Writer versus reader

- Writes, transactions and the pre-write existence lookups of sync ingest run on the writer connection.
- All API reads, GraphQL, search-poller and index-poller reads, dedup lookups and vertex-reference verification run on the general reader.
- Async Gremlin execution, status and cancel (including the REST API's `DELETE`), the async failure handler and the export key-list scan run on the async reader.
- Dedicated readers serve only `POST /persist/gremlin` and `POST /persist/gremlin/explain` requests that name the role.

### 4.4 Failure and retry semantics on readers

- Neptune stopping a query at its ceiling (`TimeLimitExceeded`, or the already-typed timeout tag re-read from the pretty-printed cause) is classified `neptune_query_timeout`: **terminal, never retried, no reconnect**. The same traversal on the same host would hit the same ceiling. The sync path maps it to `GremlinQueryTimeoutError` -> HTTP 504 with `{ query, timeoutMs }`; the raw Neptune text stays in the warn log (`timeoutMs`, `readerTarget`, `elapsedMs`, `queryLength`). GraphQL surfaces it as a field error.
- Throttling on the **sync** path (`ThrottlingException`, `too many concurrent requests`) maps to `GremlinQueryThrottledError` -> HTTP 429 without `Retry-After`, and is not retried while the caller holds the request open; its message is worded so the retry classifier does not read Neptune's throttling phrasing back as retriable. Background callers keep the normal throttle retry (linear backoff capped at 10 s).
- Transient connection errors and IAM signature freshness follow PRD §7.3 (`gremlin-sync-query.md` §8) with the per-handler budget in §3.3.
- Explain: capacity exceptions (`QueryLimitExceededException`, `ThrottlingException`, `TooManyRequestsException`, HTTP 429) -> 429; oversized-query exceptions (`QueryLimitException`, `QueryTooLargeException`) -> 400; timeouts -> 504; reports over the cap -> 502.

### 4.5 Fallback when a role's reader is absent

Stages without a given role deploy no instance or endpoint for it, publish no SSM parameter, set no `NEPTUNE_<ROLE>_READER_HOST`, and, when no role at all is deployed, route `NEPTUNE_READER_HOST` to cluster-ro. Requests naming the role are accepted, served by the general host, logged as fallback, and echoed unchanged in the response; each role falls back independently (one deployed role does not change another's resolution). In `cluster` mode on a stage that does have dedicated readers, general reads round-robin onto the dedicated instances and inherit their 30 s server-side ceiling on those hops; sync API queries are unaffected (they already cap at 30 s) but background readers such as pollers and dedup lookups are exposed.

### 4.6 Vertex-reference verification on the reader (ADR 0001)

Sync ingest and validation accept top-level GraphSON `vertexRefs` (hash + expected label). After shape, connectivity and lexicon checks, existence and label are verified with one `g.V(ids...).project("id","label")` on the **general reader** (10 s per attempt, inside the retry wrapper); every malformed, missing or mismatched ref is aggregated into one `MissingVertexRef` -> HTTP 404. Ref-bearing EventBridge facts are forced onto the sync path and skipped deterministically when refs are missing (`graph_facts_skipped_missing_ref`). Verifying on the reader accepts ordinary replica lag: a producer needing read-after-write must retry after the canonical producer has committed and propagated. Async ingest rejects `vertexRefs` rather than queue unverifiable work. Never move this lookup to a dedicated reader; it is general traffic.

## 5. Observability and alarms

- Alarm `<Prefix>NeptuneReaderCpuHighAlarm`: `AWS/Neptune` `CPUUtilization` with dimensions `DBClusterIdentifier` + `Role=READER`, statistic **Maximum**, period 1 min, threshold 80 %, 15 of 15 datapoints, `NOT_BREACHING` on missing data, alarm and OK actions to the paging integration, included in the hourly active-alarm scan (`operations-dashboards-and-alerting.md` §3.2). Maximum is used because the reader-role average is diluted by idle dedicated readers, and it covers every role and every auto-scaled replica without naming them, so adding a role needs no alarm change.
- Cluster-level logs: audit and slow-query exports are enabled (`neptune_enable_slow_query_log=info`, threshold 5,000 ms), so any query that outlives a dedicated reader's 30 s or a general reader's SLO is attributable.
- Structured logs: every connection open/reuse/refresh/close carries `endpoint` and `endpointRole`; every sync query carries `gremlinReaderTarget`; timeouts and throttles log at warn with the fields in §4.4; the fallback log in §4.1 is the signal that a role's host is missing where it should exist.
- Recommended (not shipped in the stack): per-instance `CPUUtilization`, `BufferCacheHitRatio`, `GremlinRequestsPerSec` and `MainRequestQueuePendingRequests` by `DBInstanceIdentifier` for each dedicated reader and the async reader, and a scaling-activity view for the general fleet. Size a dedicated reader on `BufferCacheHitRatio` and that consumer's latency, not on cluster averages.

## 6. Operations and runbook

### 6.1 Rehearse a role in a non-prod stage

Deploy with `--context neptune<Role>Reader=true --context neptune<Role>ReaderInstanceClass=db.t4g.medium` (repeat the pair per role). The stage skips headroom automatically, the general custom endpoint appears, and `neptuneReaderEndpointMode` resolves to `custom`. Verify the SSM parameters, that `DescribeDBClusterEndpoints` shows `available` with the expected `StaticMembers`/`ExcludedMembers`, and that a `readerTarget: "<role>"` request round-trips with no fallback log. Tear down by deploying with the key set to `false`; removing the last role deletes the general endpoint, and the mode must then be unset (or `cluster`).

### 6.2 Roll back general reads to cluster-ro

Deploy with `--context neptuneReaderEndpointMode=cluster` (or set `NEPTUNE_READER_ENDPOINT_MODE=cluster` in the CI workflow). No code change; the custom endpoints stay up and every `<role>` target stays pinned. Expect the §4.5 exposure of background readers to the 30 s ceiling; return to `custom` by unsetting the key.

### 6.3 Resize a dedicated reader

Change the role's instance-class context key (or its constant) and deploy in a maintenance window: the reader is a single instance with no failover, so that consumer is down for the modify while general reads continue. The pinned identifier keeps the general endpoint's exclusion list unchanged, so no endpoint modify occurs.

### 6.4 Add a dedicated reader for a new consumer role

Treat as a maintenance-window operation: the general endpoint's `ExcludedMembers` is rewritten and the endpoint is unusable for minutes; the scaling floor rises by one. Choose the role name once, derive `<role>`, `<Role>` and `<ROLE>`, and edit every site below in order; the build fails until every closed set is extended, so use the compiler as the checklist.

1. `lib/neptune-configuration.ts`: add `NEPTUNE_<ROLE>_READER_INSTANCE_CLASS = "db.r8g.xlarge"`; raise `NEPTUNE_PROD_MIN_READ_REPLICA_CAPACITY` by one (the recovery stack pins its floor to this constant) and update its comment.
2. `lib/neptune-stack.ts`: export `NEPTUNE_<ROLE>_ENDPOINT_IDENTIFIER = "persist-<role>"` and `NEPTUNE_<ROLE>_READER_INSTANCE_IDENTIFIER = "persist-<role>-reader"`; add prop `<role>Reader?: NeptuneDedicatedReaderProps` and public `neptune<Role>ReaderEndpoint?: string`; call `createDedicatedReader` with `Neptune<Role>ReaderParameterGroup`, `Neptune<Role>ReaderInstance`, `Neptune<Role>CustomEndpoint`, the two identifiers and the class constant; append the result to the `dedicatedReaders` array (this extends the exclusion list, the scaling floor and the dependencies); assign `createDedicatedReaderEndpoint(...)` to the public property; add `exportValue`, `CfnOutput` `Neptune<Role>ReaderEndpoint` and `StringParameter` `Neptune<Role>ReaderEndpointParameter` at `/persist/neptune/<role>-reader-endpoint`, all guarded by presence.
3. `lib/neptune-recovery-stack.ts`: add `NEPTUNE_RECOVERY_<ROLE>_ENDPOINT_IDENTIFIER` and `NEPTUNE_RECOVERY_<ROLE>_READER_INSTANCE_IDENTIFIER` under the recovery prefix; non-optional public `neptune<Role>ReaderEndpoint: string`; `createDedicatedReader` with `NeptuneRecovery<Role>ReaderParameterGroup`, `NeptuneRecovery<Role>Reader`, `NeptuneRecovery<Role>Endpoint`; append to `dedicatedReaders`; assign `createDedicatedEndpoint(...)`; output `Recovery<Role>ReaderEndpoint`.
4. `bin/app.ts`: `const <role>ReaderEnabled = resolveDedicatedReaderEnabled("neptune<Role>Reader")`, read `neptune<Role>ReaderInstanceClass`, pass `<role>Reader: { enabled, ...instanceClass }` to `NeptuneStack`; name the new key in the `neptuneReaderEndpointMode=custom` error message; forward `neptune<Role>ReaderEndpoint` to `PersistStack` when present on the active persistence target.
5. `lib/persist-stack.ts`: prop `neptune<Role>ReaderEndpoint?: string`; conditional `NEPTUNE_<ROLE>_READER_HOST` in the REST handler's environment and nowhere else.
6. `lambda/schemas/gremlin.ts`: add `"<role>"` to `Schema.Literal(...)`; both sync and explain request schemas and both response schemas pick it up.
7. `lambda/config/neptune.ts`: `const <role>ReaderHost = Config.option(Config.string("NEPTUNE_<ROLE>_READER_HOST"))`; add it to `NeptuneReaderConfig` and `NeptuneConfig`; add `<role>: "<role>ReaderHost"` to `dedicatedReaderHostKeys` and widen its value type.
8. `lambda/services/GremlinClient.ts`: append to `ReaderTargets`; add `"<role>_reader"` to the `endpointRole` union in `GremlinConnectionState` and to `LiveEndpointRole`; add entries to `readerTargetEndpointRoles` and `readerTargetLabels`; add the `case "<role>_reader": return "<role>"` arm to `readerTargetForRole`.
9. `lambda/services/GremlinExplainService.ts`, `lambda/services/GraphQlGraphResolverService.ts`, `lib/debt-index-export-stack.ts`: no edit; confirm they compile (explain is keyed by the schema type; GraphQL stays pinned to `default`; the export stack never sees dedicated hosts).
10. `docs/openapi.json`: regenerate with the OpenAPI script so the four `readerTarget` enums carry the new literal.
11. `justfile`: in both the build and deploy recipes add `${NEPTUNE_<ROLE>_READER:+--context "neptune<Role>Reader=$NEPTUNE_<ROLE>_READER"}` and the `_INSTANCE_CLASS` twin.
12. `.github/workflows/ci-cd-dev.yml`: add `NEPTUNE_<ROLE>_READER=true` and `NEPTUNE_<ROLE>_READER_INSTANCE_CLASS=db.t4g.medium` to the `env-vars` block; the prod workflow needs nothing because the key defaults on in prod.
13. `README.md`: add the role to the `readerTarget` table and to the "Neptune reader endpoint topology" table.
14. `test/cdk/stack-templates.ts`: pass `neptune<Role>ReaderEndpoint: "<role>.reader.example"` to the synthesized API stack.
15. `test/cdk/neptune-stack.test.ts`: import both identifiers; add a `with<Role>Reader(instanceClass?)` helper and include the role in the all-roles helper; extend the pinned-identifier/30,000 ms test, the class-override test, the exclusion-list test (order follows the `dedicatedReaders` array), the `ANY`/`StaticMembers` test, the dependency tests and the scaling-floor expectations (`min` = permanent count, `+1` with headroom).
16. `test/cdk/neptune-recovery-stack.test.ts`: assert the recovery identifiers, the instance, the exclusion entry and the `ANY` endpoint for the role.
17. `test/cdk/persist-stack.test.ts`: assert `NEPTUNE_<ROLE>_READER_HOST` on the REST handler and undefined on every other function.
18. `test/schemas/gremlin.test.ts`: decode `readerTarget: "<role>"` on the sync and explain schemas.
19. `test/services/GremlinClient.test.ts`: extend the registry-builds-every-target assertion, `readerTargetForRole("<role>_reader")`, the per-target host resolution, the one-role-deployed independence case and the fallback loop.
20. `test/routes/gremlin.router.test.ts` and `test/services/GremlinExplainService.test.ts`: extend the target loops so the route and explain forward the new literal.
21. `test/e2e/persist-api.e2e.test.ts`: widen the `readerTarget` union and add the literal to the echo loop.
22. Deploy: rehearse per §6.1, then deploy to prod in the maintenance window; confirm `ExcludedMembers` on the general endpoint, `available` on the new endpoint, the new SSM parameter, the raised Auto Scaling floor and no fallback log for the role.

### 6.5 Remove a role

Reverse §6.4 in the same maintenance window: set `neptune<Role>Reader=false` first so the instance, endpoint, SSM parameter and export disappear and the exclusion list shrinks (if it was the last role, the general endpoint goes with it and `neptuneReaderEndpointMode` must be unset or `cluster`); then delete the literal and every site above, and lower the prod floor constant. Callers still sending the removed literal get a 400 at decode time, so coordinate with the consumer before the code removal ships.

**Never rename an endpoint identifier or an instance identifier casually.** Both are DNS or membership keys; a rename replaces the endpoint or rewrites the exclusion list.

## 7. Verification and acceptance criteria

- CDK (`test/cdk/neptune-stack.test.ts`): with no role the stack has two instances, no custom endpoints and scaling `min 1 / max 7`; one role gives `min 3`, both give `min 4`, headroom off gives `min` = permanent count; each role's instance has its pinned identifier, default or overridden class, and a parameter group with `neptune_query_timeout: "30000"`; the general endpoint is `READER` with `ExcludedMembers` equal to exactly the deployed role identifiers and empty `StaticMembers`; each role's endpoint is `ANY` with only its own instance; every endpoint depends on the instances it names; the scaling target depends on every permanent reader; SSM parameters exist only for deployed endpoints; the provider policy carries the `rds:*DBClusterEndpoint` actions; cluster-ro remains exported exactly once. The recovery suite asserts the mirrored identifiers, exclusion list and `ANY` endpoints for every role.
- API stack (`test/cdk/persist-stack.test.ts`): only the REST handler has any `NEPTUNE_<ROLE>_READER_HOST`; every other function lacks them; the GraphQL handler's writer host equals its reader host; the async worker, Fargate task and failure handler have `NEPTUNE_ASYNC_READER_HOST` distinct from `NEPTUNE_READER_HOST`; Fargate execution timeout is `3720000`; REST and GraphQL pin `GREMLIN_SYNC_EVALUATION_TIMEOUT_MS=30000` and their retry budgets.
- Unit: the schema defaults `readerTarget` to `default`, accepts every role literal and rejects unknown values (`test/schemas/gremlin.test.ts`); the async submit schema declares no `readerTarget` (no test asserts rejection, and the decoder drops it, §3.2); host resolution returns the role's host when set and the general host with `usedFallback: true` otherwise, independently per role (`test/services/GremlinClient.test.ts`); the client registry builds a pool per target lazily and `reset` drains only instantiated targets; `readerTargetForRole` maps every `<role>_reader` back to its target; the retry classifier treats query timeouts and the sync-throttle tag as terminal; responses map timeout to 504 and throttle to 429; the router and explain forward the requested target (`test/routes/gremlin.router.test.ts`, `test/services/GremlinExplainService.test.ts`).
- E2E (`test/e2e/persist-api.e2e.test.ts`): for `default` and every role literal, `POST /persist/gremlin` returns 200 and echoes the target. Not automated, verify manually: an async job longer than 30 s still succeeds; a deliberately slow sync query returns 504 (or API Gateway's timeout) within the API window.
- A new role is accepted when every suite above carries the same assertion group for it as for `portal` and `agency`, and a deployment smoke test resolves the role's endpoint from inside the VPC, runs one query per target, shows no fallback log in a stage that deploys the role, and shows the expected Auto Scaling floor.

## 8. Design decisions

- **One reader per consumer, not one shared "fast" reader.** A shared low-latency replica reintroduces the noisy-neighbour problem between consumers that was the reason to leave cluster-ro; a per-role instance gives each consumer its own capacity, its own timeout ceiling, its own log line and its own maintenance blast radius (a resize takes down one consumer, not all).
- **Custom endpoints, not cluster-ro.** The built-in reader endpoint round-robins across every replica and cannot exclude one. The general endpoint uses an exclusion list so auto-scaled replicas join automatically; each role's endpoint uses a static list so it holds exactly one instance.
- **`ANY` for dedicated, `READER` for general.** A consumer keeps working through a failover that promotes its instance; general reads must never land on the writer.
- **Do not exclude the async reader from the general pool.** It is the only guaranteed member when auto-scaling is at zero; sync queries carry their own 30 s ceiling so its 12 h timeout is harmless to them.
- **Pinned instance identifiers** are a deliberate exception to letting CDK name resources, because membership lists are strings and a membership edit is a multi-minute outage on the general endpoint.
- **Held headroom replica instead of trusting target tracking**, because the only metric Neptune target tracking supports is an unweighted reader average that idle dedicated readers dilute; every added role dilutes it further.
- **One shared 30 s constant for every role** so a runaway consumer query dies on the server; the sync `evaluationTimeout` matches it because Neptune rejects a per-query value above the instance parameter, and a client-side timeout stops the waiting but not the query.
- **Query timeouts are terminal; sync throttles are 429 without `Retry-After`.** Retrying a timed-out traversal doubles the rejected load; a fixed `Retry-After` would line every throttled client up on the same tick.
- **Fallback rather than failure for a missing role host**, so dev, local and E2E runs work against a cluster without dedicated readers, at the cost of the response echoing the requested target rather than the served one.
- **Only the REST handler receives dedicated hosts**; anywhere else they would be dead configuration hiding which consumers can actually reach the instances. Async submitters and GraphQL cannot pick a reader.
- **A closed literal set today.** Roles are spelled out as literals in the schema, the config record, the client's role union and records, the stack props and the tests. This buys exhaustive compile-time checking (a missing site is a type error) and keeps each role visible in the CloudFormation template and the OpenAPI document, at the cost of the ~22-site checklist in §6.4.
- **TARGET, not shipped: a list-driven role table.** One exported `DEDICATED_READER_ROLES` array (name, class constant, default-on stages) would drive `neptune-stack.ts`, the recovery stack, `bin/app.ts`, the API-stack env vars, the schema literal (`Schema.Literal(...roles)`), the config record, the client registries and the test helpers, collapsing §6.4 to one entry plus regenerated docs. The trade-off is weaker exhaustiveness at the type level (records become `Record<string, ...>` built at runtime), harder-to-read synthesized templates, and a `readerTarget` enum in OpenAPI that must be generated from the table; do not adopt it until a third role is actually requested.
- **`neptuneReaderEndpointMode` defaults from the endpoint's existence**, so stages with no role deploy without extra flags and prod isolation is on unless someone turns it off.
- **Keep exporting cluster-ro after nothing imports it.** The producer stack deploys before its consumers; pruning the auto-generated export would make CloudFormation reject the producer update while consumers still import it.

## 9. Source map (persist repo, relative paths)

| Path                                                         | Responsibility                                                                                     |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `bin/app.ts`                                                 | `resolveDedicatedReaderEnabled`, per-role context keys and stack props, endpoint-mode resolution, per-stack endpoint wiring |
| `lib/neptune-configuration.ts`                               | Instance classes (one constant per role), per-class `neptune_query_timeout`, parameter family, replica floor/ceiling |
| `lib/neptune-stack.ts`                                       | `NeptuneDedicatedReaderProps`, `createDedicatedReader`, identifiers, custom endpoints, `dedicatedReaders` array, auto-scaling, SSM/outputs/exports |
| `lib/neptune-recovery-stack.ts`                              | Mirrored per-role readers and endpoints on the recovery cluster, fixed prod floor                  |
| `lib/neptune-cluster-endpoint.ts`                            | Provider-backed custom resource construct for Neptune custom endpoints and its IAM                 |
| `lambda/neptune-cluster-endpoint/handler.ts`, `lambda/services/NeptuneClusterEndpointService.ts` | Create/converge/delete endpoints, poll until `available`                     |
| `lib/persist-stack.ts`                                       | Per-role env vars on the REST handler only, sync/async timeouts, retry budgets, reader CPU alarm   |
| `lib/debt-index-export-stack.ts`                             | General and async hosts only; never receives a dedicated host                                      |
| `lambda/config/neptune.ts`                                   | Per-role host options, `dedicatedReaderHostKeys`, `resolveNeptuneReaderHost` fallback              |
| `lambda/schemas/gremlin.ts`, `lambda/schemas/gremlin-async.ts` | `readerTarget` literal set and default on sync and explain; its deliberate absence on async      |
| `lambda/services/GremlinClient.ts`                           | `ReaderTargets`, endpoint-role union, target/role/label records, `readerTargetForRole`, lazy per-target registries and pools |
| `lambda/services/GremlinService.ts`                          | Sync query path, `evaluationTimeout`, timeout/throttle mapping                                     |
| `lambda/services/GremlinRetry.ts`                            | Retry classification incl. terminal query-timeout and sync-throttle tags                           |
| `lambda/services/GremlinExplainService.ts`                   | Per-target Neptune Data API explain client, 25 s timeout, error mapping                            |
| `lambda/services/NeptuneDataApiGremlinService.ts`            | Async execution on the async reader host with fallback, signed HTTPS execute, status, cancel       |
| `lambda/services/GraphQlGraphResolverService.ts`             | GraphQL resolvers pinned to `readerTarget: "default"`                                              |
| `lambda/services/GraphSONVertexRefVerifierService.ts`, `docs/adr/0001-verify-vertex-references-on-reader-endpoint.md` | Reader-side vertex reference verification            |
| `lambda/http/responses.ts`                                   | 504 / 429 envelopes for timeout and throttle                                                       |
| `docs/openapi.json`, `scripts/generate-openapi.ts`           | Generated `readerTarget` enums in request and response schemas                                     |
| `test/cdk/stack-templates.ts`, `test/cdk/neptune-stack.test.ts`, `test/cdk/neptune-recovery-stack.test.ts`, `test/cdk/persist-stack.test.ts` | Fixture hosts, topology, endpoint, scaling and env var assertions per role |
| `test/schemas/gremlin.test.ts`, `test/services/GremlinClient.test.ts`, `test/routes/gremlin.router.test.ts`, `test/services/GremlinExplainService.test.ts`, `test/e2e/persist-api.e2e.test.ts` | Literal acceptance, registry and host resolution, route and explain forwarding, end-to-end echo |
| `README.md` ("Neptune reader endpoint topology"), `justfile`, `.github/workflows/ci-cd-dev.yml` | Operator-facing tables, context forwarding, dev-stage rehearsal defaults               |
