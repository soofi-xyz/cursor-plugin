# GraphSON v3 ingest contract

Persist accepts graph writes as GraphSON v3 typed JSON on three synchronous routes: `POST /persist/ingest` (validate, verify references, materialise blobs, hash, write in one transaction), `POST /persist/validate` (the same validation and reference verification with no side effects), and `POST /persist/ingest-async` (validate, then queue; covered in `async-graphson-ingest-and-graph-facts.md`). This file is the contract for what those routes accept, every validation stage and issue code, the vertex-reference mechanism, how the lexicon is consumed, and how the GraphSON router composes and sanitises its responses. Everything below is derived from the Persist code, not from the PRD.

## 1 Scope and non-goals

In scope:

- The GraphSON typed-value set and the `g:Vertex`, `g:VertexProperty`, `g:Edge`, `g:Property`, `g:VertexRef` shapes with their required fields.
- The `tinker:graph` request wrapper and the `graphson.{vertices,vertexRefs,edges}` event body that is re-wrapped into it.
- `persist:Blob` at the contract level (accepted forms, one-level lists, rejection codes).
- Vertex references end to end: schema, integrity, semantic, Neptune verification, async rejection, cross-authority hashing.
- Lexicon consumption (URI source, cache, failure surfacing, candidate lexicons) and the property-rule shape the GraphSON validator enforces.
- The full validation pipeline with every issue code and its HTTP outcome.
- `POST /persist/ingest` and `POST /persist/validate` pipelines, transaction semantics, responses.
- GraphSON router composition and error sanitisation.

Out of scope (see the named sibling file):

- Hash normalisation, blob URI derivation, S3 blob runtime, temporal canonicalisation: `identity-hashing-and-blobs.md`.
- `/ingest-async`, the queue worker and `GraphFactProduced` routing: `async-graphson-ingest-and-graph-facts.md`.
- The response envelope and the complete tag-to-status table: `error-catalogue-and-responses.md`.
- Lexicon `indexes` rules and derived-index writes: `derived-index-maintenance.md`.
- Environment variables and IAM: `stacks-configuration-and-iam.md`.

## 2 GraphSON typed values and graph shapes

### 2.1 Accepted property values

`GraphSONValue` (`lambda/schemas/graphson/types.ts`) is the exact union below. Anything else fails schema decode with a `Type` issue.

| Form | `@value` | Notes |
| --- | --- | --- |
| `g:Int32` | JSON number | Semantic type `integer` when integral, else `number`. |
| `g:Int64` | JSON number (or a runtime `bigint`) | The schema admits `bigint` for in-process callers; `JSON.parse` never produces one, so over HTTP `@value` must be a number. String-encoded int64 is not accepted. |
| `g:Float`, `g:Double` | JSON number | Semantic type `number`. |
| `g:UUID` | any JSON string | Not validated as a UUID; semantic type `string`. |
| `g:Date`, `g:Timestamp` | JSON number (epoch millis) | Semantic type `number`, except on `string` rules with `format: date` / `date-time` (section 4.3). |
| `persist:Blob` | JSON string | Raw text to be materialised (section 2.4). |
| `g:List`, `g:Set` | array of `GraphSONValue` | Recursive; semantic type `array`. |
| bare `string`, `boolean`, `null` | | Accepted without a wrapper. `null` never satisfies any lexicon type. |

Not accepted: `g:Map` (the `GMap` helper exists in `types.ts` but is not part of `GraphSONValue`), bare numbers, bare arrays, bare objects, and any other `@type`. The decode message for a bad value is: `GraphSON value must be either a typed object {"@type":...,"@value":...} (g:Int32|g:Int64|g:Float|g:Double|g:UUID|g:Date|g:Timestamp|g:List|g:Set|persist:Blob) or a primitive string|boolean|null`.

`GraphSONId` is `g:Int64 | g:Int32 | g:UUID` only. Plain string ids are rejected with `GraphSON id must be a typed object ... using one of g:Int32, g:Int64, or g:UUID`. Caller-supplied ids are request-local handles; Persist replaces them with content hashes (section 6).

### 2.2 Vertex, vertex property, edge, edge property

```json
{
  "@type": "g:Vertex",
  "@value": {
    "id": { "@type": "g:Int64", "@value": 1 },
    "label": "person",
    "properties": {
      "name": [
        {
          "@type": "g:VertexProperty",
          "@value": {
            "id": { "@type": "g:Int64", "@value": 10 },
            "label": "name",
            "value": "Alice",
            "properties": { "source": "crm" }
          }
        }
      ]
    }
  }
}
```

- `g:Vertex.@value` requires `id` (`GraphSONId`), `label` (string) and `properties`, a record keyed by property name whose values are arrays of `g:VertexProperty`. The record must have at least one key (`Vertex properties must contain at least one property entry`). Multiple entries per key are allowed and each is validated separately.
- `g:VertexProperty.@value` requires `id` (`GraphSONId`), `label` (string) and `value` (`GraphSONValue`); `properties` (meta-properties, record of `GraphSONValue`) is optional and is dropped before persistence.
- Decode message for a malformed entry: `Vertex property must be an array of GraphSON VertexProperty entries, e.g. [{"@type":"g:VertexProperty","@value":{"id":...,"label":"name","value":...}}]`.

```json
{
  "@type": "g:Edge",
  "@value": {
    "id": { "@type": "g:UUID", "@value": "edge-1" },
    "label": "knows",
    "outV": { "@type": "g:Int64", "@value": 1 },
    "outVLabel": "person",
    "inV": { "@type": "g:Int64", "@value": 2 },
    "inVLabel": "person",
    "properties": {
      "weight": { "@type": "g:Property", "@value": { "key": "weight", "value": { "@type": "g:Double", "@value": 0.5 } } }
    }
  }
}
```

- `g:Edge.@value` requires `id`, `label`, `inV`, `inVLabel`, `outV`, `outVLabel`; `properties` is optional (a record of `g:Property`). Unlike vertices, an edge may carry no properties.
- `g:Property.@value` requires `key` and `value`. Decode message: `Edge property value must be a GraphSON g:Property object`.

### 2.3 Request wrapper and the event-body form

The HTTP body for `/ingest`, `/ingest-async` and the bare form of `/validate` is:

```json
{
  "@type": "tinker:graph",
  "@value": {
    "vertices": [ { "@type": "g:Vertex", "@value": { } } ],
    "vertexRefs": [ { "@type": "g:VertexRef", "@value": { "id": { "@type": "g:UUID", "@value": "<64 hex>" }, "label": "phone_number" } } ],
    "edges": [ { "@type": "g:Edge", "@value": { } } ]
  }
}
```

`vertices` and `edges` are required arrays (they may be empty, but an empty graph fails integrity); `vertexRefs` is optional. The decoder (`lambda/services/GraphSONDecode.ts`) returns the `@value` body (`GraphSONIngestBody`), so every later stage works on `{ vertices, vertexRefs?, edges }`.

`GraphFactProduced` events carry the same three arrays under `detail.graphson` without the `tinker:graph` envelope (`lambda/schemas/eventbridge/graph-fact.ts`). `GraphFactEventService` re-wraps them as `{ "@type": "tinker:graph", "@value": detail.graphson }` and calls the same sync ingest, so the contract in this file applies unchanged to events.

### 2.4 Persist Blob typed values (contract level)

A lexicon property with `type: "blob"` accepts exactly two forms:

1. `{ "@type": "persist:Blob", "@value": "<raw text>" }` where the UTF-8 byte length of `@value` is `<= PERSIST_BLOB_MAX_BYTES` (default `1048576`). Persist materialises the text to S3 and replaces the value with the derived `s3://` URI before hashing and writing.
2. A plain string matching `^s3://[^/]+/.+` (caller-supplied URI). It is accepted as-is and stored unchanged; Persist does not fetch or verify it. Consequence: a caller URI and a `persist:Blob` of the same text hash to the same element id only when the caller's URI equals the URI Persist would derive.

Rejections on a blob rule: a non-S3 plain string and any other value shape give `BlobTypeMismatch`; text over the limit gives `BlobTooLarge`; a blob rule that declares `enum` gives `BlobNotAllowed` for every `persist:Blob` value (the rule, not the value, is wrong). A `persist:Blob` on a non-blob rule is an ordinary `TypeMismatch` (`actual: "blob"`).

Lists of blobs: an `array` rule with `items.type: "blob"` validates and materialises each direct child of the `g:List` / `g:Set`. Only one level is traversed; nested containers are left untouched. On the vertex path, array items whose `items.type` is not `blob` are not item-checked at all; on the edge path they get `ArrayItemTypeMismatch` (section 5).

Hashing, key derivation and the S3 write path are in `identity-hashing-and-blobs.md`.

## 3 Vertex references

A `g:VertexRef` (`lambda/schemas/graphson/vertex-ref.ts`) is `{ id: GraphSONId, label: string }`. It asserts "this vertex already exists in Neptune under this content-hash id and label; use it as an edge endpoint but do not upsert it". It is a Persist extension, not a TinkerPop type.

Contract:

- `vertexRefs` is optional. Payloads without it behave exactly as before refs existed.
- Ref ids must be Persist vertex hashes: after unwrapping, the raw string must match `^[a-f0-9]{64}$` case-insensitively. Ids are lower-cased before lookup and comparison.
- Integrity (`GraphSONValidationService`): a ref id that also appears in `vertices` gives `DuplicateVertexRef { vertexId, vertexLabel, refLabel }` (reported once per id); the same ref id listed twice with different labels gives `DuplicateVertexRef { vertexId, vertexLabel: <first label>, refLabel: <second label> }`; exact duplicates are accepted. A ref satisfies `MissingEdgeVertex` for `outV` / `inV`; a ref no edge touches gives `IsolatedVertexRef`.
- Semantic: `UnknownVertexRefLabel` when the label is not a lexicon vertex type. Ref labels also feed the endpoint checks, so an edge whose endpoint is a ref with the wrong label gets `OutVVertexLabelMismatch` / `InVVertexLabelMismatch`.
- Verification (`GraphSONVertexRefVerifierService.verifyVertexRefs`) runs on both `POST /persist/ingest` and `POST /persist/validate`, after schema, integrity and semantic validation and before any side effect. It is a no-op when the payload has no refs.
  - `MalformedRefId` is raised without touching Neptune.
  - Well-formed ids are de-duplicated and looked up in a single reader-endpoint traversal: `g.V(id1, id2, ...).project('id', 'label').by(id).by(label)`. The lookup has a 10 s timeout (`GremlinExecutionError` on expiry) and runs under the shared Neptune retry policy (`GremlinRetry.withRetry`: `NEPTUNE_RETRY_MAX_ATTEMPTS` retries, default 5, `NEPTUNE_RETRY_BASE_DELAY_MS` base, default 1000). A row missing the `id` or `label` projection is a `GremlinExecutionError`.
  - An id with no row gives `VertexNotFoundForRef`; a row whose label differs gives `LabelMismatchForRef { actualLabel }`.
  - All issues are aggregated into one `MissingVertexRef { message, issues[] }` (each issue: `{ code, vertexId, expectedLabel, actualLabel? }`) returned as HTTP 404 with `details: { issues, issueCount }`. Reader-endpoint verification accepts replica-lag risk; a producer that needs read-after-write must retry after the owning producer has committed (ADR 0001).
- Async route: `/ingest-async` runs full validation and then rejects any non-empty `vertexRefs` with `GraphSONIntegrityError` (400) carrying the single issue `{ type: "VertexRefsNotSupportedForAsyncIngest" }`. Ref-bearing `GraphFactProduced` events are forced onto the sync path; there a `MissingVertexRef` is a deterministic skip, not a failure (sibling file).
- Cross-authority hashing: `transformGraphSONForPersist` starts with an empty id map and only fills it from payload vertices. A ref endpoint therefore passes through as its raw hash string, so an edge to a ref hashes identically to the same edge written against the full vertex. The response echoes the ref endpoint id exactly as sent (typed object, original casing). Refs are never upserted and are not echoed in the response.

## 4 Lexicon consumption and property rules

### 4.1 Loading and caching

`LexiconSchemaService` reads `LEXICON_DATA_URI` (the stack resolves it from the SSM parameter `/lexicon/data-uri` at deploy time through a CloudFormation SSM parameter value), parses it as an `s3://bucket/key` URI, fetches the object with a per-request timeout of `LEXICON_OBJECT_TIMEOUT_MS` (default 10 000 ms; non-positive or non-finite values fall back to the default), `JSON.parse`s it and decodes it against `LexiconDocument` collecting all issues. Failures are tagged `LexiconConfigReadError`, `LexiconUriParseError`, `LexiconObjectFetchError` (fetch failure or timeout) or `LexiconDecodeError` (bad JSON or schema).

The loaded document is memoised with `Effect.cachedWithTTL` for 300 s per service instance. After expiry the next call refetches; if that refetch fails the call fails (no stale fallback). Because the GraphSON router builds its `ManagedRuntime` once (section 8), the cache survives across warm invocations of the same Lambda container.

### 4.2 How a load failure surfaces

- Semantic validation (`/ingest`, `/ingest-async`, `/validate`, graph-fact events) maps any `LexiconSchemaServiceError` to `GraphSONPayloadValidationError` (HTTP 400) with one issue `{ code: "SemanticLexiconLoadFailure", path: "/", message: "Failed to load lexicon schema for semantic validation", actual: "<ErrorName>: <message> (<cause>)" }`.
- `GraphSONBlobTransformService` and `GraphSONPersistTransformService` call `getLexicon()` with `Effect.orDie`; a failure there is a defect that the router catches and answers as HTTP 500 `InternalServerError`. On `/ingest` this can only happen if the cache expires between the validation stage and the transform stage.
- The four lexicon tags have no case in the HTTP status mapper, so if one escapes untranslated it also collapses to the 500 fallback.

### 4.3 Candidate lexicons on `/validate`

The `/validate` wrapper (section 7) may carry `candidate_lexicon_s3_uri`. The router only checks that it is a string; it then builds a fresh GraphSON layer whose `LexiconSchemaService` uses that URI instead of `LEXICON_DATA_URI` (`makeGraphsonRouterLayer(uri)` -> `makeLexiconSchemaServiceLayer(uri)`), runs the validation in a per-request `ManagedRuntime`, and disposes it in `finally`. Nothing in the code restricts the bucket, prefix or suffix; the only bound is the API Lambda role's `s3:GetObject` grant, which in the current stack is an object-level wildcard rather than a lexicon-bucket restriction. Treat the candidate URI as trusted-caller input. Candidate lexicons never drive writes.

### 4.4 Document and property-rule shape

`LexiconDocument` (`lambda/schemas/lexicon.ts`): `{ vertices: VertexRule[], edges: EdgeRule[], common_patterns?: unknown, ...passthrough }`. Unknown keys are preserved and ignored.

- Vertex rule: `{ type, properties: Record<key, PropertyRule>, required: string[], indexes?: Record<name, IndexRule> }` (`required` is mandatory, may be empty).
- Edge rule: `{ type, from, to, properties, required?: string[], indexes? }`.
- Property rule: `{ type: string|integer|number|boolean|array|blob, persistence?: graph|external, required?: boolean, enum?: (string|number|boolean)[], format?: string, pattern?: string, minLength?: number, items?: { type } }` plus passthrough keys.

What the GraphSON validator enforces from a property rule: `type`, `items.type` (edge arrays and blob lists), `required` (union of `rule.required[]` and `property.required: true`), `enum`, `format`, `persistence: external`, and `indexes` keys as server-managed. `pattern` and `minLength` are decoded but not enforced on the GraphSON path. Index rules are documented in `derived-index-maintenance.md`.

Type matching (`matchesLexiconType`):

| Rule `type` | Accepted values |
| --- | --- |
| `string` | bare string; `g:UUID`; with `format: date` a `g:Date`, with `format: date-time` a `g:Timestamp` (the other temporal wrapper is a `TypeMismatch` with `expected: "ISO date string or g:Date"` / `"ISO date-time string or g:Timestamp"`) |
| `integer` | bare integral number or bigint; `g:Int32` / `g:Int64` with an integral value |
| `number` | bare finite number or bigint; `g:Int32` (integral), `g:Int64`, `g:Float`, `g:Double`, `g:Date`, `g:Timestamp` |
| `boolean` | bare boolean only; no typed wrapper matches |
| `array` | `g:List` or `g:Set` |
| `blob` | `persist:Blob` or an `s3://` string |

Formats (`lambda/utils/lexiconStringFormat.ts`): `date` (`YYYY-MM-DD`, calendar-checked), `date-time` (ISO 8601 with `Z` or offset, parseable), `email`, `phone_number` (E.164 or exactly 10 digits), `time` (`HH:MM[:SS[.fraction]]`), `uri` (parseable by `URL`). Any other `format` string passes. Format is checked on the string form of the value (temporal wrappers are canonicalised first). Enum comparison unwraps typed values and compares the primitive against `enum[]`; a bigint outside the safe range never matches.

Server-managed keys `created_at` and `id` are ignored wherever they appear in the payload (not validated, not required even if the lexicon says so, stripped before hashing and persistence). Derived-index keys are also stripped before hashing but are rejected when a caller supplies them.

## 5 Validation pipeline and issue-code catalogue

`GraphSONValidationService.validatePayload` runs three stages in order and stops at the first failing stage; within a stage all issues are collected.

1. Schema decode (`decodeGraphSONIngestRequest`, `errors: "all"`): issues are `{ code: <effect ParseResult tag>, path: <JSON pointer>, message }`. When several union branches fail at one path the decoder collapses them into a single `Type` issue with the generic message and suppresses the child `/@type` `Missing` issue. If formatting fails, one `ParseFailure` issue at `/`.
2. Integrity (`collectIntegrityIssues`): issues are typed objects with a `type` discriminator, returned in `GraphSONIntegrityError`.
3. Semantic (`GraphSONSemanticValidationService.validate`): loads the lexicon, collects vertex issues, then vertex-ref issues, then edge issues; on success returns the request with temporal values canonicalised for hashing. Issues are `{ code, path, message, instanceLabel?, expected?, actual? }`, returned in `GraphSONPayloadValidationError` with `details: { issues, issueCount }`.
4. Route-specific: vertex-ref verification (`/ingest`, `/validate`) or async ref rejection (`/ingest-async`).

Paths are JSON pointers rooted at the request body, e.g. `/@value/vertices/0/@value/properties/name/0/@value/value`, `/@value/edges/2/@value/properties/weight/@value/value`, `/@value/edges/2/@value/properties/tags/@value/value/@value/1` (array item), `/@value/vertexRefs/0/@value/label`. Property keys are pointer-escaped (`~` -> `~0`, `/` -> `~1`).

| Stage | Code | Fires when | HTTP |
| --- | --- | --- | --- |
| Decode | `Type`, `Missing`, `Unexpected`, other ParseResult tags | Body does not match the `tinker:graph` schema (wrong wrapper, bad id, unknown `@type`, empty vertex `properties`, ...) | 400 `GraphSONPayloadValidationError` |
| Decode | `ParseFailure` | Issue formatting itself failed | 400 `GraphSONPayloadValidationError` |
| Integrity | `EmptyGraph` | `vertices` and `edges` both empty | 400 `GraphSONIntegrityError` |
| Integrity | `MissingEdgeVertex` `{ edgeId, edgeLabel, vertexId, direction: outV\|inV }` | Edge endpoint is neither a payload vertex nor a ref | 400 `GraphSONIntegrityError` |
| Integrity | `DuplicateVertexRef` `{ vertexId, vertexLabel?, refLabel }` | Ref id is also a payload vertex, or the same ref id carries conflicting labels | 400 `GraphSONIntegrityError` |
| Integrity | `IsolatedVertex` `{ vertexId, vertexLabel }` | No edge references the vertex | 400 `GraphSONIntegrityError` |
| Integrity | `IsolatedVertexRef` `{ vertexId, vertexLabel }` | No edge references the ref | 400 `GraphSONIntegrityError` |
| Integrity (async only) | `VertexRefsNotSupportedForAsyncIngest` | `/ingest-async` body has refs | 400 `GraphSONIntegrityError` |
| Semantic | `SemanticLexiconLoadFailure` | Lexicon could not be loaded or decoded | 400 `GraphSONPayloadValidationError` |
| Semantic | `UnknownVertexLabel` / `UnknownEdgeLabel` / `UnknownVertexRefLabel` | Label not in lexicon; the element's other checks are skipped | 400 |
| Semantic | `DerivedIndexServerManagedProperty` | Caller supplied a key declared under the rule's `indexes` (checked before `UnknownProperty`) | 400 |
| Semantic | `UnknownProperty` | Property key not in the rule's `properties` | 400 |
| Semantic | `ExternalPropertyNotIngestable` | Property rule has `persistence: external`; its value is not validated further | 400 |
| Semantic | `MissingRequiredProperty` | Key in `rule.required[]` or `property.required: true` is absent (server-managed keys exempt) | 400 |
| Semantic | `OutVLabelMismatch` / `InVLabelMismatch` | Edge `outVLabel` / `inVLabel` differs from the edge rule's `from` / `to` | 400 |
| Semantic | `OutVVertexLabelMismatch` / `InVVertexLabelMismatch` | The payload vertex or ref the endpoint id resolves to has a label different from `from` / `to` | 400 |
| Semantic | `TypeMismatch` | Value does not satisfy the rule type (table in 4.4); includes `persist:Blob` on a non-blob rule and `null` on any rule | 400 |
| Semantic | `ArrayContainerMismatch` | Edge `array` property is not a `g:List` / `g:Set` (edge path only; vertex arrays surface as `TypeMismatch`) | 400 |
| Semantic | `ArrayItemTypeMismatch` | Edge array item fails `items.type` (non-blob items; edge path only) | 400 |
| Semantic | `EnumMismatch` | Unwrapped value not in `enum[]` | 400 |
| Semantic | `FormatMismatch` | String form fails the named format | 400 |
| Semantic | `BlobTypeMismatch` | Blob rule (or blob list item) received a non-S3 string or a non-`persist:Blob` value | 400 |
| Semantic | `BlobTooLarge` | `persist:Blob` text exceeds `PERSIST_BLOB_MAX_BYTES` | 400 |
| Semantic | `BlobNotAllowed` | Blob rule declares `enum`; reported for each `persist:Blob` value on it | 400 |
| Ref verification | `MalformedRefId` / `VertexNotFoundForRef` / `LabelMismatchForRef` | See section 3 | 404 `MissingVertexRef` |

`DerivedIndexServerManagedPropertyError` (a tagged 400 error class) is defined and status-mapped but is not raised by any code path in `lambda/`; GraphSON callers always see the `DerivedIndexServerManagedProperty` issue code inside `GraphSONPayloadValidationError`.

## 6 `POST /persist/ingest`

Pipeline (`GraphSONService.ingest`):

1. `validatePayload` (section 5). On success the request carries hash-canonical temporal strings.
2. `verifyVertexRefs` (section 3). Nothing has been written yet.
3. Start the `durationMs` clock (validation and ref verification are excluded from it).
4. `materializeGraphBlobs`: for every property whose rule is `blob` or `array` of `blob`, write each `persist:Blob` text to S3 and substitute the URI; count `blobsMaterialized`, `bytesMaterialized`, `objectsCreated`, `objectsReused`. This is the only side effect before the graph transaction; content-addressed objects left behind by a later failure are treated as immutable cache entries.
5. `normalizeNow`: strip `created_at`, `id` and derived-index keys; hash every vertex id from `label + properties`; remap edge endpoints through the vertex id map (refs pass through); hash every edge id from `label + outV + inV + properties`; build `graphForResponse` (hashed ids as `g:UUID`, meta keys stripped); build `graphForPersist` by additionally stamping `created_at` as `g:Timestamp` (ingest-time epoch ms; vertex property id `<vertexHash>#created_at`) on every vertex and edge and converting lexicon `date` / `date-time` strings to `g:Date` / `g:Timestamp` for storage.
6. `withTransaction` on the writer connection: `g.tx().begin()`, then for each vertex `g.V().hasId(hash).fold().coalesce(unfold(), addV(label).property(id, hash).property(...))`, then for each edge `g.E().hasId(hash).fold().coalesce(unfold(), V().hasId(outV).addE(label).to(V().hasId(inV)).property(id, hash).property(...))`. Because `graphForPersist` always carries `created_at` as a `g:Timestamp`, these upserts run as Gremlin scripts with `datetime()` literals (`identity-hashing-and-blobs.md` §4.2); the bytecode `has(id, ...)` form in `GremlinService` is reached only by property sets with no temporal value. Commit on success; on any failure or interruption roll back if `tx.isOpen` (rollback failures are logged, not raised). The whole transaction is wrapped in the Neptune retry policy, so a retriable failure re-runs the entire batch.
7. Record `IngestMetricsService` counts (`method: sync_ingest` unless the caller overrides, e.g. `eventbridge_graph_fact_sync`) and blob counters.

Semantics: all-or-nothing per request; idempotent across requests because ids are content hashes (`upsert` is a no-op for an existing hash and never rewrites its properties). Ref endpoints are never written.

Response (`ok`, HTTP 200):

```json
{ "ok": true, "data": { "vertices": { "upserted": [ <g:Vertex> ] }, "edges": { "upserted": [ <g:Edge> ] }, "durationMs": 156 } }
```

Each upserted element is the caller's element with `id` (and edge `outV` / `inV` for payload vertices) replaced by `{ "@type": "g:UUID", "@value": "<sha256 hex>" }`, blob values replaced by URIs, `created_at` / `id` / derived keys removed, and temporal values in hash-canonical string form. `vertexRefs` are not echoed.

## 7 `POST /persist/validate`

Body parsing (`parseValidationPayload`):

- A non-object body, an array, or an object without `graph` and without `candidate_lexicon_s3_uri` is treated as the bare `tinker:graph` request.
- An object with either key is a wrapper `{ graph, candidate_lexicon_s3_uri? }`. Missing `graph` -> 400 `BadRequest` "Validation wrapper must include graph". Non-string `candidate_lexicon_s3_uri` -> 400 `BadRequest` "candidate_lexicon_s3_uri must be a string". An empty string is ignored.

Program: `validatePayload(graph)` then `verifyVertexRefs(request)`; success returns `{ "ok": true, "data": { "valid": true } }`. No blob materialisation, no hashing, no S3 or Neptune writes; the only Neptune access is the reader-endpoint ref lookup. With a candidate URI the router creates a one-off container (section 4.3) and disposes it after the response, so candidate lexicons never enter the shared cache.

## 8 Router composition and error sanitisation

`createGraphsonRouter` (`lambda/routes/graphson.router.ts`) calls `ManagedRuntime.make(layer)` once at construction; the module-level `graphsonRouter` therefore holds one container for the Lambda's lifetime. `makeGraphsonRouterLayer` merges:

- `GremlinLayer`: `GremlinClient`, `GremlinRetry`, `GremlinService` (upserts), `GremlinTx` (plus the query and FTS policy services the Gremlin service needs).
- `LexiconSchemaService`, `GraphSONSemanticValidationService`, `GraphSONValidationService`.
- `PersistBlobService`, `GraphSONBlobTransformService`, `GraphSONPersistTransformService`.
- `GraphSONVertexRefVerifierService` (built on `GremlinClient` + `GremlinRetry` only).
- `GraphSONService` (with `IngestMetricsService`) and `GraphSONAsyncIngestService`.

Every route: parse JSON (failure -> 400 `BadRequest` "Invalid JSON body"), run the program with `Effect.either`, log validation-class failures (`GraphSONValidationError`, `GraphSONPayloadValidationError`, `GraphSONIntegrityError`, `MissingVertexRef`) at `warn` and everything else at `error`, then pass the error through `sanitizeGraphsonError` before the HTTP mapper. Thrown defects are caught and sanitised the same way. Sanitisation applies to `/ingest`, `/ingest-async` and `/validate` alike:

| Tag | Rewrite |
| --- | --- |
| `GraphSONValidationError` | `received` replaced with `"invalid"`; `path` and `expected` kept |
| `GraphSONIntegrityError` | `message` replaced with `"GraphSON integrity error"`; `issues` kept |
| `GraphSONPayloadValidationError` | rebuilt with the same `message` and `issues` (no visible change) |
| `VertexNotFoundError` | `message` replaced with `"Vertex not found"`; `vertexId` kept |
| `GremlinExecutionError` | replaced by a plain `Error("Internal Server Error")` -> 500 `InternalServerError`; query text never leaves the service |
| anything else | passed through unchanged (`NeptuneConnectionError` / `NeptuneRetriableError` 503, blob errors per the catalogue, untagged errors 500) |

## 9 Verification

| Rule | Test |
| --- | --- |
| Typed-value union, id strictness, readable decode messages, union-noise collapse | `test/services/GraphSONValidationService.test.ts` ("returns readable messages ...", "returns a single readable issue for invalid GraphSON typed values", "returns detailed structural issues with JSON pointer paths") |
| Integrity codes incl. both `DuplicateVertexRef` cases and refs satisfying endpoints | same file ("returns duplicate vertex reference issues for vertex/ref overlap and conflicting refs", "accepts edge endpoints declared as vertex references", "returns isolated vertex reference issues", "returns an empty graph issue") |
| Blob forms: `persist:Blob`, caller `s3://`, non-S3 string rejection, list items | `test/services/GraphSONSemanticValidationService.test.ts` ("accepts persist:Blob ...", "accepts pre-supplied S3 URI strings ...", "rejects non-S3 plain strings ...", "validates blob list item wrappers") |
| Unknown labels/properties, external, required, type/enum/format, temporal wrappers, endpoint label checks, edge array codes, issue aggregation | same file (remaining cases) |
| Derived-index keys rejected | `test/services/GraphSONSemanticValidationService.indexes.test.ts` |
| One lookup for all refs; malformed/missing/mismatched aggregated into one `MissingVertexRef` | `test/services/GraphSONVertexRefVerifierService.test.ts` |
| Refs verified before the transaction; created_at stamped and stripped; `id` stripped; hash stability; rollback | `test/services/GraphSONService.test.ts` |
| Blob materialisation counters and one-level lists | `test/services/GraphSONBlobTransformService.test.ts` |
| Lexicon fetch, TTL hit/refresh, fail-closed refresh, per-URI isolation, error tags | `test/services/LexiconSchemaService.test.ts` |
| Route statuses (200/202/400/404/503), wrapper parsing, one-off candidate layer, sanitisation of vertex-not-found / execution errors / defects, single runtime per router | `test/routes/graphson.router.test.ts` |

Run `pnpm test -- test/services/GraphSON test/routes/graphson.router.test.ts test/services/LexiconSchemaService.test.ts` in the Persist repo after touching any of the sources below.

## 10 Source map

| Concern | Path |
| --- | --- |
| Typed values, ids | `lambda/schemas/graphson/types.ts`, `lambda/utils/graphsonValue.ts` |
| Vertex / edge / ref shapes | `lambda/schemas/graphson/vertex.ts`, `edge.ts`, `vertex-ref.ts` |
| Request / response / validate schemas, integrity issue types | `lambda/schemas/graphson/ingest.ts`, `validate.ts` |
| Error classes and issue structs | `lambda/schemas/errors.ts` (`GraphSONPayloadValidationIssue`, `GraphSONIntegrityError`, `MissingVertexRef`, lexicon tags) |
| Decode and issue formatting | `lambda/services/GraphSONDecode.ts` |
| Integrity and stage orchestration | `lambda/services/GraphSONValidationService.ts` |
| Semantic rules and every issue code | `lambda/services/GraphSONSemanticValidationService.ts`, `lambda/utils/lexiconStringFormat.ts`, `lambda/utils/graphsonTemporalTransform.ts` |
| Ref verification | `lambda/services/GraphSONVertexRefVerifierService.ts`, `docs/adr/0001-verify-vertex-references-on-reader-endpoint.md` |
| Blob transform | `lambda/services/GraphSONBlobTransformService.ts` |
| Persist transform (strip, hash, stamp) | `lambda/services/GraphSONPersistTransform.ts`, `GraphSONPersistTransformService.ts` |
| Ingest orchestration and transaction | `lambda/services/GraphSONService.ts`, `GremlinTx.ts`, `GremlinService.ts` (`upsertVertex`, `upsertEdge`) |
| Async ref rejection | `lambda/services/GraphSONAsyncIngestService.ts` |
| Event re-wrapping | `lambda/schemas/eventbridge/graph-fact.ts`, `lambda/services/GraphFactEventService.ts` |
| Lexicon schema and loader | `lambda/schemas/lexicon.ts`, `lambda/services/LexiconSchemaService.ts` |
| Router, sanitisation, wrapper parsing | `lambda/routes/graphson.router.ts`, `lambda/http/responses.ts` |
| Layer composition | `lambda/services/index.ts` (`makeGraphsonRouterLayer`, `GraphsonRouterLayer`) |
| Narrative references | `README.md` (GraphSON core types, Persist Blobs, GraphSON graph types, Vertex references, `POST /persist/ingest`), `CONTEXT.md` (Vertex Reference Contract) |
