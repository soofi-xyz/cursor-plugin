# Email Workflow Certification Report Contract

Return a factual Markdown report in this order. Keep it pasteable into a PR, task, or handoff record.

## 1. Verdict

```text
Verdict: CERTIFIED | NOT_CERTIFIED | BLOCKED
Total: n/100
Certification profile: email-workflow-certification-v1
```

Add one sentence naming the decisive evidence or gap.

## 2. Scope and immutable revisions

Include:

- Email repository, PR, and commit SHA
- SMS requested ref and reference repository, plus the resolved commit SHA
- environment and region
- existing execution ARN when evaluated
- observation timestamp

Never report only a branch name.

## 3. Gates

| Gate | Status | Evidence IDs | Why |
|---|---|---|---|
| Source and runtime traceability | Pass/Failed/Blocked | IDs | concise reason |
| End-to-end DEV runtime | Pass/Failed/Blocked | IDs | concise reason |
| Compliance and freshness | Pass/Failed/Blocked | IDs | concise reason |
| PII and security | Pass/Failed/Blocked | IDs | concise reason |
| Production safety | Pass/Failed/Blocked | IDs | concise reason |

## 4. Scorecard

| Dimension | Weight | Band | Points | Evidence IDs | Why |
|---|---:|---:|---:|---|---|
| Audience and compliance | 15 | allowed band | exact lookup | IDs | concise reason |
| Deterministic recipient identity | 10 | allowed band | exact lookup | IDs | concise reason |
| Legal scheduling and capacity | 15 | allowed band | exact lookup | IDs | concise reason |
| Rendering and handoff | 10 | allowed band | exact lookup | IDs | concise reason |
| SES backlog and send controls | 15 | allowed band | exact lookup | IDs | concise reason |
| Correlation, feedback, and lifecycle closure | 15 | allowed band | exact lookup | IDs | concise reason |
| Reliability, replay, and overflow | 10 | allowed band | exact lookup | IDs | concise reason |
| Observability, security, and evidence | 10 | allowed band | exact lookup | IDs | concise reason |
| **Total** | **100** | | **n** | | |

Bands must be `0%`, `25%`, `50%`, `75%`, or `100%`. Use the point lookup in `parity-scorecard.md`.

## 5. Capability findings

For each capability boundary, state:

- observed behavior;
- expected parity behavior;
- status: `Proven`, `Partial`, `Missing`, or `Blocked`;
- evidence IDs;
- material limitation.

Order: audience, runtime, templates, provider execution, feedback/persistence.

## 6. Scale reconciliation

| Input size | Commit linked | End-to-end | Reconciled | Evidence IDs | Result |
|---:|---|---|---|---|---|
| 100 | Yes/No | Yes/No | Yes/No | IDs | Pass/Failed/Blocked |
| 10,000 | Yes/No | Yes/No | Yes/No | IDs | Pass/Failed/Blocked |
| 100,000 | Yes/No | Yes/No | Yes/No | IDs | Pass/Failed/Blocked |

Do not substitute a unit/performance test for deployed end-to-end evidence.

## 7. Evidence registry

List each cited ID with:

- source URL, ARN, or PII-safe key;
- observation timestamp;
- observed fact;
- limitation.

Do not include raw population rows, message content, protected identifiers, secrets, or task tokens.

## 8. Missing capabilities and remediation

List findings in certification-blocking order. Each item includes:

- failed or blocked gate/dimension;
- concrete missing evidence or capability;
- owning boundary: Xatu, Oranguru, Wigglytuff, Chatot, or release engineering;
- evidence required for closure.

Do not implement fixes during certification.

## 9. Safety statement

End with:

```text
Safety: certification used read-only GitHub and AWS evidence; it did not start,
redrive, deploy, send, receive queue messages, retrieve secrets, or mutate DEV
or PROD.
```

If an action was not observable, say `not observed`; never claim safety from absence of access alone.

## Machine-readable mirror

When the caller requests JSON, return the same findings without changing names or arithmetic:

```json
{
  "profile": "email-workflow-certification-v1",
  "verdict": "CERTIFIED | NOT_CERTIFIED | BLOCKED",
  "total_points": 0,
  "observed_at": "ISO-8601 UTC",
  "scope": {
    "email_repository": "owner/repo",
    "email_pull_request": 0,
    "email_commit_sha": "40-character SHA",
    "sms_repository": "owner/repo",
    "sms_requested_ref": "main",
    "sms_commit_sha": "40-character SHA",
    "environment": "dev",
    "region": "us-east-2",
    "execution_arn": null
  },
  "gates": [
    {
      "name": "source_and_runtime_traceability",
      "status": "Pass | Failed | Blocked",
      "evidence_ids": ["GH-01"],
      "reason": "..."
    }
  ],
  "dimensions": [
    {
      "name": "audience_and_compliance",
      "weight": 15,
      "band": 0,
      "points": 0,
      "evidence_ids": ["GH-01"],
      "reason": "..."
    }
  ],
  "scale": [],
  "evidence": [],
  "remediation": [],
  "safety": {
    "read_only": true,
    "mutations_observed": []
  }
}
```

Emit all five gates and all eight dimensions. `total_points` must equal the dimension sum. Do not place protected data in JSON.

## Arithmetic check

Before returning:

1. verify every band is allowed;
2. verify every point value matches the lookup;
3. sum points exactly;
4. apply gate precedence;
5. verify `CERTIFIED` satisfies all thresholds;
6. verify every scored claim cites at least one evidence ID.
