# GraphQL Read Surface

Persist exposes a read-only GraphQL API whose object types are generated from the canonical lexicon and whose leaf fields resolve from the Neptune graph or, when a Persist-owned resolution map says so, from an external source. This file documents the surface **as shipped in the code** (paths relative to the persist repo root). Section 11 records the intended ports-and-adapters design as a target and lists the gaps between it and the shipped code. Treat the code as authoritative over the PRD wherever they disagree.

## 1. Scope and non-goals

In scope:

- `POST /persist/graphql` and `GET /persist/graphql/schema`, served by the dedicated `PersistGraphQlHandler` Lambda (`lambda/graphql/handler.ts`).
- Schema generation (`lambda/services/GraphQlSchemaService.ts`), the resolution map (`lambda/schemas/graphql.ts`, `lambda/services/GraphQlResolutionMapService.ts`, `config/graphql-resolution-map.json`), the executor (`lambda/services/GraphQlExecutorService.ts`), query guards (`lambda/services/graphqlQueryGuards.ts`), the three source adapters, metrics, IAM, and configuration.

Non-goals:

- Mutations, subscriptions, caller-defined types or resolvers, per-request source selection. The generated schema has only a `Query` root and the executor rejects any non-`query` operation.
- Candidate lexicons. The schema is generated only from the canonical lexicon the `LexiconSchemaService` loads.
- The PII access policy decision itself. Read `graphql-pii-access-policy.md` for the policy document, matching rules, and denial semantics; this file only shows where the gate sits in the pipeline.
- The Gremlin reader client, retry classifier, and `GREMLIN_SYNC_EVALUATION_TIMEOUT_MS` semantics. Read `gremlin-sync-query.md` and `neptune-reader-topology.md`.

## 2. Routes and request/response contracts

Both routes are explicit HTTP API routes with the IAM authorizer, registered ahead of the `/persist/{proxy+}` catch-all and integrated with `PersistGraphQlHandler` (`lib/persist-stack.ts`, `httpApi.addRoutes` for `/persist/graphql` POST and `/persist/graphql/schema` GET). The handler is a separate `NodejsFunction` (Node 24, arm64, 1024 MB, 30 s timeout, private subnets, JSON logging, three-month log retention).

Handler dispatch (`lambda/graphql/handler.ts`):

1. `GET` with `rawPath` ending in `/persist/graphql/schema` → `GraphQlExecutorService.getSchema()` → `200` JSON.
2. Any other non-`POST` → `405 { ok: false, error: { type: "MethodNotAllowed", message: "Method Not Allowed" } }`.
3. `POST` → parse the body (base64-aware `JSON.parse`; an empty body becomes `{}`) → `GraphQlExecutorService.executeQuery({ payload, requestId, principalArn })`.
4. `principalArn` is read from `requestContext.authorizer.iam.userArn`, then `userId`, then the literal `"unknown"`.
5. A failed effect goes through `error()` from `lambda/http/responses.ts` (the shared envelope); a thrown exception (for example malformed JSON) is logged as `Unhandled GraphQL handler failure` and answered with `500 InternalServerError`.

`POST /persist/graphql` request schema (`GraphQlQueryRequest`):

| Field           | Type                        | Rule                      |
| --------------- | --------------------------- | ------------------------- |
| `query`         | `string`                    | 1 to 100,000 characters   |
| `variables`     | `Record<string, unknown>`   | optional                  |
| `operationName` | `string`                    | optional                  |

Transport-level rejections (envelope `{ ok: false, error: { type, message, ... } }`):

| Status | `type`                          | When                                                                                                                                 |
| ------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 400    | `GraphQlRequestError`           | Request schema decode failure, document parse failure, non-`query` operation, undefined or cyclic fragment during guard analysis, Yoga transport failure |
| 400    | `GraphQlComplexityError`        | Depth or complexity over limit; carries `limit` and `actual`                                                                         |
| 500    | `GraphQlSchemaGenerationError`  | `buildActiveGraphQlSchema` threw                                                                                                     |
| 500    | `GraphQlResolutionMapError`     | Map fetch, decode, or validation failed; carries `issues: string[]`                                                                  |

Any executed document returns `200` with the standard GraphQL body plus executor-added extensions:

```json
{
  "data": { "...": "..." },
  "errors": [ { "message": "...", "path": ["..."], "extensions": { "code": "InterproseResolverError", "source": "interprose", "retriable": true } } ],
  "extensions": {
    "sources": { "graph": { "used": true, "durationMs": 12 }, "interprose": { "used": true, "durationMs": 340 } },
    "sdlHash": "<sha256 hex>",
    "resolutionMapHash": "<sha256 hex>"
  }
}
```

`GET /persist/graphql/schema` returns `GraphQlSchemaResponse` exactly:

```json
{ "sdl": "scalar PersistInt64\n...", "sdlHash": "<sha256 hex of sdl>", "lexiconUri": "<LEXICON_DATA_URI>", "resolutionMapHash": "<sha256 hex of the raw map text>", "generatedAt": "<ISO-8601>" }
```

`generatedAt` is the time the cached schema was built, not the request time (see section 3). Both routes are also described in `lambda/api/definitions.ts`, so `docs/openapi.json` carries them.

## 3. Schema generation rules

`GraphQlSchemaService` loads the lexicon and the resolution map, then calls the pure builder:

```ts
buildActiveGraphQlSchema({ lexicon, lexiconUri, resolutionMapHash, resolutionFields, generatedAt? }): ActiveGraphQlSchema
// returns { sdl, sdlHash, lexiconUri, resolutionMapHash, generatedAt, lexicon, fields, fieldsByType, relationshipsByType }
```

- `generatedAt` defaults to `new Date().toISOString()` inside the builder when the caller omits it; the service omits it, so the value is the cache-fill time. Tests inject it for determinism.
- The result is cached with `Effect.cachedWithTTL(300 s)`; the resolution map has its own 300 s cache; the lexicon loader has its own. A lexicon or map refresh regenerates the schema on the next cache miss.
- `lexiconUri` echoes `LEXICON_DATA_URI` (default string `"configured"` when unset).
- `sdlHash = sha256(sdl)`. Generation is deterministic for the same lexicon and map: every collection is sorted and de-duplicated before emission, so two builds yield byte-identical SDL.
- `fields` is the `debt` type's field list (kept for older callers); use `fieldsByType` and `relationshipsByType`.

Rules, in the order the builder applies them:

1. **Vertex types.** De-duplicate `lexicon.vertices` by `type` (first occurrence wins), sort by `type`. Each becomes `type <PascalCase(type)>` (split on `_`, capitalize each part: `social_security_number` → `SocialSecurityNumber`). Field names keep the lexicon's snake_case verbatim.
2. **`id`.** Skip any property or index named `id`; every type starts with `id: ID!`.
3. **Scalar mapping** (`graphQlScalar`): `format` `date`, `date-time`, or `time` → `PersistDateTime`; else by `type`: `integer` → `PersistInt64`, `number` → `Float`, `boolean` → `Boolean`, anything else (`string`, `blob`, unknown) → `String`. `array` recurses on `items.type` only, so an item `format` is ignored (an array of `date-time` strings emits `[String]`). Arrays emit `[Scalar]` (nullable list of nullable items).
4. **Enums.** A property or index rule with `enum` becomes `enum <PascalOwner><PascalField>Enum` **only when every value is a string that matches `/^[_A-Za-z][_0-9A-Za-z]*$/`**. Values are emitted sorted; there are no descriptions anywhere in the SDL. Otherwise the field falls back to the mapped scalar (not necessarily `String`). The enum check runs before the array wrapping, so an `array` rule whose `enum` values are all valid names emits the bare enum type in the SDL rather than a list; the executable runtime schema (`graphQlTypeForField` in the executor) still wraps it in `GraphQLList` because `list` is `rule.type === "array"`, so served SDL and executed type disagree for that case.
5. **Nullability.** A vertex property is non-null (`!`) only when it is listed in `vertex.required` **and** its resolution entry is absent or `source: graph`. Externally resolved fields are always nullable so a failed or denied source degrades to `null` plus an `errors[]` entry. Index-derived fields are always nullable and never lists. Edge properties are non-null when listed in `edge.required`.
6. **Index fields.** Every key in `vertex.indexes` (except `id`) appears as an ordinary read field on the owner type using the same scalar and enum rules.
7. **Field order.** Property and index fields are merged and sorted by name.
8. **Relationships.** For each edge whose `from` and `to` are both known vertex types: the `from` type gets `<edge.type>(first: PersistInt64, after: String): [<Target>]`; the `to` type gets `rev_<edge.type>(first: PersistInt64, after: String): [<Source>]`. Edges with an unknown endpoint type are skipped silently. When the edge declares properties, the list element is a wrapper `type <PascalOwner><PascalFieldName>Connection { node: <Target>, <edge fields...> }` (for example `PersonPersonOwesDebtConnection` and `DebtRevPersonOwesDebtConnection`); otherwise the field returns the target type directly. Relationship lines are sorted after the scalar fields.
9. **Query root.** For every vertex: `<type>(id: ID!): <Type>`. Additionally `<type>_by(<index>: <Scalar>, ...): <Type>` **only when the vertex declares `indexes`** with at least one non-`id` key; the arguments are the derived-index keys mapped through `graphQlScalar` (never enums), all optional, sorted by name. Query fields are de-duplicated and sorted.
10. **SDL layout.** `scalar PersistInt64`, `scalar PersistDateTime`, enums (sorted), object types (sorted), wrapper types (sorted), `type Query { ... }`.

Runtime scalars (`GraphQlExecutorService`): `PersistInt64` serializes `bigint` as a string and accepts `Int` or `String` literals; `PersistDateTime` passes values through and accepts `String` literals only.

## 4. Resolution map

### 4.1 Shape (`lambda/schemas/graphql.ts`)

```json
{
  "schema_version": "1.0",
  "defaults": { "source": "graph" },
  "types": {
    "<vertex type>": {
      "fields": {
        "<field>": { "source": "graph", "pii_access": "none" },
        "<field>": { "source": "dynamodb", "table_env": "GRAPHQL_DDB_TABLE_X", "key": { "pk": "debt#${id}", "sk": "notes" }, "attribute": "notes", "pii_access": "none" },
        "<field>": { "source": "interprose", "operation": "getDebt", "key_field": "debt.debt_identifier", "response_path": "primaryDemographic.nationalIDLastFour", "pii_access": "ssn_last_four" }
      }
    }
  }
}
```

- `schema_version` is the literal `"1.0"`.
- `source` is `graph | dynamodb | interprose`. `pii_access` is `none | ssn_last_four | full_ssn`; optional on `graph` and `dynamodb` entries, **required** on `interprose` entries.
- `defaults.source` is decoded but never read by any service. Unmapped fields always resolve from the graph. Keep it at `"graph"`; changing it has no effect.
- The shipped `config/graphql-resolution-map.json` maps exactly two fields, both on `social_security_number`: `social_security_number_last_four` (`response_path: primaryDemographic.nationalIDLastFour`, `pii_access: ssn_last_four`) and `social_security_number_full` (`response_path: primaryDemographic.nationalID`, `pii_access: full_ssn`), both `operation: getDebt`, `key_field: debt.debt_identifier`.

### 4.2 Storage and loading

- `lib/persist-stack.ts` creates `GraphQlResolutionMapBucket` (versioned, public access blocked, SSL enforced, S3-managed encryption, bucket-owner-enforced ownership, no lifecycle rule) and a `BucketDeployment` that copies only `config/graphql-resolution-map.json` from the `config` asset to key `graphql-resolution-map/graphql-resolution-map.json`. `GRAPHQL_RESOLUTION_MAP_URI` is set to that object's `s3://` URI. Promote map changes through this deployment, not by editing the object by hand.
- `GraphQlResolutionMapService` parses the URI (must be `s3://…`, else `GraphQlResolutionMapError`), fetches the object with a `GRAPHQL_RESOLUTION_MAP_TIMEOUT_MS` timeout (default 10,000 ms), `JSON.parse`s it, decodes it with `errors: "all"`, validates it against the current lexicon and the resolver registry, and caches `{ map, hash: sha256(rawText), fields }` for 300 s. Every failure is `GraphQlResolutionMapError` and surfaces as HTTP 500 on both routes.

### 4.3 Load-time validation

For every `types.<owner>.fields.<field>` entry, in order:

1. `owner` must be a vertex type in the lexicon.
2. `field` must be a property **or** an index key of that vertex.
3. If `source !== "graph"`, the lexicon property must declare `persistence: "external"`; otherwise the issue `... uses <source> but is not marked persistence: external in Lexicon` is raised. (Index keys have no `persistence`, so an index key cannot be routed externally.)
4. A resolver must be registered for `source`.
5. The resolver's `validateEntry(entry, ownerVertexRule, lexicon)` returns `ReadonlyArray<string>`; every string is an issue.

Adapter rules:

- `graph`: no extra checks.
- `dynamodb`: `table_env` must match `^[A-Z0-9_]+$` (an environment-variable name); `attribute` must be non-empty; every `${var}` in a `key` template must be `id` or match `[a-zA-Z0-9_.-]+`. There is **no** check that a template variable is a lexicon property; an unresolved variable renders as an empty string at runtime.
- `interprose`: `operation` is schema-constrained to `getDebt`; the owner type must be `social_security_number`; `key_field` must be `debt.id`, `debt.debt_identifier`, or a property of the owner; `response_path` must be one of `ssn`, `ssnLastFour`, `nationalID`, `nationalIDLastFour`, `primaryDemographic.nationalID`, `primaryDemographic.nationalIDLastFour`; full-value paths require `pii_access: full_ssn`; last-four paths require `pii_access: ssn_last_four`.

Any issue fails the load closed; the response lists all issues.

## 5. Executor and resolvers as shipped

### 5.1 Components

```
handler.ts ──► GraphQlExecutorService ──► GraphQlSchemaService ──► LexiconSchemaService
                    │                          └──────────────► GraphQlResolutionMapService ──► registry (validateEntry)
                    ├──► GraphQlGraphResolverService (direct dependency: vertex lookups, relationship batches)
                    └──► GraphQlSourceResolverRegistryService ──► graph | dynamodb | interprose adapters
                                                                        └── interprose ──► InterproseClientService + GraphQlPiiAccessPolicyService
```

Layer wiring lives in `lambda/services/index.ts` (`GraphQlHandlerLayer`, built from `GraphQlExecutorLayer`); the executor's `dependencies` list names `GraphQlGraphResolverService.Default` directly. The runtime is GraphQL Yoga (`createYoga`) over `graphql-js` inside the Lambda, with `maskedErrors: false`, `logging: false`, and `graphqlEndpoint: "/persist/graphql"`. `graphql`, `graphql-yoga`, and `dataloader` are runtime dependencies.

### 5.2 Per-request flow (`executeQuery`)

1. Decode the payload (`GraphQlQueryRequest`) → `GraphQlRequestError` on failure.
2. `parse(query)` → `GraphQlRequestError`.
3. Reject any operation definition whose `operation !== "query"`.
4. Load the active schema (cached). Collect the relationship field names (`relationshipsByType`) as the guard's `listFieldNames`.
5. `analyzeGraphQlDocument` → depth and complexity (section 7); throw `GraphQlComplexityError` on either limit.
6. Fetch or build the executable runtime from an in-memory cache keyed `sdlHash:resolutionMapHash:maxListPageSize`. The cache holds one entry; a key change clears it and rebuilds the `GraphQLSchema` and Yoga instance.
7. Create the execution context: `{ requestId, principalArn, sdlHash, resolutionMapHash, loaders: new Map(), sourceUsage: new Map(), noteSourceUsage }`.
8. Build a synthetic `Request` to `/persist/graphql`, register the context in a `WeakMap<Request, context>` that Yoga's `context` factory reads, call `yoga.fetch`, and parse the JSON body.
9. Emit `graphql_field_resolutions` once per source key in `sourceUsage` and `graphql_field_failures` once per error whose `extensions.source` is a known source.
10. Return `{ ...result, extensions: { ...result.extensions, sources, sdlHash, resolutionMapHash } }`.

### 5.3 Field resolvers

`createGenericTypes` builds every `GraphQLObjectType` and attaches resolvers by category:

- `id` → `parent.id`.
- Graph scalar field (no entry or `source: graph`) → `context.noteSourceUsage("graph")` then `parent.properties[fieldName]`. No extra traversal: the parent record already carries all properties from `elementMap()`.
- Externally resolved field → `createExternalResolver`: look up `registry.get(entry.source)`, get or lazily create a `DataLoader` in `context.loaders` under key `<ownerType>.<fieldName>`, and `load({ parentId: parent.id, properties: { ...parent.properties, ...parent.context } })`. The loader's batch function calls `sourceResolver.batchLoad({ ownerType, fieldName, entry, keys, ctx })`; a batch-level failure is mapped to `{ ok: false, error }` for every key; `noteSourceUsage(source, { durationMs })` is called once per batch; per-key errors become `GraphQLError`s which the field resolver throws, so the field nulls and the error lands in `errors[]`.
- Relationship field → a lazily created `DataLoader` keyed by `relationship:<connection|node>:<owner>:<field>:<edge>:<direction>:<target>:<first>:<afterOffset>`, batching all parents that request the same relationship with the same page into one `getRelatedConnectionsBatch` or `getRelatedVerticesBatch` call. Wrapper fields resolve `node` and `edgeProperties[fieldName]`.
- `Query.<type>(id)` → `graphResolver.getVertexById(type, id)`; `Query.<type>_by(...)` → the first argument with a non-null value drives `graphResolver.getVertexByProperty(type, fieldName, value)`; no argument → `undefined`.

Pagination: `first` is coerced to a number, defaults to `GRAPHQL_MAX_LIST_PAGE_SIZE` when absent, non-finite, or ≤ 0, and is clamped to that maximum. `after` is parsed as an integer offset (`parseInt`), not an opaque cursor; non-positive or invalid → 0. The batch traversal applies `range(afterOffset, afterOffset + first)`.

Context propagation: `graphQlContextForRecord(record, parentContext)` merges the parent's context, `<label>.id`, `<label>.<property>` for every property, and the plain properties. It is attached to root lookups and to every related node, so a `social_security_number` node three hops below a `debt` still carries `debt.debt_identifier` in its `context`, which is how the vendor adapter's `key_field` resolves.

### 5.4 Batching, timeouts, and errors

- DataLoaders are created lazily inside resolvers and stored in the context-owned map; the batching and memoization scope is one request. There is no cross-request cache except the vendor client's in-process TTL cache and secret cache.
- Graph batch traversals send every parent id in one `g.V(id1, id2, ...)` script; there is no chunking.
- `GRAPHQL_FIELD_TIMEOUT_MS` (default 5,000 ms) bounds only the DynamoDB adapter's calls (`Effect.timeoutFail`) and the vendor HTTP client (`AbortSignal.timeout`). Graph reads go through `GremlinService.query` and are bounded by Neptune's server-side `GREMLIN_SYNC_EVALUATION_TIMEOUT_MS` (30,000 ms for this handler) plus the Gremlin retry budget (`NEPTUNE_RETRY_MAX_ATTEMPTS=3`, `NEPTUNE_RETRY_BASE_DELAY_MS=1000`). The Lambda's 30 s timeout and the HTTP API's integration ceiling are the outer bound.
- `toGraphQlError(error, source)` maps any failure to `GraphQLError(message, { extensions: { code: <_tag or "GraphQlFieldError">, source, retriable } })`. `retriable` is taken from `InterproseResolverError.retriable` or any error exposing a boolean `retriable`, else `false`. Graph failures use `source: "graph"`; a failing non-null graph field propagates `null` upward per GraphQL rules.
- Field failures never fail the HTTP request; only the transport-level errors in section 2 do.

## 6. Source adapters

All adapters implement `SourceResolver<TEntry>` (`lambda/services/GraphQlSourceResolver.ts`): `{ source, validateEntry(entry, ownerVertexRule, lexicon): ReadonlyArray<string>, batchLoad({ ownerType, fieldName, entry, keys, ctx }): Effect<ReadonlyArray<{ ok: true, value } | { ok: false, error }>, unknown> }`. Keys are `{ parentId, properties }`. The registry (`GraphQlSourceResolverRegistryService`) is a `Map` of the three adapters with `get(source)` and `all()`.

### 6.1 Graph (`GraphQlGraphResolverService`)

- Depends on `GremlinService`; every read uses `gremlin.query({ gremlin, readerTarget: "default" })`, so the read-only policy assertion, FTS policy, retry classification, and evaluation timeout are shared with `POST /persist/gremlin`. The handler sets `NEPTUNE_WRITER_HOST` to the reader endpoint as well, so no connection from this Lambda can reach the writer.
- Traversals: `getVertexById` → `g.V(<id>).hasLabel(<label>).elementMap().limit(1)`; `getVertexByProperty` → `g.V().hasLabel(<label>).has(<prop>, <value>).elementMap().limit(1)`; `getRelatedVerticesBatch` → `g.V(<ids>).hasLabel(<parent>).project('parentId','nodes').by(id()).by(__.out|in(<edge>).hasLabel(<target>).range(s, e).elementMap().fold())`; `getRelatedConnectionsBatch` → the same with `outE|inE(...).as('edge').inV|outV()` and `project('node','edge')`. Results are re-ordered to match the input parents; single-element `elementMap` arrays are unwrapped.
- The port `batchLoad` is a pass-through stub (`key.properties["graph"] ?? key.properties[parentId]`). The executor never routes graph fields through the port; it calls the traversal methods above directly.

### 6.2 DynamoDB (`GraphQlDynamoDbResolverService`) — code-supported, not wired

- Reads the table name from `process.env[entry.table_env]`; when unset the whole batch fails with `DynamoDB table env <name> is not configured` (tagged `InterproseResolverError` with `operation: "dynamodb"`; the tag name is a misnomer inherited from the first adapter).
- Single-attribute key → one `Query` per key (`KeyConditionExpression: #pk = :pk`, `Limit: 1`, `ProjectionExpression` on `attribute`), concurrency 100, per-call timeout, per-key error isolation. Composite key → `BatchGetItem` in 100-key chunks, sequential, per-chunk timeout; a chunk failure fails the batch. All rendered key values are string attributes (`S`). Values are unmarshalled for `S`, `N` (as string), `BOOL`, `SS`, `NS`, `L`, `M`.
- Calls `ctx.noteSourceUsage("dynamodb", { durationMs })` itself; the executor's loader adds its own measurement, so `sources.dynamodb.durationMs` double-counts for this source.
- **Deployment status:** `lib/persist-stack.ts` sets no `GRAPHQL_DDB_*` (or any `table_env`) variable and grants no `dynamodb:*` action to the GraphQL role. A `dynamodb` entry passes map validation but every resolution fails at runtime. Adding a table requires the env var, an IAM statement on that table, and a test; see section 11.

### 6.3 Interprose (`GraphQlInterproseResolverService` + `InterproseClientService`)

- `batchLoad` first asks `GraphQlPiiAccessPolicyService.allows(ctx.principalArn, entry.pii_access)`; on denial every key returns `GraphQlPiiAccessDenied` and no vendor call is made (details in `graphql-pii-access-policy.md`).
- Keys are split into chunks of `INTERPROSE_MAX_BATCH_SIZE` (default 25). Chunks run sequentially; within a chunk each key is resolved with `Effect.forEach` concurrency `INTERPROSE_MAX_CONCURRENT_REQUESTS` (default 4). **There is one vendor HTTP call per key**; the batch size only bounds the chunk loop. A key whose `key_field` value is missing or empty returns `GraphQlExternalContextMissing`; vendor failures are caught per key as `InterproseResolverError`.
- Metrics from the adapter: `interprose_resolver_calls` += number of keys in the batch (before the cache is consulted, so it counts requested keys, not HTTP calls); `interprose_resolver_throttles` += `chunks - 1` when a batch spans more than one chunk. Throttles therefore mean chunk overflow, not vendor `429`s.
- Client: `resolveDebtField(debtId, responsePath)` → `getDebt(debtId)` → `GET <INTERPROSE_BASE_URL>/api/account/<debtId>` with `Authorization: Bearer <api_key>`, `X-CustomerID: <INTERPROSE_CUSTOMER_ID>`, `Accept: application/json`, and `AbortSignal.timeout(GRAPHQL_FIELD_TIMEOUT_MS)`. The API key is the `api_key` field of the Secrets Manager secret at `INTERPROSE_CREDENTIALS_SECRET_ARN`, cached in a module-level map for the container lifetime. Debts are cached in a module-level map keyed `<customerId>:<debtId>` for `INTERPROSE_CACHE_TTL_SECONDS` (default 60). Non-2xx → `InterproseResolverError` with `retriable = status >= 500 || status === 429`; credential read failures are retriable, decode failures are not. `primaryDemographic.*` paths read the `demographics[]` entry whose `demographicType` is `PRIMARY`. Values are returned only when they are non-empty strings.
- The adapter does not call `noteSourceUsage`; the executor's loader records `sources.interprose.durationMs` per batch. Cache hits are invisible: nothing sets `cacheHit` and `recordInterproseResolverCacheHit` has no caller.

## 7. Guards and limits

`analyzeGraphQlDocument(document, maxListPageSize, { listFieldNames })` in `graphqlQueryGuards.ts` is pure and runs before any data-source call.

- **Depth.** Each root selection starts at 1; every nested selection set adds 1. Inline fragments and fragment spreads do not add depth. Undefined fragments and fragment cycles throw (surfaced as `GraphQlRequestError`).
- **Complexity.** `field = 1 + multiplier × Σ children`; fragments contribute their children's sum. `multiplier = clamp(first, 1, GRAPHQL_MAX_LIST_PAGE_SIZE)` when the field has a `first` argument **or** its name is a relationship field name; when such a field has no integer-literal `first` (absent, or passed as a variable) the multiplier is `GRAPHQL_MAX_LIST_PAGE_SIZE`. All other fields have multiplier 1. Example with the default 100: `debt { rev_person_owes_debt { node { id } } }` costs `1 + (1 + 100 × (1 + 1)) = 202`.
- Limits: `GRAPHQL_MAX_QUERY_DEPTH` (default 8), `GRAPHQL_MAX_QUERY_COMPLEXITY` (default 1000), `GRAPHQL_MAX_LIST_PAGE_SIZE` (default 100; also the runtime clamp on `first`). Depth is checked first.
- Non-`query` operations are rejected before the guards run. Introspection is allowed and is charged like any other selection.

## 8. Observability

Metrics (`GraphQlMetricsService`, Powertools, namespace `POWERTOOLS_METRICS_NAMESPACE` default `persist`, service `POWERTOOLS_SERVICE_NAME` default `persist-graphql`; all `Count` unless noted):

| Metric                          | Emitted when                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| `graphql_requests`              | Once per successfully executed `POST` (HTTP 200); rejected requests are not counted            |
| `graphql_request_duration_ms`   | With `graphql_requests` (`Milliseconds`)                                                       |
| `graphql_complexity_rejections` | Once per `GraphQlComplexityError`                                                              |
| `graphql_field_resolutions`     | Value 1 per **source used per request**, dimension `source`; not a per-field count             |
| `graphql_field_failures`        | 1 per `errors[]` entry whose `extensions.source` is `graph`, `dynamodb`, or `interprose`; dimension `source` |
| `interprose_resolver_calls`     | Number of keys per vendor batch                                                                |
| `interprose_resolver_throttles` | Extra chunks beyond the first per vendor batch                                                 |
| `interprose_resolver_cache_hits`| Defined but never emitted                                                                      |

Metrics are reset at the start of each invocation and flushed in `finally`.

Logs (Powertools JSON): `GraphQL request completed` with `requestId`, `operationName`, `sdlHash`, `resolutionMapHash`, `sources` (source names only), `errorCount`, `durationMs`; `Unhandled GraphQL handler failure` with `requestId` and the cause message. No resolved values, vendor URLs, or Gremlin text are logged by the handler. Per-source batch counts are not logged.

## 9. IAM and configuration

Role of `PersistGraphQlHandler` (`lib/persist-stack.ts`, asserted by `test/cdk/persist-stack.test.ts`):

- Managed policy `service-role/AWSLambdaVPCAccessExecutionRole`.
- `neptune-db:connect`, `neptune-db:ReadDataViaQuery` on the cluster resource. No `WriteDataViaQuery` or `DeleteDataViaQuery`.
- `s3:GetObject` on the lexicon bucket (bucket name parsed from `LEXICON_DATA_URI`, all keys) and on `graphql-resolution-map/*` in the map bucket, plus `grantRead` on that prefix. This is the only handler whose lexicon read is bucket-scoped rather than `*/*`.
- `secretsmanager:GetSecretValue` on the vendor credentials secret.
- Nothing else: no DynamoDB, no SQS, no Step Functions, no S3 writes, no OpenSearch writes.

Environment (full table in `stacks-configuration-and-iam.md`; values below are what the stack pins):

| Variable                             | Value / default            | Consumer and note                                                                 |
| ------------------------------------ | -------------------------- | --------------------------------------------------------------------------------- |
| `NEPTUNE_READER_HOST`, `NEPTUNE_WRITER_HOST` | reader endpoint     | Both point at the reader; `NEPTUNE_PORT` alongside                                |
| `NEPTUNE_RETRY_MAX_ATTEMPTS` / `_BASE_DELAY_MS` | `3` / `1000`     | Retry budget sized to the 30 s function timeout                                   |
| `GREMLIN_SYNC_EVALUATION_TIMEOUT_MS` | `30000`                    | Server-side ceiling for every graph read                                          |
| `LEXICON_DATA_URI`                   | from SSM at deploy         | Lexicon loader; echoed as `lexiconUri`                                            |
| `GRAPHQL_RESOLUTION_MAP_URI`         | derived from the map bucket| Required; must be `s3://…`                                                        |
| `GRAPHQL_RESOLUTION_MAP_TIMEOUT_MS`  | `10000`                    | Map fetch timeout                                                                 |
| `GRAPHQL_MAX_QUERY_DEPTH`            | `8`                        | Guard                                                                             |
| `GRAPHQL_MAX_QUERY_COMPLEXITY`       | `1000`                     | Guard                                                                             |
| `GRAPHQL_MAX_LIST_PAGE_SIZE`         | `100`                      | Guard multiplier and runtime clamp on `first`                                     |
| `GRAPHQL_FIELD_TIMEOUT_MS`           | `5000`                     | DynamoDB calls and vendor HTTP calls only                                         |
| `GRAPHQL_PII_ACCESS_POLICY_JSON`     | stack-defined policy       | See `graphql-pii-access-policy.md`                                                |
| `INTERPROSE_BASE_URL`                | per environment            | **Required at startup** regardless of map contents                                |
| `INTERPROSE_CREDENTIALS_SECRET_ARN`  | per environment            | **Required at startup**; secret JSON must carry `api_key`                         |
| `INTERPROSE_CUSTOMER_ID`             | per environment            | **Required at startup**; sent as `X-CustomerID`                                   |
| `INTERPROSE_MAX_CONCURRENT_REQUESTS` | `4`                        | Per-chunk concurrency                                                             |
| `INTERPROSE_MAX_BATCH_SIZE`          | `25`                       | Chunk size                                                                        |
| `INTERPROSE_CACHE_TTL_SECONDS`       | `60`                       | Vendor response cache                                                             |
| `AWS_REGION`                         | Lambda-provided            | S3, Secrets Manager, DynamoDB clients; a hard-coded default constant applies when unset |

The three `INTERPROSE_*` credentials variables use `Config.string` without defaults, so the service layer fails to construct when any is missing, even for a map that declares no `interprose` source. Do not hardcode developer-specific AWS profiles in examples; use `AWS_PROFILE=<selected-profile>`.

## 10. Verification and acceptance

Unit tests that exist (`pnpm test`, which excludes `test/e2e/**`):

- `test/services/GraphQlSchemaService.test.ts`: one test building the schema twice from a fixture lexicon (scalar, `date-time`, array, enum, `blob`, index, edge with properties) and asserting identical SDL and hash plus the expected fragments (`enum DebtStatusEnum`, `opened_at: PersistDateTime!`, `tags: [String]`, `rendered_artifact_uri: String`, `type PersonPersonOwesDebtConnection`, `debt_by(current_balance_bucket: String): Debt`). No snapshot file.
- `test/services/graphqlQueryGuards.test.ts`: depth through named and inline fragments, omitted `first` charged at the maximum page size (202), cyclic fragments fail closed.
- `test/services/GraphQlGraphResolverService.test.ts`: `graphQlContextForRecord` namespacing across hops; batched relationship and connection results stay ordered by input parent.
- `test/services/GraphQlInterproseResolverService.test.ts`: full-SSN denied before any vendor call; full SSN resolved with debt context when allowed; last-four allowed by default; fail-closed on missing debt context. Uses in-memory client and policy layers.
- `test/services/GraphQlPiiAccessPolicyService.test.ts`: policy matching (see the PII file).
- `test/cdk/persist-stack.test.ts` ("provisions a read-only GraphQL handler…"): environment values, the `/persist/graphql` path present in the rendered template (the schema route is not asserted separately), role actions include Neptune read, `s3:GetObject`, `secretsmanager:GetSecretValue` and exclude write actions; statements scope to `graphql-resolution-map/*` and the lexicon bucket, never an all-buckets S3 wildcard resource.

E2E (`pnpm run e2e:persist-graphql`, `test/e2e/persist-graphql.e2e.test.ts`, SigV4-signed, API URL from the `persist-api-url` SSM parameter, part of the `pnpm run e2e` aggregate): schema metadata stable across two calls and containing the SSN field names; graph-only query reports `sources.graph.used` and no `interprose`/`dynamodb` key; mixed query resolves last-four and enforces full-SSN authorization without logging values; over-depth query returns 400 `GraphQlComplexityError`.

Acceptance for this surface (what the code and tests actually establish):

- Two builds from the same lexicon and map produce byte-identical SDL and the same `sdlHash`; `GET /persist/graphql/schema` reports it with `resolutionMapHash`.
- Routing comes only from the validated map; unknown types or fields, non-external lexicon properties, bad `table_env` or key templates, and non-whitelisted vendor paths fail the load closed with `GraphQlResolutionMapError`.
- Graph-only selections never touch the vendor client; mixed selections batch external keys per `(ownerType, fieldName)` DataLoader and graph relationships per `(relationship, page)` loader.
- A vendor failure or PII denial nulls only the affected fields and appends `errors[].extensions.source = "interprose"` with HTTP 200.
- Mutations, subscriptions, and depth or complexity violations are rejected before any data-source call.
- The role has no write action of any kind.

Target-state tests that do **not** exist: SDL snapshot test; mutation/subscription rejection test; `extensions.source` partial-failure test; one-batched-call-per-source assertion with resolver spies; vendor cache and throttle tests; resolution-map validation-failure tests; DynamoDB adapter tests; a shared `SourceResolver` contract suite.

## 11. Target-state architecture and gap list

The intended design is ports-and-adapters: every data source is a `SourceResolver` adapter behind a registry; the schema generator is a pure `(lexicon, resolutionMap)` function; the executor and generator depend only on the registry interface; field behaviour is driven entirely by the resolution map through one generic resolver factory; adding a source is implement-port, register, extend-schema-enum with no executor change; every adapter passes a shared contract suite (batch-call count, per-key isolation, batch-level failure, timeout mapping, `validateEntry` rejection). Keep this as the goal for new work and reviews.

Gaps between that goal and the shipped code:

1. The executor imports `GraphQlGraphResolverService` directly, lists it as a dependency, and calls its traversal methods; graph fields never go through the port, whose `batchLoad` is a stub. Target: move root lookups and relationship batching behind the graph adapter's port or a dedicated traversal port.
2. The executor branches on `entry.source !== "graph"` to choose between property read and external loader. Target: a single generic resolver keyed by entry.
3. Adding a source touches five places: `GraphQlSource`/`GraphQlFieldErrorSource` unions in `lambda/schemas/graphql.ts`, the registry's `dependencies` and `Map`, `toGraphQlError`/`runResolverEffect` source unions in the executor, `SourceName` in the metrics service, and the layer wiring in `lambda/services/index.ts`. Target: one enum and one registration.
4. `defaults.source` is unused. Target: either honour it or drop it from the schema.
5. No `table_env` variable and no DynamoDB IAM grant exist; the DynamoDB adapter has no tests. Target: wire and grant per table when a `dynamodb` entry is introduced, and add adapter tests.
6. `cacheHit` and `interprose_resolver_cache_hits` are never populated. Target: have the client report cache hits through `noteSourceUsage` and the metric.
7. `interprose_resolver_calls` counts keys, not HTTP calls, and `interprose_resolver_throttles` counts chunk overflow, not vendor `429`s. Target: rename or re-define so dashboards read correctly.
8. Vendor resolution is one HTTP call per key. Target: a batched vendor operation if the vendor offers one.
9. `GRAPHQL_FIELD_TIMEOUT_MS` does not bound graph reads; graph batches are unchunked. Target: decide whether a client-side timeout and chunking are needed for large parent sets.
10. `durationMs` for `dynamodb` is double-counted (adapter plus loader). Target: record in one place only.
11. `generatedAt` is a clock read inside the builder. Target: inject it from the service so the builder is clock-free.
12. `after` is an integer offset, not an opaque cursor. Target: keep or document deliberately.
13. Missing tests listed at the end of section 10, including the shared contract suite.

## 12. Source map

| Concern                                   | File                                                        |
| ----------------------------------------- | ----------------------------------------------------------- |
| Handler, dispatch, logging, metric flush  | `lambda/graphql/handler.ts`                                 |
| Request, schema-response, map schemas     | `lambda/schemas/graphql.ts`                                 |
| Error tags                                | `lambda/schemas/errors.ts`; status mapping in `lambda/http/responses.ts` |
| Schema generation                         | `lambda/services/GraphQlSchemaService.ts`                   |
| Resolution map load and validation        | `lambda/services/GraphQlResolutionMapService.ts`            |
| Shipped map                               | `config/graphql-resolution-map.json`                        |
| Executor, Yoga, DataLoaders, scalars      | `lambda/services/GraphQlExecutorService.ts`                 |
| Guards                                    | `lambda/services/graphqlQueryGuards.ts`                     |
| Port and registry                         | `lambda/services/GraphQlSourceResolver.ts`, `GraphQlSourceResolverRegistryService.ts` |
| Graph adapter                             | `lambda/services/GraphQlGraphResolverService.ts`            |
| DynamoDB adapter                          | `lambda/services/GraphQlDynamoDbResolverService.ts`         |
| Vendor adapter and client                 | `lambda/services/GraphQlInterproseResolverService.ts`, `InterproseClientService.ts` |
| PII policy                                | `lambda/services/GraphQlPiiAccessPolicyService.ts`          |
| Metrics                                   | `lambda/services/GraphQlMetricsService.ts`                  |
| Layer wiring                              | `lambda/services/index.ts` (`GraphQlHandlerLayer`)          |
| Stack: bucket, deployment, handler, IAM, routes | `lib/persist-stack.ts`                                |
| Tests                                     | `test/services/GraphQl*.test.ts`, `test/services/graphqlQueryGuards.test.ts`, `test/cdk/persist-stack.test.ts`, `test/e2e/persist-graphql.e2e.test.ts` |
| Operator notes                            | `README.md` ("Persist GraphQL E2E tests")                   |
