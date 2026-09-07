# Email Workflow Parity Scorecard

Version: `email-workflow-certification-v1`

Score capabilities, not file similarity. Use only bands `0`, `25`, `50`, `75`, or `100`.

## Band anchors

- `0%`: absent, contradicted, unsafe, or no relevant evidence.
- `25%`: intent, documentation, or isolated tests exist; runtime outcome is unproven.
- `50%`: implementation and limited runtime evidence exist; material end-to-end or scale gaps remain.
- `75%`: the capability is substantially proven end to end; only bounded evidence or operational gaps remain.
- `100%`: direct, reproducible, commit-linked runtime evidence proves the complete capability at required scale and failure modes.

Do not interpolate. Use this exact point lookup:

| Weight | 0% | 25% | 50% | 75% | 100% |
|---|---:|---:|---:|---:|---:|
| 15 | 0 | 4 | 8 | 11 | 15 |
| 10 | 0 | 3 | 5 | 8 | 10 |

## Dimensions

### 1. Audience and compliance — 15

Prove:

- Filter/Xatu owns eligibility, consent, suppressions, and required evidence;
- rules apply at email-address level, not debt level only;
- a campaign is filtered on its actual send date;
- a final pre-submission check prevents stale opt-out, DNC, invalid, or ineligible contact use;
- the runtime does not silently reconstruct eligibility from raw systems.

A historical Filter output with no freshness control cannot exceed `25%`.

### 2. Deterministic recipient identity — 10

Prove:

- one selected email action per debt under the declared policy;
- stable normalized email and action identity;
- deterministic primary/verification/tie-break behavior;
- duplicate and conflicting debt rows have explicit outcomes;
- retries cannot create a second logical action.

### 3. Legal scheduling and capacity — 15

Prove:

- recipient-local and campaign-clock legal windows;
- timezone/postal ambiguity fails closed;
- separate daily and hourly capacity;
- shared-provider quota is authoritative at execution time;
- same-day overflow, no accidental next-day rollover, and deterministic ordering;
- 100, 10,000, and 100,000-row reconciled evidence.

### 4. Rendering and handoff — 10

Prove:

- a reviewed Git template inventory is the runtime source of truth;
- active version, language, variables, disclosures, and template identity are explicit;
- rendering is deterministic and preserves interaction identity;
- per-row rendering failures are durable and do not silently disappear;
- the execution artifact is complete enough for Chatot without re-ranking or re-deriving audience.

### 5. SES backlog and send controls — 15

Prove:

- a shared backlog prevents campaigns from independently over-planning SES capacity;
- per-second and rolling/day quotas are enforced at provider attempt time;
- legal deadlines remain enforced while queued;
- provider submission is idempotent and ambiguous outcomes do not cause blind resend;
- retries, lanes, throttling, and DLQs are bounded and observable.

### 6. Correlation, feedback, and lifecycle closure — 15

Prove:

- local message ID, SES/provider message ID, and internal interaction ID remain correlated;
- delivery, bounce, complaint, unsubscribe, and response events are normalized;
- events persist idempotently to the internal source of truth;
- unresolved correlation or persistence remains retryable;
- external reporting is downstream and does not substitute for lifecycle closure.

### 7. Reliability, replay, and overflow — 10

Prove:

- immutable run and artifact identity;
- explicit partial-success versus infrastructure-failure semantics;
- exact selected/overflow/hourly reconciliation;
- replay and redrive boundaries prevent duplicates;
- stale approvals and expired schedules fail closed;
- recovery paths preserve evidence and do not repeat provider side effects.

### 8. Observability, security, and evidence — 10

Prove:

- commit-to-deployment provenance;
- metrics, alarms, DLQs, cost controls, and run summaries;
- PII-free logs, Step Functions state, metrics, alerts, and queue control messages;
- encrypted data artifacts and least-privilege roles;
- production release gates and rollback;
- reproducible evidence IDs for all claims.

## Verdict thresholds

Return `CERTIFIED` only when:

- every gate passes;
- total points are at least `85`;
- every dimension band is at least `75%`;
- all three required scale runs are commit-linked and reconciled.

Return `NOT_CERTIFIED` when any gate fails, total points are below `85`, or any dimension is below `75%`.

Return `BLOCKED` only when there is no conclusive failed gate and evaluator access or provenance prevents resolution.
