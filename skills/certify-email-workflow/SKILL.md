---
name: certify-email-workflow
description: "Certifies the complete Spring Oaks Email Workflow against pinned SMS workflow capability parity using deterministic scoring and read-only GitHub and AWS evidence. Use when assessing email workflow readiness, handoff quality, or production certification."
---

# Certify Email Workflow

Use this skill to evaluate an existing end-to-end Email Workflow. Do not use it to implement or repair the workflow.

## Load first

Read these companion skills before collecting evidence:

1. `skills/apply-engineering-guidelines/`
2. `skills/select-communication-audience/`
3. `skills/assemble-communication-runtime/`
4. `skills/manage-channel-templates/`
5. `skills/manage-communication-activity/`

Then read every reference in this skill:

- `reference/parity-scorecard.md`
- `reference/evidence-contract.md`
- `reference/gates-and-verdicts.md`
- `reference/report-contract.md`
- `reference/scoring-examples.md`

Read `reference/calibration-email-workflow-pr-1.md` only when validating the rubric or comparing a later assessment with the initial calibration.

## Required inputs

Collect:

- Email Workflow repository or PR URL
- Email Workflow ref to evaluate
- optional SMS Workflow reference repository and ref; default to `Spring-Oaks-Capital-LLC/sms-workflow@main`
- target environment and AWS region
- operator-selected AWS profile
- optional existing DEV execution ARN

Resolve both refs to commit SHAs and record them before scoring. When the SMS reference is omitted, resolve the current HEAD of `Spring-Oaks-Capital-LLC/sms-workflow@main` once at the start of the run. A branch name is input convenience, not report identity; score only the resolved SHA and do not re-resolve it during the run.

## Capability model

Evaluate the full workflow through these boundaries:

```text
Filter / Xatu audience
  -> Email runtime reduction and legal scheduling / Oranguru
  -> reviewed template selection and rendering / Wigglytuff
  -> shared backlog, SES submission, correlation, feedback / Chatot
  -> internal lifecycle persistence, metrics, reconciliation, replay
```

Use SMS as the capability reference, not a demand for identical code:

- provider-specific behavior may differ;
- email does not require OR-Tools when the business decision is to schedule every eligible debt;
- email still requires deterministic identity, legal timing, capacity enforcement, overflow evidence, idempotency, provider correlation, and lifecycle closure;
- solver-only output is not an end-to-end communication.

## Phase 1: intent, refs, and gates

1. State the one-sentence business intent.
2. Pin the email and SMS commit SHAs.
3. Identify the evaluated email scope and runtime components.
4. Create the evidence registry.
5. Evaluate all five gates using `gates-and-verdicts.md`.
6. Distinguish:
   - `Failed`: implementation or submitted evidence contradicts the requirement;
   - `Blocked`: evaluator access or missing provenance prevents a conclusion;
   - `Pass`: direct evidence resolves the gate.

Do not stop diagnostic scoring because a gate failed.

## Phase 2: product and runtime evidence

Collect only the evidence allowed by `evidence-contract.md`.

Evaluate:

- email-level eligibility, consent, suppression, and send-time freshness;
- deterministic one-email-per-debt identity and duplicate behavior;
- timezone-correct legal windows, daily/hourly capacity, and overflow;
- reviewed template inventory and deterministic rendering;
- shared backlog admission, SES quotas/rate limiting, and submission idempotency;
- local-to-provider-to-interaction correlation;
- delivery, bounce, complaint, unsubscribe, and response ingestion;
- idempotent internal persistence and unresolved-event recovery;
- replay, redrive, partial failure, and reconciliation;
- metrics, alarms, DLQs, cost limits, PII boundaries, and source provenance.

Runtime evidence must be linked to the evaluated email commit. A successful execution from an unknown deployment revision is useful context but cannot prove that revision.

Require existing successful evidence at:

- 100 rows;
- 10,000 rows;
- 100,000 rows.

For each size, require input, selected, overflow, and hourly count reconciliation plus immutable manifest or digest evidence. Never start these runs during certification.

## Phase 3: independent review and score

Ask the following agents for read-only findings against the same refs:

- Xatu for audience and compliance;
- Oranguru for runtime, scheduling, outputs, and scale;
- Wigglytuff for templates and rendering;
- Chatot for provider execution and lifecycle closure.

Each reviewer returns:

- resolved commit SHAs;
- relevant evidence IDs;
- dimension bands it recommends;
- strengths, failures, and blockers;
- confidence.

Reconcile conflicts from evidence, not majority vote. Score implementation only after product/runtime findings are complete.

## Safety

- Do not modify repositories, comments, checks, branches, or pull requests.
- Do not start, stop, retry, redrive, or approve AWS workflows.
- Do not invoke Lambda, Glue, SES, EventBridge, or provider APIs.
- Do not write or delete S3 objects.
- Do not receive, delete, or change SQS messages.
- Do not call Secrets Manager `GetSecretValue`.
- Do not read population rows or message bodies.
- Do not inspect PROD data-plane artifacts.
- Keep PII and secrets out of prompts and reports.

## Completion checklist

- both source revisions are immutable SHAs;
- evidence is timestamped and identified;
- all gates have concrete reasons;
- all eight dimensions use allowed bands and exact points;
- points sum to 100 or less without arithmetic drift;
- verdict follows the gate and threshold rules;
- solver evidence is not presented as full-workflow proof;
- report follows `report-contract.md`;
- no mutation or protected-data action occurred.
