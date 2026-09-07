---
title: Existing Repository Changes
impact: CRITICAL
tags: repository, backend, feature-branch, pull-request, incremental
---

# Existing Repository Changes

Use this rule when `deliveryMode` is `existing_repository`. Modify the current
project incrementally; do not scaffold a replacement repository or force the
new-portal architecture onto established code.

## 1. Resolve and inspect the repository

Confirm the repository path or URL, base branch, requested change, affected
scopes, and acceptance criteria. Then inspect before planning:

```bash
git status --short --branch
git remote -v
git branch --show-current
git log -5 --oneline
```

Read the repository's `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, package
scripts, API handlers, infrastructure, tests, CI, and deployment conventions.
Follow the existing architecture unless the change explicitly requires a
reviewed migration. Do not replace an established backend framework merely
because Hoopa's new-portal default is Lambda plus HTTP API Gateway.

Inspect `.github/workflows/` before asking for secrets. Copy sibling API
deploy jobs, preview apps, Express/Lambda/CDK/persist clients, and frontend
test scripts (`unit-test`, `test:design:mocked`, `test:browser:*:mocked`).
Do not scaffold a second Turborepo, a second auth model, or tRPC unless the
user asked for it.

## 2. Preserve user changes

Preserve user changes exactly. Never run `git reset --hard`, `git clean`,
`git checkout --`, or silently stash another person's work.

If the checkout is dirty or another task is active, create an isolated worktree
from the approved base branch. The base is the repository's **integration
branch** (often `development`), not `main`, unless the repo documents a
different promotion path:

```bash
git fetch origin "$BASE_BRANCH"
git worktree add "$WORKTREE_PATH" -b "$FEATURE_BRANCH" "origin/$BASE_BRANCH"
```

Before using `-b`, check whether the feature branch or named PR already exists.
If it does, create the worktree from that existing branch/PR head; never
recreate, overwrite, or reset it.

If the requested change intentionally depends on uncommitted work, stop and ask
how it should be included. Do not copy unrelated changes into the feature
branch. If the checkout is clean and dedicated to this task, create or switch
to the approved feature branch normally.

Record the resolved repository, base branch, and feature branch in
`repositoryContext`. Keep the normalized spec as a transient planning artifact
unless the repository already tracks change specs or the user requests it.
Never commit Hoopa metadata merely to operate on a project. Never commit
directly to the default branch.

## 3. Plan the minimum change

Trace the existing request path, tests, infrastructure, and deployment surface.
Implement the minimum necessary change that satisfies the supplied acceptance
criteria. Reuse existing modules and patterns; avoid adjacent refactors unless
they are required for correctness.

For backend management:

- authenticate and authorize every new externally reachable mutation
- validate request inputs and preserve existing error contracts
- scope IAM and secret access to the resources the change actually needs
- update API contracts and generated clients together
- add structured logs, metrics, and alarms only where the repository's
  observability pattern or the requested behavior requires them
- keep production values out of code and test fixtures
- reuse sibling identifiers already in the repo (shared HTTP API id, Persist
  SSM parameter, JWT issuer/audience/claim, reader target, test fixtures).
  Do not invent a parallel Cognito pool, Persist URL, or HTTP API
- if a new route must attach to a shared `/api/v2` HTTP API, add
  `API_V2_HTTP_API_ID` to **that API's existing deploy workflow** with the
  same GitHub var plus fallback pattern sibling APIs already use. Leaving
  the workflow unwired is a delivery miss even when local AWS is absent
- when frontend is in scope, match Figma control types. A dropdown in the
  design is a select, not a static label
- copy sibling CORS. A deploy fallback of `*` is not a literal Origin
  string. Express `origins.includes(origin)` will never match a portal or
  preview host against `*`. If siblings allow trusted host suffixes
  (custom domains, preview hosts, localhost), reuse that helper instead of
  exact-list matching

## 3d. Shared `/api/v2` authorization

When attaching a new route to a shared `/api/v2` HTTP API, copy sibling
route `authorizationType`. If siblings use `NONE` and authorize in Lambda,
do not add a JWT authorizer on the shared API.

A gateway JWT authorizer returns `{"message":"Unauthorized"}` before Lambda
runs. Opening the API URL in the address bar sends no `Authorization`
header and is not an auth test.

Authorize in the handler instead:

1. Prefer API Gateway JWT claims when they are present.
2. Otherwise verify `Authorization: Bearer` in-process (Cognito ID token
   first).
3. Then enforce the account allow-list claim. Portal auth tokens may have
   account ids without a Cognito `sub`.

Frontend clients must send `Authorization: Bearer`. Prefer the Cognito ID
token when the session has one. If a supported legacy login left only a
legacy session token, send that token; do not reject the request before
fetch. Requiring an ID token alone hides recovery UI for those sessions.

Confirm authenticated calls from the logged-in app with a fetch that
includes the session Bearer token. Do not treat an address-bar GET as
proof of auth.

## 3b. Persist / Gremlin queries

When the change reads Persist (or the story names Hoothoot / a Gremlin
query):

1. Delegate to `conkeldurr` and the target repo's existing persist client.
   If a Persist query specialist such as `hoothoot` is available in the
   session, call it to produce or validate the query.
2. Absence of that specialist is not permission to skip the query. Copy
   sibling Gremlin from the same repo and lock efficiency in unit tests:
   indexed identifier start, immediate `limit(1)`, filter before order,
   `project()` of API fields only (no `valueMap(true)` dumps), one Persist
   round-trip.
3. Do not treat a hand-written query as done solely because increment mode
   skipped a live specialist pass. Encode the constraints in tests and add
   an optional live Persist validation step to CI when the repo already
   uses OIDC to call Persist.

## 3c. Story acceptance criteria vs local hard-stops

Missing local `AWS_ACCESS_KEY_ID`, soak bearer tokens, BrowserStack
secrets, or `API_V2_HTTP_API_ID` is **not** an agent hard stop. Those are
CI-owned. It is also **not** a waiver of acceptance criteria.

| Story asks for | Increment still requires |
| --- | --- |
| Live integration or feature-branch API tests | Contract tests on the real Express/Lambda handler; optional `skipIf` live host call with a named reason; post-deploy CI step when the repo deploys API on the integration branch |
| p95 soak (for example 200 requests / 5 minutes) | A sibling-style script **and** a step in the existing deploy or preview workflow. Skip in CI only when secrets are unset, with an explicit log. Do not leave the script unwired |
| Real feature-branch API | Follow this repo. If APIs deploy only after merge to the integration branch, say so in the handoff. Do not pretend a portal Amplify preview deployed the API |

If the story names a specialist Hoopa cannot call, still complete the
in-repo substitute above and record the missing specialist in the handoff.

## 4. Test before and after implementation

Write or update the narrowest test that proves the requested behavior. Confirm
it fails for the missing behavior when practical, implement the change, then
run targeted tests and the repository's own lint, typecheck, test, and build
gates. Add infrastructure synthesis or diff checks when IaC changes.

Do not require Figma, responsive design tests, BrowserStack, Amplify, a latency
dataset, or a full portal scaffold for backend-only work unless the change or
its acceptance criteria actually touch those surfaces.

## 5. Commit and open the pull request

Review the diff for unrelated files and secret material, then create coherent
commits on the feature branch:

```bash
git diff --check
git status --short
git push --set-upstream origin "$FEATURE_BRANCH"
gh pr create \
  --base "$BASE_BRANCH" \
  --head "$FEATURE_BRANCH" \
  --title "$PR_TITLE" \
  --body "$PR_BODY"
```

The pull-request body must describe the requested behavior, implementation,
tests, deployment impact, unresolved placeholders, and evidence. Link the PR in
the handoff. Prefer a **draft PR into the integration branch** so preview and
test-before-review can start.

If `repositoryContext.pullRequestUrl` names an active PR, update an existing PR
on its head branch instead of opening a duplicate, but only after confirming
that its scope matches the request.

Never merge, close, or deploy the pull request without explicit authorization.
Repository write permission authorizes branch and PR delivery, not production
mutation. Do not push to `main`. Do not create a new GitHub repo.

## Stop rules

Stop before code changes when:

- the repository or approved base branch cannot be resolved
- the requested behavior or acceptance criteria are ambiguous
- existing user changes overlap the requested files and inclusion is unclear
- branch pushes or pull-request creation were not authorized

List only blockers relevant to the requested scope. A missing UI design is not
a backend-change blocker, and missing deployment access does not prevent a
code-only PR when deployment was not requested.

If secrets, datasets, or credentials are missing only for a requested live
deployment or verification step, continue the safe local implementation and PR.
Report that gate as blocked and stop immediately before the external action.
