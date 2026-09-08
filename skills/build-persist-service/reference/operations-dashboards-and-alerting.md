# Operations: Dashboards, Paging and Neptune Alarms

Persist detects problems with CloudWatch and pages people through a single, thin bridge: CloudWatch alarms publish to one SNS topic, a paging Lambda deduplicates alarm state changes per hour in DynamoDB and forwards them to a paging service (PagerDuty Events API v2 in the reference implementation), and an hourly scan re-pages while an alarm stays active and resolves incidents when it clears. Two standalone dashboard stacks (derived-index/OpenSearch lag, CSV-ingest volume) read metrics by name only and deploy independently of the producing stacks. Neptune itself exports audit and slow-query logs and is guarded by a sustained reader-CPU alarm. This document is the operational contract; metric producers and pipelines are specified in `csv-bulk-load-workflow.md`, `derived-index-maintenance.md`, `opensearch-fts-mirror.md` and `engineering-conventions-and-testing.md` §3.

## 1. Purpose & scope

- Page only on conditions that need a human now: index maintenance failures, real (not idle) stream backlog, a broken lag monitor, rebuild workflow failures, and a reader that has been saturated for a sustained window.
- Keep paging mechanics out of runtime paths: workers and pollers emit metrics and fail loudly; nothing in the ingest or indexer path talks to the paging service.
- Bound incident volume to one trigger per alarm per hour and auto-resolve on OK.
- Give operators two dashboards that can be changed without redeploying the indexer or the ingest workflow.

Out of scope: OpenSearch replication alarms (created in `PersistSearchStack`, `opensearch-fts-mirror.md`) exist for visibility but are not wired to paging; application logs and tracing are `engineering-conventions-and-testing.md` §3; the CSV workflow itself is `csv-bulk-load-workflow.md`. The export stack deploys a second, independent instance of the same paging handler (own dedupe table, alarms invoke the Lambda directly, prefix-based scan); its alarms are catalogued in `neptune-stream-export.md` §5.

## 2. Architecture

```
 Producers (1-min schedules / workflow events)                 Detection                 Paging
 ┌──────────────────────┐  persist/IndexStream…        ┌────────────────────────┐   ┌─────────────────────┐
 │ IndexStreamLagProbe  │─────────────────────────────►│ PersistIndexer*Alarm   │──►│ SNS topic           │
 │ OpenSearchStreamLag… │  persist/OpenSearchFts…      │ (5 paging alarms)      │OK │ (alarm + OK actions)│
 │ PersistCsvWorkflow   │  persist/CsvWorkflow…        └────────────────────────┘   └──────────┬──────────┘
 │   Metrics            │  AWS/Lambda Errors           ┌────────────────────────┐              ▼
 │ IndexStreamPoller    │  AWS/States Executions*      │ OpenSearch*Alarm (3)   │   ┌─────────────────────┐
 │ Step Functions       │  AWS/Neptune CPUUtilization  │ visibility only        │   │ PersistPagerDutyAlert│
 │ Neptune (service)    │                              └────────────────────────┘   │  prod-gated          │
 └──────────────────────┘                                                           │  DynamoDB dedupe     │
                                                        EventBridge rate(1h) ──────►│  {action: scan}      │
 ┌──────────────────────────────┐  by namespace/name/dimension only                 └──────────┬──────────┘
 │ IndexingDashboardStack       │◄─ no CloudFormation dependency                               ▼
 │ CsvIngestDashboardStack      │                                                   Paging service Events API
 └──────────────────────────────┘                                                   routing key from Secrets Manager
```

Metric namespaces: `persist` (custom, Powertools EMF, dimension `service`), `AWS/Lambda`, `AWS/States`, `AWS/Neptune`. The bridge accepts three inputs — SNS alarm notifications, direct CloudWatch alarm Lambda-action events (`source: aws.cloudwatch`), and the scheduled `{ "action": "scan-active-alarms" }` payload — and normalises all three to `{ alarmName, state, description, reason, stateChangeTime, accountId, region, trigger }`.

## 3. Contracts

### 3.1 Metric catalogue

| Namespace | Metric | Dimensions | Unit | Producer / cadence |
| --- | --- | --- | --- | --- |
| `persist` | `IndexStreamOldestUnprocessedRecordAgeSeconds` | `service=persist` | Seconds | `IndexStreamLagProbe`, every 1 min; `0` when caught up |
| `persist` | `IndexStreamCommitBacklog` | `service=persist` | Count | `IndexStreamLagProbe`; `max(0, latestCommitNum − checkpointCommitNum)` |
| `persist` | `OpenSearchFtsStreamOldestUnprocessedRecordAgeSeconds` | `service=persist-opensearch-fts` | Seconds | `OpenSearchStreamLagProbe`, every 5 min; nothing emitted when the checkpoint is missing |
| `persist` | `OpenSearchFtsStreamCommitBacklog` | `service=persist-opensearch-fts` | Count | `OpenSearchStreamLagProbe` |
| `persist` | `CsvWorkflowVerticesInserted`, `CsvWorkflowEdgesInserted` | `service=persist-csv-workflow` | Count | `PersistCsvWorkflowMetrics`, once per finished CSV workflow execution (net-new rows only) |
| `persist` | ingest / rebuild / blob / FTS counters (`vertices_ingested`, `index_rebuild_properties_written`, `opensearch_write_failures`, …) | `ingest_method`, `phase`, `owner_type`, `index_name`, … | Count / Bytes / ms | `engineering-conventions-and-testing.md` §3.2 — dashboards may add them; none are alarmed today |
| `AWS/Lambda` | `Errors` | `FunctionName` | Count | `IndexStreamPoller`, `IndexStreamLagProbe`, `OpenSearchStreamPoller` |
| `AWS/States` | `ExecutionsFailed`, `ExecutionsTimedOut`, `ExecutionsAborted` | `StateMachineArn` | Count | `PersistIndexRebuildWorkflow`, `PersistOpenSearchBackfillWorkflow` |
| `AWS/Neptune` | `CPUUtilization` | `DBClusterIdentifier`, `Role=READER` | Percent | Neptune, 1-min resolution |

Rules: keep every `persist` dimension bounded (`engineering-conventions-and-testing.md` §3.2); publish `0` rather than skipping a datapoint when a gauge is healthy so widgets stay continuous and `treatMissingData` semantics stay simple; never put blob text or IDs of unbounded cardinality in a dimension.

### 3.2 Alarm catalogue

All alarms in this catalogue use `treatMissingData: NOT_BREACHING` (the export stack's alarms in `neptune-stream-export.md` §5 do not all follow that rule). "Pages" means both `alarmAction` and `okAction` target the paging SNS topic; "visibility" means no action. Physical alarm names are CloudFormation-generated from the logical IDs below; the paging Lambda receives the exact list via `ALERT_ALARM_NAMES`.

| Logical ID | Metric (stat, period) | Comparison / threshold | Eval / datapoints | Severity |
| --- | --- | --- | --- | --- |
| `PersistIndexerStreamPollerErrorsAlarm` | `AWS/Lambda Errors` of `IndexStreamPoller` (Sum, 1 min) | `>= 1` | 1 / 1 | pages, critical |
| `PersistIndexerStreamLagAlarm` | `IndexStreamOldestUnprocessedRecordAgeSeconds` (Maximum, 1 min) | `>= 1800` s | 3 / 3 | pages, critical |
| `PersistIndexerStreamLagProbeErrorsAlarm` | `AWS/Lambda Errors` of `IndexStreamLagProbe` (Sum, 1 min) | `>= 1` | 3 / 3 | pages, critical |
| `PersistIndexerRebuildWorkflowUnsuccessfulAlarm` | math `failed + timedOut + aborted` over `AWS/States` for the rebuild state machine (Sum, 1 min) | `>= 1` | 1 / 1 | pages, critical |
| `PersistIndexerNeptuneReaderCpuHighAlarm` | `AWS/Neptune CPUUtilization` `Role=READER` (Maximum, 1 min) | `> 80` % | 15 / 15 | pages, critical |
| `OpenSearchStreamPollerErrorsAlarm` | `AWS/Lambda Errors` of `OpenSearchStreamPoller` (Sum, 1 min) | `>= 1` | 1 / 1 | visibility |
| `OpenSearchBackfillFailuresAlarm` | `AWS/States ExecutionsFailed` for the backfill state machine (Sum, 1 min) | `>= 1` | 1 / 1 | visibility |
| `OpenSearchStreamLagAlarm` | `OpenSearchFtsStreamOldestUnprocessedRecordAgeSeconds` (Maximum, 5 min) | `>= 1800` s | 2 / 2 | visibility |

Alarm descriptions for paging alarms start with the literal prefix `PagerDuty:`; the bridge strips it and uses the remainder as the incident headline.

### 3.3 Paging bridge (`PersistPagerDutyAlert`)

Runtime: Node 24 / ARM64, 512 MB, 30 s timeout, subscribed to the SNS topic, invoked hourly by an EventBridge rule with `{ "action": "scan-active-alarms" }`. IAM: read/write on the dedupe table, `secretsmanager:GetSecretValue` on the integrations secret, `cloudwatch:DescribeAlarms` on `*`.

| Env var | Default | Meaning |
| --- | --- | --- |
| `AWS_ACCOUNT_ID` | `Aws.ACCOUNT_ID` | Compared with the compiled-in `<production-account>` constant; anything else returns `skipped: non_production_account` and never calls the paging service. |
| `PAGERDUTY_SECRET_ARN` | `<integrations-secret-arn>` | Secrets Manager secret whose JSON maps service name → routing key. |
| `PAGERDUTY_SERVICE_NAME` | `daily_tasking` (handler default); `PersistStack` sets `persist` | Key inside that JSON; the value is `<integration-key>`. |
| `ALERT_DEDUPE_TABLE_NAME` | required | DynamoDB table `pk`/`sk`, PAY_PER_REQUEST, TTL attribute `ttlEpochSeconds`. |
| `ALERT_WINDOW_MINUTES` | `60` | Dedupe window; also the re-page cadence. |
| `ALERT_TTL_DAYS` | `7` | Dedupe record retention. |
| `ALERT_ALARM_NAMES` | comma list of the five paging alarm names | Alarms the scheduled scan describes (batches of 100). |
| `ALERT_ALARM_NAME_PREFIX` | empty | Fallback for the scan when the names list is empty. `PersistStack` sets `ALARM_NAME_PREFIX=PersistIndexer` instead of this key, so that value is read by nothing; the scan there works only because `ALERT_ALARM_NAMES` is populated. The export stack sets the correct key. |
| `ALERT_SUMMARY_PREFIX`, `ALERT_SOURCE` | `Persist indexing`, `persist-indexer` | Incident summary prefix and `payload.source`. |

Trigger payload sent to `<events-api-url>`:

```json
{
  "routing_key": "<integration-key>",
  "event_action": "trigger",
  "dedup_key": "persist:<alarmName>",
  "payload": {
    "summary": "<ALERT_SUMMARY_PREFIX>: <alarm description without the PagerDuty: prefix, or the state reason>",
    "source": "<ALERT_SOURCE>",
    "severity": "critical",
    "custom_details": { "alarmName": "…", "state": "ALARM", "reason": "…", "stateChangeTime": "…", "accountId": "…", "region": "…", "trigger": { "metricName": "…", "namespace": "…", "dimensions": [] } }
  }
}
```

Resolve payload: `{ "routing_key", "event_action": "resolve", "dedup_key" }`. HTTP `202` is success; anything else is logged and returned as an error.

Dedupe table row: `pk = alarm#<alarmName>`, `sk = window#<windowStartEpochSeconds>` where the window start is `now` floored to `ALERT_WINDOW_MINUTES`; attributes `alarmName`, `status` (`CLAIMED` → `SENT` → `RESOLVED`), `dedupKey`, `pagerDutyDedupKey`, `state`, `createdAt`, `sentAt`, `resolvedAt`, `ttlEpochSeconds`.

### 3.4 Dashboards

`persist-indexing` (`IndexingDashboardStack`, `periodOverride: AUTO`, tag `project_name=persist`), four `SingleValueWidget`s with sparkline, 12×6 each, all Maximum over 1 min:

1. Indexing time lag (oldest unprocessed record age) — `IndexStreamOldestUnprocessedRecordAgeSeconds`.
2. Indexing commit backlog (commits behind) — `IndexStreamCommitBacklog`.
3. OpenSearch FTS time lag — `OpenSearchFtsStreamOldestUnprocessedRecordAgeSeconds`.
4. OpenSearch FTS commit backlog — `OpenSearchFtsStreamCommitBacklog`.

`persist-csv-ingest` (`CsvIngestDashboardStack`, same `periodOverride` and tag), all Sum over 1 day:

1. `GraphWidget` 24×8, `liveData: true`: new vertices and edges inserted via CSV workflow (daily).
2. `SingleValueWidget` 12×6 with sparkline: new vertices inserted.
3. `SingleValueWidget` 12×6 with sparkline: new edges inserted.

Both stacks import metric name/dimension constants from the producing Lambda's `metrics.ts` module (shared TypeScript, not CloudFormation references) and are instantiated last in `bin/app.ts` with no `addDependency`.

### 3.5 CSV workflow metrics Lambda (`PersistCsvWorkflowMetrics`)

- Trigger: the CSV workflow (`csv-bulk-load-workflow.md` §3.8) emits an EventBridge event `source: persist.csv-workflow`, `detail-type: Persist CSV Workflow Loaded`, `detail: { schemaVersion: "1", executionId, streamTarget? }` immediately after both load phases and before the index catch-up wait. The `PutEvents` task has retry (`States.ALL`, 3 attempts, 2 s, backoff 2) and a `Catch` that continues the workflow, so metrics can never fail or delay ingest. An EventBridge rule on that source/detail-type invokes the Lambda asynchronously. Direct invocation with `{ "executionId": "<execution id>" }` reruns it.
- Runtime: Node 24 / ARM64, 1024 MB, 15 min timeout; env `NEPTUNE_BULK_BUCKET`, `WORKFLOW_SUMMARY_PREFIX=workflow-summaries`, `CSV_WORKFLOW_METRICS_COUNT_CONCURRENCY=8`, `POWERTOOLS_METRICS_NAMESPACE=persist`; S3 read on `workflow-summaries/*` and `bulk-load/*`.
- Behaviour: read per-item summaries under `workflow-summaries/<executionId>/<phase>/`, locate each staged "new rows only" CSV under `bulk-load/`, stream-parse it, subtract the header row, and publish the two `Count` metrics. Log line `Published CSV workflow ingest metrics` carries `executionId`, `verticesInserted`, `edgesInserted`, `verticesItemsLoaded`, `edgesItemsLoaded`. The log group name is published to SSM `persist-csv-workflow-metrics-log-group` for the E2E test.

### 3.6 Neptune observability

- Cluster parameter group (primary and recovery): `neptune_enable_audit_log=1`, `neptune_enable_slow_query_log=info`, `neptune_slow_query_log_threshold=5000` (ms); `enableCloudwatchLogsExports: ["audit", "slowquery"]`. Parameter changes require an instance reboot to take effect (`operations-playbook.md` §2).
- `PersistStack` receives `neptuneClusterIdentifier` (in addition to the resource ID) purely to dimension `AWS/Neptune` metrics; on a recovery cutover it is the recovery cluster's identifier, so the CPU alarm follows the active cluster automatically.
- Reader auto-scaling tracks `NeptuneReaderAverageCPUUtilization`; the alarm deliberately uses `Maximum` per reader because the fleet Average is diluted by idle dedicated readers, and `Maximum` covers auto-scaled replicas without naming them in CDK.

## 4. Runtime behaviour

- **Lag probe semantics (ADR 0004)**: every minute the probe loads the checkpoint from the derived-index state table (`derived-index-maintenance.md` §6.1), reads Neptune Streams after it with `INDEX_STREAM_POLL_LIMIT=1`, and separately reads the `LATEST` watermark. It emits the age of the first unprocessed record (or `0`) and the commit backlog. A missing checkpoint is a hard error (`IndexStreamCheckpointMissing`) so the probe-errors alarm pages after 3 consecutive minutes and the runbook item in `operations-playbook.md` §7 applies. The OpenSearch probe runs every 5 minutes and returns `checkpoint_missing` without emitting.
- **Why not `lastCommitTimestamp`**: an idle graph has an old checkpoint timestamp with nothing to process, and the first write after idle looks stale for a minute. Measuring the oldest *unprocessed* record is zero in both cases and only grows with real backlog.
- **Alarm evaluation**: `NOT_BREACHING` on missing data means a stopped probe never pages through the lag alarm itself — that is why the probe has its own errors alarm. Lag pages after 3 consecutive 1-minute datapoints `>= 1800 s`; poller errors page on the first minute with any error.
- **Sustained CPU**: 15 consecutive 1-minute `Maximum` datapoints `> 80 %` on any reader. The earlier shape (3 × 5-minute) paged when three brief spikes landed in three separate buckets, because `Maximum` over 5 minutes counts a one-second spike as the whole bucket; 15 × 1-minute requires the reader to be hot for every one of 15 minutes. The wall-clock window is the same.
- **Trigger path**: state `ALARM` → conditional `PutItem` of the current window row (`attribute_not_exists(pk) AND attribute_not_exists(sk)`). Success → call the paging service with the stable dedup key `persist:<alarmName>` → mark `SENT`. Condition failure → consistent `GetItem`: if the row is still `CLAIMED` a previous invocation died before `SENT`, so retry with the same dedup key (idempotent at the paging service); if `SENT`, return `suppressed: dedupe_window_claimed`. If the trigger call fails and this invocation created the claim, delete it so the next notification retries.
- **Resolve path**: state `OK` → query `pk = alarm#<alarmName>` for rows with `status = SENT`, a `pagerDutyDedupKey`, and no `resolvedAt`; send `resolve` for each and mark `RESOLVED`. `INSUFFICIENT_DATA` is ignored.
- **Hourly scan**: `DescribeAlarms` for `ALERT_ALARM_NAMES`; every alarm in `ALARM` goes through the trigger path (a new hour is a new window, so the same incident is re-triggered once per hour with the same dedup key rather than opened again), every alarm in `OK` goes through the resolve path. This also closes incidents whose OK notification was lost.
- **Failure surfacing**: any per-alarm error makes the handler throw after processing the batch, so SNS/async-invoke retries apply and the Lambda's own `Errors` metric records it. Non-production accounts short-circuit before any network call and return `skipped`.

## 5. Operations / runbook

| Page | First response |
| --- | --- |
| Stream poller errors | Open `IndexStreamPoller` logs for the failing trigger record; do not disable the schedule unless Neptune is the cause (`operations-playbook.md` §7 "Index stream lag warning"). |
| Stream lag ≥ 30 min | Check `persist-indexing` for commit backlog trend. Growing backlog with a healthy poller means throughput: raise poll frequency/concurrency after confirming the single-lease invariant. Flat backlog with poller errors is the errors case above. |
| Lag probe errors | Usually `IndexStreamCheckpointMissing` after a trimmed or deleted checkpoint: run `PersistIndexRebuildWorkflow` in `WRITE`, then re-enable the poll schedule (`operations-playbook.md` §7). Otherwise Neptune connectivity. |
| Rebuild unsuccessful | Open the failed execution; the `indexRebuildFail` handler records the cause in the state table. Re-run in `DRY_RUN` before `WRITE`. |
| Reader CPU > 80 % for 15 min | Identify the hot reader in `AWS/Neptune` per-instance metrics and the slow-query log; move the offending consumer to a dedicated reader or throttle `GREMLIN_BATCH_EXISTS_CONCURRENCY` (`operations-playbook.md` §7 "Connection storms"). Auto-scaling adds a replica only if the *average* is high. |

- **Silence**: use the paging service's maintenance window, or `aws cloudwatch disable-alarm-actions --alarm-names <name>`; re-enable afterwards. Do not raise thresholds to silence.
- **Re-page manually**: invoke the bridge with `{ "action": "scan-active-alarms" }`.
- **Add a paging alarm**: create the alarm with `alarmDescription: "PagerDuty: …"`, add both alarm and OK actions to the topic, append its name to `ALERT_ALARM_NAMES`, extend the template test.
- **Add a metric/widget**: export the name in the producer's `metrics.ts`, emit through Powertools with the `service` dimension, publish `0` when healthy, and reference the constant from the dashboard stack; deploy the dashboard stack alone (`pnpm cdk:deploy IndexingDashboardStack`).
- **Recount a CSV execution**: invoke `PersistCsvWorkflowMetrics` with `{ "executionId" }`; note that it emits a second datapoint, so daily Sum widgets double-count that execution.

## 6. Verification & acceptance criteria

- Template tests: each dashboard stack synthesises exactly one `AWS::CloudWatch::Dashboard`, its body references the `persist` namespace with the expected metric names and `service` dimensions, and `stack.dependencies` is empty. `PersistStack` tests assert each paging alarm's threshold, `EvaluationPeriods`/`DatapointsToAlarm`, `TreatMissingData` and description (metric name/namespace for the lag alarm), and for the CPU alarm additionally `Role=READER`, `Maximum`, period 60, `> 80`, `15/15` and that alarm and OK actions are set; they also assert the bridge's env/IAM, the SNS subscription, the `rate(1 hour)` scan rule and the `rate(1 minute)` probe schedule. Parameter-group tests assert the audit/slow-query parameters and both log exports on primary and recovery clusters.
- Handler unit tests: SNS, direct alarm-action and scan inputs each trigger with the configured summary prefix/source and the `PagerDuty:` prefix stripped; the scan reconciles `ALARM` and `OK` alarms and can discover by name prefix; non-production returns `skipped` without touching Secrets Manager or DynamoDB; second notification in the same window is `suppressed`; `CLAIMED`-but-not-`SENT` retries with the same stable dedup key; an OK whose resolve is rejected fails the invocation; a rejected trigger releases a claim this invocation created (but not an earlier uncertain one).
- E2E (CSV metrics suite, run standalone — it starts a real bulk load): upload unique rows, run the CSV workflow to `SUCCEEDED`, assert the `Published CSV workflow ingest metrics` log line for that execution reports the uploaded counts, then assert the two metrics include at least those counts.
- Release checks: after deploy, `IndexStreamOldestUnprocessedRecordAgeSeconds` is `< 60` within one poll interval of a test write (`operations-playbook.md` §5), all paging alarms are `OK`, and a forced `ALARM` (`aws cloudwatch set-alarm-state`) in prod produces one incident and an OK state resolves it.

## 7. Design decisions

- **ADR 0004** — page on failures and on *real* backlog, never on idle-age. CloudWatch is the detection layer; the bridge is the only component that knows the paging service. Costs: two Neptune Streams reads per minute and two custom datapoints per invocation; the bridge has its own health alarm so the monitor cannot fail silently; incident volume is bounded to one trigger per alarm per hour.
- **Standalone dashboards** — widgets reference metrics by namespace/name/dimension string, so dashboard iteration never redeploys the indexer or the ingest workflow and cannot create an in-use-export deadlock. The price is that a renamed metric breaks a widget silently; sharing the name constants in TypeScript is the mitigation and the template test is the guard.
- **Metrics near, not in, the workflow** — CSV counting streams potentially large CSVs, so it runs in a decoupled Lambda after a fire-and-forget event with retry + catch, keeping ingest latency and failure modes unchanged.
- **Production gating in code** — the bridge compares its account with a compiled-in production constant. Prefer supplying `<production-account>` through context or an env var when re-creating the service so non-prod stacks stay silent without a code edit.
- **OpenSearch alarms are visibility-only** — full-text search is rebuildable and non-blocking for graph reads (`opensearch-fts-mirror.md`), so its lag and failures do not page today; wire them to the same topic if FTS becomes user-facing SLA.

## 8. Source map

| Concern | Path (persist repo) |
| --- | --- |
| Dashboard stacks | `lib/indexing-dashboard-stack.ts`, `lib/csv-ingest-dashboard-stack.ts` |
| Metric name constants | `lambda/index-stream-lag-probe/metrics.ts`, `lambda/csv-workflow-metrics/metrics.ts` |
| Paging bridge | `lambda/pagerduty-alert/handler.ts` |
| Lag probes | `lambda/index-stream-lag-probe/handler.ts`, `lambda/services/IndexStreamLagProbeService.ts`, `lambda/opensearch-stream-lag-probe/handler.ts`, `lambda/services/OpenSearchStreamLagProbeService.ts` |
| CSV metrics Lambda | `lambda/csv-workflow-metrics/handler.ts`, `lambda/services/CsvWorkflowMetricsService.ts` |
| Other metric producers | `lambda/services/IngestMetricsService.ts`, `lambda/services/IndexRebuildMetricsService.ts` |
| Topic, dedupe table, alarms, hourly scan, probe schedule, CSV event/rule | `lib/persist-stack.ts` |
| OpenSearch visibility alarms and probe schedule | `lib/persist-search-stack.ts` |
| Neptune parameter group and log exports | `lib/neptune-stack.ts`, `lib/neptune-recovery-stack.ts` |
| Decision record | `docs/adr/0004-alert-on-derived-index-maintenance-failures-and-lag.md` |
| Operator docs | `README.md` §"Derived index maintenance and alerting", §"Indexing dashboard", §"CSV ingest dashboard", §"CSV ingest metrics E2E test" |
| Tests | `test/cdk/indexing-dashboard-stack.test.ts`, `test/cdk/csv-ingest-dashboard-stack.test.ts`, `test/cdk/persist-stack.test.ts`, `test/e2e/csv-workflow-metrics.e2e.test.ts` |
| Related references | `stacks-configuration-and-iam.md` §3, `csv-bulk-load-workflow.md`, `derived-index-maintenance.md`, `engineering-conventions-and-testing.md` §3, `operations-playbook.md` §5 and §7, `neptune-stream-export.md` §5 (export-stack alarms); full-text search in `opensearch-fts-mirror.md` |
