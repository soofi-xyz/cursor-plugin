# Email Workflow Certification Evidence Contract

Collect evidence without changing source, infrastructure, data, queues, executions, or provider state.

## Evidence record

Assign every observation an ID:

```text
Evidence ID: GH-01 | AWS-01 | DOC-01
Observed at: ISO-8601 UTC
Environment: source | dev | prod
Revision: immutable commit SHA when applicable
Source: URL, ARN, or PII-safe object key
Observation: concise factual result
Limitations: missing linkage, access, freshness, or scale
```

Documentation evidence proves declared intent only. Test evidence proves the tested path. Runtime evidence proves only the deployed revision and observed population.

## GitHub evidence

Resolve and record:

- repository URLs;
- email PR number and head SHA;
- SMS reference SHA;
- check names, conclusions, and run URLs;
- changed files and relevant implementation paths;
- contracts, ADRs, operations guides, agent guidance, tests, and deployment workflows;
- unresolved review findings and release prerequisites.

Use read-only `gh` operations such as:

- `gh repo view`
- `gh pr view`
- `gh pr checks`
- `gh api` with `GET`

Do not comment, review, label, merge, close, rerun, dispatch, edit, create, or push.

## AWS identity and environment

Ask for or reuse an operator-selected profile. Never embed a developer profile name in the agent or report.

Before evidence collection:

```bash
AWS_PROFILE=<selected-profile>
AWS_REGION=us-east-2
aws sts get-caller-identity --profile "$AWS_PROFILE" --region "$AWS_REGION"
```

Expected environment identities:

- DEV account: `951132547414`
- PROD account: `014948052063`
- primary region: `us-east-2`

If identity or region differs, stop AWS collection and mark it `Blocked`. Do not attempt role changes or credential repair.

## Allowed AWS evidence

Use control-plane and PII-safe metadata reads only.

### STS

- `GetCallerIdentity`

### CloudFormation

- `DescribeStacks`
- `DescribeStackEvents`
- `ListStacks`
- `ListStackResources`

Capture status, timestamps, tags, outputs, and resource identities. Prefer discovery from stack outputs/tags over guessed physical names.

### Step Functions

- `ListStateMachines`
- `DescribeStateMachine`
- `ListExecutions`
- `DescribeExecution`
- `GetExecutionHistory`

Use an existing execution. Never call start, stop, redrive, or callback APIs. Do not print execution input/output if it contains PII; extract only counts, statuses, safe reason codes, policy versions, artifact prefixes, and provenance.

### Glue

- `GetJob`
- `GetJobRun`
- `GetJobRuns`
- `GetWorkflow`
- `GetWorkflowRun`

Capture job/run identity, state, timestamps, execution time, worker configuration, and safe errors. Never start or stop a run.

### S3

- `ListBucket` / `ListObjectsV2`
- `HeadObject`
- `GetObject` only for explicitly PII-free metadata

Allowed object content:

- `_metadata/*.json`
- `_metadata/completed.json`
- `run_summary/run_summary.json`
- other manifests explicitly documented and verified as PII-free

Never read selected, overflow, hourly, rendered, send, provider-event, or population rows. Never write, copy, tag, restore, or delete objects.

### CloudWatch and logs

- `ListMetrics`
- `GetMetricData`
- `GetMetricStatistics`
- `DescribeAlarms`

Do not read application log events during routine certification because logs may contain protected data. If a required conclusion depends on logs, mark it `Blocked` and request an approved PII-safe evidence extract.

### SQS

- `GetQueueAttributes`
- `ListQueues`
- `ListQueueTags`

Capture approximate depth, age-related metrics through CloudWatch, redrive policy, encryption metadata, and queue identity. Never call `ReceiveMessage`, `DeleteMessage`, `PurgeQueue`, or visibility APIs.

### SES

- `GetAccount`
- `GetSendQuota` where supported
- `ListConfigurationSets`

Capture quota and configuration metadata only. Never call send, test-render, identity mutation, or suppression mutation APIs.

### IAM and KMS

Prefer CloudFormation templates and resource policies already visible in source. If needed, use metadata-only `GetRole`, `ListRolePolicies`, `GetRolePolicy`, `ListAttachedRolePolicies`, `DescribeKey`, and `GetKeyPolicy`. Never create sessions, decrypt data, or change policies.

### Secrets Manager

Do not call `GetSecretValue` or `BatchGetSecretValue`. Existence may be established from source wiring, CloudFormation references, or metadata-only description when explicitly allowed. Never expose secret ARNs when the report does not need them.

## DEV runtime proof

Require:

- stack and state-machine identity;
- deployed commit SHA, image digest, asset provenance, or equivalent immutable source link;
- successful end-to-end execution ARN;
- Glue/provider/lifecycle child identities;
- completion state and timestamps;
- safe selected, overflow, rendered, submitted, terminal-feedback, and persisted counts;
- immutable manifest/digest reconciliation;
- metrics and DLQ state for the observed interval.

Nearby CI and deployment timestamps are not enough to link a runtime to a commit.

## Scale proof

Require existing evidence for 100, 10,000, and 100,000 input rows. For each:

- input count and fixture/profile identity;
- selected plus overflow equals unique eligible action population;
- hourly artifacts equal selected actions;
- rendered plus render failures equals selected actions;
- submitted plus pre-submit exclusions plus failures equals rendered actions;
- terminal plus unresolved-provider equals accepted provider submissions;
- persisted plus persistence-pending equals normalized terminal events;
- duration, cost, throttling, and DLQ observations;
- commit and policy version.

## PROD boundary

PROD evidence is control-plane only:

- whether stacks/workflows exist;
- deployment status and revision metadata;
- alarms and queue attributes;
- release-gate configuration.

Do not read PROD S3 artifacts, workflow payloads, provider events, logs, message bodies, or population data.

## Access denial

After one definitive authorization or authentication denial:

1. record the denied action and environment without credentials;
2. stop that evidence path;
3. mark the affected gate/dimension `Blocked`;
4. continue independent read-only evidence paths.
