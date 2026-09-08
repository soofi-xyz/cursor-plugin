# Persist — Debt Derived-Index Export to Athena (Architecture Reference)

The debt derived-index export is a standalone CDK stack that publishes the debt-grain derived index values materialized on Neptune (`derived-index-maintenance.md`) into an Athena table, one row per `debt_identifier`, without anyone running a script by hand. Each run is a full refresh: a Fargate task walks every debt vertex once to produce the key list (the denominator) and the dense columns, a Step Functions Map extracts each sparse column into its own two-column text artifact, an Athena CTAS left-joins every artifact onto the key list and writes ZSTD Parquet to a fresh per-run prefix, two verification gates check the build against its own key list and against the build currently published, and publishing is a blue/green metadata swap: `CREATE OR REPLACE VIEW` onto a stable reader view, then DROP + CREATE EXTERNAL TABLE to retarget a legacy reader table onto the same verified prefix. Prior builds are never deleted; they are the rollback path. The run is triggered by the success of `PersistNeptuneCsvWorkflow` (`csv-bulk-load-workflow.md`), fenced by a DynamoDB lock, and announces a published build with a stable custom EventBridge event.

## 1. Purpose & Scope

- Keep an Athena table of lexicon-declared debt-grain derived indexes equal to what Neptune holds, refreshed automatically after every CSV ingest.
- Serve reporting consumers (operations-review counts, reconciliation jobs) that read a fixed column set through a stable name and must never see a half-written or silently short table.
- Keep PII out of the reporting table by construction: only an allowlist of index names is exported, never "every debt-grain index".
- Make the consistency window of every published row inspectable (graph stream positions on each row and in the run manifest) rather than pretending a multi-query export is a snapshot.

Non-goals:

- Incremental / changed-set export. Every run re-reads the whole portfolio (see §9 for the documented path to incremental).
- Historical snapshots. `export_date` is a lineage column, not a partition; consumers read current state only.
- Ageing out old builds. Nothing expires published prefixes or build tables; deciding rollback depth is a separate decision.
- A single-instant snapshot. Neptune offers no cross-query snapshot isolation; the export declares its window instead (§5).
- Recomputing index values. The export projects stored index properties only; computing them is the index writer's job (`derived-index-maintenance.md` §3).

## 2. Architecture

### 2.1 Stack placement and dependencies

Provision `DebtIndexExportStack` as its own stack (the full app topology and deploy order are in `stacks-configuration-and-iam.md` §2.1). Deploy it after `PersistStack` (`addDependency`) because it reads the CSV workflow ARN that `PersistStack` publishes to SSM. Keep it separate so a redeploy of the export can never risk the ingest API, following the `PersistSearchStack` precedent.

Inputs from other stacks (constructor props): the VPC and Lambda security group from `NeptuneStack`; the general Neptune reader endpoint (for the short Lambda extractions); the dedicated async-reader instance endpoint (for the multi-hour Fargate scan; that instance carries a 12 h `neptune_query_timeout`, whereas autoscaled replicas inherit the cluster's 1 h timeout and kill a long stream with `TimeLimitExceeded`); the Neptune port and cluster resource id; and `stage`.

SSM parameters read at synth: `/lexicon/data-uri` (`stacks-configuration-and-iam.md` §2.3) and `persist-neptune-csv-workflow-arn`. SSM parameters published: `/persist/debt-index-export/workflow-arn`, `/persist/debt-index-export/bucket`, `/persist/debt-index-export/table` (`<database>.<table base>`), `/persist/debt-index-export/view` (`<database>.<view>`).

CDK context knobs: `debtIndexExportDatabase` (default `debt_derived_indexes`), `debtIndexExportTable` (default `debt_index_values`, a base name), `debtIndexExportView` (default `debt_index_values_current`), `debtIndexExportSchemaVersion` (default `"1"`), `debtIndexExportMaxShrinkRatio` (default `0.02`), `debtIndexExportTriggerEnabled` (default: on for `stage=prod`, off otherwise; must be a boolean or `"true"`/`"false"`, anything else fails synth).

### 2.2 Resources

| Resource | Type | Notes |
| --- | --- | --- |
| Export bucket | `s3.Bucket` | Block public, SSE-S3, enforce SSL, bucket-owner-enforced, `RemovalPolicy.RETAIN` in every stage. Lifecycle: expire `debt-keys/` after 14 d, `athena-results/` after 30 d, abort multipart after 3 d (plus a legacy `staging/` 14 d rule for a superseded layout, and the sibling consumers' own rules on their prefixes). Never expire `runs/`. |
| Athena workgroup | `athena.CfnWorkGroup` | Name `debt-index-export-<stage>`; result location `s3://<bucket>/athena-results/`, SSE-S3; `enforceWorkGroupConfiguration: false` (a CTAS with `external_location` is rejected when the workgroup enforces settings); CloudWatch metrics on. |
| Run Lambda | `NodejsFunction` | Node 24, ARM64, 15 min, 4096 MB, in VPC private subnets, JSON logs, one function serving every Lambda phase (`acquireLock`, `releaseLock`, `plan`, `extractIndex`, `sealRun`, `guardPublish`, `recordRun`). `INDEX_STREAM_POLL_LIMIT=1` because it only reads the stream head. |
| Key-list task | ECS cluster + `FargateTaskDefinition` + `DockerImageAsset` | 2 vCPU / 8192 MiB, ARM64, `NODE_OPTIONS=--max-old-space-size=6144`, 120 s stop timeout, own log group. Pinned to the async reader endpoint. |
| Lock table | `dynamodb.Table` | `pk` string, pay-per-request, TTL attribute `ttl`, `DESTROY`. Singleton row `pk="debt-index-export"`. |
| Workflow | `sfn.StateMachine` STANDARD | 18 h timeout, tracing on. Workflow role gets read/write on the export bucket because Athena reads and writes S3 as the caller. |
| Trigger rule | `events.Rule` → `SfnStateMachine` target | Pattern: `source=aws.states`, `detail-type=Step Functions Execution Status Change`, `detail.status=SUCCEEDED`, `detail.stateMachineArn=<CSV workflow ARN>`. Input `{ "mode": "full" }`. Enabled per §2.1. |
| Failure alarm | `cloudwatch.Alarm` | `AWS/States ExecutionsFailed` for the workflow, Sum over 5 min, threshold 1, 1/1, missing data not breaching; alarm and OK actions route to the paging integration (§6). |
| Outputs | `CfnOutput` | Bucket, workflow ARN, workgroup, `<db>.<table base>`, `<db>.<view>`, alarm ARN. |

### 2.3 Data flow

```
PersistNeptuneCsvWorkflow SUCCEEDED (EventBridge)
        │
        ▼
AcquireDebtIndexExportLock (DynamoDB conditional put) ──not acquired──▶ DebtIndexExportAlreadyRunning (Succeed, no event)
        │ acquired
        ▼
DebtIndexExportWork (Parallel; catch States.ALL → ReleaseLockOnError → Fail)
  ├─ BuildDebtKeyList        ecs:runTask.sync   Neptune(async reader) ──one scan──▶ s3://<bucket>/debt-keys/<listId>/{keys/,idx/<dense col>/,map/,person-map/,_complete.json}
  ├─ PlanDebtIndexExport     Lambda             resolve newest complete list, read stream head, derive plan ─▶ runs/<build>/_plan.json
  ├─ ExtractDebtIndexColumns Map (×4)           Neptune(general reader) ──seek pages──▶ runs/<build>/idx/<sparse col>/page-NNNNNN.tsv
  ├─ SealDebtIndexGraphWindow Lambda            re-derive plan, verify identity digest + key pages, read stream head, render CTAS ─▶ runs/<build>/_seal.json
  ├─ RegisterDebtIndexStagingTables Map (×4)    Athena CREATE EXTERNAL TABLE IF NOT EXISTS (keys table + one per column)
  ├─ JoinDebtIndexBuild      Athena CTAS        LEFT JOIN every staging table onto keys ─▶ runs/<build>/table/*.parquet (ZSTD)
  ├─ VerifyDebtIndexBuild + ReadDebtIndexVerification   row_count, key_count, expected_count
  ├─ DebtIndexBuildIsComplete (Choice) ──mismatch──▶ DebtIndexExportIncomplete (Fail)
  ├─ CompareDebtIndexBuildToPublished (+ Read)  ──TABLE_NOT_FOUND──▶ SkipDebtIndexComparison (Pass) ──┐
  ├─ GuardDebtIndexPublish   Lambda  ◀──────────────────────────────────────────────────────────────────┘
  ├─ DebtIndexBuildIsNotShrunk (Choice) ──not explicit true──▶ DebtIndexExportShrank (Fail)
  ├─ PublishDebtIndexBuild   Athena  CREATE OR REPLACE VIEW <view> AS SELECT * FROM <build>
  ├─ PublishDebtIndexMethodADrop / PublishDebtIndexMethodACreate   Athena  retarget legacy table onto runs/<build>/table/
  └─ RecordDebtIndexExportRun Lambda            runs/<build>/_manifest.json (written last, outside table/)
        │
        ▼
ReleaseDebtIndexExportLock ─▶ EmitDebtIndexExportSucceededEvent (retry ×3, catch → Succeed) ─▶ DebtIndexExportSucceeded
```

Every SQL statement is a native `athena:startQueryExecution.sync` integration scoped to the export database; no Lambda forwards or polls Athena. Only the plan, extraction, seal, guard and record phases run in Lambda; only plan and seal touch Neptune Streams; only extraction and the Fargate scan run Gremlin.

## 3. Contracts

### 3.1 Inputs

- Automatic: the EventBridge rule above. Accept `{ "mode": "full" }`; the workflow ignores other input keys.
- Manual: `StartExecution` on the workflow ARN with any input. The execution name is the run id (`$$.Execution.Name`); it is the only identity the platform guarantees unique, so every name a run owns derives from it. Direct Lambda invocation without a run id generates `<instant without punctuation>_<8 hex random>`.

### 3.2 S3 layout (export bucket)

```
debt-keys/<listId>/                       listId = <StartTime with "-" and ":" removed and fractional seconds dropped><"__"><execution name sanitized, ≤64>
  keys/page-NNNNNN.tsv                    one debt_identifier per line, sorted, distinct, 50k rows/page
  idx/<dense column>/page-NNNNNN.tsv      "<debt_identifier>\t<value>", absent values write no row, 50k rows/page
  map/page-NNNNNN.tsv                     vertex_id → debt_identifier (one row per debt vertex; used by stream consumers)
  person-map/page-NNNNNN.tsv              "<person_vertex_id>\t<debt_identifier>\t<empty debt_vertex_id>\tADD" (one row per owner pair, the stream consumer's staging shape)
  _complete.json                          DebtKeyListManifest, written LAST; a prefix without it is never selected
runs/<build table>/                       build table = <base>_<YYYYMMDD_HHMMSS>_<run token>
  _plan.json                              frozen plan (identity digest, names, SQL, keyList manifest, graphPositionStart)
  idx/<sparse column>/page-NNNNNN.tsv     per-run extraction artifacts
  _seal.json                              graphPositionStart/End, graphCommitsAdvanced, joinSql, sealedAt
  table/                                  CTAS output, ZSTD Parquet; NOTHING else may live here (HIVE_BAD_DATA otherwise)
  _manifest.json                          run record, written after publish
athena-results/                           workgroup query results (30 d)
```

Page keys are deterministic in column and page number (`page-` + 6-digit zero-padded), so a retry overwrites its own object. A column with zero rows still writes an empty `page-000000.tsv`: a table over a missing prefix reads as zero rows, which is indistinguishable from "never extracted".

### 3.3 Athena objects and naming

| Object | Name | Dialect | Statement |
| --- | --- | --- | --- |
| Key table | `debt_keys__<run token>` | Hive | `CREATE EXTERNAL TABLE IF NOT EXISTS (debt_identifier string) ROW FORMAT DELIMITED FIELDS TERMINATED BY '\t' STORED AS TEXTFILE LOCATION 's3://<bucket>/debt-keys/<listId>/keys/' TBLPROPERTIES ('serialization.null.format'='')` |
| Staging table (one per column) | `idx_<column>__<run token>` | Hive | Same shape, columns `(debt_identifier string, value string)`; dense columns register over the key list's `idx/<col>/`, sparse over the run's |
| Build table | `<base>_<YYYYMMDD_HHMMSS>_<run token>` | Trino | `CREATE TABLE … WITH (format='PARQUET', parquet_compression='ZSTD', external_location='s3://<bucket>/runs/<build>/table/') AS SELECT k.debt_identifier, COALESCE(<cast>(c0.value), <fallback>) … FROM debt_keys k LEFT JOIN idx_… c0 ON c0.debt_identifier = k.debt_identifier …` |
| Reader view | `<view>` (default `debt_index_values_current`) | Trino | `CREATE OR REPLACE VIEW "<db>"."<view>" AS SELECT * FROM "<db>"."<build>"` |
| Legacy reader table | `active_index_values` | Hive | `DROP TABLE IF EXISTS` then `CREATE EXTERNAL TABLE … STORED AS PARQUET LOCATION 's3://<bucket>/runs/<build>/table/' TBLPROPERTIES ('parquet.compress'='ZSTD')` |

Run token: use the run id verbatim when it already matches `^[a-z_][a-z0-9_]*$` and is ≤ 48 chars; otherwise lower-case, collapse illegal runs to `_`, truncate the stem to 48, prefix `r` if it starts with a digit, and append `_<8 hex sha256 of the original id>`. Sanitizing alone is not injective; the digest is what keeps two runs apart. Reject an empty run id.

Identifier rules: every table, view and column name must match `^[a-z_][a-z0-9_]*$` and is then quoted (backticks in Hive DDL, double quotes in Trino). Quote, do not blocklist keywords; never mix dialects (a double-quoted name in Hive is a string literal). Locations must be `s3://` URIs with a valid bucket and a path of `[A-Za-z0-9/_.=-]`; SQL literals (run id, dates, positions) must match `^[A-Za-z0-9 _.:+-]*$`. Reject, never escape. Refuse `active_index_values` as a build table or view name; refuse a view that resolves to itself.

### 3.4 Column derivation rules

- Declare **which** columns are exported as a flat allowlist of index names (`DEBT_INDEX_EXPORT_DECLARED_COLUMNS`, ~25 names such as `current_balance`, `debt_status_latest`, `sol_date`, `is_in_current_inventory`, `is_person_deceased`). Never derive the set from "all debt-grain indexes": that would carry PII-bearing hashes into a reporting table.
- Resolve everything else from the lexicon `IndexCatalog` (`derived-index-maintenance.md` §2): Athena type from the index `type`/`format` (`boolean`, `integer`, `double`, `date`, `timestamp`, `string`), owner vertex (`debt` direct, or `person` via one `person_owes_debt` hop), and the absent-value fallback from the trailing `coalesce(…, constant(X))` of `value_query` (`false` for booleans, `0` for amounts declared so, else null).
- Fail derivation (never emit a narrower table) on: a declared name the lexicon does not declare at debt grain (a rename must be a visible failure, not a zeroed report category), a name declared twice, two indexes claiming one column name, a name colliding with a reserved column, a name that is not a legal identifier, an owner type other than `debt`/`person`, a `value_query` without a coalesce fallback, a coalesce literal the parser does not recognize, a fallback that contradicts the declared type (including a fractional fallback on an `integer` index), or an empty result set.
- Compute `schema_fingerprint` as a sha256 over the ordered `(name, athenaType, source, fallback tag, fallback value)` tuples (owner type, lexicon type and format are not in the digest; they only reach it through `athenaType` and `source`). Type drift changes the fingerprint (the migration signal) rather than failing.
- Assign an extraction shape per column: `dense` for non-booleans and for any name in the `DEBT_INDEX_EXPORT_DENSE_COLUMNS` override set (booleans true for most of the portfolio, or measured near the 900 s Lambda wall); `personSparse` for person-owned booleans; `sparseBoolean` for the rest. Dense columns come out of the key-list scan; only sparse shapes are extracted per run.

### 3.5 Published table schema

`debt_identifier string`, then every derived column in lexicon order (debt-owned first, then person-owned) at its Athena type, then lineage columns: `export_date date`, `exported_at timestamp`, `run_id string`, `schema_version string`, `schema_fingerprint string`, `graph_commit_start string`, `graph_commit_end string` (both `commitNum:opNum`). Reserve these seven names plus `debt_identifier` (eight in all); a derived index may not use them. Timestamps convert through `from_iso8601_timestamp` in exactly one place (the CTAS); dates `CAST(… AS date)`.

### 3.6 Key-list manifest (`_complete.json`)

```jsonc
{ "schemaVersion": "2", "listId": "...", "prefix": "debt-keys/<listId>/", "builtAt": "<ISO>",
  "keyCount": <int > 0>, "pages": <int > 0>,
  "columns": [{ "name": "<dense column>", "rows": <int ≥ 0>, "pages": <int > 0> }],
  "map": { "rows": n, "pages": n }, "personMap": { "rows": n, "pages": n } }   // both optional (older builds)
```

Fail to decode a `"1"` marker (keys only) so a run cannot register dense tables over a prefix nothing wrote. Keep `map`/`personMap` optional: a required field would invalidate the newest marker, the shrink guard reads exactly that marker, and no build could ever write one.

### 3.7 Environment variables (generalized)

| Variable | Consumer | Meaning / default |
| --- | --- | --- |
| `LEXICON_DATA_URI` | Lambda, task | Lexicon S3 URI from SSM |
| `DEBT_INDEX_EXPORT_BUCKET` / `_DATABASE` / `_TABLE` / `_VIEW` / `_RUNS_PREFIX` / `_SCHEMA_VERSION` / `_ATHENA_WORKGROUP` | Lambda | Run target; `_TABLE` is a base name; `_VIEW` default `debt_index_values_current`; `_RUNS_PREFIX` default `runs/` |
| `DEBT_INDEX_EXPORT_MAX_SHRINK_RATIO` | Lambda, task | Fraction in `[0, 1)`, default `0.02`; one value for both halves of the guard |
| `DEBT_INDEX_EXPORT_LOCK_TABLE` | Lambda | DynamoDB lock table |
| `DEBT_INDEX_EXPORT_SPARSE_PAGE_ROWS` (200 000), `_SPARSE_PERSON_PAGE_ROWS` (25 000), `_DENSE_PAGE_ROWS` (50 000), `_KEY_PAGE_ROWS` (50 000), `_PROJECTION_BATCH_ROWS` (2 000) | Lambda, task | Page sizes; reject non-positive or fractional values at config read (a zero page size is an endless loop, not a slow one) |
| `NEPTUNE_READER_HOST` / `NEPTUNE_PORT` (`NEPTUNE_WRITER_HOST` is set to the same endpoint because the shared Neptune config requires it; `NEPTUNE_HOST` is also set but unread) | Lambda, task | General reader for Lambda; async reader for the task |
| `INDEX_STREAM_POLL_LIMIT=1` | Lambda | Stream head reads only |
| `DEBT_KEY_LIST_STARTED_AT`, `DEBT_KEY_LIST_EXECUTION_NAME` | task (container override) | `$$.Execution.StartTime`, `$$.Execution.Name`; both required |

### 3.8 IAM scopes (generalized)

- Run Lambda: `neptune-db:connect`, `ReadDataViaQuery`, `GetStreamRecords` on `<cluster resource>/*`; `s3:GetObject` on the lexicon bucket only; read/write on the export bucket; read/write on the lock table; VPC execution.
- Key-list task role: `neptune-db:connect`, `ReadDataViaQuery` on the cluster; `s3:GetObject` on the lexicon bucket; read/write on the export bucket.
- Workflow role: read/write on the export bucket (Athena runs S3 as the caller, and the S3 grant must include `GetBucketLocation` or every query fails at submission); Athena start/get/stop on the workgroup and Glue table CRUD scoped to the export database, as CDK derives for `AthenaStartQueryExecution` with `queryExecutionContext.databaseName`; `ecs:RunTask` + `PassRole`; `lambda:InvokeFunction`; `events:PutEvents` on the default bus.

### 3.9 Emitted event

After a published run only (never on the lock-skip path), put one event on the default bus: `source="persist.debt-index-export"`, `detail-type="Debt Index Export Succeeded"`, `detail={ schemaVersion: "1", executionId, executionName }`. Downstream rules must match `source`/`detail-type`, never the state machine ARN. Retry ×3 (2 s, backoff 2) and catch to Succeed: emission can never fail an export that already published.

## 4. Runtime Behaviour

1. **AcquireDebtIndexExportLock** — conditional `PutItem` on `pk="debt-index-export"` with `attribute_not_exists(pk) OR ttl < now`; `ttl = now + 18 h` (matches the workflow timeout so a timed-out holder cannot block forever). A losing execution ends at `DebtIndexExportAlreadyRunning` as **Succeed**, so a skip does not trip the failure alarm.
2. **BuildDebtKeyList** (Fargate, `ecs:runTask.sync`, 6 h task timeout, retry ×1 on `States.TaskFailed` and `States.Timeout`, 2 min interval): delete any objects under this list's prefix (a retry rewrites its own build); sweep `debt-keys/` for the newest readable marker (**Absent** = listing succeeded with no prefixes → proceed with a WARN that no floor was applied; **Unreadable** = prefixes exist but none carries a decodable marker → fail before the scan); run one unordered, un-limited Gremlin scan `g.V().hasLabel('debt').has('debt_identifier').project('vertex_id', key, '__owner_person_ids', <dense col>, …)` — `by(id())`, `by(values(key).fold())`, `by(in('person_owes_debt').has('version', <current generation>).id().fold())`, then per dense column `by(values(col).fold())` for debt-owned or `by(in('person_owes_debt').has('version', …).has(col, true).limit(1).constant(true).fold())` for person-owned — streamed in 2 000-row batches, sequentially, never fanned out; dedup keys client-side (first row wins), stream dense/map/person-map pages as they fill, restart the scan from row zero on a retriable mid-stream failure (dropping all progress and pages first; at most 3 attempts, backoff `min(30, 2^(attempt−2))` s, never on `TimeLimitExceeded`); fail on zero keys; apply the **shrink guard** (`keyCount ≥ previousKeyCount × (1 − ratio)`, shrink only); sort keys and write `keys/` pages; flush every column tail (and page 0 for empty columns); write `_complete.json` last. Exit non-zero on any failure.
3. **PlanDebtIndexExport** — derive the table schema from the lexicon; resolve the newest complete key list (fail when none); read the Neptune Streams head (`getLatestWatermark`, fail if absent) as `graphPositionStart`; derive the plan (names, prefixes, DDL, verify/compare/publish SQL, `extractions` = non-dense columns, `registrations` = key DDL first); fail if the list lacks an artifact for any column the lexicon now calls dense; write `_plan.json`. The plan's `identity` is a 16-hex sha256 over the entire derived object.
4. **ExtractDebtIndexColumns** — Map over `plan.extractions`, `maxConcurrency=4`, one column per Lambda invocation. Each invocation re-derives the schema and refuses to run if the fingerprint differs from the plan's. `sparseBoolean`: `has('<flag>', true)` seek-paged by `debt_identifier` (`gt(cursor)…dedup().order().limit(n)`), assert strict ascent above the cursor on every page, stop on a short page. `personSparse`: first count flagged persons with no `person_identifier` and refuse if non-zero; page distinct person identifiers, then for each batch run `g.V().hasLabel('person').has('version', <current generation>).has(<flag>, true).has('person_identifier', within(…)).out('person_owes_debt').hasLabel('debt').values('debt_identifier')` and carry the set of debts already written for the whole column (a client-side `Set`) so a joint debt is not staged twice. Refuse values containing tab/CR/LF or empty strings. Return `{ columnName, pages, rows, startedAt, finishedAt, lastCursor }`.
5. **SealDebtIndexGraphWindow** — re-derive the plan from live configuration with the payload's `keyList` and `graphPositionStart`; fail unless `identity` matches; stream-validate the key pages against the marker (strict ascent, count equals `keyCount`, without retaining keys); read the stream head as `graphPositionEnd`; render the CTAS from both positions; write `_seal.json`.
6. **RegisterDebtIndexStagingTables** — Map over `plan.registrations`, concurrency 4, `IF NOT EXISTS`. After extraction, never before: a table over an empty prefix joins as all-fallback without failing.
7. **JoinDebtIndexBuild** — the CTAS. Athena refuses a non-empty `external_location`, so a replay of a run that already published fails visibly.
8. **VerifyDebtIndexBuild / ReadDebtIndexVerification** — one query returning `row_count`, `key_count` (distinct), `expected_count` (from the key table) as varchar; `GetQueryResults` reads row 1. **DebtIndexBuildIsComplete** requires `rowCount == expectedCount AND keyCount == expectedCount`, else `DebtIndexExportIncomplete`.
9. **CompareDebtIndexBuildToPublished** — `build_count` beside `published_count` (via the view). Catch `States.TaskFailed` only; route to `SkipDebtIndexComparison` (empty counts) when the cause matches `*TABLE_NOT_FOUND*` or `*does not exist*`, otherwise `DebtIndexComparisonFailed`. Never catch `States.ALL` here.
10. **GuardDebtIndexPublish / DebtIndexBuildIsNotShrunk** — Lambda (a ratio needs numbers; Choice compares Athena strings only for equality). Empty or zero `publishedCount` → publishable with reason `no-published-predecessor`; unparsable counts → fail; else `judgeDebtIndexShrink`. The Choice tests `booleanEquals(publishable, true)` and fails closed on anything else. Both the first-publish skip and the normal path pass through the gate; there is no edge into publish without it.
11. **Publish** — view swap first (atomic, keeps the cutover name valid even if the next step fails), then legacy table DROP + CREATE (brief catalog gap, no bytes copied).
12. **RecordDebtIndexExportRun** — `_manifest.json` outside `table/`, after publish, containing counts, both positions, `graphCommitsAdvanced`, `graphSkewDetected`, `keyListBuiltAt`, `keyListKeyCount`, the key-list manifest, and every column's span.
13. **Release lock → emit event → Succeed.** Any failure inside the Parallel releases the lock (`ReleaseDebtIndexExportLockOnError`) and re-raises the original error/cause.

Cost and size guards: one scan per run, sequential; dense pages 50k rows; sparse pages (200k) bounded below the measured Neptune response failure window (a ~230k-row response succeeded, a ~490k-row response failed with 500); Lambda 15 min per column (a column that exceeds it fails the run; pages are deterministic so a resumable loop is possible but not implemented); task 6 h; workflow 18 h; extraction/registration concurrency 4 (measured throughput per request falls as concurrency rises, so do not raise without measuring).

Idempotency: every artifact key derives from column + page number or from the run id; a retried task deletes and rewrites its own list prefix; staging DDL is `IF NOT EXISTS`; the view swap is idempotent; the legacy DROP/CREATE pair is idempotent; nothing in a run deletes another run's data.

Failure classification:

| Condition | Outcome |
| --- | --- |
| Lock held | Succeed (skip), no event, no alarm |
| Scan exits non-zero / times out | One retry, then run fails, lock released; last good list remains for the next run |
| Key list shrank past ratio; unreadable predecessor markers; zero keys | Build refused before sealing; run fails |
| No complete key list; stream head unreadable; lexicon fails derivation; dense column missing from list | Plan fails before any column is read |
| Fingerprint changed mid-run; plan identity mismatch at seal; key pages disagree with marker | Run fails before the join |
| Row/key/expected mismatch | `DebtIndexExportIncomplete` |
| Comparison fails for a reason other than a missing view | `DebtIndexComparisonFailed` |
| Build shrank past ratio vs published | `DebtIndexExportShrank` |
| `graphCommitsAdvanced > 0` | Tolerated and recorded (the normal case) |
| Event emission fails after publish | Tolerated; execution still succeeds |

## 5. Consistency Semantics

A published row is a composite, not a snapshot. The key list and dense columns are enumerated by the scan at `builtAt`, which may predate the run; sparse and person columns are extracted afterwards, four at a time, over tens of minutes, each by its own queries; the derived-index stream poller (`derived-index-maintenance.md` §5) writes index properties every minute and the next ingest may start while an export runs. Detect and declare the window rather than pretend to close it:

- Read the **stream head** (`getLatestWatermark`), never the poller checkpoint, before the first extraction (`graph_commit_start`, frozen in the plan) and after the last (`graph_commit_end`, in the seal). Fail the run if either read fails: a build whose window is unknown must not publish.
- Carry both positions on every row and in the manifest with `graphCommitsAdvanced` and `graphSkewDetected = advanced != 0`. Equal positions mean internally consistent; unequal means composite. Record per-column `startedAt`/`finishedAt` so the window is inspectable per column.
- Do not fail on an advance. Ingest runs several times a day, a full export takes ~45 min or more, and the poller commits every minute, so an advance is the normal case; skew is a provenance flag, not an integrity signal. Do not add a lock between ingest and export: it would delay index freshness for every consumer to buy consistency for one table and would still not close the window.
- Consumers that need one instant must use an incremental export keyed on the changed set (§9) or accept the declared window.

## 6. Observability & Alarms

- Alarm on `AWS/States ExecutionsFailed` (Sum, 5 min, ≥ 1) for the workflow; wire alarm and OK actions directly to the paging integration (a Lambda action with a dedupe table), not through an SNS topic with no subscribers.
- Log groups (3 months): run Lambda (JSON, Powertools service `persist-debt-index-export-run`) and key-list task (`persist-debt-key-list`). Key log lines: `Planned debt index export run` (list id, key count, fingerprint, table), `Sealed debt index export graph window` (commit start/end/advanced), `Debt index publish gate cleared the build` / `Debt index publish gate found no predecessor to compare against` (build/published/floor/shortfall/reason) and the ERROR `Refusing to publish a debt index build that shrank`, `Built debt key list`, and the WARN `shrink guard skipped: no previous list`.
- Run records: `_plan.json`, `_seal.json`, `_manifest.json` under `runs/<build>/` answer "what did this run stage, compare and publish" without log retention.
- Athena workgroup CloudWatch metrics enabled. The pace script (`tasks/check-debt-key-list-pace.sh`) reports current phase, dense pages written vs expected, minutes per page and ETA for a running execution by listing the list prefix.
- Open monitoring item: alarm on an unusually wide `graphCommitsAdvanced` once a distribution is observed; treat it as monitoring, never a publish gate.

## 7. Operations / Runbook

- **Deploy**: `cdk deploy DebtIndexExportStack` after `PersistStack`; for prod the trigger arms by stage default; elsewhere pass `--context debtIndexExportTriggerEnabled=true` to arm. Never toggle the live EventBridge rule in the console; the next deploy restores what the stack resolves. Raise the tolerance knowingly with `--context debtIndexExportMaxShrinkRatio=<fraction>` (moves both halves of the guard).
- **Manual run**: `aws stepfunctions start-execution --state-machine-arn $(aws ssm get-parameter --name /persist/debt-index-export/workflow-arn --query Parameter.Value --output text) --name <unique name> --input '{"mode":"full"}'`. Watch with `tasks/check-debt-key-list-pace.sh <execution name>`.
- **Verify declared columns** against a real lexicon before changing the allowlist: `pnpm exec tsx scripts/verify-debt-index-export-columns.ts [path/to/lexicon.json]` (prints source, name, type, fallback, fingerprint; fails on any derivation error).
- **List builds**: `SHOW TABLES IN <database>` — build names sort by instant. Which prefix backs a build is the same string under `runs/`.
- **Rollback view**: `CREATE OR REPLACE VIEW "<db>"."<view>" AS SELECT * FROM "<db>"."<earlier build>"`. **Rollback legacy table**: `DROP TABLE IF EXISTS` then `CREATE EXTERNAL TABLE … LOCATION 's3://<bucket>/runs/<earlier build>/table/'` with the same column DDL. There is no separate rollback tool; both are the publish statements naming an earlier build.
- **Stuck lock**: the TTL (18 h) makes an expired row stealable; to clear early, delete `pk="debt-index-export"` only after confirming no execution is RUNNING.
- **Unreadable key-list prefixes** (build refused): confirm the prefixes are debris from builds that died before sealing, delete them, re-run; if markers are readable and the failure persists, the fault is in reading S3, not the lists.
- **Known sell-back / portfolio shrink**: raise the ratio for the deploy that covers it, run, then restore.
- **Break-glass**: there is no separate manual export script in the repo; the rollback statements above, naming an earlier build, are the only manual path, and nothing in the workflow overwrites or deletes a prior build's prefix.

## 8. Verification & Acceptance Criteria

- CDK assertions: states run in the order of §2.3; the lock loser Succeeds; the event is emitted after release and never on skip; run id is `$$.Execution.Name`; seal sits between the Map and the join; the Map iterates `plan.extractions` only, concurrency 4; every SQL state is a `.sync` Athena integration in the export database; no edge into publish bypasses the guard and the Choice fails closed; legacy retarget follows the view swap and precedes the run record; the key-list task uses the async reader with one retry covering `States.TaskFailed` and `States.Timeout` (the 6 h task timeout itself is not asserted); lexicon `GetObject` is scoped to the lexicon bucket; the bucket is RETAIN; the trigger is disabled by default outside prod and enabled in prod or by context.
- Pure-module unit tests (no AWS): schema derivation failures in §3.4; run-plan naming, identity digest over the whole plan, refusal of the protected table as view, refusal of an empty runs prefix or bad bucket, dense-column-missing-from-list failure; SQL quoting per dialect, rejection of unsafe identifiers/locations/literals, CTAS left-join + fallback + lineage + window literals, verification and comparison queries, run-token injectivity and bounding, deterministic page keys, row encoding refusals (delimiter, empty key, empty value); seek-paging strict ascent and short-page stop; key-list build shrink guard (Absent proceeds with WARN, Unreadable fails, shrink fails, growth passes), marker written last, empty column page 0, retry prefix cleanup, and `readKeyList` count/ascent checks; handler phase decoding including redrive-shaped `Option` fields.
- Acceptance on a real cluster: a run publishes a build whose `row_count == key_count == expected_count`; the view resolves to the new build and the legacy table's location equals the build's `table/` prefix; a second start while one runs ends in `DebtIndexExportAlreadyRunning`; a deliberately truncated key list (or a lowered ratio) ends in `DebtIndexExportShrank` or a refused build with the previous view untouched; the manifest records both stream positions; the success event arrives on the default bus.

## 9. Design Decisions

- **Trigger on CSV workflow success, not index rebuilds**: a run started with `waitForIndexCatchup: true` ends only after the index poller has caught up (`csv-bulk-load-workflow.md` §4.12), so success then means data and indexes are current (without the flag, success means the load finished and the declared stream window covers whatever the poller had not yet applied); rebuilds are per-index, rare, and fail often.
- **Per-column artifacts joined in Athena, not range-sharded wide rows**: a range is only correct if every other range lines up; independent columns can be wrong and retried in isolation. Athena is the Parquet writer; no hand-written writer.
- **Key list from one unordered, un-limited scan in Fargate**: `order()` before anything narrows the population never returns; `between()` on the key is not index-backed; `dedup().limit(n)` has no stable next page; async Gremlin stores one response as one document and fails an order of magnitude below the key count. Dense columns ride the same walk because paging them off the list costs ~50 min per column against a 15 min Lambda. No paged fallback exists on purpose.
- **Shrink guard in two places with one tolerance**: a stream that ends early looks identical to the end of the portfolio, so the only witness is a number from outside the run; the builder refuses to seal and the export refuses to publish at the same ratio so an operator raising one cannot leave a build the other blocks. Shrink only; growth has no ceiling worth guessing.
- **Comparison against the published build, gated, not merely reported**: the completeness gate counts all three numbers from the same key list, so it is structurally satisfied by a short list; only a count the run did not produce can catch it.
- **Run token from the execution name**: second-resolution timestamps collided for two ingest-triggered starts inside one second and both runs overwrote each other's staging.
- **Plan derived once, identity-digested, CTAS rendered at seal**: the CTAS needs the end position; re-deriving from live config tens of minutes later is only safe if the whole plan can be compared, not a chosen list of names.
- **Stage values as text**: the text SerDe parses only Hive's temporal spelling, so a `timestamp`-typed staging column reads ISO instants as NULL silently; cast once in the CTAS.
- **Allowlist, lexicon-derived types**: pinning types in code let a date column drift; deriving the set from the lexicon would leak PII.
- **View plus legacy table retarget**: `CREATE OR REPLACE VIEW` cannot replace a table and CTAS cannot target a non-empty prefix, so the legacy name advances by Glue metadata only.
- **No `export_date` partitions; not Iceberg**: full copies per run would accumulate; Iceberg schema evolution cannot widen `string` to `timestamp`, and `MERGE` only matters once the export is incremental.
- **Future incremental path**: record the stream watermark at load start in the CSV workflow, walk the stream between start and target to collect changed debt ids, and switch to a writer that updates rows in place (Iceberg becomes worth it then).

## 10. Source Map (persist repo, relative paths)

| Path | Responsibility |
| --- | --- |
| `lib/debt-index-export-stack.ts` | Stack: bucket, workgroup, run Lambda, Fargate task, lock table, state machine, trigger rule, alarm, SSM/outputs (shares the file with a sibling stream-export workflow) |
| `lib/debt-index-export-trigger.ts` | Event `source`/`detail-type` constants; trigger-enabled resolution from stage and context |
| `bin/app.ts` | Stack wiring: reader endpoints, VPC/SG, `addDependency(persistStack)` |
| `lambda/config/debt-index-export.ts` | Run-target, shrink-ratio and page-size config with validation |
| `lambda/schemas/debt-index-export.ts` | Declared column allowlist, column/schema types, lineage and reserved columns, fallback schema |
| `lambda/schemas/debt-key-list.ts` | Key-list manifest schema, marker name, prefix |
| `lambda/services/DebtIndexExportSchemaService.ts` | Lexicon → table schema derivation, fingerprint, derivation failures |
| `lambda/services/DebtIndexExportExtract.ts` | Extraction shape assignment, dense override set, seek-paging invariants, page-size assertion |
| `lambda/services/DebtIndexExportExtractService.ts` | One column's extraction: Neptune pages → S3 text pages, span record |
| `lambda/services/DebtIndexExportQuery.ts` | Gremlin builders: base scan, sparse seek page, person-hop pages |
| `lambda/services/DebtIndexExportReadService.ts` | Gremlin execution/streaming with mid-scan restart; staged value rendering |
| `lambda/services/DebtIndexExportDecode.ts` | Decoding folded Neptune values, rejecting multi-valued properties |
| `lambda/services/DebtIndexExportSql.ts` | All Athena SQL, naming (build table, run token, staging tables), page keys, row encoding, validation |
| `lambda/services/DebtIndexExportRunPlan.ts` | Pure run-plan derivation and identity digest; CTAS assembly from plan + end position |
| `lambda/services/DebtIndexExportRunPlanService.ts` | `buildPlan`, `resolveSchema`, `sealRun`, `assertPublishable`, `finalize` |
| `lambda/services/DebtIndexExportShrinkGuard.ts` | Shared shrink verdict and description |
| `lambda/services/DebtIndexExportStagingService.ts` | S3 put/get/list/delete helpers for the export bucket |
| `lambda/services/DebtKeyListService.ts` | Key-list build (scan, guard, pages, marker), sweep/resolve, read-back validation |
| `lambda/fargate/debt-key-list-entrypoint.ts`, `lambda/fargate/DebtKeyList.Dockerfile` | Fargate entrypoint (list id from execution start/name, exit codes) and image |
| `lambda/workflow-debt-index-export/handler.ts` | Phase router Lambda; lock acquire/release; redrive-safe manifest decoding |
| `scripts/verify-debt-index-export-columns.ts` | Resolve the allowlist against a real lexicon file |
| `tasks/check-debt-key-list-pace.sh` | Operator pace/ETA report for a running execution |
| `docs/debt-index-athena-export.md` | Design doc with measurements and rationale |
| `test/cdk/debt-index-export-stack.test.ts`, `test/services/DebtIndexExport*.test.ts`, `test/services/DebtKeyListService.test.ts`, `test/handlers/workflow-debt-index-export.handler.test.ts`, `test/utils/debt-index-export-trigger.test.ts` | Stack assertions, pure-module and handler tests |
