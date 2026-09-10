---
name: unified-portal-smoke-testing
description: "Create and run scenario-derived unified-portal integration tests on feature and approved development deployments, including isolated CORS-disabled Chrome diagnostics, checkpoint screenshots, and Asana evidence sheets."
---

# Unified Portal Smoke Testing

Use this skill when Hoopa changes a unified-portal user journey or integration
boundary. Create executable integration tests from the story's test scenarios,
run them on the exact feature deployment, and rerun the same tests on the
development deployment after explicit approval.

## Intake

Resolve:

- Asana user-story reference and supplied acceptance criteria
- stable scenario ID, title, preconditions, steps, and expected result for every
  test scenario
- approved non-production fixture label for each scenario
- feature branch, feature commit, preview URL, and configured backend URL
- development branch and development URL
- repository test command, Playwright configuration, and artifact store
- whether approval exists to promote or merge and test development

Do not copy credentials, identity fields, auth payloads, tokens, account
identifiers, or payment details into test source, logs, screenshots, or reports.
Ask for missing scenario details only when the expected behavior cannot be made
executable from the story and repository.

## Create Scenario-Derived Tests

Inspect the repository's existing Playwright, browser, fixture, and CI patterns.
Extend those patterns instead of creating a second test framework.

For every scenario:

1. Preserve its story ID in the test title or metadata, such as
   `@scenario:UP-123-01`.
2. Encode the supplied preconditions, actions, assertions, and safe stop.
3. Exercise the real UI and configured non-production services. Do not intercept
   or mock the primary integration seam.
4. Resolve secrets at runtime from the repository's approved test source.
5. Capture a sanitized PNG at every declared evidence checkpoint, including at
   least the final asserted state. Configure trace, video, console, and
   network-summary capture without response bodies or sensitive headers.
6. Keep scenarios independently runnable and independently reportable. Do not
   hide several story scenarios inside one undifferentiated test.

Commit the tests on the feature branch before executing them. A test file,
skipped test, or test that never reached its expected state is not passing
evidence.

## Feature-Branch Run

Target the exact feature branch deployment and record its frontend URL, backend
URL, deployment/check identity, branch, and commit before the run. Reject
localhost, mocks, production, another preview, or stale commits.

Run both lanes:

1. Run or preserve a normal-security browser baseline so a real CORS failure is
   visible.
2. Run every scenario in an isolated CORS-disabled Chrome instance. On macOS,
   launch only a disposable profile:

   ```bash
   open -na "Google Chrome" --args \
     --user-data-dir=/tmp/unified-portal-cors-disabled \
     --disable-web-security \
     --remote-debugging-port=9222 \
     --no-first-run \
     --no-default-browser-check
   ```

Connect the repository's browser tests to that instance over the Chrome DevTools
Protocol and run the scenario suite against the feature URL. Keep credentials
out of command arguments and logs. Close only the disposable profile after
artifacts are finalized.

Report normal-security and CORS-disabled results separately. A CORS-disabled
pass proves the functional journey behind the CORS boundary; it does not prove
that browser CORS is configured correctly and does not satisfy production
release approval. Keep a normal-security CORS failure visible as `BLOCKED`.

Publish the feature evidence package before requesting approval.

## Approval Boundary

Stop after feature evidence until the user or designated reviewer gives explicit
approval to proceed with development verification.

Do not interpret approval to test development as permission to merge. Merge only
when the approval explicitly authorizes the merge; otherwise wait until the
repository owner promotes the feature. Before the development run, prove that
the development deployment contains the tested feature commit and the same test
suite. If tests changed during review, rerun feature evidence before comparing
development.

## Development-Branch Run

After approval and promotion, check out or resolve the development branch head
and run the same scenario IDs against the exact development deployment. Use a
normal-security browser for the qualifying development result. Use
CORS-disabled Chrome only as a separately labeled diagnostic if normal security
fails; never substitute it for the development verdict.

Do not run development tests against the feature preview while labeling them as
development. Record the development commit, deployment identity, frontend URL,
backend URL, and test-suite digest.

## Image Evidence

Generate image evidence from the real browser run. Do not synthesize, recreate,
or AI-generate a screen that was not captured during the test.

For every scenario and browser lane:

1. Wait for the asserted UI state and complete the scenario assertions before
   capture. Do not use a loading screen, blank shell, or navigation transition
   as passing evidence.
2. Capture at least one PNG showing the expected final state. Capture additional
   checkpoints when the scenario proves a handoff, modal, disclosure, offer,
   validation error, or multi-step state change.
3. Use the repository's Playwright screenshot support. Use screenshot masks for
   selectors that may expose names, account identifiers, balances, addresses,
   identity fields, auth material, or payment details. Record which regions were
   masked without recording their values.
4. Preserve the viewport and device name in evidence metadata. Capture a focused
   viewport image for readability; add a full-page image only when the complete
   layout is relevant.
5. Store images under a deterministic path such as
   `<run>/<environment>/<scenario-id>/<security-mode>/<checkpoint>.png`.
6. Hash every PNG with SHA-256 and include the digest in `evidence.json`.
7. Verify each image is readable, non-empty, tied to the expected page state,
   and free of secrets and personal data before publishing it.

Keep the scenario PNGs as the source evidence. Also generate an
attachment-friendly contact sheet for each environment and browser lane. Put
the environment, scenario ID, result, branch, short commit, browser-security
mode, and capture time in the contact-sheet card—not over the source screenshot.
Never use a contact sheet to hide a missing scenario image.

For a failed or blocked scenario, capture the visible failure state when safe
and label it `FAIL` or `BLOCKED`; do not manufacture a success image. Image
evidence supplements assertions, traces, and service evidence. It cannot by
itself prove backend calls, persistence, or CORS correctness.

## Per-Scenario Evidence

Produce one evidence record per scenario per environment. Include:

- scenario ID and title
- source test file and test title
- result: `PASS`, `FAIL`, `BLOCKED`, or `NOT RUN`
- feature or development environment
- browser security mode: `normal` or `cors-disabled`
- source branch, commit SHA, test-suite digest, and deployment/check identity
- sanitized frontend and backend URL origins or path patterns
- start time, duration, and relevant non-sensitive status
- required checkpoint PNG links and SHA-256 digests, plus trace, video, and
  CI/build artifact links
- expected result, observed result, and blocker or failure summary

Write a machine-readable `evidence.json` and a compact `evidence.md` index in the
approved CI artifact store, with scenario artifacts grouped by scenario ID.
Every story scenario must have both a feature result and, after approval, a
development result. Missing artifacts must be reported as missing, never
inferred from another scenario.

Write one contact-sheet PNG for each environment/security-mode combination.
Attach the contact sheet for quick review and preserve direct links to every
source checkpoint PNG in the evidence index.

Attach or link the scenario evidence to the Asana user story when authenticated
Asana tooling and write authorization are available. Otherwise return an
attachment-ready evidence bundle plus a copy-pasteable Asana comment containing
the run links and per-scenario verdicts. Missing Asana write access does not
waive testing or evidence creation.

## Safety

- Use approved non-production fixtures only.
- Stop before real payment submission or another destructive action unless the
  user explicitly authorizes a disposable development transaction.
- Stop on CAPTCHA, account-lockout risk, unexpected destructive prompts, or
  missing approved credentials.
- Never expose secrets or personal data in artifacts, PRs, Asana, or chat.
- Do not call a scenario passed when assertions, evidence capture, or the
  required environment run was skipped.

## Return

Return the test files and scenario mapping, feature and development run links,
per-scenario checkpoint PNGs and contact sheets, normal-security and
CORS-disabled verdicts, approval reference, and any blockers. Include an
Asana-ready summary for the user story.
