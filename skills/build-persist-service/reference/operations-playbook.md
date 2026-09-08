# Operations playbook and acceptance criteria

Persist is deployed as one CDK app of seven stacks through `just build` / `just deploy`, exposed as an IAM-authorized HTTP API whose URL is published to SSM, and validated after every deploy with a fixed set of per-surface smoke checks. This file is the operational contract: what a deployer needs, how deploy/destroy/rollback behave as implemented, how to call and smoke-test each surface, the runbook with the real retry and concurrency numbers, and the acceptance criteria a re-implementation must meet. It replaces PRD §8 and §10. Every number below is taken from the code paths listed in §9, not from the PRD.

## 1. Scope

- In scope: prerequisites, deploy/destroy commands and context keys, stack outputs and SSM summary, API invocation, smoke tests and release validation, rollback, common runbook items, and acceptance criteria grouped by surface.
- Out of scope (owned by sibling files, pointed to where relevant): the full env-var, output, and IAM tables (`stacks-configuration-and-iam.md`), alarms and dashboards (`operations-dashboards-and-alerting.md`), reader-endpoint and persistence-target cutovers (`neptune-reader-topology.md`, `neptune-recovery-and-persistence-target.md`), FTS (`opensearch-fts-mirror.md`), the Athena exports (`athena-debt-index-export.md`, `neptune-stream-export.md`), and the test layout (`engineering-conventions-and-testing.md`).

## 2. Prerequisites

Toolchain (all driven by `justfile`):

- Node.js 22 or newer. `package.json` declares no `engines` pin; every Lambda runs `nodejs24.x` on ARM64 and esbuild targets `node24`, so prefer Node 24 locally.
- pnpm pinned by `packageManager` to `pnpm@10.14.0`; `just setup` activates it through corepack, runs `pnpm install --frozen-lockfile`, and rebuilds `esbuild` / `unrs-resolver`.
- `just` (the only entry point shared CI runs).
- `uv` and Python 3 for the Glue jobs under `glue/`; `just setup` installs a pinned `uv` if absent and runs `uv sync --group dev`. `scripts/run-tests.sh` exits 1 without `uv`.
- Docker: `just test` starts a local Gremlin Server container, and the async Gremlin worker image is a `DockerImageAsset` built and pushed during deploy.
- AWS CLI plus AWS CDK CLI, with the target account bootstrapped (pass `CDK_BOOTSTRAP_QUALIFIER` when the bootstrap uses a custom qualifier).

Deployer IAM permission families (the app creates resources in all of them): EC2/VPC, Neptune, OpenSearch, S3, SQS, SNS, DynamoDB, ECS/Fargate, ECR (Docker asset publishing through the bootstrap roles), Step Functions, EventBridge rules, EventBridge Pipes, EventBridge Scheduler, Lambda, API Gateway v2, IAM, CloudWatch Logs/Metrics/Alarms, SSM Parameter Store, Secrets Manager, Glue, Athena, and CloudFormation custom resources (Neptune custom endpoints are created by a custom resource).

Inputs that must exist before `PersistStack` deploys (both are read with `StringParameter.valueForStringParameter` at synth/deploy time):

- SSM `/lexicon/data-uri`: S3 URI of the canonical `lexicon.json`. Every lexicon-reading handler receives it as `LEXICON_DATA_URI`.
- SSM `/persist-spark/glue/neptune-csv-rehash/job-name`: name of the Glue rehash job the CSV workflow starts. The workflow role is granted only `glue:StartJobRun`, `glue:GetJobRun`, `glue:GetJobRuns`, `glue:BatchStopJobRun`.
- SSM `/persist/opensearch/collection-endpoint` is published by `PersistSearchStack` and read by `PersistStack`; it is satisfied by deploying in order, not by hand.

Other prerequisites:

- Resolution map: `config/graphql-resolution-map.json` in the repo is deployed by a `BucketDeployment` to `graphql-resolution-map/graphql-resolution-map.json` in a stack-owned bucket and exposed as `GRAPHQL_RESOLUTION_MAP_URI`. A defaults-only map routing every field to `graph` is valid. `dynamodb` sources are code-supported but not wired: the GraphQL handler has no DynamoDB grant and no `table_env` variable, so a map declaring one fails at resolve time.
- Vendor (Interprose) access: the stack selects the credentials secret ARN, base URL, and customer id per account inside `lib/persist-stack.ts` (not from context) and sets `INTERPROSE_BASE_URL`, `INTERPROSE_CREDENTIALS_SECRET_ARN`, `INTERPROSE_CUSTOMER_ID`. All three are read with `Config.string` and no default, so the GraphQL handler fails at startup without them regardless of what the map declares. The secret itself is not created by the stack; it must exist before the first GraphQL call, and the handler is granted `secretsmanager:GetSecretValue` on it.
- Neptune Streams: `NeptuneStack` sets `neptune_streams=1` and `neptune_streams_expiry_days` (context `neptuneStreamsExpiryDays`, default 30, clamped to 1–90) in the cluster parameter group. Stream and autoscaling parameters are static: after changing them, reboot every DB instance before relying on the stream.

## 3. Deploy and destroy

```bash
export AWS_PROFILE=<selected-profile>
aws sts get-caller-identity --query Account --output text   # must equal <expected-account>
aws configure get region                                     # must equal <expected-region>
just setup
just build                                   # cdk synth --strict with the same context as deploy
TARGET_ENV=<stage> just deploy               # cdk deploy --all --require-approval never
```

Pre-deploy gates (the same recipes shared CI runs; run them before `just deploy` from a workstation):

```bash
just format && just lint && just type-check   # prettier + ruff, eslint + ruff check, tsc + effect diagnostics + basedpyright
just test                                     # scripts/run-tests.sh, see below
pnpm exec cdk diff --all --context stage=<stage> --context graphFactEventBusName=<bus>
```

`just test` runs three phases in order and stops at the first failure: `pytest` once per file under `glue/tests/` (needs `uv`, no Docker), the CDK contract tests `test/cdk/persist-stack.test.ts` and `test/cdk/debt-index-export-stack.test.ts` (synthesize only; they guard IAM scoping and Glue job arguments), then a Docker Gremlin Server plus `vitest` excluding `test/integration/**`, `test/e2e/**`, and `test/cdk/**`. There is no `test/integration` directory; the exclusion is defensive. The deployed-API suites are the `e2e:*` scripts in §5.

`just build` and `just deploy` always pass `--context stage="${TARGET_ENV:-dev}"` and `--context graphFactEventBusName="${GRAPH_FACT_EVENT_BUS_NAME:-<default-bus>}"`. They forward these context keys only when the matching environment variable is set: `@aws-cdk/core:bootstrapQualifier` (`CDK_BOOTSTRAP_QUALIFIER`), `neptunePortalReader` and `neptunePortalReaderInstanceClass`, `neptuneAgencyReader` and `neptuneAgencyReaderInstanceClass` (role names per `neptune-reader-topology.md`), `neptuneReaderEndpointMode`, `workflowRouteSizeBasis`, `debtIndexExportTriggerEnabled`, `athenaIndexStreamScheduleEnabled`. Keys the recipes do not forward (`neptunePersistenceTarget`, `neptuneStreamsExpiryDays`, `neptuneBackupRetentionDays`) must be passed by hand to `pnpm exec cdk deploy --all --context stage=<stage> --context <key>=<value>`.

Why `--all`: `bin/app.ts` defines `NeptuneStack`, `NeptuneRecovery<date>Stack` (prod only), `PersistSearchStack`, `PersistStack`, `DebtIndexExportStack`, `IndexingDashboardStack`, and `CsvIngestDashboardStack`. A bare `pnpm cdk:deploy` (the README's `cdk deploy` with no stack selector) is refused by the CDK CLI because the app has more than one stack. Ordering comes from explicit `addDependency` calls: Neptune → (Recovery) → Search → Persist → Export; the two dashboard stacks reference metrics by name only and deploy independently.

What `stage=prod` changes: `deletionProtection` is `stage === "prod"` for the Neptune cluster (removal policy RETAIN, otherwise DESTROY) and for the search stack's sync-state table and collection; the recovery stack is instantiated only for prod and refuses any other account; dedicated readers and the auto-scaled headroom replica default on; `neptunePersistenceTarget` defaults to `recovery` (see `neptune-recovery-and-persistence-target.md`). With no `stage` context every guard resolves to non-prod.

Destroy: there is no `just` recipe. Run `pnpm exec cdk destroy --all --context stage=<stage>` with the same context used to deploy, and only when `stage` is not `prod`. `PersistStack` sets no removal policy on its DynamoDB tables or S3 buckets, so CDK's default RETAIN keeps them (and their data) after destroy; queues, functions, schedules, and the API are deleted.

Outputs and SSM parameters (summary; `stacks-configuration-and-iam.md` has the full tables):

| Stack | CloudFormation outputs | SSM parameters |
| --- | --- | --- |
| `NeptuneStack` | `NeptuneWriterEndpoint`, `NeptuneReaderEndpoint`, `NeptuneAsyncReaderEndpoint`, `NeptunePort`, `NeptuneClusterResourceId`, `NeptuneClusterIdentifier`, `NeptuneBulkLoadRoleArn`, `VpcId` (export `NeptuneVpcId`), `VpcCidr` (export `NeptuneVpcCidr`); when the dedicated readers exist also `NeptuneGeneralReaderEndpoint`, `NeptunePortalReaderEndpoint`, `NeptuneAgencyReaderEndpoint` | `/persist/neptune/general-reader-endpoint`, `/persist/neptune/portal-reader-endpoint`, `/persist/neptune/agency-reader-endpoint` (each only when its endpoint exists) |
| `PersistStack` | `ApiUrl`, `PersistApiCrossAccountInvokeRoleArn`, `NeptuneCsvWorkflowArn`, `PersistIndexRebuildWorkflowArn` | `persist-api-url`, `persist-api-cross-account-invoke-role-arn`, `persist-neptune-csv-workflow-arn`, `persist-csv-workflow-metrics-log-group`, `persist-index-rebuild-workflow-arn` |
| `PersistSearchStack` | see `opensearch-fts-mirror.md` | `/persist/opensearch/collection-endpoint` and siblings |
| `DebtIndexExportStack` | see `athena-debt-index-export.md`, `neptune-stream-export.md` | see those files |

## 4. Invoking the API

The HTTP API uses IAM authorization: every request is SigV4-signed for service `execute-api`. There is no custom domain or API mapping; the URL is the execute-api endpoint published as `persist-api-url`.

```bash
API_URL=$(aws ssm get-parameter --name persist-api-url --query Parameter.Value --output text)
awscurl -u "$API_URL/persist/gremlin" -p "$AWS_PROFILE" -- \
  -X POST -H "content-type: application/json" -d '{"gremlin":"g.V().limit(1).count()"}'
```

`awscurl` is the README's shell helper: it exports credentials with `aws configure export-credentials --profile <profile> --format env-no-export`, derives the region from the URL, and calls `curl --aws-sigv4 "aws:amz:<region>:execute-api"` with the session token header. Any SigV4-capable client is equivalent. The same shape serves `POST /persist/ingest`, `/persist/ingest-async`, `/persist/validate`, `/persist/gremlin/explain`, `/persist/gremlin-async` (`POST`, `GET /:requestId`, `DELETE /:requestId`), `POST /persist/graphql`, and `GET /persist/graphql/schema`.

Callers in another account assume the role published as `persist-api-cross-account-invoke-role-arn`; it trusts the configured peer accounts and grants `execute-api:Invoke` on `/persist` and `/persist/*`. The e2e suites resolve the URL the same way (SSM `persist-api-url`, overridable with `PERSIST_API_URL_PARAMETER`) and skip when no AWS credentials are present.

## 5. Smoke tests and release validation per surface

Run after every deploy. The automated deployed-API suites live in `test/e2e/*.e2e.test.ts` (`pnpm run e2e` = `e2e:persist-api`, `e2e:persist-blobs`, `e2e:persist-graphql`, `e2e:raw-stream`; `e2e:csv-metrics` is deliberately excluded because it starts a real bulk load). Async Gremlin and the derived-index workflow have no e2e suite; those checks are manual.

Sync API (`AWS_PROFILE=<selected-profile> pnpm run e2e:persist-api`, or by hand):

1. `POST /persist/gremlin` with `g.V().limit(1).count()` returns `results`, `durationMs`, and echoes `readerTarget` (`default` when omitted); repeat once per configured `readerTarget`.
2. `POST /persist/ingest` upserts, then a second ingest of the same payload returns the same IDs and preserves the first `created_at`.
3. `POST /persist/validate` returns issues with `code` and JSON-pointer `path` without writing.
4. `POST /persist/ingest` with `vertexRefs` succeeds against existing vertices and returns `MissingVertexRef` (404) for missing or label-mismatched refs; `POST /persist/ingest-async` with non-empty `vertexRefs` is rejected before any S3 PUT or SQS send.
5. A `GraphFactProduced` event on the configured bus lands in the graph (sync route for refs or `<= SYNC_INGEST_MAX_ELEMENTS` = 50 elements, async route otherwise).

Async Gremlin (manual, aligned with README "Async Gremlin release validation"):

1. Quick success: `POST /persist/gremlin-async` with `g.V().limit(1).count()`; poll `GET /persist/gremlin-async/<requestId>` to `SUCCEEDED`; the status body carries `status`, timestamps, `durationMs`, `neptuneQueryId`, optional `resultS3Uri`, and never inlines the result. The request body does not accept `readerTarget`.
2. Cancel a genuinely running multi-minute request with `DELETE`; from a VPC host confirm the query id leaves the async reader's `/gremlin/status` before Persist reports `CANCELLED`; a repeated `DELETE` is idempotent.
3. Soak: submit an approved query that runs longer than the one-hour ceiling and confirm `TIMEOUT` (Fargate watchdog 3,720,000 ms; callback task timeout 4,800 s; execution timeout 6,000 s).
4. Poll every request to a terminal state and verify it is one of `SUCCEEDED`, `CANCELLED`, `TIMEOUT`, `FAILED`. Details in `async-gremlin.md`.

Derived indexes (manual; `derived-index-maintenance.md` and `derived-index-discovery-and-catchup.md` for inputs):

1. Start `PersistIndexRebuildWorkflow` (ARN from `persist-index-rebuild-workflow-arn`) with `{"schemaVersion":"1","mode":"DRY_RUN","indexes":[...]}` and confirm the S3 summary reports counts with no Neptune writes.
2. Rerun with `mode: "WRITE"` (add `initializeStreamCheckpoint: true` when the checkpoint is missing) and verify a sample owner element carries the derived property.
3. Ingest a graph fact that creates a matching trigger edge, wait for `IndexStreamPoller` (EventBridge Scheduler, rate 1 minute, `INDEX_STREAM_POLL_LIMIT=50000`), and verify the recomputed value plus an advanced checkpoint.
4. Read the lag-probe metrics in namespace `persist`: `IndexStreamOldestUnprocessedRecordAgeSeconds` returns to `0` and `IndexStreamCommitBacklog` to `0` within a couple of probe intervals (probe rate 1 minute, `INDEX_STREAM_POLL_LIMIT=1`). Alarm thresholds are in `operations-dashboards-and-alerting.md`.

CSV workflow: `pnpm run e2e:csv-metrics` uploads a lexicon plus CSVs, starts `PersistNeptuneCsvWorkflow` (ARN from `persist-neptune-csv-workflow-arn`), waits for `SUCCEEDED`, and asserts the metrics log line and `CsvWorkflowVerticesInserted` / `CsvWorkflowEdgesInserted` datapoints. Verify `workflow-summaries/<executionId>/<phase>/item-<itemIndex>.json` exists per item. Contract in `csv-bulk-load-workflow.md`.

GraphQL (`pnpm run e2e:persist-graphql`, or by hand):

1. `GET /persist/graphql/schema` returns SDL metadata with `sdlHash` and `resolutionMapHash`.
2. A graph-only query returns data with no vendor source in `extensions.sources`.
3. A mixed query returns vendor fields when the vendor is healthy; with credentials deliberately broken in non-prod it returns HTTP 200, graph fields intact, vendor fields `null`, and `errors[].extensions.source` set.
4. A query deeper than `GRAPHQL_MAX_QUERY_DEPTH` (8) returns `GraphQlComplexityError` (400) with no data-source call. PII fields follow `graphql-pii-access-policy.md`; the surface contract is `graphql-read-surface.md`.

Other surfaces: FTS in `opensearch-fts-mirror.md` §8; debt-index export in `athena-debt-index-export.md`; stream export and raw capture (`pnpm run e2e:raw-stream`) in `neptune-stream-export.md`; peering in `cross-account-vpc-peering.md`.

## 6. Rollback

1. `git checkout <last-known-good-revision>` and `TARGET_ENV=<stage> just deploy` with the same context values as the failed deploy. Stateful resources are untouched: Neptune data, the DynamoDB tables (async jobs, derived-index state, alert dedupe, search sync state), S3 buckets, queues and their DLQs, and SSM parameters. Lambda code, the Fargate image, state-machine definitions, and schedules revert.
2. Re-run §5 for every surface the release touched, at minimum the sync API and async Gremlin checks.
3. Audit stuck async jobs: scan the table named by `GREMLIN_ASYNC_JOBS_TABLE_NAME` (partition key `requestId`) for `status IN (QUEUED, RUNNING)` with `updatedAt` older than one hour; issue `DELETE /persist/gremlin-async/<requestId>` for each so cancel intent is recorded and the failure handler terminalizes it. Rows expire through `ttlEpochSeconds` (default 7 days).

   ```bash
   CUTOFF=$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ)
   aws dynamodb scan --table-name <gremlin-async-jobs-table> \
     --filter-expression '#s IN (:q, :r) AND updatedAt < :cutoff' \
     --expression-attribute-names '{"#s":"status"}' \
     --expression-attribute-values "{\":q\":{\"S\":\"QUEUED\"},\":r\":{\"S\":\"RUNNING\"},\":cutoff\":{\"S\":\"$CUTOFF\"}}" \
     --projection-expression 'requestId, #s, updatedAt, neptuneQueryId'
   ```

   `updatedAt` is an ISO-8601 UTC string, so lexical comparison is chronological. Read the table name from the `PersistStack` resource `GremlinAsyncJobsTable` (or the handler's environment); it is not published to SSM.
4. Reader-endpoint rollback (`--context neptuneReaderEndpointMode=cluster`) is in `neptune-reader-topology.md` §6; persistence-target rollback (`neptunePersistenceTarget=blue`) is in `neptune-recovery-and-persistence-target.md` §6.3. Do not combine either with a code rollback in the same deploy unless the incident requires it.

## 7. Runbook

| Symptom | Cause | Action | Numbers (from code) |
| --- | --- | --- | --- |
| `Max load task queue size limit breached` on bulk load start | Neptune loader queue saturated by concurrent items | Let the built-in retries run; if `Start<Phase>DirectLoad` still fails, lower the workflow `maxConcurrency` input and restart the failed items | In-loader: 2 attempts (`START_QUEUE_LIMIT_MAX_RETRIES=1`), jittered 5–15 s, then `NeptuneBulkLoadQueueFullError`; Step Functions retry on the direct-load task: 12 attempts, 60 s interval, backoff ×2, max delay 600 s, full jitter |
| Load reports `SINGLE_CARDINALITY_VIOLATION` on `created_at` only | Re-load of existing elements with a new `created_at` | None; treated as `LOAD_COMPLETED_WITH_TOLERATED_CREATED_AT_CONFLICTS`. Any other error code, or a mix, hard-fails the item | Tolerance applies only when every error is `created_at` single-cardinality |
| Async Gremlin job stays `QUEUED`/`RUNNING` | Worker or heartbeat failure before the terminal write | `GET` the request; if past the ceiling, `DELETE` to persist `cancelRequested`, which the worker poll or the failure handler honours | One-hour ceiling; heartbeat every 60 s with a 15-minute heartbeat timeout; job TTL 7 days |
| Sync Gremlin returns 429 or 504 | Reader throttling (`GremlinQueryThrottledError`, 429, no `Retry-After`) or evaluation timeout (`GremlinQueryTimeoutError`, 504) | Caller backs off with jitter; move long reads to `/persist/gremlin-async` | Sync evaluation ceiling 30 s (`GREMLIN_SYNC_EVALUATION_TIMEOUT_MS`, capped); API Gateway may answer its own timeout first |
| Connection storms or `ConcurrentModification` during CSV dedup | Too many parallel exists-checks against the general reader pool | Lower `GREMLIN_BATCH_EXISTS_CONCURRENCY` / `NEPTUNE_CSV_DEDUP_BATCH_CONCURRENCY` on `PersistWorkflowItemStage`, then raise `NEPTUNE_RETRY_MAX_ATTEMPTS` | Code default `GREMLIN_BATCH_EXISTS_CONCURRENCY=100`; ItemStage pins 110 with `NEPTUNE_RETRY_MAX_ATTEMPTS=10`, `NEPTUNE_RETRY_BASE_DELAY_MS=1000`, edge dedup concurrency 8; the dedup path reads `NEPTUNE_READER_HOST` (general reader pool, `db.r8g.8xlarge` auto-scaled replicas), not the `db.r8g.12xlarge` async reader |
| `IndexStreamCheckpointMissing` from poller or lag probe | Checkpoint row missing (never initialized, deleted, or reset after a cluster cutover) | Run `PersistIndexRebuildWorkflow` in `WRITE` with `initializeStreamCheckpoint: true` so it stores its captured watermark, then re-enable `IndexStreamPollSchedule`. Never start from `LATEST` in production | Poller fails closed on a missing checkpoint. A checkpoint older than stream retention is not detected: the stream client maps 404 `StreamRecordsNotFoundException` to end-of-stream, so a trimmed checkpoint reads as caught up |
| `IndexStreamOldestUnprocessedRecordAgeSeconds` climbing | Poller errors on a trigger record, or throughput | Read `IndexStreamPoller` logs first; growing `IndexStreamCommitBacklog` with a healthy poller means throughput: raise frequency/concurrency only after confirming the single-lease invariant; lower `INDEX_STREAM_POLL_LIMIT` only when Neptune pressure is the cause | Poller and probe both run every 1 minute; lag alarm at 1,800 s for 3 of 3 |
| Messages in `IngestAsyncDlq` / `FilteredBatchDlq` | Async worker failed a message repeatedly | Fix the cause, then redrive from the DLQ to the source queue | `maxReceiveCount` 5; source retention 2 days, visibility 30 minutes; DLQ retention 4 days |
| Events in `GraphFactEventDlq` | `PersistGraphFactHandler` rejected the event after EventBridge retries | Inspect the event, fix or discard, then re-put it on the bus (the handler is idempotent on `idempotency_key`) | EventBridge target retries 3, max event age 2 hours; DLQ retention 14 days |
| Messages in `GremlinAsyncDlq` | Submit-to-worker message failed 5 times | Redrive after the worker is healthy; jobs already terminal are skipped | `maxReceiveCount` 5; visibility 15 minutes; DLQ retention 14 days |

## 8. Acceptance criteria

Every criterion is testable against the current code; the check that covers it is named where one exists. Sibling files carry their own sections: `opensearch-fts-mirror.md` §8, `neptune-reader-topology.md` §7, `neptune-recovery-and-persistence-target.md` §7, `neptune-stream-export.md` §7, `cross-account-vpc-peering.md` §7, `derived-index-discovery-and-catchup.md` §7, `operations-dashboards-and-alerting.md` §6, plus the acceptance sections of `async-gremlin.md`, `csv-bulk-load-workflow.md`, `derived-index-maintenance.md`, `graphql-read-surface.md`, and `athena-debt-index-export.md`.

Sync API (`test/e2e/persist-api.e2e.test.ts`, `test/routes`, `test/services`):

- Every `/persist/*` route returns the documented success and error envelopes for the README and OpenAPI example payloads.
- `POST /persist/ingest` is transactional: a failure on any vertex or edge leaves zero new records.
- `POST /persist/ingest` accepts `vertexRefs`, verifies each ref at its declared label before the transaction, never upserts referenced vertices, and returns `MissingVertexRef` (404) with zero writes on failure.
- `POST /persist/ingest-async` validates the payload and rejects non-empty `vertexRefs` before any S3 PUT or SQS send; an enqueue failure returns an error and persists nothing (there is no job store for async ingest).
- Hashing produces identical IDs across two independent runs of the same payload (fixed-vector tests in `test/services/GraphSONHash.test.ts`; no fuzzing is claimed).
- `POST /persist/validate` accepts the bare `tinker:graph` payload and the `{ graph, candidate_lexicon_s3_uri }` wrapper and returns issues with `code` and JSON-pointer `path`.
- `POST /persist/gremlin` echoes `readerTarget` in the response, returns 429 `GremlinQueryThrottledError` on reader throttling and 504 `GremlinQueryTimeoutError` on evaluation timeout, and caps `GREMLIN_SYNC_EVALUATION_TIMEOUT_MS` at 30 s.
- The lexicon is cached per handler for 300 s and refreshed on expiry; refresh failures fail closed.

Persist Blobs (`test/e2e/persist-blobs.e2e.test.ts`):

- `persist:Blob` values are accepted only for lexicon `blob` properties, written once to content-addressed keys derived from the exact UTF-8 text hash, and replaced by deterministic S3 URIs before ID hashing.
- Same blob text yields the same URI and element IDs; changed text yields a new URI and a new element ID.
- Raw blob text never appears in Neptune properties, logs, SQS messages, DynamoDB rows, EventBridge metadata, or HTTP error details after materialisation.

Graph facts (`test/services/GraphFactEventService.test.ts`):

- `GraphFactProduced` events are decoded and validated before any side effect, routed to sync ingest when they carry `vertexRefs` or at most `SYNC_INGEST_MAX_ELEMENTS` elements and to async ingest otherwise, keep `idempotency_key` in metadata, and never duplicate elements on replay.

Async Gremlin (`test/services/GremlinAsync*.test.ts`, manual §5):

- The four release-validation steps pass in one deployed environment; `QUEUED → RUNNING` preassigns `neptuneQueryId=requestId`; `DELETE` persists cancel intent first and is idempotent; a stranded `RUNNING` job is terminalized by the failure handler; status responses never inline results.

CSV workflow (`test/e2e/csv-workflow-metrics.e2e.test.ts`, `test/services/WorkflowItem*.test.ts`):

- The workflow accepts all documented input shapes, routes each item by staged size (`workflowRouteSizeBasis`), writes `workflow-summaries/<executionId>/<phase>/item-<itemIndex>.json` per successful item, and treats a `created_at`-only `SINGLE_CARDINALITY_VIOLATION` as success.
- Queue-full starts follow the retry numbers in §7.

Derived indexes (`test/services/IndexRebuild*.test.ts`, `IndexStreamPoller*.test.ts`):

- Index declarations are consumed from the canonical lexicon; callers cannot write derived properties directly; values are validated against their declared scalar schema.
- `PersistIndexRebuildWorkflow` dry-runs and writes selected indexes, stores S3 summaries, captures a stream watermark, and stores it as the checkpoint only in `WRITE` with `initializeStreamCheckpoint`.
- `IndexStreamPoller` reads from the stored checkpoint, matches trigger records, recomputes `subject_query` / `value_query`, writes idempotently, and advances the checkpoint only after successful processing.
- A missing checkpoint fails closed with `IndexStreamCheckpointMissing`. A checkpoint older than stream retention is not detected today (end-of-stream mapping); treat detection as a hardening target, not a shipped guarantee.

GraphQL (`test/e2e/persist-graphql.e2e.test.ts`, `test/services/GraphQl*.test.ts`):

- The schema is generated deterministically: two loads of the same lexicon and map produce byte-identical SDL, and `GET /persist/graphql/schema` reports matching `sdlHash` and `resolutionMapHash`.
- Routing comes only from the validated resolution map; unknown types or fields, malformed key templates, and non-whitelisted vendor operations fail the load with `GraphQlResolutionMapError`; callers cannot select sources.
- Graph-only queries never call the vendor client (spy-verified); mixed queries batch per source per level.
- A vendor failure nulls only its fields, appends `errors[].extensions.source`, and returns HTTP 200; mutations, subscriptions, and depth/complexity violations are rejected before any data-source call.
- The handler role allows only `neptune-db:connect` and `neptune-db:ReadDataViaQuery`, `s3:GetObject` on the lexicon bucket and the map prefix, and `secretsmanager:GetSecretValue` on the vendor secret. A DynamoDB grant is future work, added only when a `dynamodb` source is declared.
- The runtime is GraphQL Yoga inside `PersistGraphQlHandler`; every source is a `SourceResolver` adapter behind the registry and adding a source needs no executor, planner, or schema-generator change. A shared adapter contract test suite is a target: today only the graph and vendor resolvers have tests and the DynamoDB resolver has none.

Deployment and operations (`test/cdk/*.test.ts`, manual §3–§6):

- `just build` synthesizes six stacks for a non-prod `stage` and seven for `stage=prod` (the recovery stack is added), with `--strict`; `just deploy` completes with `--all` and no interactive approval.
- After deploy the SSM parameters in §3 exist and `persist-api-url` resolves to an execute-api endpoint that answers a SigV4-signed `POST /persist/gremlin`; a principal in a configured peer account can assume the role in `persist-api-cross-account-invoke-role-arn` and invoke `/persist/*`.
- Deploying without `stage=prod` produces a Neptune cluster with deletion protection off and DESTROY removal policies on the cluster and the search stack's sync-state table and collection; with `stage=prod` deletion protection is on and those removal policies are RETAIN. `cdk destroy --all` on a non-prod stage removes compute and queues while the DynamoDB tables and S3 buckets of `PersistStack` remain.
- Every `test/e2e/*.e2e.test.ts` suite resolves its target from SSM and self-skips when no AWS credentials are present, so `pnpm run e2e` is safe to run from a workstation without a deployment.
- A rollback to the previous revision (§6) needs no data migration and leaves no async job in `QUEUED`/`RUNNING` older than one hour after the audit step.

Cross-cutting (`test/cdk/*.test.ts`):

- All Lambdas use `nodejs24.x`, ARM64, ESM bundling, and the `createRequire` banner with `gremlin` / `gremlin-aws-sigv4` as node modules.
- IAM follows the scopes in `stacks-configuration-and-iam.md`; the CDK contract tests in `scripts/run-tests.sh` guard them.
- Structured logs carry `requestId` / `executionId` / `loadId` / `taskToken` so one ingestion is traceable end to end in CloudWatch Logs Insights.

## 9. Source map

- `justfile` (`setup`, `build`, `deploy`, `test`, `e2e*`); `package.json` (`packageManager`, scripts); `scripts/run-tests.sh`; `README.md` (Prerequisites, Deployment, Async Gremlin release validation, Invoking the API, E2E sections).
- `bin/app.ts` (stack set, `stage` guards, context keys, dependencies).
- `lib/persist-stack.ts` (SSM reads, queues and DLQs, tables, GraphQL env and role, ItemStage env, direct-load retry, schedulers, cross-account role, outputs and parameters); `lib/neptune-stack.ts` (parameter group, outputs); `lib/persist-search-stack.ts` (deletion protection); `lib/neptune-configuration.ts` (instance classes, timeouts).
- `lambda/services/NeptuneBulkLoaderService.ts` (queue-full retry, `created_at` tolerance); `lambda/services/GremlinService.ts` (concurrency default, sync timeout ceiling); `lambda/http/responses.ts` (429/504 mapping); `lambda/schemas/gremlin.ts`, `lambda/schemas/gremlin-async.ts` (`readerTarget`, status literals).
- `lambda/services/GraphSONAsyncIngestService.ts`, `lambda/services/GraphFactEventService.ts` (validation before side effects, routing threshold); `lambda/services/GremlinAsyncJobStoreService.ts` (table env, `status`, `updatedAt`, TTL).
- `lambda/services/InterproseClientService.ts` (required vendor config); `lambda/services/LexiconSchemaService.ts` (300 s cache); `lambda/graphql/handler.ts`, `lambda/services/GraphQlSchemaService.ts` (schema hashes).
- `lambda/services/IndexStreamPollerService.ts`, `lambda/services/IndexStreamClientService.ts`, `lambda/index-stream-lag-probe/metrics.ts`, `lambda/services/IndexRebuildService.ts`, `lambda/schemas/derived-index.ts` (checkpoint semantics, metric names, rebuild input).
- `test/e2e/*.e2e.test.ts` (URL resolution from SSM, covered cases).
