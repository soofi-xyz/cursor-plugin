# Response envelope and error catalogue

Every HTTP surface of the persistence service answers with one JSON envelope, and one function (`lambda/http/responses.ts` `error()`) is the only place a tagged error becomes an HTTP status. This file is the code-derived catalogue of that mapping: the envelope shapes, every tagged error class in `lambda/schemas/errors.ts` and where it lands, the tags that collapse to the 500 fallback, the per-route sanitisation and logging, and the rules that decide when a failure is a tagged error versus an issue code. Treat this file, not the PRD, as authoritative for this area.

## 1 Scope

- In scope: envelope shape, tag-to-status mapping, fallback behaviour, sanitisation, per-route logging, GraphQL whole-request versus per-field failure, issue-code-versus-tag rule.
- Out of scope, owned elsewhere: the issue-code catalogue for GraphSON validation stages (`graphson-ingest-contract.md`), FTS tag semantics and OpenSearch policy checks (`opensearch-fts-mirror.md`), explain tag semantics and Neptune code mapping (`gremlin-explain.md`), blob hashing rules (`identity-hashing-and-blobs.md`), async job lifecycle (`async-gremlin.md`), GraphQL field resolution (`graphql-read-surface.md`).

## 2 Response envelope

Source: `lambda/http/responses.ts` (`ok`, `accepted`, `error`, `badRequest`, `internalError`) and `lambda/schemas/http.ts` (`OkResponse`, `ErrorResponse`, one `*Response` schema per mapped tag). All helpers set `Content-Type: application/json`.

Success. `ok(data)` is 200, `accepted(data)` is 202 (async submissions and async cancel acknowledgements). `ok(undefined)` serialises to `{ "ok": true }` with no `data` key.

```json
{ "ok": true, "data": { "results": [], "durationMs": 12, "readerTarget": "default" } }
```

Error. `type` is the error tag verbatim, `message` is the tag's `message` field (except `GraphSONValidationError`, whose envelope message is always the constant `"GraphSON validation error"`), and `details` is present only when the tag contributes at least one field; `withDetails` drops an empty object. Optional tag fields (`cause`, `queryId`, `neptuneCode`, ...) are spread in only when set. Fields marked log-only in `errors.ts` (`neptuneMessage` on the sync timeout and throttle tags) never reach the envelope.

```json
{
  "ok": false,
  "error": {
    "type": "GraphSONPayloadValidationError",
    "message": "GraphSON payload validation failed",
    "details": {
      "issues": [
        { "code": "Type", "path": "/@value/vertices/0/@value/id", "message": "Expected string, actual undefined" }
      ],
      "issueCount": 1
    }
  }
}
```

Issue arrays. `GraphSONPayloadValidationError.details.issues[]` is `GraphSONPayloadValidationIssue`: `{ code, path, message, instanceLabel?, expected?, actual? }`, and `issueCount` is added by `error()` as `issues.length`. Semantic-stage issues populate the three optional fields; decode-stage issues carry only the first three. `GraphSONIntegrityError.details.issues[]` is the integrity issue union from `lambda/schemas/graphson/validate.ts`; the sync routes use `GraphSONSyncValidationIssue`, `/ingest-async` uses the wider `GraphSONValidationIssue` (adds the vertex-refs-not-supported-for-async issue) and has no `issueCount`. `MissingVertexRef.details.issues[]` is `{ code: VertexNotFoundForRef | LabelMismatchForRef | MalformedRefId, vertexId, expectedLabel, actualLabel? }` plus `issueCount`. Issue codes themselves are catalogued in `graphson-ingest-contract.md`.

`requestId`. The envelope has no top-level request id. The API Gateway `requestContext.requestId` is appended to every log line for the request by the `httpApiRequestContext` middleware (`lambda/http/request-context.ts`, keys `method`, `path`, `requestId`, removed after the handler) and is never copied into the body. A `requestId` that does appear in a body is domain data: `data.requestId` on async submit/status/cancel and, optionally, on sync Gremlin and explain responses (`lambda/schemas/gremlin.ts`), and `details.requestId` on the async-Gremlin tags.

Two bodies outside the envelope. `POST /persist/graphql` returns the raw GraphQL result `{ data?, errors?, extensions }` at 200 with no `ok` wrapper (`lambda/graphql/handler.ts`, `json(200, attempt.right)`); `GET /persist/graphql/schema` likewise returns `{ sdl, sdlHash, lexiconUri, resolutionMapHash, generatedAt }` unwrapped. Whole-request GraphQL failures do use the error envelope through the shared `error()`.

## 3 Status mapping table

`error()` switches on `_tag` for exactly 40 tags. Every other value, and any non-tagged throwable, falls to `500 InternalServerError` (section 4). `badRequest(message)` and `internalError(message)` produce `BadRequest` / `InternalServerError` envelopes with no `details`.

| HTTP | Tag | `details` keys | Raised by / surface | Owner file |
| ---- | --- | -------------- | ------------------- | ---------- |
| 400 | `BadRequest` | none | every route on unparseable JSON (`"Invalid JSON body"`), Gremlin/explain request decode failure (formatted parse error), `/validate` wrapper errors, async status/cancel missing `requestId` | this file |
| 400 | `GremlinSyntaxError` | `query` | Gremlin sync, explain, async submit | `gremlin-sync-query.md` |
| 400 | `GremlinMutationNotAllowedError` | `query` | Gremlin sync, explain (`GremlinQueryPolicy`) | `gremlin-sync-query.md` |
| 400 | `GremlinFtsPolicyError` | `query`, `key?`, `value?` | Gremlin sync, explain | `opensearch-fts-mirror.md` |
| 400 | `GraphSONValidationError` | `path`, `expected`, `received` | mapped and sanitised on GraphSON routes; no service constructs it today | this file |
| 400 | `GraphSONPayloadValidationError` | `issues[]`, `issueCount` | GraphSON `/ingest`, `/ingest-async`, `/validate` (decode + semantic stages, incl. lexicon load failure) | `graphson-ingest-contract.md` |
| 400 | `GraphSONIntegrityError` | `issues[]` | GraphSON all three routes | `graphson-ingest-contract.md` |
| 400 | `DerivedIndexServerManagedPropertyError` | `ownerType`, `ownerKind`, `indexName`, `path` | mapped, but no code path constructs it (section 6) | this file |
| 400 | `PersistBlobValidationError` | `path?`, `code?`, `expected?`, `actual?` | GraphSON `/ingest`, `/ingest-async` (blob transform) | `identity-hashing-and-blobs.md` |
| 400 | `GraphQlRequestError` | `cause?` | GraphQL whole-request: body decode, document parse, non-query operation, guard analysis throwing on an undefined or cyclic fragment, and Yoga transport failures | `graphql-read-surface.md` |
| 400 | `GraphQlComplexityError` | `limit`, `actual` | GraphQL whole-request | `graphql-read-surface.md` |
| 404 | `VertexNotFoundError` | `vertexId` | mapped and sanitised on GraphSON routes; no service constructs it today | this file |
| 404 | `MissingVertexRef` | `issues[]`, `issueCount` | GraphSON `/ingest`, `/validate` (vertex-ref verifier) | `graphson-ingest-contract.md` |
| 404 | `GremlinAsyncRequestNotFoundError` | `requestId` | async status, async cancel | `async-gremlin.md` |
| 429 | `GremlinQueryThrottledError` | `query` | Gremlin sync; terminal, no retry, no `Retry-After` | `gremlin-sync-query.md` |
| 429 | `GremlinExplainThrottledError` | `query`, `neptuneCode?` | explain | `gremlin-explain.md` |
| 500 | `GremlinExecutionError` | `query` | Gremlin sync (unsanitised); GraphSON routes (sanitised to `InternalServerError`) | `gremlin-sync-query.md` |
| 500 | `GremlinExplainError` | `query`, `neptuneCode?`, `httpStatusCode?` | explain | `gremlin-explain.md` |
| 500 | `OpenSearchSyncStateError` | `operation`, `cause?` | Gremlin sync, explain (FTS checkpoint read) | `opensearch-fts-mirror.md` |
| 500 | `GraphQlSchemaGenerationError` | `cause?` | GraphQL whole-request and `GET /schema` | `graphql-read-surface.md` |
| 500 | `GraphQlResolutionMapError` | `issues[]`, `cause?` | GraphQL whole-request and `GET /schema` | `graphql-read-surface.md` |
| 500 | `PersistBlobHashCollisionError` | `bucket`, `key`, `contentHash`, `expectedByteLength`, `actualByteLength?` | GraphSON `/ingest`, `/ingest-async` | `identity-hashing-and-blobs.md` |
| 500 | `GremlinAsyncJobSerializationError` | `operation`, `requestId?`, `cause?` | async status, async cancel | `async-gremlin.md` |
| 500 | `GremlinAsyncResultSerializationError` | `requestId`, `cause?` | mapped; raised by the async worker, not by a route | `async-gremlin.md` |
| 500 | `GremlinAsyncJobConditionalConflictError` | `operation`, `requestId`, `expectedStatuses[]` | async cancel | `async-gremlin.md` |
| 500 | `InternalServerError` | none | fallback for everything else (section 4) | this file |
| 502 | `GremlinExplainReportTooLargeError` | `reportBytes`, `maxReportBytes` | explain | `gremlin-explain.md` |
| 504 | `GremlinQueryTimeoutError` | `query`, `timeoutMs` | Gremlin sync (Neptune evaluation timeout); `neptuneMessage` is log-only | `gremlin-sync-query.md` |
| 504 | `GremlinExplainTimeoutError` | `query`, `timeoutMs`, `neptuneCode?` | explain | `gremlin-explain.md` |
| 503 | `NeptuneConnectionError` | `endpoint`, `cause?` | Gremlin sync, explain, GraphSON routes (client connect) | `gremlin-sync-query.md` |
| 503 | `NeptuneRetriableError` | `cause?`, `shouldReconnect` | Gremlin sync, GraphSON routes (retry budget exhausted) | `gremlin-sync-query.md` |
| 503 | `OpenSearchIndexUnavailable` | `endpoint?`, `indexName?`, `cause?` | Gremlin sync, explain | `opensearch-fts-mirror.md` |
| 503 | `OpenSearchIndexLagExceeded` | `lagSeconds`, `maxLagSeconds` | Gremlin sync, explain | `opensearch-fts-mirror.md` |
| 503 | `OpenSearchSyncCheckpointMissing` | none | Gremlin sync, explain | `opensearch-fts-mirror.md` |
| 503 | `S3PayloadStoreError` | `bucket`, `key`, `cause?` | GraphSON `/ingest-async` (payload stash) | this file |
| 503 | `PersistBlobStoreError` | `bucket`, `key`, `cause?` | GraphSON `/ingest`, `/ingest-async` | `identity-hashing-and-blobs.md` |
| 503 | `SqsEnqueueError` | `queueUrl`, `cause?` | GraphSON `/ingest-async`, async Gremlin submit | `async-gremlin.md` |
| 503 | `GremlinAsyncJobStoreError` | `operation`, `requestId?`, `cause?` | async status, async cancel | `async-gremlin.md` |
| 503 | `GremlinAsyncResultStoreError` | `bucket`, `key`, `cause?` | mapped; raised by the async worker, not by a route | `async-gremlin.md` |
| 503 | `GremlinAsyncExecutionError` | `operation`, `requestId`, `queryId?`, `cause?` | mapped; raised by the Neptune data-API client used by the worker | `async-gremlin.md` |
| 503 | `GremlinAsyncExecutionTimeoutError` | `operation`, `requestId`, `queryId?`, `timeoutMs` | async cancel (data-API cancel timeout), worker | `async-gremlin.md` |
| 503 | `GremlinAsyncCancelError` | `operation`, `requestId`, `queryId`, `cause?` | async cancel | `async-gremlin.md` |

Two non-`error()` statuses exist: `405 { ok:false, error:{ type:"MethodNotAllowed", message:"Method Not Allowed" } }` from the GraphQL handler for any non-POST on `/persist/graphql`, and the Powertools router's own 404/405 for unknown routes (section 5). `docs/openapi.json` is generated from `lambda/api/definitions.ts` and lists, per path, only the tags that route can emit; keep it in step with this table.

## 4 Unmapped tags and the fallback

`lambda/schemas/errors.ts` declares 90 `Schema.TaggedError` classes; `error()` handles 40. Any of the remaining 50 that reaches a route collapses to `500 { ok:false, error:{ type:"InternalServerError", message:"Internal Server Error" } }` with no `details`, so no tag name, bucket, key, or cause leaks. Group them by how they actually surface:

- Lexicon loader: `LexiconConfigReadError`, `LexiconUriParseError`, `LexiconObjectFetchError`, `LexiconDecodeError`. On `/validate` and both ingest routes the semantic validator maps them to `GraphSONPayloadValidationError` with a single issue `code: "SemanticLexiconLoadFailure"`, `path: "/"`, `actual: "<ErrorName>: <message> (<cause>)"` (400). The blob and persist transforms load the lexicon with `Effect.orDie`, so a failure there is a defect, escapes `Effect.either`, hits the route's `catch`, and becomes the 500 fallback.
- GraphQL per-field tags: `GraphQlPiiAccessDenied`, `GraphQlExternalContextMissing`, `InterproseResolverError` (Interprose resolver). Never reach `error()`; see section 6. `GraphQlPiiAccessPolicyConfigError` is raised while building the policy layer and reaches the caller only as the 500 fallback.
- Derived index and export: `DerivedIndexCatalogError`, `DerivedIndexValidationError`, `DerivedIndexExecutionError`, `DerivedIndexStateStoreError`, `DerivedIndexStreamError`, `IndexStreamCheckpointMissing`, `IndexRebuildInputError`, `IndexRebuildStorageError`, `DebtIndexExport{Schema,Query,Sql,Decode,Run}Error`, `AthenaIndexStreamSeedRefusedError`, `WorkflowIndexCatchupError`. Raised in stream pollers, rebuild steps, and export workflows; surfaced as thrown Lambda errors whose `name` is the tag (`toReadableError` in `lambda/utils/errors.ts`), never as HTTP.
- EventBridge: `GraphFactEventValidationError` (malformed graph-fact event). `lambda/graph-fact-event/handler.ts` logs `"Graph fact event failed"` with `eventId`, `source`, and the message, then rethrows so the invocation fails and the event is retried or dead-lettered by the bus.
- Async workers and CSV workflow: `AsyncQueueMessageDecodeError`, `AsyncPayloadFetchError`, `AsyncPayloadDecodeError`, `AsyncFilteredCsvReadError`, `AsyncFilteredCsvParseError`, `NeptuneCsvUploadError`, `NeptuneBulkLoad{,QueueFull,Timeout}Error`, `StepFunctionTaskCallbackError`, `GremlinAsyncQueryCancelledError`, `WorkflowInputValidationError`, `WorkflowCostPredictionError`, `NeptuneCsv{Lexicon,Workflow,Object}ValidationError`, `NeptuneCsvDedupError`, `WorkflowSummaryError`, `CsvWorkflowMetricsError`. SQS/Step Functions surfaces; they change job state or fail the invocation, never an HTTP body.
- Other: `NeptuneClusterEndpointError` (custom-endpoint lifecycle handler), `OpenSearchFts{Definition,Mapping,Transform}Error` (FTS mirror build; see `opensearch-fts-mirror.md`).
- Declared but never constructed anywhere in `lambda/`: `S3ObjectMetadataError`, `AsyncFilteredBatchQueueDecodeError`, `NeptuneCsvEdgeReferenceError` (present only in error-type unions), and the three route-facing tags called out in the table (`DerivedIndexServerManagedPropertyError`, `GraphSONValidationError`, `VertexNotFoundError`). Do not document them as observable outcomes; remove or wire them deliberately.

## 5 Sanitisation and logging

Sanitisation. `sanitizeGraphsonError` in `lambda/routes/graphson.router.ts` runs on `/ingest`, `/ingest-async`, and `/validate`, on both the `Effect.either` Left branch and the `catch` branch, before `error()`:

| Tag | Rewritten | Kept | Why |
| --- | --------- | ---- | --- |
| `GraphSONValidationError` | `received` becomes `"invalid"` | `path`, `expected` | never echo the caller's raw value |
| `GraphSONIntegrityError` | `message` becomes `"GraphSON integrity error"` | `issues` | strip service-internal wording |
| `GraphSONPayloadValidationError` | rebuilt from `message` + `issues` only | both | drop any extra properties |
| `VertexNotFoundError` | `message` becomes `"Vertex not found"` | `vertexId` | strip internal wording |
| `GremlinExecutionError` | replaced by a plain `Error` -> 500 `InternalServerError`, no `details` | nothing | the tag carries `query` text; ingest callers must not see generated Gremlin |
| anything else | passed through unchanged | all | `NeptuneConnectionError.endpoint`, blob `bucket`/`key`, `SqsEnqueueError.queueUrl` are returned as-is |

The Gremlin sync, explain, and async routers do not sanitise: `GremlinExecutionError`, `GremlinSyntaxError`, timeout and throttle tags return `details.query` verbatim, and connection errors return `endpoint`.

Route logging (all through the Powertools logger, with `method`/`path`/`requestId` appended by middleware):

- GraphSON routes: validation tags (`GraphSONValidationError`, `GraphSONPayloadValidationError`, `GraphSONIntegrityError`, `MissingVertexRef`) log at `warn` (`"GraphSON ingest failed"` / `"... async ingest failed"` / `"... validation failed"`, with the full error object); every other Left logs at `error`. A rejected promise (defect) logs `error` `"GraphSON ... threw"` with the cause and is then sanitised, so a defect yields the 500 fallback (covered by the "hides defects behind internal responses" test). A candidate-lexicon runtime that fails to dispose logs `"GraphSON validation runtime disposal failed"` without changing the response.
- Gremlin sync: a Left is returned through `error()` with no route-level log; a thrown error logs `"Gremlin query failed"` with the cause and returns `internalError("Internal server error")` (lower-case `s`, unlike the default).
- Explain: same shape; the throw path logs only `causeType` (`"Gremlin explain failed unexpectedly"`) and returns `internalError("Internal server error")`.
- Async Gremlin: `GremlinSyntaxError` on submit and `GremlinAsyncRequestNotFoundError` on status/cancel log at `warn`; other Lefts at `error`; throws log `"... threw"` (with `requestId` on status/cancel) and return `internalError()` with the default message.
- GraphQL: a successful request logs `"GraphQL request completed"` with `requestId`, `operationName`, `sdlHash`, `resolutionMapHash`, `sources`, `errorCount`, `durationMs`; an unhandled throw logs `"Unhandled GraphQL handler failure"` with `requestId` and message, returns `internalError()`, then `resetKeys()`.

Powertools router fallback (`lambda/router.ts` builds a `Router` from `@aws-lambda-powertools/event-handler/http` with three included routers under the `/persist` prefix). Because every route handler catches both the Left and the throw, the router's own error path is reached only for: an unknown path (404 `{ statusCode: 404, error: "NotFoundError", message: "Route <path> for method <method> not found" }`), an unsupported HTTP method on the event (405, empty body), or a failure inside middleware (500 `{ statusCode: 500, error: "Internal Server Error", message: "Internal Server Error" }`). These three bodies are not in the `ok` envelope. The router logs the caught error at `debug` (`"There was an error processing the request: ..."`); the message and stack are included in the 500 body only when Powertools dev mode is on, which the stack never enables. `lambda/handler.ts` logs `"Lambda event received"` with the full event before resolving and always flushes ingest metrics in `finally`.

## 6 Rules

- GraphQL per-field failures never fail the request. `GraphQlExecutorService` wraps each data-loader batch in `Effect.catchAll`, turning a source failure into one `GraphQLError` per key with `extensions: { code, source, retriable }` where `code` is the tag (`GraphQlPiiAccessDenied`, `GraphQlExternalContextMissing`, the vendor resolver tag, or `GraphQlFieldError` for untagged causes) and `source` is `graph` / `dynamodb` / the vendor source; the field resolves to `null` and the entry lands in the top-level `errors[]` of a 200 response. Only `GraphQlRequestError`, `GraphQlComplexityError`, `GraphQlSchemaGenerationError`, and `GraphQlResolutionMapError` fail the whole request through `error()`. Complexity rejections also increment the complexity-rejection metric before the 400 is returned.
- Derived-key violations on GraphSON and graph-fact paths are an issue code, not a tag. `GraphSONSemanticValidationService` emits `code: "DerivedIndexServerManagedProperty"` inside `GraphSONPayloadValidationError` (400) for a vertex or edge property that the lexicon marks as index-managed; the CSV lexicon validator emits the same code inside `NeptuneCsvLexiconValidationError`. The tagged class `DerivedIndexServerManagedPropertyError` and its 400 case exist, but a whole-repo search finds no constructor call, so callers today only ever see the issue code. If a future non-GraphSON boundary raises the tag, keep the 400 mapping and add its surface to the table.
- `error()` is the only tag-to-status mapper. Routes may pre-process (sanitise, log) but never choose a status themselves; add a `case` in `responses.ts`, a matching `*Response` schema in `schemas/http.ts`, the route's union in `lambda/api/definitions.ts`, and a test in `test/http/responses.test.ts` in the same change.
- A tag without a `case` is a 500 with an empty body by design. Before adding a case, decide whether the caller can act on the tag; if not, leave it unmapped and rely on logs.

## 7 Verification

```bash
# Inventory: 90 declared tags, 40 handled cases, 50 unmapped (fallback 500)
grep -oE 'TaggedError<[A-Za-z0-9]+>' lambda/schemas/errors.ts | sed -E 's/TaggedError<(.*)>/\1/' | sort -u > /tmp/tags
grep -oE 'case "[A-Za-z0-9]+"' lambda/http/responses.ts | sed -E 's/case "(.*)"/\1/' | sort -u > /tmp/cases
wc -l /tmp/tags /tmp/cases; comm -23 /tmp/tags /tmp/cases      # unmapped tags
comm -13 /tmp/tags /tmp/cases                                    # must print nothing (case without a class)

# Envelope, status, sanitisation, per-route logging behaviour
npx vitest run test/http/responses.test.ts test/routes

# Sanitiser coverage on all three GraphSON routes
grep -n "sanitizeGraphsonError" lambda/routes/graphson.router.ts   # expect the definition plus 6 call sites

# Never-constructed route-facing tags (expect no hits outside errors.ts, responses.ts, http.ts, definitions.ts, router sanitiser, tests)
grep -rn --exclude-dir=node_modules -E "new (DerivedIndexServerManagedPropertyError|GraphSONValidationError|VertexNotFoundError)\(" lambda

# OpenAPI per-path statuses stay in step with the table
python3 -c "import json;d=json.load(open('docs/openapi.json'));[print(p,m.upper(),sorted(o['responses'])) for p,ops in d['paths'].items() for m,o in ops.items()]"
```

## 8 Source map

| Topic | Source (persist repo) |
| ----- | --------------------- |
| Envelope helpers and the tag switch | `lambda/http/responses.ts` |
| Envelope schemas per tag, issue structs | `lambda/schemas/http.ts`, `lambda/schemas/errors.ts`, `lambda/schemas/graphson/validate.ts` |
| Request-scoped log keys (`method`, `path`, `requestId`) | `lambda/http/request-context.ts`, `lambda/router.ts`, `lambda/handler.ts` |
| GraphSON sanitiser and warn/error split | `lambda/routes/graphson.router.ts` |
| Gremlin sync / explain route catch paths | `lambda/routes/gremlin.router.ts` |
| Async Gremlin route catch paths | `lambda/routes/gremlin-async.router.ts` |
| GraphQL whole-request mapping, 405, raw 200 body | `lambda/graphql/handler.ts` |
| GraphQL per-field error conversion | `lambda/services/GraphQlExecutorService.ts` (`toGraphQlError`, loader `catchAll`) |
| Lexicon load failure -> `SemanticLexiconLoadFailure` vs `orDie` | `lambda/services/GraphSONSemanticValidationService.ts`, `GraphSONBlobTransformService.ts`, `GraphSONPersistTransformService.ts` |
| `DerivedIndexServerManagedProperty` issue code | `lambda/services/GraphSONSemanticValidationService.ts`, `NeptuneCsvLexiconValidationService.ts` |
| EventBridge failure surfacing | `lambda/graph-fact-event/handler.ts`, `lambda/services/GraphFactEventService.ts` |
| Tag-as-`name` for non-HTTP surfaces | `lambda/utils/errors.ts` (`isTaggedError`, `toReadableError`) |
| Per-path response unions feeding OpenAPI | `lambda/api/definitions.ts`, `docs/openapi.json` |
| Tests | `test/http/responses.test.ts`, `test/routes/graphson.router.test.ts`, `test/routes/gremlin.router.test.ts`, `test/routes/gremlin-async.router.test.ts` |
