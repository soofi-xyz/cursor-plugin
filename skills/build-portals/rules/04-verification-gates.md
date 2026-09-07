---
title: Portal Verification Gates
impact: CRITICAL
tags: tests, coverage, browserstack, design, integration, latency
---

# Portal Verification Gates

Always run the repository's required gates: lint, typecheck, relevant tests,
build, and any CI checks required by its conventions. Then select
scope-appropriate gates below from `changeRequest.scopes`.

All five gates apply to a full `new_repository` portal delivery. For an
`existing_repository` change, run a gate only when the changed surface or an
acceptance criterion requires it. Mark unrelated gates **not applicable** with
a one-line reason; do not call them blocked or passed. A required gate must pass
and retain evidence before handoff. Do not replace failures with waivers or
mock results.

A named acceptance criterion is still required implementation work when the
agent cannot execute it locally. Missing soak tokens, BrowserStack secrets, or
AWS keys do not make that criterion not applicable. Write the sibling-style
script, attach it to the existing deploy or preview workflow, and report that
CI will run it.

| Changed scope | Additional required gates |
| --- | --- |
| Backend behavior | API unit/contract tests; live integration and latency only when deployment/live verification is explicitly in scope |
| Frontend behavior or appearance | Responsive design tests |
| User flow, auth, or preview deployment | BrowserStack full flow when credentials and a deployed target are required by acceptance criteria |
| Infrastructure | Synthesis/diff plus the repository's infrastructure tests |
| Code-only refactor | Repository gates and focused regression tests; live deployment gates are not applicable |

## Gate 1: API unit tests

Apply when backend code, API contracts, or backend infrastructure changes.

- Require a 100% test pass rate.
- For a new portal, require at least 80% statement, branch, function, and line
  coverage for the backend.
- For an existing project, require no coverage regression, preserve its
  existing threshold, and require at least 80% coverage for new backend modules
  unless the repository has a stricter rule.
- Exercise successful responses, validation failures, authorization behavior,
  upstream failures, and timeout/error mapping.
- Save the machine-readable coverage artifact path and summary.

Any failed applicable test or violated coverage threshold blocks handoff.

## Gate 2: Responsive design tests

Apply only when frontend behavior or appearance changes.

Use the portal spec's exact route and state inventory. Capture and compare all
required screens at the declared mobile, tablet, and desktop widths. Test at
least one authenticated and one unauthenticated state when the portal has auth.

Use deterministic data, disable incidental animation, and retain diff images.
An approved baseline update must be reviewable in the feature branch; never
update baselines merely to hide a mismatch.

## Gate 3: BrowserStack full flow

Apply when the change affects a user flow, authentication, browser integration,
or a deployed preview and the acceptance criteria require cross-browser proof.

Run Playwright user-behavior flows in BrowserStack against the deployed
Amplify preview URL. Cover the primary persona journey, auth boundaries,
validation errors, backend-dependent success, and logout/session expiration
when applicable.

The preview must call the real feature backend URL captured from its deployment
output. Before the run, fail if frontend runtime configuration points to
production, localhost, a mock server, or another environment. A local-only
Playwright result does not satisfy this gate.

Record:

- BrowserStack project and build URL
- commit SHA and feature branch
- preview URL
- feature API URL
- browser/device matrix
- pass/fail counts

All required flows must pass.

## Gate 4: Backend integration

For `new_repository`, apply this gate. For `existing_repository`, apply only
when `deployment` is in `changeRequest.scopes` or an acceptance criterion
explicitly requires live feature/dev or real-upstream verification.

Seed or attach the user-supplied `datasetRef` in the approved development
environment. Run API contract and frontend integration tests against the
deployed backend. Do not use fixtures that bypass Lambda, API Gateway,
authorization, secrets retrieval, or required upstream calls.

Confirm authenticated GETs with a fetch that sends
`Authorization: Bearer` from the logged-in session (Cognito ID token when
present, otherwise the legacy session token). Opening the API URL in the
address bar sends no Authorization header and is not an auth test. A
gateway body of `{"message":"Unauthorized"}` means the request never
reached Lambda; that usually means a JWT authorizer was added to a shared
`/api/v2` route whose siblings use `NONE`. A CORS miss against a literal
`*` origin is also not an auth failure.

Redact credentials and customer records from logs and evidence.

## Gate 5: API latency

For `new_repository`, apply this gate. For `existing_repository`, apply only
when `deployment` is in `changeRequest.scopes` and API performance is affected,
or an acceptance criterion explicitly requires latency evidence.

When the criterion applies, implement a sibling-style soak or
`reference/measure-latency.mjs` runner **and** add it to the existing deploy
or preview workflow. Do not leave a local script unwired. CI may skip the
live run when secrets are unset; the skip must log the missing names.

Measure deployed API responses with representative data from `datasetRef`.
This gate measures the complete API response, not page load, local handlers, or
mocks. Use `reference/measure-latency.mjs`:

```bash
API_URL="$FEATURE_API_URL" \
EXPECTED_API_URL="$RECORDED_FEATURE_API_URL" \
DATASET_PATH="$REPRESENTATIVE_DATASET_PATH" \
REQUEST_COUNT=100 \
LATENCY_OUTPUT_PATH="artifacts/latency.json" \
node skills/build-portals/reference/measure-latency.mjs
```

`EXPECTED_API_URL` must come independently from the recorded feature-stack
deployment output; the runner rejects a mismatched target. It accepts only
HTTPS URLs without embedded credentials, query strings, or fragments.

The dataset is a non-empty JSON array of request objects:

```json
[
  {
    "path": "/records/search",
    "method": "POST",
    "headerEnv": { "authorization": "TEST_AUTHORIZATION" },
    "body": { "query": "representative-input" }
  }
]
```

Store real test credentials outside the dataset file. `headerEnv` maps an HTTP
header to the environment variable containing its complete runtime value, such
as `Bearer <token>`. Never commit a populated authorization header. Run enough
requests to represent the accepted flow; increase `REQUEST_COUNT` when the
supplied dataset or performance plan requires it.

GET and HEAD are the safe default. A dataset containing POST, PUT, PATCH, or
DELETE requires `ALLOW_MUTATING_REQUESTS=true` plus an explicitly approved
synthetic/test tenant and idempotent or disposable test data. Never run the
latency tool against production.

Sort measured durations and calculate the nearest-rank percentile. The p95
requirement is strictly `< 200` ms; p95 equal to or greater than 200 ms fails.
Any non-successful API response also fails.

## Required evidence

Keep applicable artifacts in the repository or approved CI store and attach
their links to the pull request and delivery task:

- unit-test result and coverage path
- responsive design baselines and diff report
- BrowserStack build URL
- Amplify preview URL
- real feature API URL
- latency JSON (`artifacts/latency.json`)
- integration test result

Evidence must identify the feature commit tested. Missing, stale, production,
or mock-backed evidence blocks handoff only when that gate applies. The handoff
must separately list passed, blocked, and not-applicable gates.
