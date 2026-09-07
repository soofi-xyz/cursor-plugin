# Email Workflow Certification Gates

Evaluate every gate before assigning the final verdict. Continue diagnostic scoring after a failed gate.

Use:

- `Pass`: direct evidence satisfies the gate.
- `Failed`: the evaluated implementation or release path is absent, unsafe, or contradicts the gate.
- `Blocked`: evaluator access or missing immutable provenance prevents a conclusion.

Do not use `Blocked` to soften a known implementation failure.

## Gate 1: Source and runtime traceability

Pass only when:

- email and SMS refs resolve to immutable commit SHAs;
- the report identifies the exact evaluated email PR or commit;
- existing DEV runtime evidence carries a deployed commit SHA, image digest, asset manifest, or equivalent immutable provenance;
- policy and contract versions are present on run evidence.

Mark `Blocked` when the runtime is healthy but cannot be linked to a source revision. A nearby deployment timestamp is not sufficient.

## Gate 2: End-to-end DEV runtime

Pass only when one existing successful DEV run proves:

```text
eligible audience
  -> reduction and legal scheduling
  -> reviewed template rendering
  -> controlled SES/provider submission
  -> provider feedback or deterministic provider simulator feedback
  -> internal lifecycle persistence
```

Require count reconciliation and durable evidence across every boundary. A solver-only run fails this gate even when its artifacts are correct.

Use an approved deterministic provider simulator for DEV when real sending is unsafe. Do not create that run during certification.

## Gate 3: Compliance and freshness

Pass only when:

- Filter evaluates email-address-level rules;
- consent, unsubscribe, DNC/contact restrictions, invalidity, and suppressions are owned explicitly;
- the campaign population is evaluated on its actual send date;
- queued work receives a final pre-submission freshness check;
- an ineligible address is excluded without suppressing unrelated valid addresses unless policy explicitly requires debt-level exclusion;
- the final decision and reason are auditable.

An accepted design that knowingly sends from stale Filter output fails certification even if Solver correctly treats Filter as authoritative.

## Gate 4: PII and security

Pass only when evidence shows:

- no email addresses, message bodies, debt/person identifiers, provider payloads, or task tokens in logs, Step Functions state, metrics dimensions, PagerDuty, or review/control queue messages;
- sensitive artifacts are encrypted and private;
- IAM permissions match capability boundaries;
- manifests and reports expose only PII-safe counts, hashes, statuses, and references;
- unresolved-event evidence remains useful without leaking protected content.

If the implemented provider or feedback stages do not yet exist, mark this gate `Blocked` only when no unsafe behavior is present and their absence is already captured by the end-to-end gate. Mark `Failed` when a known path exposes protected content.

## Gate 5: Production safety

Pass only when:

- certification itself cannot send or mutate;
- PROD deployment requires explicit release approval after documented prerequisites;
- merging an implementation PR cannot automatically provision or enable an unapproved provider path;
- sender enablement, quotas, credentials, dependencies, alarms, and rollback are preflighted;
- shadow/scale certification evidence is complete before production activation;
- no real provider send is required to evaluate the agent.

An unconditional deploy-on-merge path while readiness prerequisites remain open fails this gate, even when no current PROD stack exists.

## Verdict decision

Apply in order:

1. If any gate is `Failed`, return `NOT_CERTIFIED`.
2. Otherwise, if any gate is `Blocked`, return `BLOCKED`.
3. Otherwise, require total `>= 85`, every dimension `>= 75%`, and all three scale runs.
4. If those scoring requirements pass, return `CERTIFIED`.
5. Otherwise return `NOT_CERTIFIED`.

Always report diagnostic scores. Gate failure changes the verdict, not the arithmetic.
