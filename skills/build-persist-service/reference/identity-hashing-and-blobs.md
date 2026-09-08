# Identity Hashing, Persist Blobs, and Temporal Handling

Persist assigns every vertex and edge a deterministic id: a SHA-256 over the label, the endpoints (edges only), and the canonicalised lexicon properties. The same business fact therefore lands on the same graph element whichever path carried it (sync ingest, async ingest, event ingestion, Neptune CSV rehash). Two transforms run before the hash so that transport shape cannot change the id: `persist:Blob` text is replaced by a content-addressed `s3://` URI, and temporal values are collapsed to one ISO string form. After the hash, temporal strings are wrapped back into `g:Date` / `g:Timestamp` so Neptune stores native datetimes. This file is the code-derived contract for those three mechanisms; it replaces PRD §3.2.1, §3.4, §3.4.1, §6.7, and §7.1.

## 1. Scope and non-goals

In scope: the hash algorithm and its canonicalisation rules; what does and does not change an id; the `persist:Blob` value, its validation, URI derivation, S3 runtime, privacy rules, metrics, and schemas; temporal values on ingest, at persist time, on read, and in the CSV type-widening rules.

Non-goals: the GraphSON envelope, integrity checks, and the full validation-code catalogue (see `graphson-ingest-contract.md`); the CSV workflow itself (see `csv-bulk-load-workflow.md`); the environment variable table (see `stacks-configuration-and-iam.md`); derived-index computation (its keys only matter here because they are excluded from the hash).

Pipeline order, which the rest of this file assumes (`lambda/services/GraphSONService.ts`, `lambda/services/GraphSONAsyncIngestService.ts`):

1. `validatePayload`: decode, integrity check, semantic validation. Semantic validation returns the request with temporal values canonicalised to ISO strings (§4.1).
2. Vertex reference verification (sync ingest only; async rejects `vertexRefs`).
3. `materializeGraphBlobs`: every `persist:Blob` becomes an `s3://` URI (§3).
4. `normalizeNow` / `normalizeAtEpoch`: strip meta properties, hash, remap ids, stamp `created_at`; then wrap temporal strings for persistence (§2, §4.2).
5. Write to Neptune (sync) or store the persisted-shape graph as the async payload document and enqueue it (async / event ingestion).

## 2. Hashed identity

### 2.1 Inputs

`lambda/services/GraphSONHash.ts`, `lambda/services/GraphSONPersistTransform.ts`.

- Vertex id = `sha256(stableStringify({ label, properties }))`, hex lowercase, returned as `{ "@type": "g:UUID", "@value": "<hex>" }`.
- Edge id = `sha256(stableStringify({ label, outV, inV, properties }))`.
- `properties` are the lexicon property values only. Extraction takes `@value.value` out of each `g:VertexProperty` / `g:Property` wrapper; a vertex property key with zero values is dropped before hashing.
- Meta properties are stripped first: `created_at`, `id`, and every derived-index key declared for that label in the lexicon (`indexes` on the vertex or edge rule). They never contribute to the id.
- Edge endpoints: `outV` / `inV` are unwrapped to their primitive (`@value` of `g:UUID` / `g:Int32` / `g:Int64`). If the endpoint's original id belongs to a vertex in the same payload, the vertex's freshly computed hash is used. Otherwise the primitive passes through unchanged: a verified `vertexRefs` endpoint is already a final hash string, so the edge hash equals what a full-endpoint payload would produce (`test/services/GraphSONPersistTransform.test.ts`, "uses vertex references as edge endpoints without persisting them"). The id map starts empty; nothing is pre-populated from refs.
- The caller-supplied vertex `id` and the edge `outVLabel` / `inVLabel` are not hash inputs. Vertex ids only serve to resolve edge endpoints inside the payload.

### 2.2 Canonicalisation (`normalizeGraphSONValue`)

Values are canonicalised recursively before serialisation. The hash representation is what `stableStringify` sees.

| Input | Hash representation |
| ----- | ------------------- |
| Bare integral number (`2`, `2.0`, `70146.0`) | `{ "type": "csv:Int", "value": 2 }` |
| Integer wrapper `g:Int16` / `g:Int32` / `g:Int64` / `g:Byte` / `g:Short` / `g:Long` / `csv:Int` / `csv:Integer` / `csv:Long` / `csv:Short` / `csv:Byte` | `{ "type": "csv:Int", "value": <n> }` — `@value` number kept as number; `@value` bigint becomes a number when it is a safe integer, else its decimal digit string |
| Bare non-integral number (`70146.5`) | the number itself |
| Float wrapper `g:Float` / `g:Double` / `csv:Float` / `csv:Double` / `csv:Decimal` with numeric `@value` | unwrapped, then re-canonicalised: integral values collapse to the `csv:Int` shape, others stay bare numbers |
| Bare boolean, or `g:Boolean` / `csv:Bool` / `csv:Boolean` with boolean `@value` | the boolean |
| Bare string, or `g:String` / `csv:String` / `csv:Str` / `csv:Varchar` / `csv:Char` with string `@value` | the string (a string `"false"` stays distinct from boolean `false`) |
| Bare bigint (outside an integer wrapper) | `{ "type": "bigint", "value": "<digits>" }` |
| `null` | `null` |
| Bare JSON array | array, order preserved, each item canonicalised |
| Any other typed value (`g:List`, `g:Set`, `g:Map`, `g:UUID`, `g:Date`, `g:Timestamp`, ...) | `{ "type": "<@type>", "value": <canonicalised @value> }` — the wrapper name is part of the hash |
| Plain object | keys sorted (`localeCompare`), values canonicalised |

`stableStringify` emits `JSON.stringify` for primitives, `[...]` for arrays, and `{...}` with keys sorted by `localeCompare`. Numbers therefore serialise as JavaScript numbers (`2`, `70146.5`).

Vertex multi-property values are sorted by their stable string after canonicalisation, so `["b","a"]` and `["a","b"]` as two values of one key hash the same. Items inside a `g:List` / `g:Set` `@value` are not sorted: list order is identity.

Temporal properties reach the hash as strings because semantic validation canonicalised them first (§4.1). A `g:Date` or `g:Timestamp` wrapper on a non-temporal lexicon property (or a label unknown to the lexicon) is hashed with its wrapper name, per the table.

### 2.3 Worked examples

Repo fixtures (`test/services/GraphSONHash.test.ts`):

- Vertex `person` with `filing_date: ["2025-03-10"]`, `effective_at: ["2025-03-10T10:15:30.000Z"]` serialises as `{"label":"person","properties":{"effective_at":["2025-03-10T10:15:30.000Z"],"filing_date":["2025-03-10"]}}` and hashes to `8ce0c301dc2846847ca2d8613602a9d5ece0a586f2245fd1bfacf0351fc230c3`.
- Edge `knows`, `outV: "out-1"`, `inV: "in-1"`, same two properties, serialises as `{"inV":"in-1","label":"knows","outV":"out-1","properties":{"effective_at":"2025-03-10T10:15:30.000Z","filing_date":"2025-03-10"}}` and hashes to `f392e19e4dae1a183d41289a300ac292a2efe45d8ed19a62d1ac1e355cfe3da7`.
- The same `person` payload with `version` as `g:Int64 2` or `csv:Int 2` hashes identically; so do `g:Int32 2`, bare `2`, and `2.0`.

Cross-type example (recomputed with the repo's `hashVertexId`, which also reproduces both fixtures above). Vertex `account` with `account_identifier: ["acct-1"]`, `version: [g:Int64 2]`, `active: [g:Boolean true]`, `balance: [g:Double 70146.5]`, `tags: [g:List ["b","a"]]` serialises as

```json
{"label":"account","properties":{"account_identifier":["acct-1"],"active":[true],"balance":[70146.5],"tags":[{"type":"g:List","value":["b","a"]}],"version":[{"type":"csv:Int","value":2}]}}
```

and hashes to `2f2f48b9071a7b50f9e33cb3dbe5601b3e8f8dd9a6acc99fa612cccefdd99de2`. Sending the same fact with bare `2`, `true`, `70146.5` produces the identical id. `g:Boolean` exists only as a hash-level alias (it is not in the GraphSON value union the HTTP routes accept, see `graphson-ingest-contract.md` §2); over HTTP the boolean is sent bare.

### 2.4 Invariants

Changes the id: label; any lexicon property key or value; the order of items inside a `g:List` / `g:Set`; a `persist:Blob` whose text differs by a single byte; a temporal string's exact form (see §4.1 caveat); edge endpoint identity.

Does not change the id: caller-supplied vertex ids; `created_at`, `id`, derived-index keys; the order of keys or of vertex multi-property values; integer wrapper choice; float wrapper on an integral value; string/boolean wrapper choice; sending a full endpoint vertex versus a verified vertex ref with the same hash; the persisted temporal wrapper (added after hashing).

The response graph carries the hashed ids as `g:UUID` values with meta properties stripped; the persisted graph additionally carries `created_at` (`g:Timestamp` epoch ms; vertex property id `<hash>#created_at`). Changing `created_at` between two submissions of the same fact leaves the id unchanged (`test/services/GraphSONPersistTransform.test.ts`).

## 3. Persist Blobs

### 3.1 Contract

`lambda/utils/graphsonValue.ts`, `lambda/services/GraphSONSemanticValidationService.ts`, `lambda/schemas/lexicon.ts`.

- Typed value: `{ "@type": "persist:Blob", "@value": "<raw text>" }`. `@value` must be a string.
- Allowed only where the lexicon property rule is `type: "blob"`, or `type: "array"` with `items: { type: "blob" }` (children of a `g:List` / `g:Set`). A `persist:Blob` on any other property type fails the lexicon type check.
- Validation of a blob-typed property value:
  - A plain string matching `^s3://[^/]+/.+` is accepted as-is and stored unchanged (backward compatibility for already-materialised content).
  - Any other plain string: `BlobTypeMismatch` ("raw text must use a persist:Blob wrapper").
  - Any value that is neither an `s3://` string nor `persist:Blob`: `BlobTypeMismatch`.
  - `persist:Blob` whose UTF-8 byte length exceeds `PERSIST_BLOB_MAX_BYTES` (default 1 048 576): `BlobTooLarge`.
  - A blob rule that declares `enum`: `BlobNotAllowed`.
- Determinism caveat: because caller `s3://` strings pass through untouched, a mirrored URI and a `persist:Blob` of the same text produce the same id only if the caller's URI is byte-identical to the URI Persist would derive (same bucket, prefix, and content hash). Send raw text as `persist:Blob` when cross-path identity matters.
- One-level list handling: for an array-of-blob property the transform maps the direct children of the `g:List` / `g:Set`; children that are not `persist:Blob` pass through; nested containers and `g:Map` are not traversed.
- The transform only visits labels present in the lexicon and property keys that have a rule; edges without `properties` are skipped.
- Blob properties are stored in Neptune as ordinary `String` values holding the URI. Read paths return the URI, never the text.

### 3.2 URI derivation

`lambda/services/PersistBlobService.ts` (`hashPersistBlobText`, `buildPersistBlobKey`).

1. Take the exact caller string. Do not trim, normalise Unicode, canonicalise line endings, or parse it.
2. `contentHash = sha256(utf8(text))`, lowercase hex.
3. `prefix' = PERSIST_BLOB_PREFIX` with leading and trailing `/` stripped; empty result becomes `persist-blobs`.
4. `key = <prefix'>/sha256/<contentHash[0:2]>/<contentHash[2:4]>/<contentHash>.txt`.
5. `s3Uri = s3://<PERSIST_BLOB_BUCKET>/<key>`.

The bucket and prefix are part of every stored property value and therefore of every id that depends on a blob. Treat both as immutable once data exists; changing either is an identity migration.

### 3.3 Runtime behaviour

`materializeText(text, { path? })`:

- Size check first: over-limit text fails with `PersistBlobValidationError` (`code: "BlobTooLarge"`, `expected: "<= N bytes"`, `actual: "M bytes"`, `path` when given) before any S3 call.
- In-process memo keyed by `contentHash`, at most 10 000 entries, oldest insertion evicted. A hit returns the stored result with `objectCreated: false` and performs no S3 calls.
- `PutObject` with `IfNoneMatch: "*"`, `ContentType: text/plain; charset=utf-8`, and object metadata `persist-content-sha256`, `persist-content-byte-length`, `persist-blob-schema-version` (`"1"`). Success means `objectCreated: true`. `PreconditionFailed` / HTTP 412 means the object exists; the service then `HeadObject`s it and compares metadata hash, byte length (falling back to `ContentLength`), and schema version. Any mismatch fails closed with `PersistBlobHashCollisionError`.
- Every put and head runs under a semaphore of `PERSIST_BLOB_PUT_CONCURRENCY` permits (default 16) and a retry schedule: exponential backoff from `PERSIST_BLOB_RETRY_BASE_MS` (default 200 ms) with jitter, at most `PERSIST_BLOB_RETRY_MAX_ATTEMPTS` attempts in total (default 8). Only errors classified retryable are retried: HTTP 429 / 500 / 502 / 503 / 504, SDK `$retryable`, or an error `name` / `code` in the fixed list `SlowDown`, `ServiceUnavailable`, `InternalError`, `RequestTimeout`, `RequestTimeoutException`, `Throttling`, `ThrottlingException`, `TooManyRequestsException`, `TimeoutError`, `NetworkingError`, `AbortError`.
- Per-request S3 timeout `PERSIST_BLOB_OBJECT_TIMEOUT_MS` (default 10 000). Whole materialisation bounded by `max(PERSIST_BLOB_TOTAL_TIMEOUT_MS, object timeout)` (default 120 000); expiry fails with a non-retryable `PersistBlobStoreError`.
- The S3 client uses `retryMode: "adaptive"` with `PERSIST_BLOB_S3_MAX_ATTEMPTS` (default 8) underneath the service-level retry.
- Sequencing per ingest: the graph transform materialises vertices then edges, each property entry in order, and sums counters `{ blobsMaterialized, bytesMaterialized, objectsCreated, objectsReused }`.

### 3.4 Privacy

Raw blob text exists only in the request body and the blob bucket object. Enforced by construction:

- Materialisation runs before hashing, before the async payload document is written to S3, and before the queue message is sent, so payload documents, queue messages, and event-driven ingests carry URIs only.
- `PersistBlobValidationError`, `PersistBlobStoreError`, and `PersistBlobHashCollisionError` carry paths, bucket, key, hash, byte counts, and messages, never the text.
- Ingest logging records counts (`blobCount`); metrics record counts and bytes.
- `test/services/GraphSONBlobTransformService.test.ts` asserts the transformed graph's JSON does not contain the source text.

Keep these properties when changing the code: never log `@value` of a `persist:Blob`, never include it in an error, and never store the pre-materialisation graph anywhere durable.

### 3.5 Metrics

`lambda/services/IngestMetricsService.ts`, namespace `POWERTOOLS_METRICS_NAMESPACE` (default `persist`):

| Metric | Unit |
| ------ | ---- |
| `blobs_materialized` | Count |
| `blob_bytes_materialized` | Bytes |
| `blob_objects_created` | Count |
| `blob_objects_reused` | Count |

Dimensions: `ingest_method` always, one of `sync_ingest`, `async_ingest`, `eventbridge_graph_fact`, `eventbridge_graph_fact_sync`, `async_csv_upload`; `phase` (`vertices` or `edges`) only when the caller supplies it, which the CSV workflow does under `async_csv_upload`. Values are buffered per `method:phase` and flushed together with the ingest counters; zero-valued metrics are not emitted.

### 3.6 Schemas

```ts
type PersistBlobMaterializationResult = {
  schemaVersion: "1"
  contentHash: string          // lowercase sha256 hex of the exact UTF-8 bytes
  byteLength: number
  s3Uri: `s3://${string}`
  objectCreated: boolean       // false on memo hit or verified existing object
}
PersistBlobValidationError    { message, path?, code?, expected?, actual? }
PersistBlobStoreError         { bucket, key, message, cause?, retryable? }
PersistBlobHashCollisionError { bucket, key, contentHash, message, expectedByteLength, actualByteLength? }
```

CSV: a `<name>:Blob` column is materialised cell by cell during the dedup stage (multi-value cells split on `;`, each part materialised, URIs re-joined with `;`), and the header is rewritten to `<name>:String` keeping any cardinality suffix. A `String` column on a blob property must hold `s3://` URIs. Details in `csv-bulk-load-workflow.md`.

## 4. Temporal handling

`lambda/utils/neptuneTemporal.ts`, `lambda/utils/graphsonTemporalTransform.ts`, `lambda/utils/lexiconStringFormat.ts`.

### 4.1 Ingest direction (validation and hash canonicalisation)

Applies to lexicon properties with `type: "string"` and `format: "date"` or `"date-time"`; server-managed keys (`created_at`, `id`) and properties without a rule are skipped.

Accepted inputs:

- `date`: a string `YYYY-MM-DD` that is a real calendar date, or `{ "@type": "g:Date", "@value": <finite epoch ms> }`.
- `date-time`: a string matching `YYYY-MM-DDTHH:MM:SS[.fff](Z|±HH:MM)` that `Date.parse` accepts, or `{ "@type": "g:Timestamp", "@value": <finite epoch ms> }`.
- A `g:Timestamp` on a `date` property or `g:Date` on a `date-time` property fails with "Temporal GraphSON wrapper does not match the lexicon format", `expected: "ISO date string or g:Date"` / `"ISO date-time string or g:Timestamp"`.

Canonical form for hashing and for the response echo (`canonicalizeTemporalValueForHash`): strings pass through unchanged; `g:Date` becomes `new Date(ms).toISOString().slice(0, 10)`; `g:Timestamp` becomes `new Date(ms).toISOString()` (always `.fffZ`, UTC). Semantic validation returns the request in this form, so the hash, the response, and the blob transform all see strings.

Caveat: string inputs are not re-normalised. `"2025-03-10T10:15:30Z"`, `"2025-03-10T10:15:30.000Z"`, and `"2025-03-10T12:15:30+02:00"` are three different hash inputs even though they denote one instant, whereas a `g:Timestamp` always canonicalises to the `.000Z` form. Producers that need cross-form identity must send one fixed string form or the wrapper.

### 4.2 Persist rendering

`toPersistenceTemporalValue` runs on `graphForPersist` only, after hashing: a canonical `date` string becomes `{ "@type": "g:Date", "@value": Date.parse(value + "T00:00:00.000Z") }` and a `date-time` string becomes `{ "@type": "g:Timestamp", "@value": Date.parse(value) }`. `graphForResponse` keeps the strings (`test/services/GraphSONPersistTransformService.test.ts`).

`GremlinService.upsertVertex` / `upsertEdge` (`lambda/services/GremlinService.ts`): when any property value (or any item of a multi-valued property) is a `g:Date` / `g:Timestamp`, the write takes the Gremlin script path instead of bytecode. The script is submitted through the traversal source's underlying client and fails with `GremlinExecutionError` if none is exposed. Shape:

```groovy
g.V().hasId("<id>").fold().coalesce(unfold(), addV("<label>").property(id, "<id>").property("filing_date", datetime("2025-03-10")).property("created_at", datetime("2026-01-01T00:00:00Z")))
g.E().hasId("<id>").fold().coalesce(unfold(), V().hasId("<out>").addE("<label>").to(V().hasId("<in>")).property(id, "<id>")...)
```

- `g:Date` renders as `datetime("YYYY-MM-DD")`; `g:Timestamp` renders as `datetime("YYYY-MM-DDTHH:MM:SSZ")` with milliseconds dropped, because the renderer emits whole-second `datetime()` literals. Stored precision is one second while the hash input kept milliseconds, so two events in the same second remain distinct elements even though their stored timestamps are equal. This is a documented storage constraint, not a defect to fix in the renderer.
- Non-temporal values in the same script render as JSON string, finite number, boolean, bigint digits, or `null`; anything else is quoted via `String()`. Multi-valued vertex properties render as repeated `.property(k, v)` calls.
- Because every persisted element carries `created_at` as `g:Timestamp`, ingest writes always take the script path in practice; the bytecode path (`applyProperties`, which unwraps `@value` one level and flattens arrays) remains for callers without temporal values.

CSV bulk load writes temporal columns as `Date` (`YYYY-MM-DD`) and `Datetime` (`YYYY-MM-DDTHH:MM:SSZ`, milliseconds stripped); the workflow adds `created_at:Datetime` (`(single)` on vertices) in the same form.

### 4.3 Read direction

Neptune returns datetimes to the driver as JavaScript `Date` objects. Two serialisers exist:

- `POST /persist/gremlin` results (`GremlinService` result normalisation): `Date` becomes epoch milliseconds (`getTime()`); bigint becomes a decimal string.
- Entity readers in `lambda/utils/gremlinEntity.ts` (used by the search mirror and the derived-index export read path): `Date` becomes an ISO string so downstream strict temporal validation can tell a datetime from an arbitrary number; bigint becomes a number when safe, else a string.

Callers of the Gremlin route that need ISO strings must convert; do not rely on the persisted string form surviving a round trip.

### 4.4 CSV type widening

`widenNeptuneCsvScalarType(current, next)` merges the scalar type of successive values under one property header. Rules apply in this order:

| Case | Result |
| ---- | ------ |
| No current type | `next` |
| Same type | unchanged |
| Either side `Blob` | `String` |
| Either side `String` | `String` |
| Either side `Bool` | `String` |
| `Date` with `Datetime` | `Datetime` |
| `Date` or `Datetime` with any other type | `String` |
| Both integral | wider of `Byte < Short < Int < Long` |
| Either side `Double` (integral or `Float` on the other) | `Double` |
| Either side `Float` (integral on the other) | `Float` |
| Anything else | `String` |

Scalar typing of async payload values when building CSV (`lambda/services/NeptuneCsvService.ts`): `g:Int32` to `Int`, `g:Int64` to `Long`, `g:Float` / `g:Double` to `Double`, `g:Date` to `Date`, `g:Timestamp` to `Datetime`, `g:UUID` to `String`, other typed values to `String` (JSON of `@value`); bare booleans to `Bool`; bare integers to `Int` within 32-bit range else `Long`; other numbers to `Double`; bigint to `Long`; everything else `String`. `Float` therefore only arises from caller-supplied CSV headers.

## 5. Verification

Unit tests (`pnpm test`, filter by file):

- `test/services/GraphSONHash.test.ts`: fixed vectors `8ce0c301...` (vertex) and `f392e19e...` (edge); integer, boolean, string, and integral-double collapse; `g:Int64` versus `csv:Int` parity.
- `test/services/GraphSONPersistTransform.test.ts` and `GraphSONPersistTransform.indexes.test.ts`: meta-property stripping, `created_at` stamping without id drift, vertex-ref endpoints, derived-index key exclusion.
- `test/services/GraphSONPersistTransformService.test.ts`: response ids stable while persisted temporals become `g:Date` / `g:Timestamp`.
- `test/services/GraphSONBlobTransformService.test.ts`: counters, one-level list materialisation, external URI pass-through, no raw text in output.
- `test/services/PersistBlobService.test.ts`: deterministic URI from exact bytes, over-limit rejection before side effects, metadata verification, retry on throttling and exhaustion, non-retryable errors, concurrency cap, memoisation, collision fail-closed.
- `test/services/GremlinService.test.ts`: `datetime()` script rendering for vertex and edge writes.
- `test/services/NeptuneCsvService.test.ts` (type inference, conflict fallback to `String`) and `NeptuneCsvDedupService.test.ts` (Blob column materialisation, URI column pass-through).

There is no dedicated unit test file for `neptuneTemporal.ts`; widening and canonicalisation are covered indirectly through the services above. Add one when changing the widening table.

End-to-end: `test/e2e/persist-blobs.e2e.test.ts` (`pnpm run e2e:*`) exercises inline blobs and external URIs over GraphSON ingest and the CSV workflow against a deployed stack.

When changing any rule in §2 or §4.1, re-run the fixed vectors and add a new vector; a changed vector is an identity migration, not a refactor.

## 6. Design decisions

- **Canonical scalar identity (ADR 0002, `docs/adr/0002-*.md`)**: Persist owns the identity-hash contract. Equivalent scalars collapse across transports before hashing (`2`, `2.0`, `g:Int32 2`, `g:Int64 2`, `csv:Int 2` are one value; typed booleans and strings unwrap), while primitive kind is preserved (`"false"` is not `false`). Consequence: GraphSON ingest and CSV rehash converge on the same ids; payloads whose old ids depended on `g:*` names hash differently after the change; existing duplicates are not merged automatically; parity tests elsewhere must conform to this contract rather than define it.
- **Blob text is never a hash input**: the derived URI is, so identity depends on bucket, prefix, and content hash, and stays stable across replays and paths.
- **Temporal strings, not epochs, are hash inputs**: preserves ids for payloads that pre-date wrapper support (the two fixed vectors) and keeps the response human-readable, at the cost of the string-form caveat in §4.1.
- **Native datetimes in Neptune**: temporal values are stored as `datetime()` so Gremlin range predicates work; this forces the script path for those writes.

## 7. Source map

Paths are relative to the Persist repository.

| Concern | Files |
| ------- | ----- |
| Hash algorithm, canonicalisation, stable stringify | `lambda/services/GraphSONHash.ts` |
| Meta stripping, id remap, endpoint resolution, `created_at` | `lambda/services/GraphSONPersistTransform.ts`, `lambda/services/GraphSONPersistTransformService.ts` |
| Temporal canonicalisation for hashing, blob validation | `lambda/services/GraphSONSemanticValidationService.ts`, `lambda/utils/graphsonTemporalTransform.ts`, `lambda/utils/lexiconStringFormat.ts` |
| Temporal helpers, CSV widening, CSV date strings | `lambda/utils/neptuneTemporal.ts` |
| Blob typed value guards | `lambda/utils/graphsonValue.ts` |
| Blob graph transform | `lambda/services/GraphSONBlobTransformService.ts` |
| Blob S3 runtime, URI derivation, config | `lambda/services/PersistBlobService.ts`, `lambda/config/blob.ts`, `lambda/schemas/errors.ts` |
| Ingest pipelines | `lambda/services/GraphSONService.ts`, `lambda/services/GraphSONAsyncIngestService.ts`, `lambda/services/GraphSONValidationService.ts` |
| Gremlin write paths, `datetime()` scripts, read serialisation | `lambda/services/GremlinService.ts`, `lambda/utils/gremlinScript.ts`, `lambda/utils/gremlinEntity.ts` |
| CSV scalar typing, Blob columns | `lambda/services/NeptuneCsvService.ts`, `lambda/services/NeptuneCsvDedupService.ts`, `lambda/services/NeptuneCsvLexiconValidationService.ts` |
| Blob metrics | `lambda/services/IngestMetricsService.ts` |
| Lexicon property rule schema | `lambda/schemas/lexicon.ts` |
| Decision record | `docs/adr/0002-*.md` |
| Caller-facing summary | `README.md` sections "GraphSON core types" and "Persist Blobs" |
