# Derived Index Discovery, Trigger-First Rebuilds, and Workflow Catch-Up

This reference extends PRD sections 3.3 (lexicon `indexes` contract), 5.6 (derived index maintenance: 5.6.1 `PersistIndexRebuildWorkflow`, 5.6.2 Neptune Streams incremental indexer), and 6.6 (derived index schemas). It documents the control plane around those mechanisms that the PRD does not describe: the hourly index discovery poller that detects lexicon definition changes and starts rebuilds, the DynamoDB index definition state store and its SHA-256 fingerprints, the split between trigger conditions and rebuild fingerprints (ADR 0007), lexicon-declared trigger-first ("sparse") rebuilds (ADR 0008), owner-rootable indexes (ADR 0003) and direct stream owner resolution (ADR 0005), the checkpoint store's lease and conditional-write contract, index value validation and writer details beyond 3.3, and the optional index catch-up barrier that runs inside `PersistNeptuneCsvWorkflow`. The data contracts, the writer, the rebuild data path, and the stream poller loop that PRD 3.3/5.6/6.6 described are now specified in `derived-index-maintenance.md`, which supersedes those PRD sections; read it first. Everything already stated there is referenced, not restated.

## 1. Purpose and scope

Deltas over PRD 5.6 that this document owns:

- **Discovery**: nothing in the PRD explains *who* starts `PersistIndexRebuildWorkflow` when the lexicon changes. A scheduled poller compares per-index fingerprints against a state store and starts at most one rebuild per run.
- **Definition state**: the `DerivedIndexStateTable` holds `pk="index"` items alongside the `pk="stream"` checkpoint. Their schema, conditional-write rules, and lifecycle (`REBUILDING` -> `ACTIVE` / `FAILED`) are defined here.
- **Correction to PRD 5.6.1 step 3**: the shipped default rebuild strategy enumerates *owner* elements in bounded `range(a, b)` pages and reports `ownerElementsRead`; trigger-first enumeration is opt-in per index through `sparse_rebuild` in the lexicon. There is no `triggerElementsRead` counter; candidate counts are published as separate metrics (ADR 0008).
- **Trigger conditions** (`change_trigger.when`), **additional triggers**, **absent values**, and **delete awareness** (`on_remove`) are lexicon fields absent from PRD 3.3.
- **Catch-up barrier**: an optional tail of the CSV workflow that blocks completion until the stream checkpoint passes the watermark captured after the bulk load.

Non-goals: alarm and dashboard wiring (see `operations-dashboards-and-alerting.md` and ADR 0004), the range/batch Distributed Map mechanics of the rebuild itself (`derived-index-maintenance.md` 4), stream page parsing and transaction grouping (`derived-index-maintenance.md` 5), and the analytics export of index values to a warehouse.

## 2. Architecture

```
EventBridge Scheduler                     DerivedIndexStateTable (DynamoDB)
  rate(1 hour) ──► IndexDiscoveryPoller     pk="index"  sk=<kind>#<owner>#<index>  (definition state)
                     │  1. load lexicon → IndexCatalog → fingerprints
                     │  2. Query pk="index"; ListExecutions(RUNNING)
                     │  3. pick ≤ N indexes whose fingerprint/status demand a rebuild
                     └─► StartExecution(PersistIndexRebuildWorkflow, mode=WRITE, indexes=[…])
                                │
      Prepare ── markRebuilding (conditional claim) ── LATEST watermark ── ranges/batches
      … Distributed Maps (owner-scan lanes | sparse candidate lanes) …
      Finalize ── [putCheckpoint if initializeStreamCheckpoint] ── markActive
      FAILED/TIMED_OUT/ABORTED ──(EventBridge status-change rule)──► index-rebuild-fail ── markFailed

  rate(1 minute) ──► IndexStreamPoller ── acquireLease / advanceCheckpoint / releaseLease
                                           pk="stream" sk="checkpoint"  (derived-index-maintenance.md 5, 6.1)

PersistNeptuneCsvWorkflow (PRD 5.4)
  … vertices phase → edges phase → emit loaded event →
  ShouldWaitForIndexCatchup? ── no ──► Succeed
        │ yes
        ▼
  CaptureIndexCatchupTarget (action=capture: LATEST stream watermark)
        ▼
  WaitForIndexCatchup (waitSeconds) ──► CheckIndexCatchup (action=check) ──► caughtUp? ── yes ► Succeed
        ▲                                                                       │ no
        └───────────────────────────────────────────────────────────────────────┘
```

Placement rules:

- The discovery poller runs outside the VPC (it needs S3, DynamoDB, and Step Functions only). The catch-up Lambda runs inside the VPC because it calls the Neptune Streams REST endpoint.
- Discovery, rebuild prepare/finalize, the fail handler, and the stream poller share one table. Definition items and the checkpoint item never share a key, so a rebuild cannot clobber the poller's lease.
- Discovery-started rebuilds never pass `initializeStreamCheckpoint`; only an operator-started initial materialisation moves the stream checkpoint.

## 3. Contracts

### 3.1 Definition state item (`pk="index"`)

```ts
{
  pk: "index",
  sk: `${ownerKind}#${ownerType}#${indexName}`,   // indexDefinitionKey
  ownerKind: "vertex" | "edge",
  ownerType: string,
  indexName: string,
  fingerprint: string,                             // sha256 hex, see 3.2
  status: "ACTIVE" | "REBUILDING" | "FAILED" | "REMOVED",
  updatedAt: ISO8601 UTC,
  executionArn?: string,                           // execution that last claimed / completed / failed
  lastBackfillStartedAt?: ISO8601 UTC,
  lastBackfillCompletedAt?: ISO8601 UTC,
  backfillWatermarkCommitNum?: number,             // LATEST watermark read at prepare, stored at markActive
  backfillWatermarkOpNum?: number,
  errorMessage?: string                            // truncated to 2000 chars
}
```

Items that fail to decode (missing required attributes, unknown status) are skipped by discovery rather than failing it. `REMOVED` is accepted on read and treated as "needs rebuild"; no service writes it today, so it is reserved for operator use.

### 3.2 Rebuild fingerprint versus trigger condition

The fingerprint is `sha256(JSON.stringify(canonicalize(subset)))` where `canonicalize` sorts object keys recursively and `subset` is:

| Included | Excluded |
|---|---|
| `ownerKind`, `ownerType`, `indexName` | `change_trigger.when` (ADR 0007) and `when` on additional triggers |
| `valueSchema` (`type`, `enum`, `format`, `pattern`, `minLength`) | sparse performance knobs: `range_size`, `batch_file_owner_ids`, `owner_query_batch_size`, `max_candidate_elements` |
| `changeTrigger: { type, label }` only | runtime-only `ownerDiscoveryQuery` |
| `additionalChangeTriggers[]: { type, label, subjectQuery? }` | `comment` and other lexicon pass-through keys |
| `absentValue`, `onRemove` | |
| `sparseRebuild.candidates` sorted by `source` (a set, not a list) | |
| `subjectQuery`, `valueQuery` | |

Rule: every field added after the original contract is spread conditionally, so an absent field contributes no key and existing fingerprints stay byte-identical. The fingerprint answers "would a rebuild produce different materialized values?"; a trigger condition or a tuning knob changes *when* or *how* work happens, not the stored value, so it must not schedule a rebuild.

A trigger condition is `change_trigger.when: NonEmptyArray<{ property, operator: "eq", value: string|number|boolean }>`, ANDed. The catalog loader rejects: an unknown property on the trigger label, an externally persisted property, a non-scalar type, a value primitive that does not match the property type, a non-integral value for an integer property, a value outside the property enum, a duplicate property, and a conditioned subject query that does not start at `g.V(__ID__)` / `g.E(__ID__)`.

### 3.3 Discovery decision output

```ts
{
  catalogIndexes: number,        // entries in the validated catalog
  activeIndexes: number,         // state items with status ACTIVE
  candidateIndexes: number,      // selected for this run (≤ INDEX_DISCOVERY_MAX_INDEXES_PER_EXECUTION)
  startedIndexes: number,
  skippedReason?: "running_execution" | "rebuilding_state",
  executionArn?: string
}
```

Started execution: name `index-discovery-<epoch-ms>`, input `{ schemaVersion: "1", mode: "WRITE", executionId: <name>, indexes: [{ owner_type, index_name }] }`.

### 3.4 Lexicon index fields beyond PRD 3.3

```jsonc
"indexes": {
  "<index_name>": {
    "type": "string|integer|number|boolean", "enum": [], "format": "", "pattern": "", "minLength": 0,
    "change_trigger": { "type": "vertex|edge", "label": "…", "when": [{ "property": "…", "operator": "eq", "value": … }] },
    "additional_change_triggers": [{ "type": "…", "label": "…", "when": [...], "subject_query": { "gremlin": "g.E(__ID__)….id()" } }],
    "absent_value": { "value": … },              // reader semantic for a missing property; no write-path change
    "sparse_rebuild": {                          // opt-in trigger-first rebuild (ADR 0008)
      "candidates": [{ "source": "change_trigger" }, { "source": "existing_non_default" }],
      "range_size": 0, "batch_file_owner_ids": 0, "owner_query_batch_size": 0, "max_candidate_elements": 0
    },
    "on_remove": { "recompute_owner": true },    // opt-in delete awareness (unconditioned exact-endpoint edge triggers only)
    "subject_query": { "gremlin": "…" }, "value_query": { "gremlin": "…" }
  }
}
```

Catalog-load validations (fail closed, whole catalog): owner-rootable (`value_query` starts with `subject_query` minus trailing `.id()`); no two triggers of one index share `(type, label)`; an additional trigger's traversal starts at its own element kind and ends in `.id()` (also when inherited); `existing_non_default` requires `absent_value`; `absent_value` matches the value type and enum; sparse knobs are positive integers; candidate sources are unique; a sparse primary subject query starts at `g.V(__ID__)`/`g.E(__ID__)`, ends in `.id()`, and binds `__ID__` exactly once; `on_remove` requires every trigger to be an unconditioned edge trigger with subject `g.E(__ID__).outV().id()` or `g.E(__ID__).inV().id()`.

### 3.5 Sparse candidate plan (carried on the owner group and range item)

```ts
{ schemaVersion: "1", sourceId: "change_trigger-0" | "existing_non_default", source, candidateKind, candidateLabel,
  ownerQueryBatchSize, maxCandidateElements }
```

`candidateLabel` is recorded at prepare so a lexicon refresh mid-execution cannot range a different population than was counted. Range items for `existing_non_default` also carry `candidateOwnerElementIds` enumerated at prepare time.

### 3.6 Catch-up input and output

Workflow start input (all accepted shapes in PRD 5.4.1) accepts `waitForIndexCatchup?: boolean`; the normalized workflow item carries `waitForIndexCatchup` (default `false`).

```ts
// action=capture input                        // action=check input (the previous status object)
{ schemaVersion: "1", action: "capture",       { schemaVersion: "1", action: "check", executionId,
  executionId }                                  targetWatermark: { commitNum, opNum }, attempt, maxAttempts, waitSeconds }

// status (output of both actions)
{ schemaVersion: "1", action: "check", executionId, targetWatermark, attempt, maxAttempts, waitSeconds,
  caughtUp: boolean, checkpoint?: { commitNum, opNum }, lastCommitTimestamp?: number }
```

`caughtUp` is `checkpoint.commitNum > target.commitNum || (equal && checkpoint.opNum >= target.opNum)`.

### 3.7 Checkpoint store operations (item schema: `derived-index-maintenance.md` 6.1)

| Operation | DynamoDB call | Condition | Notes |
|---|---|---|---|
| `getCheckpoint` | `GetItem` consistent read | — | `None` when the item or `commitNum`/`opNum`/`updatedAt` is missing |
| `acquireLease` | `UpdateItem` | `attribute_exists(pk) AND (no lease OR lease expired OR leaseOwner = me)` | Lease TTL = caller-supplied (poller: remaining invocation time + `INDEX_STREAM_LEASE_SAFETY_SECONDS`) else `INDEX_STREAM_LEASE_TTL_SECONDS`; condition failure returns `None` (`lease_held`); no item means no lease, which is the fail-closed bootstrap in `derived-index-maintenance.md` 5.6 |
| `putCheckpoint` | `PutItem` | — | Replaces the whole item (drops any lease); only rebuild finalize with `initializeStreamCheckpoint` and operators call it; records `sourceExecutionArn` |
| `advanceCheckpoint` | `UpdateItem` | `leaseOwner = me` | Sets `commitNum`, `opNum`, `updatedAt`, `lastCommitTimestamp`; `releaseLease` defaults to true, the poller passes false between pages in one invocation |
| `releaseLease` | `UpdateItem` | `leaseOwner = me` | Condition failure is a no-op; called on both the success and the failure path |

### 3.8 Generalized environment and IAM

| Component | Env vars | IAM |
|---|---|---|
| Discovery poller (rate 1 h, 1 min timeout) | `LEXICON_DATA_URI`, `DERIVED_INDEX_STATE_TABLE_NAME`, `INDEX_REBUILD_STATE_MACHINE_ARN`, `INDEX_DISCOVERY_MAX_INDEXES_PER_EXECUTION` (default 1) | `AWSLambdaBasicExecutionRole` (no VPC); `s3:GetObject` on any object (lexicon read); `states:ListExecutions` + `states:StartExecution` on the rebuild state machine; table read/write |
| Rebuild prepare/finalize/fail | the shared index block (`derived-index-maintenance.md` 4.5), including `INDEX_REBUILD_SPARSE_MAX_CANDIDATE_ELEMENTS` (default 5,000,000), `INDEX_REBUILD_OWNER_QUERY_BATCH_SIZE` (50), `INDEX_REBUILD_RANGE_SIZE` (500,000), `INDEX_REBUILD_BATCH_FILE_TRIGGER_IDS` (25,000) | fail handler additionally needs `states:DescribeExecution` on the state machine |
| Catch-up Lambda (60 s timeout, in VPC) | `NEPTUNE_READER_HOST`, `NEPTUNE_PORT`, `DERIVED_INDEX_STATE_TABLE_NAME`, `INDEX_STREAM_POLL_LIMIT`, `INDEX_STREAM_REQUEST_TIMEOUT_MS`, `WORKFLOW_INDEX_CATCHUP_POLL_INTERVAL_SECONDS` (60), `WORKFLOW_INDEX_CATCHUP_MAX_ATTEMPTS` (180, so a 3 h ceiling) | `neptune-db:GetStreamRecords`; table read only |

Sparse knob precedence: per-index lexicon value > execution input (`rangeSize`, `batchFileTriggerIds` only) > environment default. `owner_query_batch_size` and `max_candidate_elements` have no execution-input field.

## 4. Runtime behaviour

### 4.1 Discovery algorithm

1. Load the canonical lexicon and build the catalog; any validation error in 3.4 fails the poll (no partial discovery on a broken lexicon).
2. Map every entry to `{ ownerKind, ownerType, indexName, fingerprint }`.
3. Query all `pk="index"` items; count `ACTIVE`.
4. If the rebuild state machine has any `RUNNING` execution, return `skippedReason="running_execution"`.
5. If any state item is `REBUILDING`, return `skippedReason="rebuilding_state"` (covers a claim whose execution has already terminated but whose cleanup has not landed).
6. Select entries with no state item, status `FAILED` or `REMOVED`, or a fingerprint different from the stored one. Keep the first `max(1, INDEX_DISCOVERY_MAX_INDEXES_PER_EXECUTION)` in catalog order.
7. Start one `WRITE` execution for the selection, or return with zero candidates.

Because at most one index starts per hour and the poller skips while anything runs, a lexicon publish that changes five indexes rebuilds them serially over at least five hours. This is deliberate: two concurrent full-graph rebuilds saturated the reader replica and timed out child executions.

### 4.2 Rebuild lifecycle against the state store

- **Prepare (WRITE only)**: after selection and (for sparse indexes) candidate counting, call `markRebuilding` for every selected index. The update sets fingerprint, `REBUILDING`, `executionArn`, `lastBackfillStartedAt`, removes `errorMessage`, and is conditioned on `attribute_not_exists(pk) OR attribute_not_exists(status) OR status <> REBUILDING OR executionArn = :self`. It is an `UpdateItem`, not a `PutItem`, so completed-backfill evidence survives a failed claim. If any index is not claimed, prepare fails with "already being rebuilt". The LATEST watermark is read only after the claim.
- **Finalize (WRITE only)**: when `initializeStreamCheckpoint` is true and a watermark exists, `putCheckpoint` first; then `markActive` unconditionally sets `ACTIVE`, `lastBackfillCompletedAt`, and the backfill watermark (0/0 when none).
- **Failure**: the state machine has no catch chain, so it stays `FAILED` and is redrivable. An EventBridge rule on Step Functions status change (`FAILED`, `TIMED_OUT`, `ABORTED`) invokes the fail handler, which decodes `detail.input` (falling back to `DescribeExecution` when EventBridge omits input over its size quota), resolves the selected indexes, and calls `markFailed` conditioned on `status = REBUILDING AND executionArn = :self`. A condition failure is a no-op so a late or replayed event cannot overwrite `ACTIVE` or another execution's claim. Missing or empty `indexes` is a no-op because prepare never claimed anything.
- **Dry run**: never touches the state store or checkpoint.

### 4.3 Trigger-first (sparse) enumeration

1. For each selected index with `sparse_rebuild`, emit one single-index owner group per candidate source (a candidate set is index-specific, so it cannot share the multi-index owner group of the owner-scan strategy). Artifacts are keyed `<rangePrefix|batchPrefix>/<ownerKind>-<ownerType>/<indexName>/<sourceId>/…` (the sparse lane adds the index and source segments below the owner segment the owner-scan strategy already uses).
2. Count first, bounded: `g.E().hasLabel(L)<has(cond)…>.limit(max+1).count()`. A count above `max_candidate_elements` fails the rebuild; there is no fallback to an owner scan. Zero candidates logs a warning and completes.
3. Range lazily for `change_trigger`: `g.E().hasLabel(L)<has(cond)…>.range(a, b)<subject tail>`, where the tail is the primary subject query minus its `g.V(__ID__)`/`g.E(__ID__)` head, so enumeration and owner mapping are one server-side traversal. Only the primary trigger is a candidate source; additional triggers exist for the incremental arrival-order race and return no owner the primary lane cannot reach on a settled graph.
4. Enumerate eagerly for `existing_non_default`: `g.V().hasLabel(owner).has(indexName).range(a, b).id()` at prepare time, one range at a time, ids stored on the range item, because the rebuild's own writes shift that population. Trigger populations are untouched by index writes and stay lazy.
5. Dedupe owner ids inside a range with a set; never across ranges and never with `dedup`/`group`/`groupCount`/`aggregate`/`count` in a range query. Recompute is idempotent, so a duplicate owner costs a read, not correctness.
6. `root_vertices_to_rebuild_indexes` (per-owner-label CSV of owner ids that scopes an owner-scan rebuild) cannot name an owner type that has a selected sparse index; prepare fails naming both.

### 4.4 Owner-rootable recompute and owner resolution

- Every recompute is a full owner-rooted value replacement: `g.V(owner)<value tail>` where the tail is `value_query` minus the `subject_query` prefix. Reads for a batch of owners are one `g.inject(0).union(__.V(id).project('ownerElementId','values').by(constant).by(__<tail>.fold()), …)`.
- **Direct lane**: for an unconditioned edge trigger whose effective subject query is exactly `g.E(__ID__).outV().id()` (owner = record `from`) or `g.E(__ID__).inV().id()` (owner = record `to`), the poller takes the owner id from stream metadata and skips the discovery read. Owner ids are deduped per index per recompute window (both lanes together, before the owner-value read).
- **Fallback lane**: everything else (vertex triggers, indirect subjects, conditioned triggers, records missing the endpoint) goes through batched owner discovery: `g.inject(0).union(…project('triggerElementId','triggerExists','conditionMatched','ownerElementIds')…)`, with `has(property, value)` steps inserted immediately after the trigger root. A trigger element that no longer exists is counted in `missingTriggerElements` and advances the checkpoint; a filtered condition counts in `filteredIndexTriggers` and also advances.
- Multi-trigger indexes are registered in the stream lookup as one single-trigger view per binding; the binding's own traversal travels as runtime-only `ownerDiscoveryQuery`, while `subjectQuery` stays canonical because the value read is derived from it. Recompute work is still grouped per index. A bound traversal that does not start at `g.V('<id>')`/`g.E('<id>')` is refused rather than run unrooted.
- Delete-aware triggers read the pre-delete owner from `from`/`to` on `REMOVE` label records. A missing endpoint fails the poll after the safe prefix is applied and the lease is released, so the checkpoint stops exactly before the bad record. The checkpoint is global, so one unresolvable delete halts maintenance for every index.

### 4.5 Value validation and writer contract

- Validation reads only `{ ownerType, indexName, valueSchema }`. Order: date coercion (a `Date` or ISO date-time for a `string`/`date` index is cut to the date part), type (`integer` accepts bigint and integral numbers; `number` requires finite), `enum`, `format`, `pattern`, `minLength`. Failures are tagged `DerivedIndexValidationError { ownerType, indexName, ownerElementId?, expected, actual }`.
- `null`, `undefined`, and empty traversal results remove the property: `g.V(id).properties(k).drop()`. Any other value writes `g.V(id).property(single, k, <literal>)`. Literals are inlined via a Gremlin literal encoder; no bindings.
- Mutations are batched into `g.inject(0).sideEffect(__.V(id).property(single,…)).sideEffect(__.V(id).properties(k).drop())….iterate()` chunks and submitted on the writer endpoint with bounded concurrency (pooled connections above concurrency 1).
- Writer results expose `propertiesWritten`, `propertiesRemoved`, `validationFailures`, `recomputations`, `conditionedTriggeringRecords`, `matchedConditions`, `filteredIndexTriggers`, `missingTriggerElements`.

### 4.6 Catch-up barrier

1. After both load phases and the fire-and-forget loaded event, `ShouldWaitForIndexCatchup` checks `$.waitForIndexCatchup`; false goes straight to `Succeed`.
2. `CaptureIndexCatchupTarget` reads the Neptune Streams `LATEST` event id. No event id fails the workflow (a graph with no stream history cannot be waited on).
3. `WaitForIndexCatchup` sleeps `waitSeconds`, then `CheckIndexCatchup` increments `attempt`, reads the checkpoint with a consistent read, and returns `caughtUp`. A missing checkpoint fails immediately; reaching `maxAttempts` without catching up fails the workflow even though the loads are already committed.
4. The same Lambda's `capture` action is also invoked before the loaded event (result path `$.loadedStreamTarget`) so downstream consumers learn the exact stream position the run's writes are visible at; that call is caught so a watermark read failure never fails a run whose loads committed.

### 4.7 Idempotency, concurrency, failure modes

| Guard | Mechanism |
|---|---|
| Two discovery polls overlapping | `ListExecutions(RUNNING)` plus `REBUILDING` state check; `markRebuilding` condition is the hard lock |
| Rebuild claim stomping another execution | conditional update on `status <> REBUILDING OR executionArn = self` |
| Late failure event after success | `markFailed` conditioned on `executionArn = self` |
| Lexicon reorder or knob retune | canonical, sorted, conditionally spread fingerprint |
| Poller and rebuild writing the same owner | both are owner-rooted full replacements; last writer wins with the same value |
| Catch-up waiting forever | bounded by `maxAttempts x waitSeconds`; Step Functions `Wait` costs no compute |
| Broken lexicon | catalog validation fails discovery, prepare, and the poller alike; nothing writes |

## 5. Observability and alarms (deltas only)

- Discovery logs one structured "Index discovery poll complete" record per run with the 3.3 output; errors are rethrown under their tag name (`DerivedIndexCatalogError`, `DerivedIndexStateStoreError`, which also wraps `ListExecutions`/`StartExecution` failures), with `IndexDiscoveryPollerError` as the name for untagged failures. Alarm on Lambda errors; treat a sustained `skippedReason="rebuilding_state"` with no `RUNNING` execution as a stuck claim (see 6).
- Rebuild metrics under a pinned service dimension: `index_rebuild_candidate_elements`, `index_rebuild_owner_candidates` (their ratio is the cross-range duplication rate), `index_rebuild_properties_written`, `index_rebuild_properties_removed`.
- The catch-up Lambda logs `targetCommitNum/OpNum` versus `checkpointCommitNum/OpNum` per attempt; a workflow failing on `WorkflowIndexCatchupError` is an indexing-lag symptom, not a load failure. Stream lag paging, rebuild-workflow failure paging, and the backlog dashboard are in ADR 0004 / `operations-dashboards-and-alerting.md`.

## 6. Operations and runbook

- **Force a rebuild of one index**: start `PersistIndexRebuildWorkflow` manually with `mode="WRITE"` and `indexes=[{ owner_type, index_name }]`. Do this after changing or removing an established `change_trigger.when`, because the fingerprint will not do it for you. Run one full-graph execution at a time; batch several indexes into one execution only intentionally.
- **Initial materialisation**: add `initializeStreamCheckpoint: true` so finalize seeds the stream checkpoint at the prepare-time watermark.
- **Inspect fingerprints**: query the table for `pk="index"`; compare `fingerprint`, `status`, `executionArn`, `lastBackfillCompletedAt`, `backfillWatermarkCommitNum/OpNum`, `errorMessage`. Recompute the expected value by loading the lexicon through the catalog and hashing (3.2) when a rebuild loop is suspected.
- **Release a stuck `REBUILDING` claim**: confirm no execution is running, then conditionally update the item (`status = REBUILDING AND executionArn = <that execution>`) to `FAILED`; discovery picks it up next hour. Prefer redriving the failed execution when the failure was transient.
- **Reset state**: delete the `pk="index"` item; discovery treats a missing item as "rebuild now". Never delete the `pk="stream"` item to reset; use the fast-forward playbook below or an `initializeStreamCheckpoint` rebuild.
- **Checkpoint fast-forward (unrecoverable backlog)**: set the poller's reserved concurrency to 0 (disabling the schedule alone leaves queued async invocations), wait for `updatedAt` to go static, rewrite the checkpoint with the target `commitNum` and `opNum >= 1` (the stream API rejects `opNum=0`) and a `sourceExecutionArn` marker such as `manual-fast-forward-<timestamp>`, restore concurrency to 1, then rebuild every index from current graph state. Derived values are pure functions of current state, so fast-forward plus full rebuild is consistent.
- **Sparse ceiling tripped**: correct the declaration or raise `max_candidate_elements` knowingly; the knob is outside the fingerprint, so raising it does not itself schedule a rebuild.
- **Delete-aware poll failing every minute**: the only exits are removing `on_remove` for that index in the lexicon or the fast-forward plus rebuild playbook.

## 7. Verification and acceptance criteria

- Discovery unit tests: no state item selects; same fingerprint and `ACTIVE` skips; changed fingerprint selects; `FAILED` selects; any `REBUILDING` state or `RUNNING` execution skips the whole run; selection respects the per-execution limit.
- State store tests: `markRebuilding` keeps completed-backfill evidence and clears the superseded error; refuses another execution's lock; re-claims its own lock; claims a missing item. `markFailed` is a no-op when the condition fails.
- Fail handler tests: decodes the status-change envelope; loads input via `DescribeExecution` when omitted; readable error on malformed input.
- Catalog tests: fingerprint stays byte-identical for an unchanged definition; changes for a new sparse, absent-value, additional-trigger, or delete-aware declaration; does not change for a `when` edit or a knob retune; every rejection in 3.4 has a test.
- Poller tests: direct `outV`/`inV` resolution from `from`/`to`; conditioned or endpoint-less records fall back; repeated direct triggers collapse to one recompute; unresolvable delete never checkpoints past itself and the lease is released on failure.
- Catch-up tests: watermark comparison is lexicographic on `(commitNum, opNum)`; capture returns the configured budget; check reports caught up; check fails at the attempt budget.
- CDK assertions: hourly discovery schedule, `INDEX_DISCOVERY_MAX_INDEXES_PER_EXECUTION` wired, failure rule targets the fail handler, catch-up states present with `Wait` on `$.indexCatchupStatus.waitSeconds`.
- Acceptance: publishing a lexicon that changes one index's `value_query` results in exactly one `WRITE` execution within one discovery interval and the item ending `ACTIVE` with the new fingerprint; publishing only a `when` change results in no execution; a CSV run with `waitForIndexCatchup=true` succeeds only after the checkpoint passes the post-load watermark.

## 8. Design decisions

- **ADR 0003, owner-rootable indexes**: `value_query` must extend `subject_query` minus `.id()`. Problem solved: stream pages repeat triggers for one owner and mix indexes; rooting the value read at the owner allows in-page dedupe, one final recompute per owner, and batched mixed-index mutations without relying on trigger order. Durable cross-invocation dedupe and partial page checkpoints were rejected as harder to reason about.
- **ADR 0005, direct stream owner resolution**: for exact edge-endpoint subjects the owner id is already in the stream record. Problem solved: the trigger-to-owner Gremlin read dominated poller cost on high-volume edge triggers. Recognition is exact and narrow; anything else falls back, so no feature flag was needed. Conditioned triggers cannot use it because endpoint metadata cannot prove conditions.
- **ADR 0007, conditions outside the fingerprint**: `when` narrows future recomputation eligibility but not the stored value. Problem solved: introducing conditions on existing high-volume indexes would otherwise have scheduled unnecessary full-graph rebuilds. Consequence: loosening a condition is an operator-controlled rebuild.
- **ADR 0008, trigger-first rebuilds**: declared per index, never inferred; bounded count before ranging; fused enumerate-plus-map query; hard ceiling instead of silent fallback; absence as the default encoding; eager enumeration of the self-modifying holder population; primary trigger as the only rebuild lane; opt-in delete awareness that fails loud. Problem solved: a full owner scan over a very large owner label to change a small fraction of its properties, and the unbounded label scan that the literal PRD wording implies could not finish at scale.

## 9. Source map (persist repo, relative paths)

| Path | Responsibility |
|---|---|
| `lambda/index-discovery-poller/handler.ts` | Scheduled entry point; wraps `IndexDiscoveryService.discover` |
| `lambda/services/IndexDiscoveryService.ts` | Selection rules (`shouldRebuildIndex`, `hasRebuildingIndex`, `selectIndexesForRebuild`), running-execution guard, `StartExecution` |
| `lambda/services/IndexDefinitionStateStoreService.ts` | `pk="index"` items: `listIndexStates`, `markRebuilding`, `markActive`, `markFailed` with their conditions |
| `lambda/services/IndexCheckpointStoreService.ts` | `pk="stream"` item: lease acquire/release, put, conditional advance |
| `lambda/services/IndexCatalogService.ts` | Lexicon to catalog, all load-time validations, trigger bindings, `resolveStreamOwnerField`, `sparseCandidatePlans`, `indexDefinitionFingerprint` |
| `lambda/services/IndexValueValidationService.ts` | Value contract validation and date coercion |
| `lambda/services/IndexWriterService.ts` | Trigger-rooted binding, batched owner discovery and owner reads, mutation batching, write/remove |
| `lambda/services/IndexRebuildService.ts` | Prepare (claims, counting, candidate and owner-scan ranges, CSV root vertices), range/batch processing, finalize, `markFailed` |
| `lambda/services/IndexRebuildMetricsService.ts` | Rebuild candidate and write metrics |
| `lambda/services/IndexStreamPollerService.ts` | Trigger lookup views, direct/fallback lanes, delete-aware planning, lease lifecycle |
| `lambda/index-rebuild-fail/handler.ts` | EventBridge status-change consumer that releases claims |
| `lambda/index-rebuild-finalize/handler.ts` | Finalize entry point |
| `lambda/workflow-index-catchup/handler.ts`, `lambda/services/WorkflowIndexCatchupService.ts` | `capture` and `check` actions of the catch-up barrier |
| `lambda/schemas/derived-index.ts` | Catalog entry, definition state, candidate plan, range/batch records, checkpoint, stream record schemas |
| `lambda/schemas/lexicon.ts` | Lexicon index rule fields (`when`, `additional_change_triggers`, `absent_value`, `sparse_rebuild`, `on_remove`) |
| `lambda/schemas/workflow.ts`, `lambda/services/WorkflowInputService.ts` | `waitForIndexCatchup` input and catch-up status schemas |
| `lib/persist-stack.ts` | Discovery schedule and Lambda, failure rule, catch-up Lambda and workflow states, index env block |
| `docs/adr/0003-*.md`, `0005-*.md`, `0007-*.md`, `0008-*.md` | Decision records condensed in section 8 |
| `test/services/IndexDiscoveryService.test.ts`, `IndexDefinitionStateStoreService.test.ts`, `IndexCatalogService.test.ts`, `IndexStreamPollerService.test.ts`, `WorkflowIndexCatchupService.test.ts`, `test/handlers/index-rebuild-fail.handler.test.ts` | Behaviour the acceptance criteria in section 7 are drawn from |
