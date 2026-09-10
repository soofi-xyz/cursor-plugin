# Initial Calibration: Email Workflow PR 1

This frozen calibration validates `email-workflow-certification-v1`. It is not a current status page; rerun certification against new immutable revisions for later decisions.

## Verdict

Verdict: `NOT_CERTIFIED`

Total: `25/100`

Decisive reason: the evaluated change proves a small Email Solver run, but it explicitly does not implement rendering, provider submission, feedback, or internal lifecycle closure.

## Scope

- Email PR: `Spring-Oaks-Capital-LLC/email-workflow#1`
- Email commit: `09f069872bbbd6c178558da1c1edeb7b3863d084`
- SMS reference commit: `5cc213e238fd17349d97ce60d8fe42e0e2b57d5f`
- Environment: DEV account `951132547414`, `us-east-2`
- Observation time: `2026-09-07T10:27:19Z`
- Existing execution: `arn:aws:states:us-east-2:951132547414:execution:EmailSolverWorkflow:email-solver-smoke-20260907T091645Z`

## Gates

| Gate | Status | Evidence | Why |
|---|---|---|---|
| Source and runtime traceability | Blocked | GH-01, AWS-01 | Refs are pinned, but the deployed stack has no commit tag/output or equivalent source provenance. |
| End-to-end DEV runtime | Failed | GH-02, AWS-02, AWS-03 | The successful execution ends at solver artifacts; rendering, send, feedback, and persistence are absent. |
| Compliance and freshness | Failed | GH-02 | The accepted solver boundary explicitly has no post-Filter suppression freshness check, and no downstream pre-submit check is implemented. |
| PII and security | Blocked | GH-02, AWS-01 | Solver controls are documented and encrypted, but missing provider/feedback stages prevent end-to-end PII verification. |
| Production safety | Failed | GH-03, AWS-04 | Merge to `main` invokes PROD deployment while documented readiness prerequisites remain open; no PROD stack currently exists. |

## Scorecard

| Dimension | Weight | Band | Points | Evidence | Why |
|---|---:|---:|---:|---|---|
| Audience and compliance | 15 | 25% | 4 | GH-02 | Filter ownership is specified, but fresh email-level pre-send enforcement is not proven. |
| Deterministic recipient identity | 10 | 50% | 5 | GH-01, AWS-02 | Code/tests and a four-row solver run support deterministic reduction, without commit-linked or scaled runtime proof. |
| Legal scheduling and capacity | 15 | 50% | 8 | GH-01, AWS-02, AWS-03 | Same-day scheduling, SES quota snapshot, and overflow ran successfully at four rows; required scale is absent. |
| Rendering and handoff | 10 | 0% | 0 | GH-02 | Explicitly out of scope and not implemented. |
| SES backlog and send controls | 15 | 0% | 0 | GH-02 | No shared backlog, provider attempt limiter, or SES submission path is implemented. |
| Correlation, feedback, and lifecycle closure | 15 | 0% | 0 | GH-02 | No provider correlation, event ingestion, or internal lifecycle persistence exists. |
| Reliability, replay, and overflow | 10 | 50% | 5 | GH-01, AWS-02, AWS-03 | Solver artifacts and overflow reconcile in the smoke run, but full send-side replay and failure recovery are absent. |
| Observability, security, and evidence | 10 | 25% | 3 | GH-01, AWS-01, AWS-04 | Solver alarms/encryption exist, but provenance, full lifecycle telemetry, scale evidence, and release safety are incomplete. |
| **Total** | **100** | | **25** | | |

## Scale reconciliation

| Input size | Commit linked | End-to-end | Reconciled | Evidence | Result |
|---:|---|---|---|---|---|
| 100 | No | No | No | none | Failed |
| 10,000 | No | No | No | none | Failed |
| 100,000 | No | No | No | GH-01 has a planner test only | Failed |

The four-row smoke execution is useful diagnostic evidence, not a required scale run.

## Evidence registry

### GH-01

- Source: `https://github.com/Spring-Oaks-Capital-LLC/email-workflow/pull/1`
- Observed: PR head `09f069872bbbd6c178558da1c1edeb7b3863d084`; DEV CI/CD and Greptile checks passed; the change includes deterministic planner, artifact verification, CDK, and tests.
- Limitation: passing tests and deploy checks do not prove the full communication lifecycle.

### GH-02

- Source: PR `README.md`, `docs/contracts/email-solver-v1.md`, `docs/operations.md`, and `docs/adr/0001-deterministic-same-day-scheduling.md`
- Observed: the repository states that it does not render or send email; downstream rendering, backlog, provider feedback, and delivery status are outside the implementation. It also accepts the lack of suppression freshness after Filter as a boundary.
- Limitation: declared boundaries are not runtime proof.

### GH-03

- Source: PR `.github/workflows/ci-cd-prod.yml` and `justfile`
- Observed: pushes to `main` call the shared PROD workflow, and `just deploy` runs `cdk deploy --require-approval never`.
- Limitation: shared workflow internals were not needed to establish the unconditional caller path.

### AWS-01

- Source: CloudFormation stack `EmailSolver-dev`
- Observed: stack status `UPDATE_COMPLETE`, updated `2026-09-07T09:16:21.080Z`; outputs identify the workflow, Glue packaging, artifact bucket, and control queues. Stack tags are empty and outputs contain no deployed commit SHA.
- Limitation: runtime cannot be immutably linked to GH-01.

### AWS-02

- Source: existing Step Functions execution ARN listed above
- Observed: `SUCCEEDED` from `2026-09-07T09:16:48.182Z` to `2026-09-07T09:19:38.498Z`; output status `COMPLETED_WITH_OVERFLOW`; four input candidates produced two selected actions, two overflow actions, and two hourly actions. Safe overflow reasons were `AMBIGUOUS_POSTAL_OFFSET` and `NO_ELIGIBLE_EMAIL_CANDIDATE`.
- Limitation: solver-only, four-row evidence.

### AWS-03

- Source: Glue run `jr_d8cb476a1a1c88ae226294aa4ddefb3983fb4ba8a0566b8143d52391d69b8dfc`
- Observed: `SUCCEEDED` in 108 execution seconds during AWS-02.
- Limitation: no rendering/provider/lifecycle work occurs in this job.

### AWS-04

- Source: PROD CloudFormation control-plane listing in account `014948052063`, `us-east-2`
- Observed: no active `EmailSolver-prod` stack existed at observation time.
- Limitation: absence of a stack does not make the merge-triggered deployment path safe.

## Certification blockers

1. Xatu/Filter: prove email-address-level rules and same-day plus pre-submission suppression freshness.
2. Wigglytuff: implement and prove reviewed template inventory, deterministic rendering, and durable row failures.
3. Chatot: implement shared backlog admission, SES attempt limiting, idempotent send, correlation, feedback, response ingestion, and Persist closure.
4. Oranguru/release engineering: add commit provenance and reconciled 100, 10,000, and 100,000-row end-to-end runs.
5. Release engineering: prevent automatic PROD deployment until prerequisites and explicit approval pass.

Safety: calibration used read-only GitHub and AWS evidence; it did not start, redrive, deploy, send, receive queue messages, retrieve secrets, or mutate DEV or PROD.
