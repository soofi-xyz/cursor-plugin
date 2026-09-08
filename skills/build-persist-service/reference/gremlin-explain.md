# Gremlin Explain Endpoint — `POST /persist/gremlin/explain`

Persist exposes Neptune's Gremlin explain API as a synchronous, read-only route beside `POST /persist/gremlin` (PRD §4.1). The route accepts the same query text and reader-target selector as the query route, applies the same read-only and FTS policies, then asks Neptune for the traversal's logical execution plan over the Neptune HTTP data API instead of submitting the traversal over the Gremlin websocket. The plan comes back as an opaque UTF-8 text report inside the standard `{ ok, data }` envelope (`error-catalogue-and-responses.md` §2). Use it to let callers and agents diagnose slow or badly indexed traversals without running them.

## 1. Purpose & scope

- Return Neptune's explain report for a Gremlin traversal so callers can inspect the optimized traversal, index usage, and step ordering before running it.
- Reuse the query route's policies unchanged: a query that `/persist/gremlin` would reject is rejected here for the same reason, before Neptune is contacted.
- Route to the same named reader targets as the query route so the report reflects the reader the caller will actually use.

Non-goals:

- Not a query execution path. The endpoint never returns traversal results, never mutates, and must not be used as a cheaper way to run a query.
- Not a write path. Mutation steps and transaction control are rejected exactly as on the query route (`gremlin-sync-query.md` §3); the writer endpoint is never reached.
- Not an async job. Reports are bounded in size and time; oversized or slow explains fail fast rather than spilling to S3 or a job table.

## 2. Architecture

- **Router**: the Gremlin router registers `POST /gremlin/explain` next to `POST /gremlin` (mounted under `/persist/{proxy+}` on the IAM-authorised HTTP API, PRD §2.4.5). Both routes decode JSON, decode the request schema, run the service effect, and map failures through the shared HTTP error mapper. The explain route receives its own service layer so it can be provided independently of the query/ingest layer in tests and handlers.
- **Service**: `GremlinExplainService` composes three injected pieces — a read-only query policy (`assertReadOnly`), the FTS policy (`prepareQuery`, PRD §4.1 side-effect rules and endpoint injection), and a per-reader-target runtime that lazily builds one Neptune data-API client per target and caches it for the container lifetime.
- **Endpoint selection**: explain always targets a **reader**. The request's `readerTarget` resolves through the same reader-host resolver the query route uses (`resolveNeptuneReaderHost`): `default` maps to the general reader host (`NEPTUNE_READER_HOST`, the custom general endpoint or cluster-ro per `neptune-reader-topology.md` §2.2); `portal`/`agency` map to `NEPTUNE_PORTAL_READER_HOST`/`NEPTUNE_AGENCY_READER_HOST` when set, otherwise fall back to `NEPTUNE_READER_HOST` and log the fallback (`portal`/`agency` are role names standing in for deployment-specific identifiers, see the naming note in `neptune-reader-topology.md`). The service depends only on reader-side configuration (`NEPTUNE_READER_HOST`, `NEPTUNE_PORT`, `AWS_REGION`, optional per-target hosts); it must construct without `NEPTUNE_WRITER_HOST`.
- **Transport**: the Neptune data-API SDK client (`ExecuteGremlinExplainQuery`) over HTTPS to `https://<reader-host>:<port>`, SigV4-signed with the Lambda role credentials (`neptune-db:connect` + `neptune-db:ReadDataViaQuery` on the cluster resource). This is deliberately not the websocket Gremlin client: explain is an HTTP-only Neptune operation and must not consume or disturb the pooled websocket connections managed per PRD §7.2. SDK retries are disabled (`maxAttempts: 1`); the service owns timeout and error classification.

## 3. Contract

Request (`GremlinExplainRequest`):

| Field | Type | Default | Notes |
| ----- | ---- | ------- | ----- |
| `gremlin` | string, 1..50,000 chars | required | Same `GremlinQueryText` bounds as the query route (`gremlin-sync-query.md` §2). |
| `readerTarget` | `"default"` \| `"portal"` \| `"agency"` | `"default"` | Same literal set as the query route (`neptune-reader-topology.md` §3.2); unknown values are a 400 `BadRequest` at decode time. |

Neptune explain mode/verbosity flags are **not** exposed; the service always requests the default explain output. Add them as optional schema fields with explicit defaults if a caller needs `profile`-style detail, and keep the request schema the single place they are validated.

Response (`200`, standard envelope):

```json
{ "ok": true, "data": { "report": "<opaque UTF-8 explain text>", "durationMs": 12, "readerTarget": "default", "requestId": "<neptune-request-id>" } }
```

- `report` is the raw report bytes decoded as strict UTF-8; do not parse, reformat, or truncate it server-side.
- `durationMs` covers policy checks plus the Neptune round trip. `requestId` is Neptune's request id when the SDK returns one.

Error mapping (the explain-specific rows of `error-catalogue-and-responses.md` §3; `lambda/http/responses.ts` remains the sole tag-to-status mapper):

| HTTP | Tag | When |
| ---- | --- | ---- |
| 400 | `BadRequest` | Invalid JSON or schema decode failure. |
| 400 | `GremlinMutationNotAllowedError`, `GremlinFtsPolicyError` | Policy rejection before Neptune is called. |
| 400 | `GremlinSyntaxError` | Neptune HTTP 400 or a malformed/oversized-query exception name (`MalformedQueryException`, `QueryLimitException`, `QueryTooLargeException`, `ConstraintViolationException`, …). |
| 429 | `GremlinExplainThrottledError` | Neptune HTTP 429 or a capacity exception (`QueryLimitExceededException`, `ThrottlingException`, `TooManyRequestsException`). Retriable by the caller. |
| 500 | `GremlinExplainError` | Any other Neptune failure with an HTTP status, an empty report, or a report that is not valid UTF-8. Details carry `query` plus `neptuneCode` / `httpStatusCode` when known. |
| 500 | `OpenSearchSyncStateError` | FTS policy preflight could not read the sync-state store. |
| 502 | `GremlinExplainReportTooLargeError` | Report bytes exceed `GREMLIN_EXPLAIN_MAX_REPORT_BYTES`. Details: `reportBytes`, `maxReportBytes`. |
| 503 | `NeptuneConnectionError`; `OpenSearchIndexUnavailable`, `OpenSearchSyncCheckpointMissing`, `OpenSearchIndexLagExceeded` | Failure with no HTTP status (DNS, credentials, socket); FTS freshness-gate rejections (`opensearch-fts-mirror.md` §4.6). |
| 504 | `GremlinExplainTimeoutError` | Effect-level timeout, SDK abort, Neptune HTTP 408, or a timeout exception name. Details: `timeoutMs`. |

Keep the two capacity families distinct: `QueryLimitExceededException` is a throttle (429), while `QueryLimitException` and `QueryTooLargeException` are non-retryable oversized-query failures (400).

Limits and configuration:

- `GREMLIN_EXPLAIN_TIMEOUT_MS` — default **25,000 ms**, also the hard maximum (values above are clamped, floor 1 ms) so the route always answers inside the HTTP API's 29 s integration ceiling. Applied both as the SDK request timeout (with an abort signal) and as an Effect timeout around the call. Neither variable is set in CDK; the code defaults apply on the API Lambda.
- `GREMLIN_EXPLAIN_MAX_REPORT_BYTES` — default **4 MiB**, enforced on the raw byte length before decoding so the synchronous Lambda/API response limit is never hit.
- Read-only enforcement is policy-based, not endpoint-based: reader routing alone is not a mutation guard (`gremlin-sync-query.md` §3), so `assertReadOnly` runs first and no Neptune call is made on rejection.

## 4. Runtime behaviour

1. Decode the body; reject invalid JSON or schema with 400.
2. Run `assertReadOnly(gremlin)`; fail with `GremlinMutationNotAllowedError` before any network activity.
3. Run `prepareQuery(gremlin)`; the FTS policy validates `withSideEffect` keys and injects the configured `Neptune#fts.endpoint` when the query uses FTS predicates. The **prepared** query is sent to Neptune; the **caller's original** query text is what appears in error details.
4. Resolve the reader-target client (create on first use, reuse afterwards). Log when a named target fell back to the cluster reader.
5. Send `ExecuteGremlinExplainQuery` with the abort signal and request timeout; classify any rejection through the explain error mapper.
6. Fail on a missing report, on a report above the byte cap, and on invalid UTF-8, each with its own tag.
7. Return `{ report, durationMs, readerTarget, requestId? }`.

## 5. Observability

- Log span `GremlinExplainService.execute` annotated with `endpoint`, `gremlinReaderTarget`, and `operation: ExecuteGremlinExplainQuery`.
- On failure log `errorTag`, `endpoint`, `readerTarget`, `queryLength`, and `elapsedMs` — never the report body. Unexpected router-level exceptions log only the cause's type name.
- Query text is included in structured error details returned to the (IAM-authenticated) caller, matching the query route; it is not written to logs by the service.
- No dedicated metrics are required; reuse the API handler's request metrics (PRD §7.5). If added, dimension only by bounded values (`readerTarget`, error tag).

## 6. Verification & acceptance criteria

- Router: a valid body with a named `readerTarget` returns 200 with the service response unchanged; a missing `readerTarget` defaults to `default`; an empty `gremlin` returns 400 `BadRequest`.
- Service: the UTF-8 report and request id are returned; the SDK receives the configured request timeout; the prepared (FTS-adjusted) query is sent while errors carry the original query; a mutation is rejected with zero client calls.
- Service: an empty output and an invalid-UTF-8 output both fail with `GremlinExplainError`; an output above `maxReportBytes` fails with `GremlinExplainReportTooLargeError` carrying both byte counts; a hung client is interrupted at the configured timeout with `GremlinExplainTimeoutError`.
- Error mapper: throttle names and HTTP 429 map to the throttled tag; `QueryLimitException` maps to `GremlinSyntaxError`; timeout names and HTTP 408 map to the timeout tag; a status-less failure maps to `NeptuneConnectionError`; a status-bearing unknown failure maps to `GremlinExplainError` with `httpStatusCode`.
- Layer isolation: the explain layer constructs with only `NEPTUNE_READER_HOST`, `NEPTUNE_PORT`, and `AWS_REGION`, and fails with a missing-`NEPTUNE_READER_HOST` config error when only the writer host is set.
- OpenAPI: the generated document lists `/persist/gremlin/explain` with 200/400/429/500/502/503/504 responses that match the HTTP mapper.

## 7. Source map

| Concern | Path (persist repo) |
| ------- | ------------------- |
| Route registration and decode | `lambda/routes/gremlin.router.ts` |
| Service, runtime, error mapper | `lambda/services/GremlinExplainService.ts` |
| Request/response schemas, reader-target literal | `lambda/schemas/gremlin.ts` |
| Reader-host resolution, reader-only config | `lambda/config/neptune.ts` |
| Error tags | `lambda/schemas/errors.ts` |
| Tag → HTTP status, response schemas | `lambda/http/responses.ts`, `lambda/schemas/http.ts` |
| OpenAPI route definition | `lambda/api/definitions.ts`, `docs/openapi.json` |
| Layer wiring | `lambda/services/index.ts` (`GremlinExplainRouterLayer`) |
| Tests | `test/services/GremlinExplainService.test.ts`, `test/routes/gremlin.router.test.ts`, `test/services/router-layer-isolation.test.ts`, `test/api/openapi.test.ts`, `test/http/responses.test.ts` |
