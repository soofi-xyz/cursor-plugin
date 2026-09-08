# Engineering Conventions, Observability, Testing, CI, and Re-creation Checklist

Code-derived reference for how the Persist service is built, observed, tested, and shipped. It replaces PRD §7.5–7.9 and §9. Every claim below was read from the source tree; where the PRD said something different, the code wins. Paths are relative to the persist repository root.

## 1. Scope

Covers: the Effect-TS runtime and module conventions, the Powertools logging bridge, the metrics catalogue for core ingest and blob metrics, tracing, the long-running command discipline, the repository layout as it exists, the test harness and suite families, CI/CD recipes and tooling, dependency and bundling facts, and an ordered re-creation checklist for the core service.

Does not cover: per-subsystem metric families and behaviours owned by sibling files. Read `derived-index-maintenance.md` (index rebuild and stream-poller metrics), `graphql-read-surface.md` (`graphql_*` metrics), `async-graphson-ingest-and-graph-facts.md` (graph-fact routing), `operations-dashboards-and-alerting.md` (dashboards, alarms, CSV workflow metrics), `opensearch-fts-mirror.md`, `athena-debt-index-export.md`, `athena-index-stream-consumer.md`, `neptune-stream-export.md`, `neptune-recovery-and-persistence-target.md`, `gremlin-explain.md`, `graphql-pii-access-policy.md`, `cross-account-vpc-peering.md`, `neptune-reader-topology.md`, `stacks-configuration-and-iam.md`, and `error-catalogue-and-responses.md`.

## 2. Runtime and module conventions

### 2.1 Effect-TS end to end

- The runtime is Effect-TS throughout. There is no framework-agnostic DI layer: 80 files under `lambda/services/` declare an `Effect.Service` class. The PRD's "framework-light, any DI style" framing does not describe the code.
- Declare a service as `class XxxService extends Effect.Service<XxxService>()("XxxService", { accessors: true, effect: Effect.gen(...) })`. Name every method with `Effect.fn("XxxService.method")` so the span name appears in logs (251 such spans exist).
- Export the production layer as `XxxServiceLive` (usually `XxxService.Default`, sometimes `Layer.effect` over live SDK clients) and, where tests need a double, `XxxServiceTest` or an in-memory `Layer.succeed`.
- Follow the repo guidelines in `AGENTS.md`: effect-first, TypeScript-first, never `null`/`undefined` as a domain value (use `Option`), decode JSON strings with `Schema.decodeUnknown(Schema.parseJson(S), { errors: "all" })`, and convert tagged failures to readable thrown `Error`s at handler boundaries with `toReadableError` / `toReadableHandlerError` from `lambda/utils/errors.ts` (the error `name` is set to the `_tag` so Step Functions retry/catch rules can match it).

### 2.2 Factory functions that still exist

A subset of services also export a pure `make*` factory that closes over an explicit runtime record (clients, clocks, ID generators) so tests can pass in-memory doubles. The audit's count of "four" is an undercount; the code has:

- Async Gremlin family: `makeGremlinAsyncJobStoreService`, `makeGremlinAsyncResultStoreService`, `makeGremlinAsyncSubmitService`, `makeGremlinAsyncStatusService`, `makeGremlinAsyncCancelService`, `makeGremlinAsyncWorkerService`, `makeNeptuneDataApiGremlinService`.
- Ingest and validation: `makeGraphSONAsyncIngestService`, `makeGraphSONVertexRefVerifierService`, `makePersistBlobService`, `makeLexiconSchemaService` plus `makeLexiconSchemaServiceLayer`.
- Read surface: `makeGremlinExplainService`.
- FTS mirror (sibling): `makeFtsDefinitionService`, `makeOpenSearchDocumentTransformService`, `makeOpenSearchMappingService`.

Everything else (index catalog, writer, rebuild, stream poller, checkpoint store, CSV/bulk services, workflow services, GraphQL services) is an `Effect.Service` class wired only through layers.

### 2.3 Layer composition (`lambda/services/index.ts`, ~1,170 lines)

- Compose with `Layer.mergeAll` and `Layer.provide`; never build one global merge for every route. Each router and each worker handler gets its own exported layer so a missing env var for one surface cannot break another. `test/services/router-layer-isolation.test.ts` enforces this (for example `GraphsonRouterLayer` requires `LEXICON_DATA_URI` but not `GREMLIN_ASYNC_JOBS_TABLE_NAME`; `GremlinAsyncRouterLayer` is the reverse; `GremlinExplainRouterLayer` requires only reader-side Neptune config).
- Exported production layers: `GraphsonRouterLayer` (via `makeGraphsonRouterLayer(lexiconDataUri?)`), `GremlinRouterLayer`, `GremlinExplainRouterLayer`, `GremlinAsyncRouterLayer`, `GraphQlHandlerLayer`, `GraphFactEventLayer`, `GremlinAsyncWorkerLayer`, `GremlinAsyncValidateLayer`, `GremlinAsyncFargateWorkerLayer`, `IndexRebuildLayer`, `IndexStreamPollerLayer`, `IndexDiscoveryLayer`, `IndexStreamLagProbeLayer`, `WorkflowStartLayer`, `WorkflowValidationLayer` (via `makeWorkflowValidationLayer`), `WorkflowItemStageLayer` (via `makeWorkflowItemStageLayer`), `WorkflowItemDispatchLayer`, `WorkflowItemStatusLayer`, `WorkflowIndexCatchupLayer`, `CsvWorkflowMetricsLayer`, `AsyncBulkWorkerRuntimeLayer`, `AsyncBulkAggregateWorkerRuntimeLayer`, `GremlinAsyncWorkerRuntimeLayer`, plus the legacy `AppLayer` / `WorkerLayer` aggregates. Sibling subsystems export their own (`OpenSearch*Layer`, `DebtIndexExportRunLayer`, `DebtKeyListBuilderLayer`, `AthenaIndexStreamSchemaLayer`).
- `TestLayer` mirrors `AppLayer` with `GremlinClientTest`, `GremlinTxTest`, in-memory checkpoint stores, and a fixture lexicon.
- Typed aliases (`GraphsonRouteLayer`, `GremlinAsyncRouteLayer`, `WorkerServiceLayer`, …) pin each layer's required services.

### 2.4 Errors

- Every domain error is a `Schema.TaggedError` class in `lambda/schemas/errors.ts` (~90 classes across ~850 lines). The discriminator is `_tag` only; there is no parallel `type` field on the classes. `isTaggedError` in `lambda/utils/errors.ts` narrows on `_tag`.
- Routers `switch` on `_tag` to sanitise and map errors; the HTTP envelope and status mapping live in `lambda/http/responses.ts` (see `error-catalogue-and-responses.md`).

### 2.5 HTTP routers and runtimes

- The API Lambda uses the Powertools HTTP router: `import { Router } from "@aws-lambda-powertools/event-handler/http"`, Express-style `:param` paths, `app.includeRouter(router, { prefix: "/persist" })`. `lambda/router.ts` builds `app = new Router({ logger: powertoolsLogger })`, installs the `httpApiRequestContext` middleware, and mounts `graphsonRouter`, `gremlinRouter`, `gremlinAsyncRouter`.
- Runtime strategy differs per router and is deliberate:
  - `lambda/routes/graphson.router.ts` creates one `ManagedRuntime.make(layer)` per router instance and provides it per request (`Effect.provide(runtime)`), because `LexiconSchemaService` caches the lexicon with a 300 s TTL. `/persist/validate` with a candidate lexicon URI builds a one-off `ManagedRuntime` from `makeGraphsonRouterLayer(uri)` and disposes it in `finally`.
  - `lambda/routes/gremlin.router.ts` and `lambda/routes/gremlin-async.router.ts` use plain `Effect.provide(layer)` per request.
  - `lambda/graphql/handler.ts` is a separate Lambda entrypoint with its own module-level `ManagedRuntime.make(GraphQlHandlerLayer)`; it dispatches `GET …/persist/graphql/schema` and `POST` itself without the Powertools router.
- Worker and workflow handlers follow one shape: `createXxxHandler(runtime = defaultRuntime)` where `defaultRuntime` binds the service call to its layer and `runPromise`; tests inject a fake runtime.

### 2.6 Logging bridge (`lambda/logging/`)

- `powertools.ts`: `new Logger({ serviceName: "persist" })`. The constructor option wins over `POWERTOOLS_SERVICE_NAME`, so every function's logger reports `service: "persist"` regardless of the per-function env var; log level and sampling still come from `POWERTOOLS_LOG_LEVEL` (stacks set `INFO`).
- `effect-logger.ts`: `powertoolsEffectLogger = Logger.make(...)` forwards each Effect log entry to the Powertools logger by level, attaching `effect_message`, `effect_log_level`, `effect_fiber_id`, `effect_timestamp`, `effect_annotations`, `effect_spans`, and `effect_cause` (pretty-printed only when non-empty). `PowertoolsLoggerLayer = Logger.replace(Logger.defaultLogger, powertoolsEffectLogger)`.
- `runtime.ts`: `withPowertoolsLogger` sets minimum level `Trace` and provides the layer; `runPromise` / `runFork` wrap `Effect.runPromise` / `Effect.runFork`. Use these instead of bare `Effect.runPromise` in every entrypoint.

## 3. Observability primitives

### 3.1 Structured logging conventions

- Bind the Lambda context once per invocation (`powertoolsLogger.addContext(context)`), then `appendKeys` a request-scoped key named after the function and reset in `finally` with `resetKeys()`. Keys in use: `batchRequestId` (async bulk and Gremlin async workers), `workflowExecutionId` (workflow start, cost predictor), `workflowValidationRequestId`, `workflowItemRequestId` (item stage, item dispatch), `workflowItemStatusRequestId`, `workflowIndexCatchupRequestId`, `csvWorkflowMetricsRequestId`, `indexRebuildRequestId`, `indexRebuildRangeRequestId`, `indexRebuildShardRequestId`, `indexRebuildListBatchesRequestId`, `indexRebuildFinalizeRequestId`, `indexRebuildFailRequestId`, `indexStreamPollerRequestId`, `indexStreamLagProbeRequestId`, `indexDiscoveryRequestId`, and for the EventBridge handler `graphFactEventId`, `graphFactSource`, `graphFactType`.
- The API Lambda does not append keys itself; `lambda/http/request-context.ts` middleware appends `method`, `path`, `requestId` from the HTTP API event and `removeKeys` them in `finally`.
- Inside services, name spans `ServiceName.method` via `Effect.fn` and add `Effect.annotateLogs({...})` for identifiers (`requestId`, `queryId`, `executionArn`, item context). Emit start/progress/end logs with `Effect.log("...", { ...fields })`; the bridge lifts them into Powertools JSON.
- Never log raw `persist:Blob` text. Blob logs and metrics carry `contentHash`, byte length, and S3 URI only (`GraphSONBlobTransformService` returns counters without raw text; the test asserts it).

### 3.2 Core metrics catalogue

Namespace is `persist` everywhere (`POWERTOOLS_METRICS_NAMESPACE` defaults to it). Metrics clients are separate from the logger and do read the per-function service name where noted.

| Metric | Unit | Dimensions | Producer | Flushed by |
| --- | --- | --- | --- | --- |
| `vertices_ingested` | Count | `ingest_method`, optional `phase` (`vertices`\|`edges`) | `IngestMetricsService.recordIngestCounts` | `flushIngestMetrics()` |
| `edges_ingested` | Count | same | same | same |
| `graph_facts_accepted` | Count | `ingest_method` ∈ `eventbridge_graph_fact`\|`eventbridge_graph_fact_sync` | `recordGraphFactAccepted` | same |
| `graph_facts_skipped_missing_ref` | Count | none | `recordGraphFactSkippedMissingRef` | same |
| `blobs_materialized` | Count | `ingest_method`, optional `phase` | `recordBlobMaterialization` | same |
| `blob_bytes_materialized` | Bytes | same | same | same |
| `blob_objects_created` | Count | same | same | same |
| `blob_objects_reused` | Count | same | same | same |

- `ingest_method` values: `sync_ingest`, `async_ingest`, `eventbridge_graph_fact`, `eventbridge_graph_fact_sync`, `async_csv_upload`.
- `IngestMetricsService` buffers in module-level maps and publishes one EMF blob per dimension set in `flushIngestMetrics()`; `resetIngestMetrics()` clears metrics, dimensions, metadata, and buffers. Call `resetIngestMetrics()` at the top of the handler and `flushIngestMetrics()` in `finally`. Producers: `lambda/handler.ts`, `graph-fact-event`, `async-bulk-worker`, `async-bulk-aggregate-worker`, `workflow-item-status`, `workflow-item-status-simple`.
- Service dimension for these metrics is `POWERTOOLS_SERVICE_NAME ?? "persist"`, so the same metric name splits by function (`persist`, `persist-graph-fact`, `persist-async-worker`, `persist-async-aggregate-worker`, `persist-workflow-item-status`, …).
- Other families and where they are documented: `graphql_requests`, `graphql_request_duration_ms`, `graphql_complexity_rejections`, `graphql_field_resolutions`, `graphql_field_failures` (`GraphQlMetricsService`, service `persist-graphql`) in `graphql-read-surface.md`; `index_rebuild_candidate_elements`, `index_rebuild_owner_candidates`, `index_rebuild_properties_written`, `index_rebuild_properties_removed` (service pinned to `persist-index-rebuild`) and the lag-probe pair `IndexStreamOldestUnprocessedRecordAgeSeconds` / `IndexStreamCommitBacklog` in `derived-index-maintenance.md`; `CostPredicted`, `CsvWorkflowVerticesInserted`, `CsvWorkflowEdgesInserted`, and the stream-export metrics in `operations-dashboards-and-alerting.md`. The stream poller itself emits no metrics; the PRD's `index_stream_*` counters do not exist.

### 3.3 Tracing

X-Ray is enabled on the Step Functions state machines (`tracingEnabled: true` in `lib/persist-stack.ts` for the three core workflows and in the search and export stacks). Lambda functions in the core stack do not set `tracing: Tracing.ACTIVE`; only the export stack does for one function. There is no Powertools `Tracer` in the code.

### 3.4 Long-running command discipline

- Wrap every external call in `Effect.tryPromise` and bound it with `Effect.timeoutFail({ duration, onTimeout: () => new TaggedTimeoutError(...) })`. Thirteen services do this (Neptune Data API execute/status/cancel, bulk loader, cluster-endpoint provider, lexicon fetch, vertex-ref verification, blob store, stream poller core, cost predictor, workflow CSV validation, DynamoDB resolver, resolution-map load, explain, and the sibling OpenSearch stream poller).
- In polling loops log before and after each poll with elapsed counters (`NeptuneBulkLoaderService` logs "Waiting…", "…progress", "…completed"); the stream poller core (`runNeptuneStreamPoll`) enforces a `NEPTUNE_STREAM_DEADLINE_SAFETY_MARGIN_MS = 5000` in-flight deadline against the Lambda remaining time.
- For ordered parallel work use `Stream.fromAsyncIterable(...).pipe(Stream.mapEffect(..., { concurrency }))`.

## 4. Repository layout

```text
persist/
├── bin/app.ts                      # CDK app: NeptuneStack, PersistSearchStack, PersistStack, DebtIndexExportStack,
│                                   #   NeptuneRecoveryStack (prod), two dashboard stacks
├── lib/                            # persist-stack, neptune-stack, persist-search-stack, debt-index-export-stack,
│                                   #   neptune-recovery-stack, indexing-dashboard-stack, csv-ingest-dashboard-stack,
│                                   #   neptune-configuration, neptune-cluster-endpoint, deployment-environment,
│                                   #   debt-index-export-trigger, container-asset-excludes, glue-package-asset
├── lambda/
│   ├── handler.ts                  # REST API entrypoint (resets/flushes ingest metrics, resolves the router)
│   ├── router.ts                   # Powertools Router + request-context middleware + three routers under /persist
│   ├── routes/                     # graphson.router.ts, gremlin.router.ts, gremlin-async.router.ts
│   ├── graphql/handler.ts          # GraphQL Lambda entrypoint
│   ├── api/definitions.ts          # apiRoutes: schema-typed route table driving OpenAPI
│   ├── http/                       # request-context.ts, responses.ts
│   ├── logging/                    # powertools.ts, effect-logger.ts, runtime.ts
│   ├── config/                     # neptune.ts, blob.ts, opensearch.ts, debt-index-export.ts, opensearch-fts-definition.json
│   ├── schemas/                    # errors, http, gremlin, gremlin-async, async-bulk, workflow, lexicon, derived-index,
│   │                               #   graphql (single file), opensearch-fts, debt-index-export, debt-key-list, index.ts,
│   │                               #   graphson/{types,vertex,vertex-ref,edge,ingest,validate,index}, eventbridge/graph-fact
│   ├── services/                   # ~115 service files incl. index.ts + neptune-stream/{PollerCore,CheckpointedActions,Types}
│   │                               #   + AthenaIndexStreamStand/ (sibling)
│   ├── utils/                      # csv, errors, graphsonTemporalTransform, graphsonValue, gremlinEntity, gremlinScript,
│   │                               #   lexiconStringFormat, neptuneTemporal, s3
│   ├── types/gremlin-aws-sigv4.d.ts
│   ├── fargate/                    # gremlin-async-fargate-entrypoint.ts + Dockerfile; debt-key-list-entrypoint.ts + DebtKeyList.Dockerfile
│   └── <handler-dir>/handler.ts    # one directory per Lambda (see §7 step 9); a few carry a sibling metrics.ts
├── glue/                           # Python 3.11 Glue jobs (config/, jobs/, tests/) — see neptune-stream-export.md
├── config/                         # graphql-resolution-map.json, stream-export-tables.json (rendered)
├── gremlin/tinkergraph-empty.properties
├── scripts/                        # run-tests.sh, start-gremlin-test.sh, generate-openapi.ts, verify-debt-index-export-columns.ts
├── docs/                           # openapi.json (generated), adr/0001–0008, subsystem runbooks
├── test/                           # see §5
├── src/Program.ts                  # template leftover ("Hello, World!"); not part of the service
├── setupTests.ts, vitest.config.ts, justfile, pyproject.toml, eslint.config.mjs, .prettierrc.cjs, .husky/pre-commit
└── tsconfig.{base,app,src,test,build}.json, tsconfig.json (project references)
```

Test tree: `test/api/openapi.test.ts`; `test/cdk/` (seven stack tests: `persist-stack`, `neptune-stack`, `persist-search-stack`, `debt-index-export-stack`, `neptune-recovery-stack`, `indexing-dashboard-stack`, `csv-ingest-dashboard-stack`, plus `stack-templates.ts` and `synthesize-stack-template.cli.ts`, which synthesise in a child process); `test/e2e/` (five `*.e2e.test.ts`); `test/handlers/` (15 handler tests); `test/helpers/` (`TestError.ts`, `AthenaColumns.ts`); `test/http/responses.test.ts`; `test/routes/` (three router tests); `test/schemas/` (errors, eventbridge, graphson, gremlin, gremlin-async, lexicon); `test/services/` (96 suites); `test/utils/` (`errors`, `s3`, `debt-index-export-trigger`); root-level `test/container-assets.test.ts`, `test/glue-package-asset.test.ts`, `test/workflow-item-status-simple.test.ts`, and the template `test/Dummy.test.ts`.

## 5. Testing strategy

### 5.1 Harness

- Vitest 3 with `@effect/vitest`. `vitest.config.ts` includes `./test/**/*.test.ts`, enables `globals`, registers `setupTests.ts`, and keeps a template alias for `@template/basic`.
- `setupTests.ts` does exactly one thing: `it.addEqualityTesters()` from `@effect/vitest` (structural equality for Effect data types). It does not reset or flush metrics; the PRD claim is wrong. Suites that touch metrics call `resetIngestMetrics()` / `resetGraphQlMetrics()` / rebuild-metrics reset themselves in `beforeEach` (eight files, for example `IngestMetricsService`, `GraphSONService`, `GraphFactEventService`, `AsyncBulkWorkerService`, `IndexRebuildMetricsService`).
- 120 test files import from `@effect/vitest`, 26 from plain `vitest`; 10 use `it.effect`. Most suites run Effects through `runPromise` from `lambda/logging/runtime.ts` with hand-built `Layer.succeed` stubs or the `make*` factories with in-memory runtimes.
- `test/helpers/TestError.ts` is a `Schema.TaggedError` used as a generic failure in doubles.

### 5.2 Real Gremlin Server

- Traversal-backed suites use `GremlinClientTest` (plain `ws://` to `GREMLIN_TEST_HOST`/`GREMLIN_TEST_PORT`, defaults `localhost:8182`) and `GremlinTxTest`, which bypasses sessions and runs on `g`. Ten files depend on it: `GremlinClient`, `GremlinService`, `GremlinTx`, `GremlinQuery`, `GraphSONService`, `IndexWriterService`, `IndexRebuildService.integration`, `layers`, and the `graphson` / `gremlin` router tests.
- `gremlin/tinkergraph-empty.properties` enables string IDs so `property(T.id, "...")` matches Neptune.
- `scripts/start-gremlin-test.sh` is the manual helper: it starts `tinkerpop/gremlin-server` as container `gremlin-test`, by default on host networking with a rewritten `gremlin-server.yaml` (`host: 0.0.0.0`) staged under `.tmp/`; set `GREMLIN_TEST_USE_HOST_NETWORK=0` for port mapping. Stop with `docker rm -f gremlin-test`.

### 5.3 `just test` phases (`scripts/run-tests.sh`)

1. Require `uv` (exit 1 with a hint to run `just setup`), then run `uv run pytest` once per `glue/tests/test_*.py` file (29 files) so Spark JVM state does not accumulate.
2. `corepack prepare pnpm@10.14.0 --activate`, then `pnpm exec vitest run test/cdk/persist-stack.test.ts test/cdk/debt-index-export-stack.test.ts` — the CDK contract tests that guard IAM scoping and job arguments, named one by one because synthesising every stack at once is slow.
3. Remove any stale `gremlin-test` container, start one via `start-gremlin-test.sh`, wait for `1+1` to succeed over the driver (60 s default), then `pnpm exec vitest run --exclude test/integration/** --exclude test/e2e/** --exclude test/cdk/**`. The container is removed on exit.

`pnpm test` alone runs vitest with `GREMLIN_TEST_HOST`/`PORT` set and excludes only `test/integration/**` and `test/e2e/**`; it assumes a server is already running.

### 5.4 Suite families and what they cover

- Schemas: GraphSON typed values and vertex/edge shapes, ingest payload wrapper, vertex refs, EventBridge `GraphFactProduced`, Gremlin sync/async request schemas, lexicon decoding, lexicon-aware error shapes.
- GraphSON ingest and identity: `GraphSONHash` (seven fixed-vector cases proving integral/boolean/string canonicalisation and stable temporal fixtures; no property-based or fuzz library is used), `GraphSONPersistTransform` (+ `.indexes`), `GraphSONSemanticValidationService` (+ `.indexes`), `GraphSONValidationService`, `GraphSONVertexRefVerifierService` (no-refs no-op, single lookup for all refs, one `MissingVertexRef` aggregating malformed/missing/mismatched), `GraphSONService` (against the real server), `GraphSONAsyncIngestService`, `GraphSONBlobTransformService`, `PersistBlobService` (deterministic URIs from exact bytes, byte-limit rejection before S3, reuse on matching metadata, `SlowDown` retry and exhaustion, bounded concurrency).
- EventBridge: `GraphFactEventService` (small facts → sync, large → async with metadata, ref-bearing forced sync, deterministic missing refs skipped, malformed events fail before side effects) and the handler test.
- Gremlin: `GremlinClient` (pool sizing and reuse, missing config), `GremlinRetry`, `GremlinQueryPolicy`, `GremlinFtsPolicyService`, `GremlinTx`, `GremlinExplainService`, plus router tests for the response envelope.
- Async Gremlin: job store, result store, submit, status, cancel, worker, `NeptuneDataApiGremlinService`, and `GremlinAsyncFargateWorker` (19 cases: success/timeout/failure paths, heartbeats, terminal-state races, callback reconciliation).
- CSV and bulk: `NeptuneCsvService`, `NeptuneCsvDedupService`, lexicon and workflow validation, `NeptuneBulkStageService`, `NeptuneBulkLoaderService`, both async bulk workers, `WorkflowCostPredictorService`, `WorkflowInputService`, `WorkflowItemDispatch/Stage/StatusService`, `WorkflowLock`, `WorkflowIndexCatchupService`.
- Derived indexes: `IndexCatalogService` (46 cases: trigger conditions, fingerprints, owner grouping), `IndexWriterService` (23, on the real server), `IndexStreamPollerService` (59: fast-forward vs analysis paths for ADD/REMOVE pages, dedup of trigger ids, checkpoint planning), `IndexRebuildService` (34) plus `.integration`, `IndexRebuildMetricsService`, `IndexDefinitionStateStoreService`, `IndexDiscoveryService`, `IndexStreamLagProbeService`, `NeptuneStreamPollerCore`, `NeptuneStreamCheckpointedActions`.
- GraphQL: `GraphQlSchemaService` (one stable-SDL test across scalar, enum, array, blob, index, and relationship fields), `GraphQlGraphResolverService` (batched relationship/connection results stay ordered by parent; key propagation), `GraphQlInterproseResolverService`, `GraphQlPiiAccessPolicyService`, `graphqlQueryGuards` (depth through fragments, complexity, cyclic fragments fail closed).
- Composition: `layers.test.ts` and `router-layer-isolation.test.ts`.
- Handlers: 15 `test/handlers/*.handler.test.ts` files inject fake runtimes and assert logging keys, batch failure shaping, and thrown-error names.
- Cross-cutting: `test/api/openapi.test.ts` (routes present, error envelope shape `ok:false` + `error.{type,message}`), `test/http/responses.test.ts`, `test/utils/*`, `test/container-assets.test.ts`, `test/glue-package-asset.test.ts`.

### 5.5 End-to-end suites (`test/e2e/*.e2e.test.ts`)

- Files: `persist-api`, `persist-blobs`, `persist-graphql`, `raw-stream-capture` (all in `pnpm e2e`), and `csv-workflow-metrics` (run alone via `pnpm e2e:csv-metrics`; it starts a real bulk-load workflow and takes tens of minutes). Individual scripts: `pnpm e2e:persist-api`, `e2e:persist-blobs`, `e2e:persist-graphql`, `e2e:raw-stream`. `pnpm test:integration` is an alias for `e2e:persist-api`.
- Gate: `shouldRun = Boolean(AWS_PROFILE || AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY)`; without credentials the suite is `describe.skip`. Run with `AWS_PROFILE=<selected-profile> pnpm run e2e:persist-api` and set `AWS_REGION` explicitly rather than relying on the suite's baked-in default.
- The API base URL is read from SSM parameter `persist-api-url` (override name with `PERSIST_API_URL_PARAMETER`); requests are SigV4-signed with `@smithy/signature-v4`. The CSV-metrics suite additionally reads `persist-neptune-csv-workflow-arn` and `persist-csv-workflow-metrics-log-group`.
- Excluded from `pnpm test`, `just test`, and CI.

### 5.6 PRD-claimed tests that do not exist

- `test/integration/persist-api.test.ts` and any `test/integration/` directory.
- Metrics reset/flush in `setupTests.ts`.
- Snapshot-tested or "byte-identical across two loads" SDL generation; mutation/subscription rejection tests; partial-failure `extensions.source` nulling tests; a "one batched call per source per level" assertion; Interprose cache/throttle tests with a mock client; a shared `SourceResolver` contract suite.
- Fuzz or property-based hashing tests (no `fast-check`; `@faker-js/faker` is present in devDependencies but hashing uses fixed vectors).
- Tests for `index_stream_*` poller metrics (the metrics themselves do not exist).
- Docker orchestration inside `just test` by `start-gremlin-test.sh` alone: the orchestration lives in `run-tests.sh`.

## 6. CI/CD and tooling

### 6.1 Workflows

- `.github/workflows/ci-cd-dev.yml` (pull requests to `main`, `TARGET_ENV=dev`) and `ci-cd-prod.yml` (push to `main`, `TARGET_ENV=prod`) call organisation-level reusable workflows with `id-token: write` and pass an `env-vars` block (`TARGET_ENV`, `CDK_BOOTSTRAP_QUALIFIER`, `NEPTUNE_PORTAL_READER[_INSTANCE_CLASS]`, `NEPTUNE_AGENCY_READER[_INSTANCE_CLASS]` (dedicated-reader role names per `neptune-reader-topology.md`), `ATHENA_INDEX_STREAM_SCHEDULE_ENABLED`). The reusable workflow runs only `justfile` recipes and takes no cdk arguments; stage-specific knobs are therefore workflow-file edits.
- `release.yml` and `snapshot.yml` are Effect template leftovers guarded by `if: github.repository_owner == 'Effect-Ts'`; they never run here. `.github/actions/setup` belongs to them.

### 6.2 justfile recipes

| Recipe | Runs |
| --- | --- |
| `setup` | `corepack enable`, `corepack prepare pnpm@10.14.0 --activate`, `pnpm install --frozen-lockfile`, `pnpm rebuild esbuild unrs-resolver`, install pinned `uv` if missing (appends to `GITHUB_PATH` on CI), `uv sync --group dev` |
| `format` / `format-fix` | `pnpm format:check` + `uv run ruff format --check glue` (fix variants write) |
| `lint` / `lint-fix` | `pnpm lint` + `uv run ruff check glue` |
| `type-check` | `pnpm check` + `uv run basedpyright` |
| `render-tables-config` | `uv run python -m glue.config.render` (writes `config/stream-export-tables.json` and `glue/config/stream-export-tables.json`; both checked in and compared byte for byte) |
| `test` | `./scripts/run-tests.sh` (§5.3) |
| `e2e`, `e2e-persist-api`, `e2e-persist-graphql` | the matching `pnpm e2e*` scripts |
| `build` | `pnpm exec cdk synth --strict --context stage=${TARGET_ENV:-dev} --context graphFactEventBusName=…` plus optional `--context` flags forwarded only when the env var is set (bootstrap qualifier, dedicated readers, `neptuneReaderEndpointMode`, `workflowRouteSizeBasis`, `debtIndexExportTriggerEnabled`, `athenaIndexStreamScheduleEnabled`) |
| `deploy` | `pnpm exec cdk deploy --all --require-approval never` with the same context flags |

There are no `just check`, `just cdk:synth`, or `just cdk:deploy` recipes; `pnpm cdk:synth` / `cdk:deploy` / `cdk:destroy` exist as package scripts.

### 6.3 Type checking, lint, format, hooks

- `pnpm check` = `tsc -b tsconfig.json` (project references: `tsconfig.app.json` for `bin`, `lib`, `lambda`; `tsconfig.src.json`; `tsconfig.test.json` for `test`, `lambda`, `lib`, `scripts`) followed by `effect-language-service diagnostics --project tsconfig.json --severity error,warning --strict`. `tsconfig.base.json` is strict with `exactOptionalPropertyTypes`, `NodeNext`, `ES2022`, and the `@effect/language-service` plugin.
- `pnpm lint` = ESLint 9 flat config (`eslint.config.mjs`) with `@typescript-eslint`, `import`, `simple-import-sort` (disabled in favour of Prettier's import sort), `sort-destructure-keys`, `codegen`; formatting is left to Prettier.
- `pnpm format` = Prettier 3 with `@trivago/prettier-plugin-sort-imports` (`printWidth: 120`, no semicolons, double quotes, `trailingComma: none`).
- Husky `pre-commit` runs `pnpm exec lint-staged`; `lint-staged` is `"*": "prettier --ignore-unknown --write"` — Prettier only, no ESLint on commit.
- Python side: `pyproject.toml` pins `requires-python >=3.11,<3.12` (Glue 5.0), dev group `basedpyright`, `boto3`, `pyspark 3.5`, `pytest`, `ruff`; `basedpyright` is scoped to `glue/`.

### 6.4 OpenAPI generator

- `lambda/api/definitions.ts` exports `apiRoutes`, a typed table of `{ method, path, summary, description?, request?, parameters?, responses: { status: Schema } }` built from the Effect schemas in `lambda/schemas/`.
- `scripts/generate-openapi.ts` converts each schema with `JSONSchema.make`, strips `$schema`, rejects duplicate routes, and writes OpenAPI 3.1.0 to `docs/openapi.json` with `info.version` from `package.json`. Run `pnpm api:spec` (`tsx scripts/generate-openapi.ts`). The generated file is checked in; `test/api/openapi.test.ts` calls `buildOpenApi()` directly and does not diff against the checked-in file.

### 6.5 Dependencies that matter

- Runtime: `effect`, `@aws-lambda-powertools/{event-handler,logger,metrics}`, `@aws-sdk/{client-neptunedata,client-neptune,client-s3,client-sfn,client-sqs,client-dynamodb,client-secrets-manager,client-ssm,client-athena,client-cloudwatch,client-cloudwatch-logs,credential-providers}`, `@smithy/{config-resolver,node-config-provider}`, `gremlin`, `gremlin-aws-sigv4`, `csv-parse`, `graphql`, `graphql-yoga`, `dataloader`, `hyparquet`, `hyparquet-writer`.
- Dev-placed but imported by bundled runtime code: `@smithy/hash-node`, `@smithy/protocol-http`, `@smithy/signature-v4` (esbuild inlines them). Other dev: `aws-cdk`, `aws-cdk-lib`, `constructs`, `esbuild`, `tsx`, `typescript`, `vitest`, `@effect/vitest`, `@effect/language-service`, `@types/{aws-lambda,gremlin,node}`, `husky`, `lint-staged`, `prettier`, ESLint packages, Babel and `@changesets/*` template leftovers.
- `packageManager: pnpm@10.14.0`; `pnpm.onlyBuiltDependencies: [esbuild, unrs-resolver]`. There is no `pnpm-workspace.yaml` (single package) and no `engines` field; Node 24 is the target everywhere (Lambda `NODEJS_24_X`, esbuild `node24`, Docker `node:24-slim`).
- `package.json` is still named `@template/basic` with `version 0.0.0`; OpenAPI inherits that version.

### 6.6 Bundling

- Every Lambda is a `NodejsFunction` with `{ banner: esmRequireBanner, minify: true, sourceMap: true, target: "node24", format: OutputFormat.ESM, mainFields: ["module","main"], externalModules: ["gremlin","gremlin-aws-sigv4"], nodeModules: ["gremlin","gremlin-aws-sigv4"], esbuildArgs: { "--conditions": "module" } }`. The banner injects `createRequire(import.meta.url)` so CommonJS graph libraries load inside ESM bundles; `NODE_OPTIONS=--enable-source-maps` is set in the environment.
- 27 distinct entries are wired as `NodejsFunction`s in `lib/persist-stack.ts`: the root `lambda/handler.ts`, `lambda/graphql/handler.ts`, and 25 `lambda/<dir>/handler.ts` files.
- Fargate images are built from the repository root with `ecr_assets.DockerImageAsset` and `exclude: CONTAINER_ASSET_EXCLUDES` (`lib/container-asset-excludes.ts`, mirrored in `.dockerignore`) so `node_modules`, `.venv`, `cdk.out`, `test`, caches, and `*.tsbuildinfo` never enter the build context or the asset hash. `lambda/fargate/Dockerfile` installs with pnpm, bundles `gremlin-async-fargate-entrypoint.ts` with esbuild (`--format=esm`, same banner), and runs `node index.mjs`.
- `lib/glue-package-asset.ts` stages the Glue package from the root as an allow-list (`*`, `.*` excluded, `!glue`, `!glue/**` re-included, tests and bytecode excluded) — see `neptune-stream-export.md`.

## 7. Re-creation checklist (core service, build order)

1. Skeleton: `package.json` (`type: module`, `packageManager: pnpm@10.14.0`), `tsconfig.{base,app,src,test,build}.json` + `tsconfig.json` references, `eslint.config.mjs`, `.prettierrc.cjs`, `.husky/pre-commit` + `lint-staged`, `vitest.config.ts`, `setupTests.ts`, `justfile`, `pyproject.toml` (only if the Glue jobs are in scope; otherwise drop the `uv` steps from `setup`, `format`, `lint`, `type-check`, and `run-tests.sh`).
2. Dependencies per §6.5. Install `effect` first; every module below is written against it.
3. Logging: `lambda/logging/{powertools,effect-logger,runtime}.ts` and `lambda/utils/errors.ts`.
4. Schemas: `lambda/schemas/errors.ts`, `http.ts`, `graphson/{types,vertex,vertex-ref,edge,ingest,validate,index}.ts`, `eventbridge/graph-fact.ts`, `gremlin.ts`, `gremlin-async.ts`, `async-bulk.ts`, `workflow.ts`, `lexicon.ts`, `derived-index.ts`, `graphql.ts`, and the `index.ts` barrel.
5. Utils: `lambda/utils/{csv,graphsonTemporalTransform,graphsonValue,gremlinEntity,gremlinScript,lexiconStringFormat,neptuneTemporal,s3}.ts`; `lambda/types/gremlin-aws-sigv4.d.ts`.
6. Config: `lambda/config/neptune.ts`, `lambda/config/blob.ts` (required vars fail at layer construction through `Config`; see `stacks-configuration-and-iam.md` for the variable table).
7. Services in `lambda/services/` in dependency order:
   - Gremlin core: `GremlinClient`, `GremlinRetry`, `GremlinTx`, `GremlinQueryPolicy`, `GremlinFtsPolicyService`, `GremlinService`, `GremlinExplainService`.
   - Lexicon and metrics: `LexiconSchemaService`, `IngestMetricsService`.
   - GraphSON: `GraphSONHash`, `GraphSONDecode`, `GraphSONPersistTransform`, `GraphSONPersistTransformService`, `GraphSONSemanticValidationService`, `GraphSONValidationService`, `GraphSONVertexRefVerifierService`, `PersistBlobService`, `GraphSONBlobTransformService`, `GraphSONService`, `GraphSONAsyncIngestService`, `GraphFactEventService`.
   - Async Gremlin: `GremlinAsyncJobStoreService`, `GremlinAsyncResultStoreService`, `GremlinAsyncSubmitService`, `GremlinAsyncStatusService`, `GremlinAsyncCancelService`, `NeptuneDataApiGremlinService`, `GremlinAsyncWorkerService`.
   - CSV and bulk: `NeptuneCsvService`, `NeptuneCsvDedupService`, `NeptuneCsvLexiconValidationService`, `NeptuneCsvWorkflowValidationService`, `NeptuneBulkStageService`, `NeptuneBulkLoaderService`, `AsyncIngestPayloadService`, `AsyncFilteredBatchEnqueueService`, `AsyncBulkWorkerService`, `AsyncBulkAggregateWorkerService`, `StepFunctionsCallbackService`.
   - Workflow: `WorkflowInputService`, `WorkflowCostPredictorService`, `WorkflowItemDispatchService`, `WorkflowItemStageService`, `WorkflowItemStatusService`, `WorkflowSummaryService`, `WorkflowLock`, `WorkflowIndexCatchupService`, `CsvWorkflowMetricsService`.
   - Derived indexes: `neptune-stream/{NeptuneStreamTypes,NeptuneStreamPollerCore,NeptuneStreamCheckpointedActions}`, `IndexCatalogService`, `IndexValueValidationService`, `IndexWriterService`, `IndexCheckpointStoreService`, `IndexDefinitionStateStoreService`, `IndexStreamClientService`, `IndexStreamPollerService`, `IndexStreamLagProbeService`, `IndexDiscoveryService`, `IndexRebuildService`, `IndexRebuildMetricsService`, `NeptuneClusterEndpointService`.
   - GraphQL: `GraphQlSchemaService`, `GraphQlResolutionMapService`, `GraphQlSourceResolver`, `GraphQlSourceResolverRegistryService`, `GraphQlGraphResolverService`, `GraphQlDynamoDbResolverService`, `InterproseClientService`, `GraphQlInterproseResolverService`, `GraphQlPiiAccessPolicyService`, `graphqlQueryGuards`, `GraphQlExecutorService`, `GraphQlMetricsService`.
   - Composition: `lambda/services/index.ts` with the per-router and per-handler layers listed in §2.3 and `TestLayer`.
8. HTTP layer: `lambda/http/{request-context,responses}.ts`, `lambda/routes/{graphson,gremlin,gremlin-async}.router.ts`, `lambda/router.ts`, `lambda/handler.ts`, `lambda/graphql/handler.ts`.
9. Handler directories (`lambda/<dir>/handler.ts`): `graph-fact-event`, `async-bulk-worker`, `async-bulk-aggregate-worker`, `gremlin-async-validate`, `gremlin-async-worker`, `gremlin-async-failure`, `workflow-start`, `workflow-cost-predictor`, `workflow-validate`, `workflow-item-dispatch`, `workflow-item-stage`, `workflow-item-status`, `workflow-item-status-simple`, `workflow-index-catchup`, `index-rebuild-prepare`, `index-rebuild-range-enumerator`, `index-rebuild-list-batches`, `index-rebuild-shard-worker`, `index-rebuild-finalize`, `index-rebuild-fail`, `index-stream-poller`, `index-stream-lag-probe` (+ `metrics.ts`), `index-discovery-poller`, `csv-workflow-metrics` (+ `metrics.ts`), `pagerduty-alert`, `neptune-cluster-endpoint`; plus `lambda/fargate/gremlin-async-fargate-entrypoint.ts` and `lambda/fargate/Dockerfile`.
   Present in the repo but invoked by nothing (deployed and granted, no trigger or state references them; do not re-create): `gremlin-async-worker` with `GremlinAsyncWorkerService`, `workflow-item-status` with `WorkflowItemStatusService` (`workflow-item-status-simple` is the live checker), and `index-rebuild-list-batches` with `IndexRebuildService.listBatchFiles` and `processShard`. Also dead: the env keys `NEPTUNE_HOST`, `GREMLIN_ASYNC_STATUS_POLL_INTERVAL_MS`, `GREMLIN_ASYNC_STATUS_LOG_EVERY_POLLS`, and `ALARM_NAME_PREFIX`; the `sqs:SendMessage` grant from `PersistAsyncBulkWorker` to `FilteredBatchQueue`; and the tagged error `DerivedIndexServerManagedPropertyError` (mapped in `lambda/http/responses.ts` but never constructed). Detail: `stacks-configuration-and-iam.md` §4.4, §5, §7 and `error-catalogue-and-responses.md` §4.
10. OpenAPI: `lambda/api/definitions.ts`, `scripts/generate-openapi.ts`, `pnpm api:spec` → `docs/openapi.json` (checked in), `test/api/openapi.test.ts`.
11. CDK: `lib/container-asset-excludes.ts`, `lib/neptune-configuration.ts`, `lib/neptune-cluster-endpoint.ts`, `lib/deployment-environment.ts`, `lib/neptune-stack.ts`, `lib/persist-stack.ts`, `bin/app.ts`, `cdk.json` (`npx tsx bin/app.ts`); contract tests `test/cdk/stack-templates.ts`, `synthesize-stack-template.cli.ts`, `persist-stack.test.ts`, `neptune-stack.test.ts`. Configuration and IAM detail: `stacks-configuration-and-iam.md`; reader topology: `neptune-reader-topology.md`.
12. Local Gremlin and test orchestration: `gremlin/tinkergraph-empty.properties`, `scripts/start-gremlin-test.sh`, `scripts/run-tests.sh`, then the suites in §5.4 and the CI callers in §6.1.
13. E2E: `test/e2e/persist-api.e2e.test.ts`, `persist-blobs.e2e.test.ts`, `persist-graphql.e2e.test.ts` and the `pnpm e2e:*` scripts, driven by the `persist-api-url` SSM parameter that the stack publishes. Release validation steps: `operations-playbook.md`.
14. Sibling subsystems, each after the core passes: FTS mirror (`lib/persist-search-stack.ts`, `opensearch-*` handlers, `OpenSearch*` services) per `opensearch-fts-mirror.md`; stream export and Athena consumers (`lib/debt-index-export-stack.ts`, `glue/`, `stream-export-*`, `athena-*`, `workflow-debt-index-export`, `DebtIndexExport*`/`Athena*` services, `lambda/fargate/debt-key-list-entrypoint.ts`) per `neptune-stream-export.md`, `athena-debt-index-export.md`, `athena-index-stream-consumer.md`; dashboards (`lib/indexing-dashboard-stack.ts`, `lib/csv-ingest-dashboard-stack.ts`) per `operations-dashboards-and-alerting.md`; recovery (`lib/neptune-recovery-stack.ts`) per `neptune-recovery-and-persistence-target.md`; explain per `gremlin-explain.md`; PII policy per `graphql-pii-access-policy.md`; peering per `cross-account-vpc-peering.md`.

## 8. Source map

| Topic | Files read |
| --- | --- |
| Effect and Powertools patterns | `AGENTS.md` (Effect-TS Patterns, Powertools router, CDK Patterns, AGENT notes) |
| Logging bridge | `lambda/logging/powertools.ts`, `effect-logger.ts`, `runtime.ts`, `lambda/http/request-context.ts` |
| Layers and factories | `lambda/services/index.ts`, `grep "export const make" lambda/services`, `grep "Effect.Service<" lambda/services` |
| Errors | `lambda/schemas/errors.ts`, `lambda/utils/errors.ts` |
| Routers and runtimes | `lambda/handler.ts`, `lambda/router.ts`, `lambda/routes/*.router.ts`, `lambda/graphql/handler.ts` |
| Metrics | `lambda/services/IngestMetricsService.ts`, `GraphQlMetricsService.ts`, `IndexRebuildMetricsService.ts`, `lambda/index-stream-lag-probe/metrics.ts`, `lambda/csv-workflow-metrics/metrics.ts`, `lambda/workflow-cost-predictor/handler.ts`, `grep "new Metrics(" lambda`, `grep POWERTOOLS_SERVICE_NAME lib/persist-stack.ts` |
| Request keys, tracing, timeouts | `grep appendKeys/resetKeys lambda`, `grep tracingEnabled lib`, `grep Effect.timeoutFail lambda`, `NeptuneBulkLoaderService.ts`, `neptune-stream/NeptuneStreamPollerCore.ts` |
| Layout | `find lambda -maxdepth 1`, `ls lambda/{schemas,services,utils,config,logging,http,routes,api} lib glue scripts docs test` |
| Testing | `vitest.config.ts`, `setupTests.ts`, `scripts/run-tests.sh`, `scripts/start-gremlin-test.sh`, `test/**` listing and `it(...)` names, `test/e2e/persist-api.e2e.test.ts`, `README.md` (Development, E2E sections) |
| CI and tooling | `.github/workflows/*.yml`, `.github/actions/setup/action.yml`, `justfile`, `package.json`, `pyproject.toml`, `tsconfig*.json`, `eslint.config.mjs`, `.prettierrc.cjs`, `.husky/pre-commit` |
| OpenAPI | `scripts/generate-openapi.ts`, `lambda/api/definitions.ts`, `test/api/openapi.test.ts` |
| Bundling | `lib/persist-stack.ts` (bundling blocks, `esmRequireBanner`, `DockerImageAsset`), `lib/container-asset-excludes.ts`, `lib/glue-package-asset.ts`, `lambda/fargate/Dockerfile`, `cdk.json`, `bin/app.ts` |
