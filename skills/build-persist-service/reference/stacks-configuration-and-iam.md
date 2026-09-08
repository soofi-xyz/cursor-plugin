# Stacks, Configuration Surface, and IAM

Persist is deployed as one AWS CDK app of seven stacks. `NeptuneStack` owns the VPC, security groups, the Neptune cluster with its parameter groups, backups, permanent writer/reader instances, read-replica auto-scaling, and the bulk-load role; `PersistStack` owns every API, ingest, async-Gremlin, CSV-workflow, and derived-index resource: six S3 buckets, three queues with dead-letter queues, three DynamoDB tables, twenty-seven Lambdas, one Fargate task, three Step Functions state machines, an HTTP API with an IAM authorizer, EventBridge rules, Scheduler schedules, and a pipe. Stacks hand values to each other by CDK props where the producer never needs to change independently, and through SSM parameters where it does (the search stack's OpenSearch target, the CSV workflow ARN). The API is exposed only as an execute-api URL published to SSM plus a cross-account `execute-api:Invoke` role; there is no custom-domain mapping. Every runtime knob is an environment variable read once at cold start through Effect `Config`; section 7 is the canonical table of every key read under `lambda/`, with the code default and the value CDK pins per function.

## 1. Scope

This file owns: the CDK app topology and deployment order (`bin/app.ts`), every CDK context key the app reads, `NeptuneStack` and `PersistStack` contents resource by resource, the IAM posture of every role those two stacks create, every stack output and SSM parameter they publish or consume, and the environment-variable table. It replaces PRD sections 1.2 (routing surface), 2.1, 2.2, 2.4, 2.5, and the IAM bullets of 2.4.6.

Non-goals, each owned by a sibling file: reader instance topology and custom endpoints (`neptune-reader-topology.md`); the recovery cluster and `neptunePersistenceTarget` (`neptune-recovery-and-persistence-target.md`); partner VPC peering and DB-auth roles (`cross-account-vpc-peering.md`); `PersistSearchStack` (`opensearch-fts-mirror.md`); `DebtIndexExportStack` (`athena-debt-index-export.md`, `neptune-stream-export.md`, `athena-index-stream-consumer.md`); the dashboard stacks, alarms and paging (`operations-dashboards-and-alerting.md`); per-subsystem runtime behaviour (`graphson-ingest-contract.md`, `async-graphson-ingest-and-graph-facts.md`, `gremlin-sync-query.md`, `async-gremlin.md`, `csv-bulk-load-workflow.md`, `derived-index-maintenance.md`, `graphql-read-surface.md`, `identity-hashing-and-blobs.md`).

## 2. CDK app topology

### 2.1 Stacks and order

`cdk.json` runs `npx tsx bin/app.ts`. The app resolves `env` from `CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION` and instantiates, in this order:

| # | Stack id | Purpose | Depends on |
| - | -------- | ------- | ---------- |
| 1 | `NeptuneStack` | VPC, security groups, blue Neptune cluster, bulk-load role, dedicated readers and custom endpoints | — |
| 2 | `NeptuneRecovery<snapshot-date>Stack` (prod only) | Cluster restored from a pinned snapshot; the persistence target when `neptunePersistenceTarget=recovery`. See `neptune-recovery-and-persistence-target.md` | 1 |
| 3 | `PersistSearchStack` | OpenSearch FTS mirror, stream poller, backfill workflow. See `opensearch-fts-mirror.md` | 1 (and 2 when it is the target) |
| 4 | `PersistStack` | Everything in section 4 | 3 (explicit), 1 and 2 via props |
| 5 | `DebtIndexExportStack` | Athena export of derived index values and stream export. See `athena-debt-index-export.md` | 4 (explicit; also reads the CSV workflow ARN from SSM) |
| 6 | `IndexingDashboardStack` | CloudWatch dashboard by metric name only | — |
| 7 | `CsvIngestDashboardStack` | CloudWatch dashboard by metric name only | — |

```
NeptuneStack ──vpc, LambdaSg, port, bulkLoadRoleArn──────────────────────────┐
   │  (prod) NeptuneRecovery<date>Stack ── writer/reader/async/custom endpoints, clusterResourceId
   │            │  "persistenceNeptune" = recovery (prod default) | blue
   ▼            ▼
PersistSearchStack ──openSearchIndexName, searchSyncStateTableName, backfillWorkflowArn (props)──┐
   │ publishes SSM /persist/opensearch/{collection-endpoint,collection-arn,index-name,backfill-workflow-arn}
   ▼                                                                                            ▼
PersistStack ── reads SSM /lexicon/data-uri, /persist-spark/glue/neptune-csv-rehash/job-name, /persist/opensearch/collection-endpoint
   │ publishes SSM persist-api-url, persist-api-cross-account-invoke-role-arn, persist-neptune-csv-workflow-arn,
   │                persist-index-rebuild-workflow-arn, persist-csv-workflow-metrics-log-group
   ▼
DebtIndexExportStack ── reads SSM /lexicon/data-uri, persist-neptune-csv-workflow-arn; publishes /persist/debt-index-export/*
IndexingDashboardStack, CsvIngestDashboardStack ── independent
```

Deploy with `just deploy` (`cdk deploy --all --require-approval never --context stage=$TARGET_ENV ...`); `just build` runs `cdk synth --strict` with the same context. Each optional context key below is passed only when its shell variable is set. A bare `cdk deploy` with seven stacks requires stack selection, so use the recipe.

### 2.2 CDK context keys

| Key | Allowed values | Default | Effect |
| --- | -------------- | ------- | ------ |
| `stage` | free string; `prod` is special | unset (`dev` inside the search and export stacks) | `prod` turns on deletion protection, the recovery stack, dedicated readers, and general-reader headroom; also selects the Interprose host and secret |
| `graphFactEventBusName` | bus name | `DEFAULT_GRAPH_FACT_EVENT_BUS_NAME` constant in `lib/persist-stack.ts` | Existing EventBridge bus the `GraphFactProducedRule` is attached to |
| `neptunePersistenceTarget` | `blue` \| `recovery` | `recovery` when `stage=prod`, else `blue`; `recovery` outside prod throws | Which cluster every data-plane consumer points at; puts blue into retention mode when `recovery` |
| `neptunePortalReader`, `neptuneAgencyReader` | `true` \| `false` (string or boolean; anything else throws) | `true` when `stage=prod` | Create the dedicated reader instance and its custom endpoint |
| `neptunePortalReaderInstanceClass`, `neptuneAgencyReaderInstanceClass` | instance class | `db.r8g.xlarge` | Override the dedicated reader class |
| `neptuneReaderEndpointMode` | `cluster` \| `custom` | `custom` when a general custom endpoint exists, else `cluster`; `custom` without a dedicated reader throws | Whether `NEPTUNE_READER_HOST` is the custom general-reader endpoint or `cluster-ro` |
| `workflowRouteSizeBasis` | `staged` \| `raw` | `staged` | Which size the CSV workflow's aggregate-vs-direct `Choice` measures |
| `neptuneStreamsExpiryDays` | integer, clamped to 1–90 | 30 | `neptune_streams_expiry_days` cluster parameter |
| `neptuneBackupRetentionDays` | integer, clamped to 1–35 | 35 | `backupRetentionPeriod` |
| `searchInstanceType`, `searchInstanceCount`, `searchVolumeGib`, `searchVolumeIops`, `searchVolumeThroughput` | see `opensearch-fts-mirror.md` | | PersistSearchStack sizing |
| `debtIndexExportDatabase`, `debtIndexExportTable`, `debtIndexExportView`, `debtIndexExportSchemaVersion`, `debtIndexExportMaxShrinkRatio`, `debtIndexExportTriggerEnabled`, `athenaIndexStreamScheduleEnabled`, `streamExportDatabase` | see `athena-debt-index-export.md` | | DebtIndexExportStack |

Partner VPC peering is not a context key: it is committed state in `bin/app.ts` that applies only when `stage=prod` in the expected account and region, and throws otherwise (`cross-account-vpc-peering.md`).

### 2.3 Cross-stack handoffs

Props (CloudFormation exports, auto-named): VPC, `LambdaSg`, port, bulk-load role ARN from `NeptuneStack`; writer, general reader, async reader, portal and agency endpoints, cluster resource ID and cluster identifier from whichever cluster is the persistence target. `NeptuneStack` calls `exportValue` on its writer, reader, async-reader, cluster-resource-id, and custom-endpoint values so the auto-generated exports survive the recovery cutover while consumers still import them. Application-level SSM handoffs are listed in section 6; the OpenSearch endpoint and ARN deliberately flow through SSM rather than exports so the search stack can replace its domain without an in-use-export deadlock, and `PersistStack` synth reads `/persist/opensearch/collection-endpoint`, which makes the search stack a hard prerequisite.

## 3. NeptuneStack

- **VPC** `NeptuneVpc`: `maxAzs: 2`, `natGateways: 1`, subnet tiers `public` (/24), `app` = `PRIVATE_WITH_EGRESS` (/24), `db` = `PRIVATE_ISOLATED` (/24); S3 gateway endpoint on the `app` and `db` route tables. Tag `project_name=persist` on the whole stack.
- **Security groups**: `LambdaSg` (`allowAllOutbound: true`), attached to every VPC Lambda and the Fargate task in every stack. `NeptuneSg` (`allowAllOutbound: false`) with egress `0.0.0.0/0:443` for S3 bulk loading and ingress `8182/tcp` from `LambdaSg` and from the VPC CIDR; the partner CIDR rule is added only with peering enabled.
- **Cluster parameter group** (`neptune1.4`): `neptune_enable_audit_log=1`, `neptune_enable_slow_query_log=info`, `neptune_slow_query_log_threshold=5000`, `neptune_query_timeout=3600000` (1 h), `neptune_streams=1`, `neptune_streams_expiry_days=<context, 30>`, `neptune_autoscaling_config={"tags":[{"key":"project_name","value":"persist"}],"dbInstanceClass":"db.r8g.8xlarge"}` (static parameter; pins the class and tags of auto-scaled replicas).
- **Instance parameter groups** (`neptune1.4`): `NeptuneAsyncReaderParameterGroup` with `neptune_query_timeout=43200000` (12 h) for the async reader; one group per dedicated reader with `neptune_query_timeout=30000` (30 s).
- **Cluster** `CfnDBCluster`: subnet group on the isolated subnets, `iamAuthEnabled: true`, `storageEncrypted: true`, `enableCloudwatchLogsExports: ["audit", "slowquery"]`, `copyTagsToSnapshot: true`, `backupRetentionPeriod=<context, 35>`, `preferredBackupWindow "05:00-05:30"`, `preferredMaintenanceWindow "sun:06:00-sun:06:30"`, `deletionProtection` from props (`stage=prod`; default `true` when the prop is omitted), removal policy `RETAIN` when protected else `DESTROY`, `associatedRoles=[NeptuneBulkLoadRole]`.
- **Instances**: writer `NeptuneInstance` `db.r8g.8xlarge`; permanent async reader `NeptuneReaderInstance` `db.r8g.12xlarge` on the 12 h parameter group; optional dedicated readers `persist-portal-reader` and `persist-agency-reader` (`db.r8g.xlarge`, pinned identifiers). Blue retention mode replaces the writer and async reader classes with `db.t4g.medium` and drops the dedicated readers.
- **Read-replica auto-scaling**: `ScalableTarget` on `neptune:cluster:ReadReplicaCount`, `minCapacity` = permanent replicas (1 + dedicated readers) plus one headroom replica when any dedicated reader exists and `generalReaderHeadroom` is on (prod: 4), `maxCapacity` 7 (retention mode: permanent count), target tracking on `NeptuneReaderAverageCPUUtilization` at 65 %, scale-out cooldown 15 min, scale-in 10 min. Registration depends on the writer, async reader and every dedicated reader.
- **Custom endpoints** (`persist-general-readers` READER endpoint excluding dedicated instances; `persist-portal` / `persist-agency` ANY endpoints with one static member) through the `NeptuneClusterEndpointProvider` custom resource, only when a dedicated reader exists. Details in `neptune-reader-topology.md`.
- **Bulk-load role** `NeptuneBulkLoadRole`: assumed by `rds.amazonaws.com`, `s3:ListBucket` + `s3:GetObject` on `arn:<partition>:s3:::*` and `*/*`. `PersistStack` imports it immutably and calls `grantRead` on the bulk-load bucket, which CDK renders as a bucket-policy statement.
- **Partner access roles** (peering-gated prod role; dev-account-only DB-auth role with `neptune-db:*` plus OpenSearch `es:ESHttp{Get,Post,Put,Head,Delete}` on the FTS domain pattern, with a CfnOutput and SSM `/persist/dev/<partner>/neptune-db-auth-role-arn`): `cross-account-vpc-peering.md`.

Outputs (all exported under the same name unless noted): `NeptuneWriterEndpoint`, `NeptuneReaderEndpoint`, `NeptuneAsyncReaderEndpoint`, `NeptunePort`, `NeptuneClusterResourceId`, `NeptuneClusterIdentifier`, `NeptuneBulkLoadRoleArn`, `VpcId` (export `NeptuneVpcId`), `VpcCidr` (export `NeptuneVpcCidr`); conditional, not exported: `NeptuneGeneralReaderEndpoint`, `NeptunePortalReaderEndpoint`, `NeptuneAgencyReaderEndpoint`, and the partner peering outputs. SSM: `/persist/neptune/general-reader-endpoint`, `/persist/neptune/portal-reader-endpoint`, `/persist/neptune/agency-reader-endpoint` when the endpoint exists.

## 4. PersistStack

Every Lambda is a `NodejsFunction` on `NODEJS_24_X` / `ARM_64`, JSON logging into a dedicated `LogGroup` with three-month retention, bundled with esbuild: `format: ESM`, `target: node24`, `minify`, `sourceMap`, `mainFields: ["module","main"]`, `--conditions module`, and an ESM `createRequire` banner. Functions that talk Gremlin list `gremlin` and `gremlin-aws-sigv4` in both `externalModules` and `nodeModules`, so those CommonJS packages ship unbundled in `node_modules` rather than being inlined. VPC functions use `PRIVATE_WITH_EGRESS` subnets and `LambdaSg`. The whole stack is tagged `project_name=persist`.

### 4.1 Storage (S3)

All buckets: `BLOCK_ALL` public access, `enforceSSL`, S3-managed encryption, `BUCKET_OWNER_ENFORCED`.

| Bucket | Lifecycle | Prefixes and use |
| ------ | --------- | ---------------- |
| `IngestAsyncPayloadBucket` | expire 2 d | `ingest-async/*` GraphSON async payloads |
| `NeptuneBulkLoadBucket` | expire 2 d | `bulk-load/*`, `bulk-load-aggregate/*`, `workflow-summaries/*`, `workflow-rehash/*`; read by the bulk-load role |
| `GremlinAsyncResultsBucket` | expire 7 d | `gremlin-async/results/*` |
| `IndexMaintenanceBucket` | expire 14 d | `index-rebuild/*` manifests, batch files, summaries |
| `GraphQlResolutionMapBucket` | none, `versioned: true` | `graphql-resolution-map/graphql-resolution-map.json`, uploaded by a `BucketDeployment` from `config/` (only that file); `GRAPHQL_RESOLUTION_MAP_URI` is its `s3://` URI |
| `PersistBlobBucket` | none | `persist-blobs/*` content-addressed text blobs |

### 4.2 Queues (SQS)

All queues: SQS-managed encryption, `enforceSSL`.

| Queue | Retention | Visibility | DLQ (retention) / maxReceiveCount | Consumer |
| ----- | --------- | ---------- | --------------------------------- | -------- |
| `IngestAsyncQueue` | 2 d | 30 min | `IngestAsyncDlq` (4 d) / 5 | `PersistAsyncBulkWorker` event source: batch 400, window 1 min (3 s in the dev account), `maxConcurrency` 4, partial batch failures |
| `FilteredBatchQueue` | 2 d | 30 min | `FilteredBatchDlq` (4 d) / 5 | `PersistAsyncBulkAggregateWorker` event source: batch 6, same window, `maxConcurrency` 4, partial batch failures |
| `GremlinAsyncQueue` | 4 d | 15 min | `GremlinAsyncDlq` (14 d) / 5 | `GremlinAsyncPipe` (batch 1) → `GremlinAsyncStateMachine` |
| `GraphFactEventDlq` | 14 d | — | — | Dead-letter target of `GraphFactProducedRule` |

### 4.3 DynamoDB

All tables `PAY_PER_REQUEST`, AWS-managed encryption.

| Table | Keys | PITR | TTL attribute |
| ----- | ---- | ---- | ------------- |
| `GremlinAsyncJobsTable` | PK `requestId` (S) | on | `ttlEpochSeconds` |
| `DerivedIndexStateTable` | PK `pk` (S), SK `sk` (S) | on | — |
| `PagerDutyAlertDedupeTable` | PK `pk` (S), SK `sk` (S) | off | `ttlEpochSeconds` |

### 4.4 Compute

| Construct id | Handler | MB | Timeout | Reserved | VPC | Trigger |
| ------------ | ------- | -- | ------- | -------- | --- | ------- |
| `PersistHandler` | `lambda/handler.ts` | 512 | 30 s | — | yes | HTTP API `/persist`, `/persist/{proxy+}` |
| `PersistGraphQlHandler` | `lambda/graphql/handler.ts` | 1024 | 30 s | — | yes | HTTP API `POST /persist/graphql`, `GET /persist/graphql/schema` |
| `PersistGraphFactHandler` | `lambda/graph-fact-event/` | 512 | 60 s | — | yes | `GraphFactProducedRule` (3 retries, `maxEventAge` 2 h, DLQ `GraphFactEventDlq`) |
| `PersistAsyncBulkWorker` | `lambda/async-bulk-worker/` | 1024 | 15 min | — | yes | SQS `IngestAsyncQueue` (4.2) |
| `PersistAsyncBulkAggregateWorker` | `lambda/async-bulk-aggregate-worker/` | 1024 | 15 min | — | yes | SQS `FilteredBatchQueue` (4.2) |
| `GremlinAsyncValidate` | `lambda/gremlin-async-validate/` | 256 | 60 s | — | yes | `GremlinAsyncStateMachine` `ValidateAndSetRunning` |
| `GremlinAsyncFailureHandler` | `lambda/gremlin-async-failure/` | 256 | 60 s | — | yes | `GremlinAsyncStateMachine` `HandleFailure` (catch of validate and execute) |
| `PersistAsyncGremlinWorker` | `lambda/gremlin-async-worker/` | 1024 | 15 min | — | yes | none (retained legacy worker; SQS source removed) |
| `IndexRebuildPrepare` | `lambda/index-rebuild-prepare/` | 1024 | 15 min | — | yes | `PersistIndexRebuildWorkflow` `PrepareIndexRebuild` |
| `IndexRebuildRangeEnumerator` | `lambda/index-rebuild-range-enumerator/` | 1024 | 15 min | — | yes | Distributed Map `EnumerateIndexRebuildRanges` |
| `IndexRebuildShardWorker` | `lambda/index-rebuild-shard-worker/` | 1024 | 15 min | — | yes | Distributed Map `RecomputeIndexBatchFiles` (S3 `listObjectsV2` item reader) |
| `IndexRebuildListBatches` | `lambda/index-rebuild-list-batches/` | 512 | 1 min | — | yes | none (defined and granted, not wired into the workflow) |
| `IndexRebuildFinalize` | `lambda/index-rebuild-finalize/` | 512 | 1 min | — | yes | `FinalizeIndexRebuild` |
| `IndexRebuildFail` | `lambda/index-rebuild-fail/` | 512 | 1 min | — | yes | `PersistIndexRebuildFailureRule` (4.6) |
| `IndexStreamPoller` | `lambda/index-stream-poller/` | 4096 | 3 min | 1 | yes | Scheduler `IndexStreamPollSchedule` rate 1 min, `retryAttempts: 0` |
| `IndexStreamLagProbe` | `lambda/index-stream-lag-probe/` | 512 | 30 s | — | yes | Scheduler `IndexStreamLagProbeSchedule` rate 1 min, `retryAttempts: 0` |
| `IndexDiscoveryPoller` | `lambda/index-discovery-poller/` | 512 | 1 min | — | no | Scheduler `IndexDiscoveryPollSchedule` rate 1 h |
| `PersistPagerDutyAlert` | `lambda/pagerduty-alert/` | 512 | 30 s | — | no | SNS `PersistIndexerPagerDutyAlertTopic`; EventBridge rate 1 h with `{action:"scan-active-alarms"}` |
| `PersistWorkflowStart` | `lambda/workflow-start/` | 512 | 30 s | — | no | `PersistNeptuneCsvWorkflow` `PrepareWorkflowInput` |
| `PersistWorkflowCostPredictor` | `lambda/workflow-cost-predictor/` | 512 | 60 s | — | no | `PredictWorkflowCost` |
| `PersistWorkflowValidate` | `lambda/workflow-validate/` | 1024 | 15 min | — | no | Distributed Map `ValidateWorkflowCsvObjects` |
| `PersistWorkflowItemStage` | `lambda/workflow-item-stage/` | 4096 + 10240 MiB ephemeral | 15 min | — | yes | `Stage{Vertex,Edge}CsvObject` |
| `PersistWorkflowItemDispatch` | `lambda/workflow-item-dispatch/` | 512 | 5 min | — | yes | `Enqueue{Vertex,Edge}Aggregate` (task token) and `Start{Vertex,Edge}DirectLoad` |
| `PersistWorkflowItemStatus` | `lambda/workflow-item-status/` | 1024 | 180 s | — | yes | none (defined and granted, not wired) |
| `PersistWorkflowItemStatusSimple` | `lambda/workflow-item-status-simple/` | 1024 | 180 s | — | yes | `Check{Vertex,Edge}LoadStatus` |
| `PersistWorkflowIndexCatchup` | `lambda/workflow-index-catchup/` | 512 | 60 s | — | yes | `CaptureIndexCatchupTarget`, `CheckIndexCatchup`, `CaptureLoadedStreamTarget` |
| `PersistCsvWorkflowMetrics` | `lambda/csv-workflow-metrics/` | 1024 | 15 min | — | no | `PersistCsvWorkflowMetricsRule` (4.6) |

Retry policies attached to these tasks (Lambda transient errors, `NeptuneBulkLoadQueueFullError`, `PersistBlobStoreError`) and the state machine shapes are specified in `async-gremlin.md`, `csv-bulk-load-workflow.md`, and `derived-index-maintenance.md`.

### 4.5 Fargate

`GremlinAsyncCluster` (ECS, Container Insights off) runs `GremlinAsyncTaskDef`: 1024 CPU / 2048 MiB, `LINUX/ARM64`, image built from `lambda/fargate/Dockerfile` (`node:24-slim`, `ENTRYPOINT node index.mjs`) with the repository root as context and `CONTAINER_ASSET_EXCLUDES` applied, `stopTimeout` 120 s, logs to `GremlinAsyncFargateLogGroup` with stream prefix `gremlin-async-fargate`. The `ExecuteQuery` task runs it with `WAIT_FOR_TASK_TOKEN` in the private subnets with `LambdaSg`, no public IP, injecting `TASK_TOKEN` and `QUEUE_MESSAGE` as container overrides; heartbeat 900 s, task timeout 4800 s, state machine timeout 6000 s. The container targets the async reader (`NEPTUNE_ASYNC_READER_HOST`) with a client execution ceiling of 3 720 000 ms (1 h query + 2 min slack).

### 4.6 Routing fabric

- **HTTP API** `PersistApi`: default stage, CORS preflight `allowOrigins: ["*"]`, methods GET/POST/PUT/PATCH/DELETE, `allowHeaders: ["Content-Type"]`. Every route uses `HttpIamAuthorizer`. Routes: `POST /persist/graphql` and `GET /persist/graphql/schema` → `PersistGraphQlHandler`; `/persist` and `/persist/{proxy+}` for GET/POST/PUT/PATCH/DELETE → `PersistHandler`. The router behind the proxy route serves `POST /persist/ingest`, `POST /persist/ingest-async`, `POST /persist/validate`, `POST /persist/gremlin`, `POST /persist/gremlin/explain`, `POST /persist/gremlin-async`, `GET|DELETE /persist/gremlin-async/{requestId}` (`lambda/api/definitions.ts`).
- **EventBridge rules**: `GraphFactProducedRule` on the bus named by `graphFactEventBusName`, pattern `detail-type=["GraphFactProduced"]`, `detail.graphson_format=["graphson-v3"]`, target `PersistGraphFactHandler` with `retryAttempts: 3`, `maxEventAge: 2 h`, DLQ `GraphFactEventDlq`. `PersistIndexRebuildFailureRule` on the default bus, `source=["aws.states"]`, `detail-type=["Step Functions Execution Status Change"]`, `detail.stateMachineArn=[PersistIndexRebuildWorkflow]`, `status in [FAILED, TIMED_OUT, ABORTED]` → `IndexRebuildFail`. `PersistCsvWorkflowMetricsRule` on the default bus, `source=[PERSIST_CSV_WORKFLOW_EVENT_SOURCE]`, `detail-type=[PERSIST_CSV_WORKFLOW_LOADED_DETAIL_TYPE]` (constants in `lambda/schemas/workflow.ts`) → `PersistCsvWorkflowMetrics`. `PersistIndexerPagerDutyActiveAlarmScanSchedule` rate 1 h → `PersistPagerDutyAlert`.
- **EventBridge Scheduler**: `IndexStreamPollSchedule` (1 min, no retries), `IndexStreamLagProbeSchedule` (1 min, no retries), `IndexDiscoveryPollSchedule` (1 h).
- **EventBridge Pipe** `GremlinAsyncPipe`: source `GremlinAsyncQueue` batch 1, target `GremlinAsyncStateMachine` `FIRE_AND_FORGET`, role `GremlinAsyncPipeRole` (consume messages + `states:StartExecution`).
- **State machines**: `GremlinAsyncStateMachine` (`UnwrapSqsRecord $[0]` → `ValidateAndSetRunning` → `ShouldExecute` → `SkipExecution` | `ExecuteQuery`; both tasks catch into `HandleFailure`, which retries `States.ALL` up to 4 attempts and receives `retryCount`/`maxRetryCount=3`; tracing on). `PersistIndexRebuildWorkflow` (`PrepareIndexRebuild` → `EnumerateIndexRebuildRanges` map → `RecomputeIndexBatchFiles` map → `FinalizeIndexRebuild`; 6 h timeout; no catch chain; tracing on). `PersistNeptuneCsvWorkflow` (STANDARD, `PersistNeptuneCsvWorkflowRole`, ALL-level logging to `PersistWorkflowStateMachineLogGroup`, tracing on; aggregate-vs-direct decision is a `Choice` on `$.stageResult.stagedBytes` — or `$.objectSize` under `workflowRouteSizeBasis=raw` — against the CDK constant 16 MiB; Glue rehash step `RunPersistSparkRehash` uses the job name from SSM).
- **SNS + alarms**: `PersistIndexerPagerDutyAlertTopic` with five CloudWatch alarms (poller errors, stream lag ≥ 1800 s, lag-probe errors, rebuild unsuccessful, Neptune reader CPU > 80 % for 15 min) — `operations-dashboards-and-alerting.md`.

### 4.7 API exposure and cross-account access

The API is reachable only at the execute-api endpoint of the default stage; no `AWS::ApiGatewayV2::DomainName` or `ApiMapping` exists. `PersistStack` publishes that URL to SSM `persist-api-url` and creates `PersistApiCrossAccountInvokeRole`, trusted by a `CompositePrincipal` of account principals computed by `getPersistApiCrossAccountInvokeAccountIds(account)`: a fixed external caller account, the sibling-stage account of the same organisation, and — in the dev account only — one additional external caller account. The role grants `execute-api:Invoke` on `arnForExecuteApi("*", "/persist", "*")` and `("*", "/persist/*", "*")`. Its ARN is published as SSM `persist-api-cross-account-invoke-role-arn` and output `PersistApiCrossAccountInvokeRoleArn`. Every caller, in-account or assumed-role, SigV4-signs `execute-api` requests.

## 5. IAM

Every VPC Lambda role gets the `AWSLambdaVPCAccessExecutionRole` managed policy; non-VPC functions keep the default `AWSLambdaBasicExecutionRole`. `<cluster>` below is `arn:<partition>:neptune-db:<region>:<account>:<clusterResourceId>/*`, built from the persistence target's resource ID. "Wildcard lexicon read" is `s3:GetObject` on `arn:<partition>:s3:::*/*`, granted because the lexicon bucket is only known as an SSM value at synth. CDK `grantPut` / `grantRead` / `grantReadWrite` emit action bundles (`s3:PutObject*`, `s3:Abort*`, `s3:GetObject*`, `s3:GetBucket*`, `s3:List*`, `s3:DeleteObject*` for read-write) scoped to the bucket and the named prefix.

| Role | Neptune | Other |
| ---- | ------- | ----- |
| `PersistHandler` | `connect`, `ReadDataViaQuery`, `WriteDataViaQuery`, `DeleteDataViaQuery`, `GetQueryStatus`, `CancelQuery` on `<cluster>` | `dynamodb:GetItem/PutItem/UpdateItem` on jobs table; `sqs:SendMessage` on `GremlinAsyncQueue` and `IngestAsyncQueue`; `es:ESHttp*` on `domain/*`; `dynamodb:GetItem` on the search sync table; wildcard lexicon read; put on `ingest-async/*`; put + read on `persist-blobs/*` |
| `PersistGraphQlHandler` | `connect`, `ReadDataViaQuery` | `s3:GetObject` on `<lexicon-bucket>/*` (bucket parsed from the SSM URI) and `graphql-resolution-map/*`; `grantRead` on the map prefix; `secretsmanager:GetSecretValue` on the stage's Interprose secret only. No DynamoDB grant exists today; add one when the resolution map declares a `dynamodb` source |
| `PersistGraphFactHandler` | `connect`, `ReadDataViaQuery`, `WriteDataViaQuery` | wildcard lexicon read; put on `ingest-async/*`; put + read on `persist-blobs/*`; `sqs:SendMessage` on `IngestAsyncQueue` |
| `PersistAsyncBulkWorker` | `connect`, `ReadDataViaQuery`, `StartLoaderJob`, `GetLoaderJobStatus`, `ListLoaderJobs` | `states:SendTaskSuccess/SendTaskFailure` on `*`; read `ingest-async/*`; put `bulk-load/*`; put + read `persist-blobs/*`; send on `FilteredBatchQueue`; consume on `IngestAsyncQueue` |
| `PersistAsyncBulkAggregateWorker` | same five loader actions | `states:SendTaskSuccess/SendTaskFailure` on `*`; read `bulk-load/*`; read-write `bulk-load-aggregate/*` and `workflow-summaries/*`; consume on `FilteredBatchQueue` |
| `GremlinAsyncValidate` | — | `dynamodb:GetItem/UpdateItem` on jobs table |
| `GremlinAsyncFailureHandler` | `connect`, `GetQueryStatus`, `CancelQuery` | `dynamodb:GetItem/UpdateItem` on jobs table |
| Fargate task role | `connect`, Read/Write/Delete `DataViaQuery`, `GetQueryStatus`, `CancelQuery` | `dynamodb:GetItem/UpdateItem` on jobs table; `s3:PutObject` on `gremlin-async/results/*`; `states:SendTaskSuccess/SendTaskFailure/SendTaskHeartbeat` on `*`; `es:ESHttp*` on `domain/*`; `dynamodb:GetItem` on the search sync table |
| `PersistAsyncGremlinWorker` (legacy) | as Fargate | `dynamodb:GetItem/UpdateItem`; `es:ESHttp*`; search-table `GetItem`; put on `gremlin-async/results/*` |
| Index Lambdas (`IndexRebuildPrepare`, `RangeEnumerator`, `ShardWorker`, `ListBatches`, `Finalize`, `Fail`, `IndexStreamPoller`) | `connect`, `GetStreamRecords`, `ReadDataViaQuery`, `WriteDataViaQuery`, `DeleteDataViaQuery` (single-cardinality replace bills as a delete) | wildcard lexicon read; read-write `index-rebuild/*` (rebuild set only); `grantReadWriteData` on `DerivedIndexStateTable`; `IndexRebuildFail` also `states:DescribeExecution` on the rebuild workflow |
| `IndexStreamLagProbe` | `connect`, `GetStreamRecords` | `grantReadData` on `DerivedIndexStateTable` |
| `IndexDiscoveryPoller` (no VPC) | — | wildcard lexicon read; `states:ListExecutions` and `StartExecution` on `PersistIndexRebuildWorkflow`; read-write on `DerivedIndexStateTable` |
| `PersistPagerDutyAlert` | — | read-write dedupe table; `secretsmanager:GetSecretValue` on the pager secret; `cloudwatch:DescribeAlarms` on `*` |
| `PersistWorkflowStart` | — | none beyond basic execution |
| `PersistWorkflowCostPredictor` | — | `s3:ListBucket` on `arn:<partition>:s3:::*` |
| `PersistWorkflowValidate` | — | wildcard lexicon read; `s3:ListBucket` on `*` |
| `PersistWorkflowItemStage` | `connect`, `ReadDataViaQuery` (dedup only; never starts a load) | wildcard read; `s3:ListBucket` on `*`; read-write `bulk-load/*` and `workflow-summaries/*`; put + read `persist-blobs/*` |
| `PersistWorkflowItemDispatch` | `connect`, `StartLoaderJob`, `GetLoaderJobStatus`, `ListLoaderJobs` | read `bulk-load/*`; send on `FilteredBatchQueue` |
| `PersistWorkflowItemStatus`, `...Simple` | `GetLoaderJobStatus` | read-write `workflow-summaries/*` |
| `PersistWorkflowIndexCatchup` | `GetStreamRecords` | `grantReadData` on `DerivedIndexStateTable` |
| `PersistCsvWorkflowMetrics` | — | read `workflow-summaries/*` and `bulk-load/*` |
| `PersistNeptuneCsvWorkflowRole` (state machine) | — | `s3:ListBucket` on `*`; `glue:StartJobRun`, `glue:GetJobRun`, `glue:GetJobRuns`, `glue:BatchStopJobRun` on `*` (optimized Glue integration requires wildcard); plus CDK-generated `lambda:InvokeFunction`, `events:PutEvents`, and Distributed Map grants |
| `PersistIndexRebuildWorkflow` role | — | read-write on `IndexMaintenanceBucket` `index-rebuild/*`; `s3:ListBucket` on `*` from the item reader; CDK invoke grants |
| `GremlinAsyncPipeRole` | — | consume `GremlinAsyncQueue`; `states:StartExecution` on `GremlinAsyncStateMachine` |
| `PersistApiCrossAccountInvokeRole` | — | `execute-api:Invoke` on `/persist` and `/persist/*` (4.7) |

Hardening targets visible from this table: the wildcard lexicon read on twelve roles across six rows of this table (only the GraphQL handler is bucket-scoped), `s3:ListBucket` on `*` for the workflow roles and item readers, and `es:ESHttp*` on every domain in the account.

## 6. Outputs and SSM parameters

Published by `PersistStack`:

| Kind | Name | Value |
| ---- | ---- | ----- |
| Output | `ApiUrl` | HTTP API execute-api endpoint |
| Output | `PersistApiCrossAccountInvokeRoleArn` | cross-account invoke role ARN |
| Output | `NeptuneCsvWorkflowArn` | `PersistNeptuneCsvWorkflow` ARN |
| Output | `PersistIndexRebuildWorkflowArn` | `PersistIndexRebuildWorkflow` ARN |
| SSM | `persist-api-url` | execute-api endpoint (read by the API and GraphQL e2e tests) |
| SSM | `persist-api-cross-account-invoke-role-arn` | invoke role ARN |
| SSM | `persist-neptune-csv-workflow-arn` | CSV workflow ARN (read by `DebtIndexExportStack`) |
| SSM | `persist-index-rebuild-workflow-arn` | rebuild workflow ARN |
| SSM | `persist-csv-workflow-metrics-log-group` | log group of `PersistCsvWorkflowMetrics` (read by the ingest-metrics e2e test) |

Consumed by `PersistStack` at synth (`StringParameter.valueForStringParameter`): `/lexicon/data-uri` (lexicon S3 URI; owned by the Lexicon product), `/persist-spark/glue/neptune-csv-rehash/job-name` (Glue rehash job; owned by the Spark product), `/persist/opensearch/collection-endpoint` (published by `PersistSearchStack`, which also publishes `/persist/opensearch/collection-arn`, `/persist/opensearch/index-name`, `/persist/opensearch/backfill-workflow-arn`). `NeptuneStack` outputs and SSM are in section 3; `DebtIndexExportStack` publishes `/persist/debt-index-export/{workflow-arn,bucket,table,view,stream-export-workflow-arn,athena-index-stream-smoke-function-name,athena-raw-stream-capture-function-name}` (`athena-debt-index-export.md`).

## 7. Environment variables

Canonical table of every key read under `lambda/` (Effect `Config.*` or `process.env`). "Code default" is what the reader falls back to; "required" means the function fails at startup without it. "CDK" lists what `lib/persist-stack.ts` sets, with per-function overrides where they differ. Keys set by CDK but read nowhere are flagged. Sibling-owned families list keys only.

**Runtime and logging**

| Key | Code default | CDK | Consumer |
| --- | ------------ | --- | -------- |
| `POWERTOOLS_SERVICE_NAME` | `persist` / `persist-graphql` fallbacks in metrics services | one name per function (`persist`, `persist-graphql`, `persist-graph-fact`, `persist-async-worker`, `persist-index-stream-poller`, ...) | Powertools logger/metrics |
| `POWERTOOLS_LOG_LEVEL` | Powertools default | `INFO` everywhere | logger |
| `POWERTOOLS_METRICS_NAMESPACE` | `persist` | `persist` (omitted on the async-Gremlin functions, the pager, `WorkflowStart`, `WorkflowValidate`, and `WorkflowIndexCatchup`) | metrics |
| `NODE_OPTIONS` | — | `--enable-source-maps` on every Lambda | runtime |
| `AWS_REGION` | required in `NeptuneConfig`; hard-coded fallback strings elsewhere (never exercised: Lambda always sets it) | set by Lambda/ECS | every SDK client |
| `AWS_ACCOUNT_ID` | `""` | `Aws.ACCOUNT_ID` on `PersistPagerDutyAlert` | pager alert links |

**Neptune connection, retry, Gremlin client**

| Key | Code default | CDK | Consumer |
| --- | ------------ | --- | -------- |
| `NEPTUNE_WRITER_HOST` | required | writer endpoint; GraphQL handler gets the reader endpoint so it cannot write | `NeptuneConfig`, bulk loader |
| `NEPTUNE_READER_HOST` | required | general reader endpoint (custom or `cluster-ro` per `neptuneReaderEndpointMode`) | `NeptuneReaderConfig`, stream client, data API |
| `NEPTUNE_ASYNC_READER_HOST` | optional | async reader instance endpoint on `PersistHandler`, `GremlinAsyncFailureHandler`, Fargate container, legacy worker | `NeptuneDataApiGremlinService` |
| `NEPTUNE_PORTAL_READER_HOST`, `NEPTUNE_AGENCY_READER_HOST` | optional (fall back to `NEPTUNE_READER_HOST`) | only on `PersistHandler`, only when the endpoint exists | `readerTarget` routing |
| `NEPTUNE_HOST` | not read by any code | set on most functions | legacy, dead |
| `NEPTUNE_PORT` | `8182` | cluster port attribute | all clients |
| `NEPTUNE_RETRY_MAX_ATTEMPTS` | 5 | `PersistHandler` 2; GraphQL 3; GraphFact 3; `WorkflowItemStage` 10 | `NeptuneRetryConfig` |
| `NEPTUNE_RETRY_BASE_DELAY_MS` | 1000 | 1000 where set | retry backoff |
| `NEPTUNE_CONNECTION_MAX_AGE_MS` | 2 700 000 | unset | connection rotation |
| `GREMLIN_READER_POOL_SIZE` / `GREMLIN_WRITER_POOL_SIZE` | 1 / 1 | index Lambdas 8 / 8; `IndexStreamPoller` 200 / 32 | `GremlinClient` pools |
| `GREMLIN_SYNC_EVALUATION_TIMEOUT_MS` | 30 000 (also the ceiling; clamped to 10–30 000) | 30 000 on `PersistHandler` and GraphQL | sync query `evaluationTimeout` |
| `GREMLIN_BATCH_EXISTS_CHUNK_SIZE` | 1000 | 1000 on `WorkflowItemStage` | existence checks |
| `GREMLIN_BATCH_EXISTS_CONCURRENCY` | 100 (hard cap 110) | 110 on `WorkflowItemStage` | existence checks |
| `GREMLIN_EXPLAIN_TIMEOUT_MS` / `GREMLIN_EXPLAIN_MAX_REPORT_BYTES` | 25 000 / 4 MiB | unset | `gremlin-explain.md` |

**Lexicon**

| Key | Code default | CDK | Consumer |
| --- | ------------ | --- | -------- |
| `LEXICON_DATA_URI` | required (`GraphQlSchemaService` defaults the display value to `configured`) | SSM `/lexicon/data-uri` on every lexicon reader; also injected into the CSV workflow as `$.lexiconDataUri` | `LexiconSchemaService` |
| `LEXICON_OBJECT_TIMEOUT_MS` | 10 000 | unset | lexicon S3 fetch |

**GraphSON ingest and graph facts**

| Key | Code default | CDK | Consumer |
| --- | ------------ | --- | -------- |
| `INGEST_ASYNC_PAYLOAD_BUCKET` | required | bucket name | API, GraphFact, bulk worker |
| `INGEST_ASYNC_QUEUE_URL` | required | queue URL | API, GraphFact |
| `INGEST_ASYNC_MAX_RECEIVE_COUNT` | 5 | 5 (mirrors the DLQ setting) | bulk worker |
| `INGEST_FILTERED_BATCH_QUEUE_URL` | required | queue URL on `PersistHandler`, bulk worker, dispatch | `AsyncFilteredBatchEnqueueService`, used only by `WorkflowItemDispatch` (the API and bulk-worker copies are read by nothing) |
| `INGEST_FILTERED_BATCH_MAX_RECEIVE_COUNT` | 5 | 5 | aggregate worker |
| `SYNC_INGEST_MAX_ELEMENTS` | 50 | 50 on GraphFact | sync/async routing |

**Bulk load**

| Key | Code default | CDK | Consumer |
| --- | ------------ | --- | -------- |
| `NEPTUNE_BULK_BUCKET` | required | bulk-load bucket | all bulk paths |
| `NEPTUNE_BULK_PREFIX` | `bulk-load` | `bulk-load` on bulk worker | `NeptuneCsvService` |
| `NEPTUNE_FILTERED_BULK_PREFIX` | `bulk-load-aggregate` | same | aggregate worker |
| `WORKFLOW_BULK_PREFIX` | `bulk-load` | same on `WorkflowItemStage` | staging |
| `WORKFLOW_SUMMARY_PREFIX` | `workflow-summaries` | same | summaries, metrics |
| `NEPTUNE_BULK_IAM_ROLE_ARN` | required | bulk-load role ARN | `StartLoaderJob` |
| `NEPTUNE_BULK_REGION` | hard-coded fallback | stack region | loader HTTP client |
| `BULK_POLL_INTERVAL_MS` / `BULK_MAX_WAIT_MS` | 5000 / 840 000 | 5000 / 840 000 (`MAX_WAIT` omitted on status functions) | loader poller |
| `NEPTUNE_BULK_START_REQUEST_TIMEOUT_MS` | none (falls back to `NEPTUNE_BULK_REQUEST_TIMEOUT_MS`) | 120 000 | start call |
| `NEPTUNE_BULK_STATUS_REQUEST_TIMEOUT_MS` | none (fallback as above; 30 000 in status-simple) | 30 000 | status call |
| `NEPTUNE_BULK_REQUEST_TIMEOUT_MS` | none | 30 000 | legacy fallback |
| `NEPTUNE_BULK_STATUS_LOG_EVERY_POLLS` | 12 | 12 | log cadence |

**CSV workflow**

| Key | Code default | CDK | Consumer |
| --- | ------------ | --- | -------- |
| `PERSIST_SPARK_OUTPUT_BUCKET` / `PERSIST_SPARK_OUTPUT_PREFIX` | required / `workflow-rehash` | bulk-load bucket / `workflow-rehash` on `WorkflowStart` | rehash output |
| `WORKFLOW_COST_CEILING_USD` | 25 | 25 | `WorkflowStart` |
| `WORKFLOW_COST_PER_GB_USD` / `WORKFLOW_COST_PER_1000_OBJECTS_USD` | 0.12 / 0.0004 | same | cost predictor |
| `WORKFLOW_COST_PREDICTOR_REQUEST_TIMEOUT_MS` | 10 000 | 10 000 | predictor S3 list |
| `WORKFLOW_VALIDATION_REQUEST_TIMEOUT_MS` | 30 000 | 30 000 | validate |
| `WORKFLOW_MAX_OBJECT_SIZE_BYTES` | 524 288 000 | same | dedup size guard |
| `NEPTUNE_CSV_DEDUP_BATCH_SIZE` | 1000 | 1000 | dedup |
| `NEPTUNE_CSV_DEDUP_BATCH_CONCURRENCY` | 100 | 110 | vertex dedup |
| `NEPTUNE_CSV_EDGE_DEDUP_BATCH_CONCURRENCY` | 100 | 8 | edge dedup |
| `WORKFLOW_INDEX_CATCHUP_POLL_INTERVAL_SECONDS` / `_MAX_ATTEMPTS` | 60 / 180 | 60 / 180 | index catch-up |
| `CSV_WORKFLOW_METRICS_COUNT_CONCURRENCY` | 8 | 8 | metrics Lambda |
| (no env) direct-load threshold | — | CDK constant 16 MiB in the `Choice`; basis via `workflowRouteSizeBasis` | — |

**Blob store** (`lambda/config/blob.ts`; CDK sets the same block on `PersistHandler`, GraphFact, bulk worker, `WorkflowItemStage`)

| Key | Code default | CDK |
| --- | ------------ | --- |
| `PERSIST_BLOB_BUCKET` | required | blob bucket |
| `PERSIST_BLOB_PREFIX` | `persist-blobs` | `persist-blobs` |
| `PERSIST_BLOB_MAX_BYTES` | 1 048 576 | same (also read by validation services) |
| `PERSIST_BLOB_OBJECT_TIMEOUT_MS` / `PERSIST_BLOB_TOTAL_TIMEOUT_MS` | 10 000 / 120 000 | same |
| `PERSIST_BLOB_S3_MAX_ATTEMPTS` / `PERSIST_BLOB_RETRY_MAX_ATTEMPTS` / `PERSIST_BLOB_RETRY_BASE_MS` | 8 / 8 / 200 | same |
| `PERSIST_BLOB_PUT_CONCURRENCY` | 16 | 16 |

**Async Gremlin**

| Key | Code default | CDK | Consumer |
| --- | ------------ | --- | -------- |
| `GREMLIN_ASYNC_QUEUE_URL` | required | queue URL on `PersistHandler` | submit |
| `GREMLIN_ASYNC_JOBS_TABLE_NAME` | required | jobs table | job store |
| `GREMLIN_ASYNC_JOB_TTL_SECONDS` | 604 800 | unset | DDB TTL |
| `GREMLIN_ASYNC_RESULTS_BUCKET` / `_PREFIX` | required / `gremlin-async/results` | bucket / same | result store |
| `GREMLIN_ASYNC_EXECUTION_TIMEOUT_MS` | 840 000 | Fargate 3 720 000; legacy worker 840 000 | data API execution |
| `GREMLIN_ASYNC_MAX_EXECUTION_TIMEOUT_MS` | 840 000 | Fargate 3 720 000 | ceiling |
| `GREMLIN_ASYNC_STATUS_REQUEST_TIMEOUT_MS` | 30 000 | legacy worker 30 000 | status call |
| `GREMLIN_ASYNC_CANCEL_REQUEST_TIMEOUT_MS` | none (falls back to the status timeout, 30 000 by default) | unset | cancel call |
| `GREMLIN_ASYNC_MAX_RECEIVE_COUNT` | 5 | legacy worker 5 | legacy worker only |
| `GREMLIN_ASYNC_STATUS_POLL_INTERVAL_MS`, `GREMLIN_ASYNC_STATUS_LOG_EVERY_POLLS` | not read by any code | legacy worker 2000 / 15 | dead |
| `TASK_TOKEN`, `QUEUE_MESSAGE` | required | Step Functions container overrides | Fargate entrypoint |

**Derived index maintenance** (CDK block `indexLambdaEnvironment` shared by all index Lambdas; overrides noted)

| Key | Code default | CDK | Consumer |
| --- | ------------ | --- | -------- |
| `INDEX_MAINTENANCE_BUCKET` / `INDEX_REBUILD_PREFIX` | required / `index-rebuild` | bucket / same | rebuild service |
| `DERIVED_INDEX_STATE_TABLE_NAME` | required | state table (also on `WorkflowIndexCatchup`) | checkpoint and definition stores |
| `INDEX_REBUILD_STATE_MACHINE_ARN` | required | rebuild workflow ARN on `IndexDiscoveryPoller` | discovery |
| `INDEX_DISCOVERY_MAX_INDEXES_PER_EXECUTION` | 1 | 1 | discovery |
| `INDEX_REBUILD_RANGE_SIZE` | 500 000 | 500 000 | range enumeration |
| `INDEX_REBUILD_BATCH_FILE_TRIGGER_IDS` | 25 000 | 25 000 | batch files |
| `INDEX_REBUILD_OWNER_QUERY_BATCH_SIZE` | 50 | 50 | owner queries |
| `INDEX_REBUILD_SPARSE_MAX_CANDIDATE_ELEMENTS` | 5 000 000 | 5 000 000 | sparse rebuild ceiling |
| `INDEX_REBUILD_SHARD_SIZE` | 1000 | 1000 | shards |
| `INDEX_REBUILD_MAX_CONCURRENCY` | 20 | 20 | fallback when the input omits both map values |
| `INDEX_REBUILD_RANGE_MAP_MAX_CONCURRENCY` / `_BATCH_MAP_MAX_CONCURRENCY` | 25 / 25 | 25 / 25 | `$.rangeMapMaxConcurrency` / `$.batchMapMaxConcurrency` |
| `INDEX_REBUILD_WORKER_CONCURRENCY` | 25 | 25 | shard worker |
| `INDEX_STREAM_POLL_LIMIT` | 100 000 | 50 000 index Lambdas; 1 lag probe; 10 000 `WorkflowIndexCatchup` | stream client |
| `INDEX_STREAM_REQUEST_TIMEOUT_MS` | 30 000 | 30 000 on `WorkflowIndexCatchup` | stream client |
| `INDEX_STREAM_LEASE_TTL_SECONDS` | 120 | 120 | checkpoint lease |
| `INDEX_STREAM_MAX_TRANSACTIONS_PER_POLL` | 2500 | 250 | poller |
| `INDEX_STREAM_MAX_LOOPS_PER_INVOCATION` | 700 | 500 | poller |
| `INDEX_STREAM_MIN_REMAINING_MS` | 15 000 | 10 000 | poller deadline |
| `INDEX_STREAM_LEASE_SAFETY_SECONDS` | 5 | 5 | poller |
| `INDEX_STREAM_MAX_RECOMPUTATIONS_PER_INVOCATION` | 40 000 | 60 000 | poller budget |
| `INDEX_STREAM_RECOMPUTE_BATCH_SIZE` | 25 | 250 | poller |
| `INDEX_STREAM_RECOMPUTE_CONCURRENCY` | 50 | 1500 shared block; `IndexStreamPoller` 200 | poller |
| `INDEX_WRITER_MUTATION_BATCH_SIZE` / `_CONCURRENCY` | 25 / 1 | 250 / 8 | index writer |
| `INDEX_WRITER_OWNER_READ_BATCH_SIZE` | 50 | 250 | index writer |

**GraphQL and Interprose** (`PersistGraphQlHandler` only)

| Key | Code default | CDK | Consumer |
| --- | ------------ | --- | -------- |
| `GRAPHQL_RESOLUTION_MAP_URI` | required | `s3://<map-bucket>/graphql-resolution-map/graphql-resolution-map.json` | resolution map |
| `GRAPHQL_RESOLUTION_MAP_TIMEOUT_MS` | 10 000 | 10 000 | map fetch |
| `GRAPHQL_MAX_QUERY_DEPTH` / `_COMPLEXITY` / `GRAPHQL_MAX_LIST_PAGE_SIZE` | 8 / 1000 / 100 | same | executor |
| `GRAPHQL_FIELD_TIMEOUT_MS` | 5000 | 5000 | DynamoDB and Interprose resolvers |
| `GRAPHQL_PII_ACCESS_POLICY_JSON` | `{"default":["ssn_last_four"],"principals":[]}` | policy granting `full_ssn` to an agent-runtime role-name pattern in each account (`graphql-pii-access-policy.md`) | PII policy |
| `INTERPROSE_BASE_URL` / `INTERPROSE_CREDENTIALS_SECRET_ARN` / `INTERPROSE_CUSTOMER_ID` | required, all three | QA host and dev secret in the dev account, production host and prod secret otherwise; fixed customer id | vendor client |
| `INTERPROSE_MAX_CONCURRENT_REQUESTS` / `INTERPROSE_MAX_BATCH_SIZE` / `INTERPROSE_CACHE_TTL_SECONDS` | 4 / 25 / 60 | same | vendor client |
| `<entry.table_env>` | dynamic: each `dynamodb` resolution-map entry names the env var holding its table | none set today | DynamoDB resolver |

**Full-text search** (set through `openSearchEnvironment` on `PersistHandler`, GraphQL, Fargate, legacy worker; spec in `opensearch-fts-mirror.md`): `OPENSEARCH_COLLECTION_ENDPOINT` (SSM value), `OPENSEARCH_COLLECTION_ARN` (`domain/*` wildcard), `OPENSEARCH_INDEX_NAME` (`amazon_neptune`), `GREMLIN_FTS_ALLOWED_QUERY_TYPES` (`simple_query_string,match,prefix,fuzzy,term,query_string`), `GREMLIN_FTS_DEFAULT_QUERY_TYPE` (`simple_query_string`), `GREMLIN_FTS_MAX_RESULTS` (40 000), `GREMLIN_FTS_ALLOW_CALLER_ENDPOINT` (`false`), `SEARCH_SYNC_STATE_TABLE_NAME`, `SEARCH_FRESHNESS_MAX_LAG_SECONDS` (300). Code defaults match the CDK values.

**Paging** (`PersistPagerDutyAlert`; behaviour in `operations-dashboards-and-alerting.md`): `PAGERDUTY_SERVICE_NAME` (default `daily_tasking`; CDK `persist`), `PAGERDUTY_SECRET_ARN` (default a hard-coded secret ARN; CDK sets the same), `ALERT_DEDUPE_TABLE_NAME` (required), `ALERT_WINDOW_MINUTES` (60), `ALERT_TTL_DAYS` (7), `ALERT_ALARM_NAMES` (CSV, set via `addEnvironment` after the alarms exist), `ALERT_SUMMARY_PREFIX` (`Persist indexing`), `ALERT_SOURCE` (`persist-indexer`), `ALERT_ALARM_NAME_PREFIX` (read; CDK sets `ALARM_NAME_PREFIX=PersistIndexer` instead, so the prefix is never applied and the scan relies on `ALERT_ALARM_NAMES`).

**Owned by other stacks** (keys only): `OPENSEARCH_MAINTENANCE_BUCKET`, `OPENSEARCH_BACKFILL_PREFIX`, `OPENSEARCH_REQUEST_TIMEOUT_MS`, `OPENSEARCH_BULK_MAX_ATTEMPTS`, `OPENSEARCH_BULK_RETRY_BASE_MS`, `OPENSEARCH_INDEX_SHARDS`, `OPENSEARCH_INDEX_REPLICAS`, `OPENSEARCH_INDEX_MAX_RESULT_WINDOW`, `SEARCH_BACKFILL_{SHARD_SIZE,SLAB_SIZE,MAX_SHARDS,MAX_CONCURRENCY,FINALIZE_PAGE_SIZE}`, `SEARCH_STREAM_{LEASE_TTL_SECONDS,MIN_REMAINING_MS,MAX_LOOPS_PER_INVOCATION}` (`opensearch-fts-mirror.md`); `DEBT_INDEX_EXPORT_{BUCKET,DATABASE,TABLE,VIEW,RUNS_PREFIX,SCHEMA_VERSION,MAX_SHRINK_RATIO,ATHENA_WORKGROUP,LOCK_TABLE,SPARSE_PAGE_ROWS,SPARSE_PERSON_PAGE_ROWS,DENSE_PAGE_ROWS,KEY_PAGE_ROWS,PROJECTION_BATCH_ROWS}`, `DEBT_KEY_LIST_{STARTED_AT,EXECUTION_NAME}`, `ATHENA_RAW_STREAM_BUCKET`, `RAW_STREAM_{MIN_REMAINING_MS,MAX_PAGES_PER_INVOCATION}`, `STREAM_EXPORT_LOCK_TABLE` (`athena-debt-index-export.md`, `neptune-stream-export.md`, `athena-index-stream-consumer.md`). `GREMLIN_TEST_HOST` / `GREMLIN_TEST_PORT` are test-only. The search stack additionally pins on its own Lambdas `SEARCH_STREAM_POLL_LIMIT` (100000, mirrored into `INDEX_STREAM_POLL_LIMIT`), `SEARCH_STREAM_MAX_TRANSACTIONS_PER_POLL` (250, read by no code), and `INDEX_STREAM_LEASE_TTL_SECONDS` (360); see `opensearch-fts-mirror.md` §4.7.

## 8. Verification

`test/cdk/neptune-stack.test.ts` (`NeptuneStack dedicated readers`) asserts: retention mode shrinks blue to two minimal instances with no scale-out capacity; nothing extra is deployed without a dedicated reader; each dedicated reader gets a pinned identifier and a 30 s parameter group; instance-class overrides apply per reader; the general endpoint excludes every deployed dedicated reader and only those; dedicated endpoints are `ANY` with one static member; endpoints depend on their member instances; auto-scaling registers after every permanent reader; the headroom replica is held above the permanent count and dropped when headroom is off; every blue routing export survives the recovery cutover; the endpoint provider has RDS-namespaced control-plane permissions; every deployed endpoint hostname is published to SSM.

`test/cdk/persist-stack.test.ts` (`CDK Neptune wiring`) asserts: the cluster resource ID is exported; the async reader endpoint is exported and its instance carries the 12 h parameter group next to a `db.r8g.8xlarge` writer and `db.r8g.12xlarge` reader; an S3 gateway endpoint exists; the cluster parameter group carries the audit, slow-query (`info`, 5000 ms), streams and 30-day expiry parameters and the cluster exports `["audit","slowquery"]`; backups use 35 days with the `05:00-05:30` / `sun:06:00-sun:06:30` windows, `CopyTagsToSnapshot` and `StorageEncrypted`; `NeptuneSg` allows outbound 443; the peering waves add and remove the expected resources; the cross-account invoke role trusts the computed account list and grants `execute-api:Invoke` on `/persist` and `/persist/*`, with the SSM parameter `persist-api-cross-account-invoke-role-arn`; async Gremlin pins the legacy worker, Fargate container and failure handler to `NEPTUNE_ASYNC_READER_HOST` (distinct from `NEPTUNE_READER_HOST`), sets both execution timeouts to `3720000`, grants `GetQueryStatus`/`CancelQuery` to the API and failure roles, and the state machine carries `HeartbeatSeconds 900`, `TimeoutSeconds 4800` and `6000`, `maxRetryCount`, `States.ALL` retries and `states:SendTaskHeartbeat`; only the REST handler receives the dedicated reader hosts; the GraphQL handler has `NEPTUNE_WRITER_HOST == NEPTUNE_READER_HOST`, the resolution-map URI, the Interprose secret and customer id, and a role with `connect`, `ReadDataViaQuery`, `GetSecretValue`, bucket-scoped `s3:GetObject`, and none of write/delete/`sqs:SendMessage`/`states:StartExecution`/`s3:PutObject`/wildcard S3/ingest or blob prefixes; the async Gremlin infrastructure synthesizes without probe resources; the loaded-stream position is captured after the loads and put on the loaded event (and the event still fires when capture fails); each CSV item is routed on `$.stageResult.stagedBytes` (or `$.objectSize` under `raw`), with the task token only on the aggregate branch and the loader-queue retry only on the direct branch; the sparse candidate ceiling ships without moving existing index defaults; the derived-index resources (state table keys, TTL, Lambdas) synthesize; and the dev-only partner DB-auth role, output and SSM parameter exist only in the dev account.

Run `pnpm vitest run test/cdk` (or `just test`, which includes the CDK phase). Confirm a change to any value in sections 3–7 by updating the matching assertion first.

## 9. Source map

| Concern | Path (persist repo) |
| ------- | ------------------- |
| App topology, context keys, persistence target, reader mode | `bin/app.ts` |
| Account helpers | `lib/deployment-environment.ts` |
| Neptune instance classes, timeouts, replica bounds | `lib/neptune-configuration.ts` |
| NeptuneStack | `lib/neptune-stack.ts`; custom endpoints `lib/neptune-cluster-endpoint.ts`, `lambda/neptune-cluster-endpoint/handler.ts` |
| PersistStack | `lib/persist-stack.ts`; image excludes `lib/container-asset-excludes.ts`; Fargate image `lambda/fargate/Dockerfile` |
| Sibling stacks | `lib/persist-search-stack.ts`, `lib/neptune-recovery-stack.ts`, `lib/debt-index-export-stack.ts`, `lib/indexing-dashboard-stack.ts`, `lib/csv-ingest-dashboard-stack.ts` |
| Route table | `lambda/api/definitions.ts`, `lambda/router.ts`, `lambda/routes/*.router.ts` |
| Config modules | `lambda/config/neptune.ts`, `lambda/config/blob.ts`, `lambda/config/opensearch.ts`, `lambda/config/debt-index-export.ts` |
| Per-service `Config` reads | `lambda/services/*Service.ts` (`GremlinClient.ts`, `GremlinService.ts`, `NeptuneBulkLoaderService.ts`, `IndexRebuildService.ts`, `IndexStreamPollerService.ts`, `IndexStreamClientService.ts`, `IndexWriterService.ts`, `NeptuneDataApiGremlinService.ts`, `GraphQl*Service.ts`, `InterproseClientService.ts`, `Workflow*Service.ts`, `NeptuneCsv*Service.ts`) |
| `process.env` readers | `lambda/workflow-item-status-simple/handler.ts`, `lambda/pagerduty-alert/handler.ts`, `lambda/fargate/gremlin-async-fargate-entrypoint.ts` |
| Deploy recipes | `justfile` (`build`, `deploy`), `cdk.json` |
| CDK tests | `test/cdk/neptune-stack.test.ts`, `test/cdk/persist-stack.test.ts`, `test/cdk/stack-templates.ts` |
