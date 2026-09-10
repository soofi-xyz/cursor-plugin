# Email Workflow Certification Scoring Examples

Use these examples to keep repeated evaluations consistent. They are anchors, not substitutes for evidence.

Dimension order:

1. audience/compliance — 15
2. recipient identity — 10
3. scheduling/capacity — 15
4. rendering/handoff — 10
5. SES backlog/send — 15
6. feedback/lifecycle — 15
7. reliability/replay — 10
8. observability/security/evidence — 10

## A. Full certified workflow

- Evidence: pinned refs, commit-linked DEV flow, every boundary reconciled, all five gates pass, required scale runs pass, production approval gate exists.
- Bands: `100, 100, 100, 100, 100, 100, 100, 100`
- Points: `15 + 10 + 15 + 10 + 15 + 15 + 10 + 10 = 100`
- Verdict: `CERTIFIED`

## B. Solver implemented; delivery lifecycle missing

- Evidence: Filter contract, deterministic reduction, scheduling, overflow, and small solver run exist. Rendering, backlog, SES submission, feedback, and persistence do not.
- Bands: `25, 50, 50, 0, 0, 0, 50, 25`
- Points: `4 + 5 + 8 + 0 + 0 + 0 + 5 + 3 = 25`
- Gates: end-to-end DEV runtime `Failed`; compliance freshness may also fail.
- Verdict: `NOT_CERTIFIED`

## C. Stale Filter population

- Evidence: end-to-end flow exists, but Monday's Filter output may send Wednesday without rerun or pre-submit suppression check.
- Audience band: at most `25%` / `4` points.
- Gate: compliance and freshness `Failed`.
- Verdict: `NOT_CERTIFIED` regardless of total.

## D. Healthy runtime cannot be linked to evaluated commit

- Evidence: a successful execution exists, but stack/output/artifact metadata has no commit SHA or immutable build provenance.
- Source gate: `Blocked`.
- Runtime-dependent dimensions cannot exceed `25%` from that execution; independently proven code/test evidence may still receive diagnostic bands.
- Verdict: `BLOCKED` unless another gate conclusively fails.

## E. PII in workflow state or alerts

- Evidence: email address, body, debt ID, person ID, or task token appears in Step Functions state, CloudWatch dimensions, PagerDuty, or a review/control message.
- Observability/security band: `0%` / `0`.
- PII/security gate: `Failed`.
- Verdict: `NOT_CERTIFIED`.

## F. End-to-end small run; scale evidence missing

- Evidence: commit-linked 100-row flow reconciles through feedback and persistence; 10,000 and 100,000 runs are absent.
- Relevant capability bands may reach `75%`, but scheduling/capacity and observability/evidence cannot reach `100%`.
- Scale rows: 100 `Pass`; 10,000 and 100,000 `Failed` when required evidence was never produced, or `Blocked` only when evidence exists but evaluator access is denied.
- Verdict: `NOT_CERTIFIED` because all required scale runs are mandatory.

## G. AWS evidence access denied

- Evidence: source review reveals no known failure; verified account access receives a definitive read authorization denial before runtime evidence can be collected.
- Affected gates/dimensions: `Blocked`.
- Verdict: `BLOCKED` when no independent failed gate exists.
- Do not retry with other identities or request broader privileges inside the certification run.

## H. Automatic production deployment before readiness

- Evidence: merge to the default branch unconditionally runs production deployment while documented provider, alarm, metric, compliance, or scale prerequisites remain open.
- Production safety gate: `Failed`.
- Verdict: `NOT_CERTIFIED`, even when no PROD stack currently exists.

## I. Focused template-rendering diagnostic

- Request: compare only Email template rendering and handoff with the pinned SMS reference.
- Mapping: dimension 4, `rendering_and_handoff` — weight 10.
- Evidence: reviewed Git inventory, deterministic renderer tests, and a commit-linked small DEV artifact exist, but durable per-row rendering-failure evidence is absent.
- Band: `50%`.
- Score: `5/10`.
- Mode: `FOCUSED_DIAGNOSTIC`.
- Certification verdict: not evaluated.
- Overall score: not calculated.

Do not score the other seven dimensions or evaluate certification gates. This result does not establish end-to-end readiness.
