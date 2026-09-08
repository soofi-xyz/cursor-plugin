# Synchronous Gremlin Query Surface and Connection Management

`POST /persist/gremlin` runs one caller-supplied Gremlin script against a named Neptune reader, inside the API Lambda's 30 s window, and returns JSON-safe results. This file is the code-derived contract for that route and for the Gremlin plumbing under it: the read-only policy, the per-query evaluation timeout, result normalisation, the 429/504 outcomes, the router's layer composition, the connection state managers and pools, the retry classifier, transactions, and the script-versus-bytecode write path. It replaces PRD §4.1, the Gremlin-router bullet of §4.4, and §7.2–7.4.

## 1. Scope and non-goals

- In scope: `lambda/routes/gremlin.router.ts` (the `/gremlin` handler only), `lambda/schemas/gremlin.ts`, `GremlinService.query`, `GremlinQueryPolicy`, `GremlinClient`, `GremlinRetry`, `GremlinTx`, and the temporal upsert script builder in `GremlinService`.
- Out of scope, covered elsewhere: reader endpoints, `readerTarget` host resolution, fallback and the timeout hierarchy (`neptune-reader-topology.md`); `POST /persist/gremlin/explain` (`gremlin-explain.md`); the `Neptune#fts.*` hint policy and freshness gate (`opensearch-fts-mirror.md`); `POST /persist/gremlin-async` (`async-gremlin.md`); the full tag-to-status table (`error-catalogue-and-responses.md`); the env var table (`stacks-configuration-and-iam.md`); datetime rendering rules and id hashing (`identity-hashing-and-blobs.md`). Batch existence lookups (`findExisting*Ids`, `GREMLIN_BATCH_EXISTS_*`) live in `GremlinService` but belong to the ingest path.

## 2. Request and response contract

Route: `POST /persist/gremlin`, mounted by `lambda/router.ts` with prefix `/persist`. Invalid JSON returns 400 `BadRequest` ("Invalid JSON body"); a schema decode failure returns 400 `BadRequest` with the decode error text.

Request (`GremlinQueryRequest`):

| Field          | Type                                    | Rule                                                        |
| -------------- | --------------------------------------- | ----------------------------------------------------------- |
| `gremlin`      | string                                  | 1..50,000 characters (`GremlinQueryText`)                   |
| `readerTarget` | `"default" \| "portal" \| "agency"`     | optional, defaults to `"default"`; `portal`/`agency` are role names standing in for deployment-specific identifiers (naming note in `neptune-reader-topology.md`); semantics in `neptune-reader-topology.md` §3.2 |

Response body is `{ ok: true, data }` where `data` is:

| Field          | Type        | Source                                                                                     |
| -------------- | ----------- | ------------------------------------------------------------------------------------------ |
| `results`      | `unknown[]` | normalised result items (§4)                                                               |
| `durationMs`   | number      | wall clock from entry into `GremlinService.query` to return: includes policy checks, retries and normalisation, not Neptune time alone |
| `readerTarget` | string      | required; echoes the requested value even when the runtime fell back to the general host   |
| `requestId`    | string?     | `result.requestId`, else `result.statusAttributes.requestId`; omitted when neither exists  |
| `fts`          | object?     | present only when the FTS policy reports `used: true`; shape in `opensearch-fts-mirror.md` |

`GremlinQueryResponse` in `lambda/schemas/gremlin.ts` declares `results`, `durationMs`, `readerTarget`, `requestId?`; `fts` is spread onto the object at runtime and the router returns the service value without re-encoding it through the schema.

## 3. Read-only query policy

`GremlinQueryPolicy.assertReadOnly` lower-cases the script and tests one regex:

```text
/(^|[^a-z])(addv|adde|property|drop|mergev|mergee|sideeffect|tx|commit|rollback)\s*\(/i
```

Rules, exactly as the regex behaves:

- A step is rejected only when its name is not preceded by a letter and is followed by optional whitespace and `(`. Digits, `_`, `.`, quotes and start-of-string all count as boundaries, so `.addV(`, `g.tx(`, `_drop(` and `1commit(` are rejected.
- Rejected step names: `addV`, `addE`, `property`, `drop`, `mergeV`, `mergeE`, `sideEffect`, `tx`, `commit`, `rollback`.
- Not rejected: the same word without `(` (`has('property', 'x')`, `hasLabel('tx')`), longer names that merely contain a rejected name (`properties(`, `dropped(`, `context(`), and `withSideEffect(` (preceded by `h`). `withSideEffect` is handled by the FTS policy instead.
- Failure: `GremlinMutationNotAllowedError { query, message: "Mutation Gremlin queries are not allowed on this endpoint" }`, HTTP 400.

Ordering in `GremlinService.query`: read-only policy first, then `GremlinFtsPolicyService.prepareQuery`. The FTS policy carries the same bare-`sideEffect(` regex as defence in depth, but on this route a bare `sideEffect(` always surfaces as `GremlinMutationNotAllowedError`, never as `GremlinFtsPolicyError`. Any `withSideEffect(` key other than the `Neptune#fts.*` hints, and any script that contains `Neptune#fts`, is judged by `opensearch-fts-mirror.md` §4.6; `prepareQuery` may rewrite the leading `g.` to inject the endpoint hint, and the rewritten text is what is submitted and what appears in error `details.query`.

Why the policy stays on a reader route: the reader connection is the routing choice, not the mutation guard. A single-instance cluster serves its reader endpoint from the primary, a `cluster` endpoint mode can round-robin general reads, and the general reader falls back to the cluster reader when a dedicated host is absent (`neptune-reader-topology.md` §4.5). The regex is the only server-independent guarantee that `/persist/gremlin` cannot write.

## 4. Execution and result normalisation

1. Resolve the reader connection for the target: `gremlinClient.getReaderConnectionFor(target)` when the client implements it, else `getReaderConnection` (test stubs and pre-target implementations). This happens **inside** the retry wrapper so a reset yields a fresh connection on the next attempt.
2. Submit the script as a string: `client.submit(prepared.query, null, { evaluationTimeout })`. This is the driver's script path, not bytecode.
3. `evaluationTimeout` = `GREMLIN_SYNC_EVALUATION_TIMEOUT_MS` clamped by `resolveSyncEvaluationTimeoutMs`: floor 10 ms (Neptune's documented minimum), ceiling `GREMLIN_SYNC_EVALUATION_TIMEOUT_CEILING_MS = 30_000`, `Math.floor` applied; default is the ceiling. The ceiling is the smallest reader `neptune_query_timeout` in the cluster (Neptune rejects a per-query value above the instance parameter) and equals the Lambda / HTTP API window, so a query that reaches the boundary may return API Gateway's timeout instead of the typed 504. The API Lambda and the GraphQL Lambda both pin `GREMLIN_SYNC_EVALUATION_TIMEOUT_MS=30000` in CDK.
4. Extract items: `result.toArray()` if present, else `result._items`, else `result.items`, else `[]`.
5. Normalise every item with `toJsonSafe`:
   - `bigint` → decimal string;
   - `Date` → epoch milliseconds (number);
   - arrays → mapped recursively;
   - `Map` → plain object; keys pass through `mapKeyToString`: string as-is, number/boolean/bigint via `String`, an object with a string `key` → that `key`, else with a string `name` → that `name`, else `String(key)`;
   - `Set` → array;
   - other objects → `Object.fromEntries` recursively; primitives unchanged.
   The result is that `valueMap(true)` arrives as `{ id, label, prop: [values] }`. Do not confuse this with `toJsonSafeGraphValue` in `lambda/utils/gremlinEntity.ts` (ISO dates, safe bigints as numbers): that helper serves the search mirror, not this route.
6. Log annotations: every log inside the query carries `gremlinReaderTarget`; timeouts log `timeoutMs`, `readerTarget`, `elapsedMs`, `queryLength`, `neptuneMessage`; throttles log the same minus `timeoutMs`.

## 5. Errors and status mapping for this route

`mapGremlinQueryError` runs on the rejected submit, in this order:

1. `formatCauseMessage(cause)` (appends the driver `ResponseError`'s `statusMessage` and `statusCode`, which is where Neptune's exception code lives). If it contains `timelimitexceeded` or `gremlinquerytimeouterror` → `GremlinQueryTimeoutError { query, timeoutMs, message, neptuneMessage }`. `message` is the fixed sentence from `gremlinQueryTimeoutMessage`, pointing callers to `POST /persist/gremlin-async`.
2. Else if the classifier (§8) says `neptune_throttling` → `GremlinQueryThrottledError { query, message, neptuneMessage }` with the fixed sentence `gremlinQueryThrottledMessage`.
3. Else `toNeptuneRetriableError(message)` → `NeptuneRetriableError` (the retry wrapper consumes it).
4. Else `GremlinSyntaxError` when the message contains any of `syntax`, `compilation`, `token`, `unexpected`, `expecting`, `parse`, `mismatched input`, `no viable alternative`; otherwise `GremlinExecutionError`.

Both fixed messages deliberately avoid Neptune's wording: `withRetry` re-classifies every failure from `Cause.pretty`, and Neptune's own timeout text matches the generic `timed out` reconnect indicator. The typed tags are themselves listed as terminal in the classifier so the retry wrapper cannot overturn the mapping. Tests assert one submit call for both outcomes.

| HTTP | Tag                              | `details`                | Notes                                                                                     |
| ---- | -------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------- |
| 400  | `BadRequest`                     | —                        | invalid JSON or schema decode failure                                                     |
| 400  | `GremlinMutationNotAllowedError` | `query`                  | §3                                                                                        |
| 400  | `GremlinFtsPolicyError`          | `query`, `key?`, `value?`| `opensearch-fts-mirror.md`                                                                |
| 400  | `GremlinSyntaxError`             | `query`                  | indicator match above                                                                     |
| 429  | `GremlinQueryThrottledError`     | `query`                  | no `Retry-After` on purpose (a fixed value would synchronise every throttled client); retry deliberately disabled while the caller holds the request open; background callers keep the normal throttle retry |
| 500  | `GremlinExecutionError`          | `query`                  | any other Neptune failure                                                                 |
| 500  | `InternalServerError`            | —                        | fallback for untagged failures (missing `NEPTUNE_*` config, lexicon loader tags from the layer build, defects) |
| 503  | `NeptuneConnectionError`         | `endpoint`               | connect, credential or signing failure                                                    |
| 503  | `NeptuneRetriableError`          | —                        | retry budget exhausted                                                                    |
| 503/500 | `OpenSearch*` tags            | —                        | FTS freshness gate, see `opensearch-fts-mirror.md`                                        |
| 504  | `GremlinQueryTimeoutError`       | `query`, `timeoutMs`     | Neptune answered that the read is too slow; `neptuneMessage` stays in logs                |

Neither 429 nor 504 is reachable from GraphQL: resolvers call the same `GremlinService.query` with `readerTarget: "default"` and surface these as field errors.

## 6. Router composition

- `createGremlinRouter(layer = GremlinRouterLayer, explainLayer = GremlinExplainRouterLayer)`; the module export `gremlinRouter` uses the defaults. Tests inject a stub layer.
- `GremlinRouterLayer = Layer.mergeAll(GremlinLayer, GraphSONLayer)`, typed as providing `GremlinService | GremlinTx | GraphSONService`. `GremlinLayer = GremlinSupportLayer (GremlinClientLive + GremlinRetryLive) + GremlinServiceLayer (+ GremlinQueryPolicy + GremlinFtsPolicyService over OpenSearchCheckpointStoreService) + GremlinTxLayer`.
- Consequence: the route calls only `GremlinService.query`, but the layer type demands `GraphSONService`, so `GraphSONLayer` and everything under it (lexicon loader with a required `LEXICON_DATA_URI`, blob and transform services) is constructed for this route too. A lexicon or GraphSON configuration error therefore breaks `/persist/gremlin`, not just the GraphSON routes. Drop `GraphSONLayer` from `GremlinRouteLayer` if that isolation is ever wanted.
- The layer is provided per request (`Effect.provide(layer)` inside the handler), not built once in a `ManagedRuntime` as the GraphSON router does. Services are re-instantiated each request; websocket reuse survives because the state managers, pools and target registries are module-level singletons in `GremlinClient.ts` (§7).
- Defects that escape the Effect error channel are caught by the handler, logged as "Gremlin query failed", and returned as 500 `InternalServerError`.

## 7. Connection management

`GremlinClientLive` exposes: `getWriterConnection`, `getReaderConnection` (= `default`), `getReaderConnectionFor(target)`, `withReaderConnection`, `withReaderConnectionFor(target)`, `withWriterConnection`, `getConnection` (= writer), `reset`, `resetConnection(connection)`.

Two reuse mechanisms exist side by side:

- **State managers** (`createStateManager`): one for the writer, one per reader target built lazily through `createReaderTargetRegistry`, plus a test manager. Each caches a single `GremlinConnectionState { g, client, connection, endpoint, endpointRole, createdAt, maxAgeMs }`. `getOrCreate` is single-flight (a pending create promise is shared by concurrent callers), returns the cached state while `client.isOpen` and age ≤ `maxAgeMs`, logs `Reusing … connection` once per state, recycles on `max_age_refresh` (closes the stale client, then creates), and clears itself on the client's `close` event (the close code and message are logged on the next create). `reset` closes and clears; `resetConnection(c)` does so only if `c` is the current state. The sync route uses this path (`getReaderConnectionFor`).
- **Pools** (`createGremlinConnectionPool`): lazy, bounded by a semaphore of `poolSize`, an idle stack, `isReusable = client.isOpen && age ≤ maxAgeMs`; a successful borrow returns the slot, a failed or stale one closes only that slot; `drain` closes idle slots. One writer pool, one reader pool per target (lazy), each pooled connection created with driver `poolSize: 1` and no close handler. Used by pollers, index writers and other background callers via `with*Connection`.

Sizing: `GREMLIN_READER_POOL_SIZE` / `GREMLIN_WRITER_POOL_SIZE` default 1. They size the pools and, for the state-manager path, the driver-level websocket count of the single cached client. CDK overrides: index Lambdas 8/8, the index stream poller 200/32; the API and GraphQL handlers leave both at 1.

Live connection creation (`createLiveConnection`): reads `NeptuneConfig` (requires `NEPTUNE_WRITER_HOST`, `NEPTUNE_READER_HOST`, `AWS_REGION`; `NEPTUNE_PORT` default `8182`; even reader connections need the writer host present), `NeptuneConnectionConfig.maxAgeMs` (`NEPTUNE_CONNECTION_MAX_AGE_MS`, default 2,700,000 ms = 45 min, clamped ≥ 1), resolves the host for the role, fetches credentials from the Node provider chain, builds the SigV4-signed `wss://<host>:<port>/gremlin` URL and headers with `gremlin-aws-sigv4`'s `getUrlAndHeaders`, opens a driver `Client { headers, traversalSource: "g", poolSize }`, and wraps it in `ClientRemoteConnection` for `traversal().withRemote(...)`. Failures at any step are `NeptuneConnectionError { endpoint, message, cause }`.

Signing refresh: the SigV4 signature is computed once per connection at open. It is renewed only by creating a new connection, which happens on max-age recycle, on a `close` event, or when the retry wrapper resets after an `iam_signature_freshness` or reconnect-classified error (§8). `reset` (the default reset used by `withRetry`) closes the writer manager and pool and every reader manager and pool that was actually instantiated; `resetConnection` routes a broken connection back to the manager that owns it via `readerTargetForRole` (`reader`/`writer`/`test` → `default`, `portal_reader` → `portal`, `agency_reader` → `agency`).

`GremlinClientTest` connects a plain `ws://` client to `GREMLIN_TEST_HOST:GREMLIN_TEST_PORT` (default `localhost:8182`), every reader target resolves to the same test connection, and `maxAgeMs` is infinite.

## 8. Retry classification

`classifyNeptuneMessage(message)` lower-cases the text and returns `{ retriable, shouldReconnect, retryClass }`. Precedence is top to bottom; the first matching row wins the class.

| Order | `retryClass`              | Matched substrings                                                                                                                                                                                                   | Reconnect? | Retriable? | Delay                                     |
| ----- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------- | ----------------------------------------- |
| 1     | `neptune_query_timeout`   | `timelimitexceeded`, `gremlinquerytimeouterror`                                                                                                                                                                      | no         | **no**     | —                                         |
| 2     | `terminal`                | `gremlinquerythrottlederror`                                                                                                                                                                                         | no         | **no**     | —                                         |
| 3     | `iam_signature_freshness` | `signature expired`, `signature not yet current`, `old date`, `future date`                                                                                                                                          | yes        | yes        | `base * 2^(attempt-1)`, cap 30,000 ms     |
| 4     | `neptune_throttling`      | `throttlingexception`, `too many concurrent requests`, `request rejected because there are already too many concurrent requests being processed`                                                                     | no         | yes        | `base * attempt` (linear), cap 10,000 ms  |
| 5     | `transient_connection`    | reconnect: `websocket is not open`, `connection has been closed`, `connection was already closed`, `connection closed prematurely`, `connection reset by peer`, `connection refused`, `server disconnected`, `timed out`, `econnreset`, `readonlyviolationexception`; retry without reconnect: `concurrentmodificationexception` | per list   | yes        | `base * 2^(attempt-1)`, cap 30,000 ms     |
| 6     | `transient_connection`    | anything else                                                                                                                                                                                                        | no         | **no**     | —                                         |

Notes:

- Row 1 must precede row 5 because Neptune's own timeout text contains `timed out`.
- `retriable = shouldReconnect || retriableIndicators.includes(...)`; `shouldReconnect` is computed independently, so a throttling message that also mentions a dropped connection reconnects.
- Rows 1 and 2 match the typed tags because `withRetry` classifies `Cause.pretty(cause)`, which renders the already-typed failure; a raw `ThrottlingException` stays retriable for background callers (verified by `GremlinRetry.test.ts`).

`GremlinRetry.withRetry(effect, { reset? })`: `maxAttempts = max(0, NEPTUNE_RETRY_MAX_ATTEMPTS) + 1` (default 5 retries, 6 attempts); `baseDelayMs = max(1, NEPTUNE_RETRY_BASE_DELAY_MS)` (default 1000). Every failure cause is re-derived through `toNeptuneRetriableError(Cause.pretty(cause))`, so a typed error whose message contains an indicator becomes retriable. On `NeptuneRetriableError` it logs `attempt`, `maxAttempts`, `retryClass`, `shouldReconnect`, `willRetry`, `retryDelayMs`; runs the reset effect (default: `GremlinClient.reset`, global) when `shouldReconnect`; then sleeps and re-runs, or fails with the `NeptuneRetriableError` (503) once the budget is spent. Anything not retriable passes through untouched.

CDK budgets (retries / base ms): API handler 2 / 1000 (two `withRetry` units per ingest request must fit the 29 s integration window), GraphQL handler 3 / 1000, EventBridge fact handler 3 / 1000, workflow item stage 10 / 1000; everything else inherits 5 / 1000.

## 9. Transactions and the write path

### 9.1 Transactions

`GremlinTx.withTransaction(f)` wraps `f` in `withRetry(acquireUseRelease(...))` on the **writer** connection:

- Acquire: `getWriterConnection`, then `tx = g.tx()`, `gtx = tx.begin()`. `begin` creates a session-bound `ClientRemoteConnection` (a new driver `Client` with a random `session` id; a session-bound connection refuses to create a child session).
- Use: run `f(gtx)`; on success `tx.commit()` (submits `Bytecode.GraphOp.commit` on the session client) and mark `committed`.
- Release: if not committed and `tx.isOpen`, `tx.rollback()`. `tx.isOpen` is the session connection's `isOpen`; `commit()` and `rollback()` both close the session in `finally`, so a failed commit that already closed the session is not rolled back twice. Rollback failures are logged (`Transaction rollback failed`) and never raised.
- Errors: begin, commit and rollback failures go through `toNeptuneRetriableError`, else `GremlinExecutionError` with `query` = `g.tx().begin()`, `tx.commit()` or `tx.rollback()`. A retriable failure re-runs the whole transaction, so `f` must be idempotent (the upserts are).
- `GremlinTxTest` runs `f` directly on `g` with no transaction. The only production caller is `GraphSONService.ingest` (one transaction per sync ingest request).

### 9.2 Script path versus bytecode path

`upsertVertex` / `upsertEdge` pick the path per element:

- If any property value (or any element of a list value) is a GraphSON temporal wrapper (`@type` `g:Date` or `g:Timestamp`), build a Groovy script and submit it through the traversal source's `remoteConnection.client.submit(script)` — this works on `g` and on a transaction-bound `gtx`. Shape: `g.V().hasId(<id>).fold().coalesce(unfold(), addV(<label>).property(id, <id>).property(<k>, datetime("<v>"))…)` (edges: `g.E().hasId(...)...V().hasId(out).addE(label).to(V().hasId(in))`). `g:Date` renders through `toNeptuneCsvDateString` (date only), `g:Timestamp` through `toNeptuneCsvDatetimeString` (ISO, no milliseconds); strings are JSON-quoted; finite numbers, bigints, booleans and `null` bare; non-finite numbers and everything else quoted via `String`. No `evaluationTimeout` is attached, so the writer's own `neptune_query_timeout` applies. A traversal source without a client yields `GremlinExecutionError` ("Traversal source does not expose a Gremlin client for temporal property upsert"). Rendering rules and why datetime is script-only: `identity-hashing-and-blobs.md`.
- Otherwise use bytecode: `g.V().has(id, hash).fold().coalesce(__.unfold(), __.addV(label).property(id, hash).property(...))`, with every GraphSON typed value unwrapped to its `@value` (recursively for lists) and list values applied as repeated `.property(key, entry)` calls. Bytecode request options (`evaluationTimeout`, `batchSize`, …) are lifted from an `OptionsStrategy` on the traversal by `ClientRemoteConnection.submit`.

## 10. Verification

- `test/routes/gremlin.router.test.ts`: 200 with results, `readerTarget` forwarded and echoed, 400 for `g.addV(...)`, 504 with `details.timeoutMs`, 429 for the throttled tag, 500 for a plain execution error, 400 for invalid payloads.
- `test/services/GremlinQueryPolicy.test.ts`, `GremlinQuery.test.ts`: policy accept/reject, syntax and execution mapping, `valueMap` normalised to objects.
- `test/services/GremlinService.test.ts`: `evaluationTimeout` sent, clamped and defaulted; timeout and throttle mapped without a second submit; datetime scripts for temporal vertex and edge properties; reader reacquired after a reconnect reset.
- `test/services/GremlinRetry.test.ts`: every class in §8, delay caps, reset-then-retry for signature expiry, no retry after a query timeout, request-scoped reset.
- `test/services/GremlinClient.test.ts`: state reuse and single-flight create, pool lazy open, cap, slot replacement and stale refresh, registry laziness, `readerTargetForRole`, host resolution and fallback.
- `test/services/GremlinTx.test.ts`: commit, rollback on failure, test layer bypass.
- Manual: `curl -X POST <api>/persist/gremlin -d '{"gremlin":"g.V().limit(1).valueMap(true)","readerTarget":"portal"}'` returns `readerTarget: "portal"`; `{"gremlin":"g.V().drop()"}` returns 400 `GremlinMutationNotAllowedError`; a deliberately slow traversal returns 504 with `timeoutMs: 30000` or API Gateway's own timeout.

## 11. Source map

| Concern                                     | Path (persist repo)                                                        |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| Route handler, per-request layer            | `lambda/routes/gremlin.router.ts`, mount in `lambda/router.ts`             |
| Schemas (`readerTarget`, size bounds)       | `lambda/schemas/gremlin.ts`                                                |
| Query flow, timeout clamp, `toJsonSafe`, error mapping, temporal scripts | `lambda/services/GremlinService.ts`                    |
| Read-only regex                             | `lambda/services/GremlinQueryPolicy.ts`                                    |
| FTS gate                                    | `lambda/services/GremlinFtsPolicyService.ts`                               |
| State managers, pools, signing, max age     | `lambda/services/GremlinClient.ts`                                         |
| Classifier and `withRetry`                  | `lambda/services/GremlinRetry.ts`                                          |
| Transactions                                | `lambda/services/GremlinTx.ts`                                             |
| Neptune config and defaults                 | `lambda/config/neptune.ts`                                                 |
| Layer composition                           | `lambda/services/index.ts` (`GremlinLayer`, `GremlinRouterLayer`)          |
| Tags and status codes                       | `lambda/schemas/errors.ts`, `lambda/http/responses.ts`                     |
| `formatCauseMessage`                        | `lambda/utils/errors.ts`                                                   |
| Temporal helpers                            | `lambda/utils/neptuneTemporal.ts`                                          |
| CDK env, timeouts, pool and retry overrides | `lib/persist-stack.ts`                                                     |
| README (note: "Gremlin service operations" still lists `countVertices`/`addVertex`/`addEdge`, which no longer exist) | `README.md` "Transactions", "Layer composition", "POST /persist/gremlin" |
