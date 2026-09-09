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
- when frontend is in scope, follow
  `07-figma-visual-fidelity.md`. Match control types and exact rendered
  properties on the final route, not only in an isolated component
- copy sibling CORS. A deploy fallback of `*` is not a literal Origin
  string. Express `origins.includes(origin)` will never match a portal or
  preview host against `*`. If siblings allow trusted host suffixes
  (custom domains, preview hosts, localhost), reuse that helper instead of
  exact-list matching
- when adding provisioned concurrency to an **existing** Lambda, do not
  create alias `live` if that alias already exists on the function.
  CloudFormation `Alias already exists` (409) rolls the deploy back.
  Use a **new** alias name (for example `provisioned`). Do not delete
  `:live` without explicit AWS ownership. Do not merge to the integration
  branch just to dodge the 409

## 3d. Shared `/api/v2` authorization

When attaching a new route to a shared `/api/v2` HTTP API, copy sibling
route `authorizationType`. If siblings use `NONE` and authorize in Lambda,
do not add a JWT authorizer on the shared API.

A gateway JWT authorizer returns `{"message":"Unauthorized"}` before Lambda
runs. `WWW-Authenticate: ... signing method HS256 is invalid` means the
shared API still has a JWT authorizer (RS256 only) in front of the
handler — the feature Lambda never ran. Opening the API URL in the
address bar sends no `Authorization` header and is not an auth test.

When the shared route key **already exists**, do not `new CfnRoute` for
the same `GET`/`OPTIONS` key. That 409s (`Route with key ... already
exists`). **Upsert**: find the route, set `target` to this stack's
integration, set `authorizationType` to `NONE`.

Do not remove an old `AWS::ApiGatewayV2::Route` logical ID from the
template until you know CloudFormation will not **delete the physical
shared route**. That delete shows up as API Gateway `{"message":"Not
Found"}` and live tests like `invalid token expected 401, received 404`.
If you replace `CfnRoute` with an upsert custom resource, force the upsert
to run again after that delete (change a property so CloudFormation
updates it) so the GET route is recreated.

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
includes the session Bearer token. Opening the API URL in the address bar
is not an auth test.

## 3e. Failed-installment overlay / payment-plan-summary

When a story asks for a post-login overlay driven by
`GET /accounts/{accountId}/payment-plan-summary` (or the same contract on
`/api/v2`):

1. Accept the existing portal HS256 `authToken` as well as Cognito ID
   tokens. Return **401** for invalid or missing tokens and **403** when
   the account is not on the token allow-list. Return **404** when the
   Persist debt does not exist.
2. Determine failure from the **latest scheduled-installment status
   event across all plans**. Do not use money `payment` vertices,
   `debt_has_payment`, Rootstrap payment history, or other money events.
   Overlay `lastPaymentFailed` is true only for installment status
   `FAILED`.
3. Remaining installments are an allow-list: missing, `SCHEDULED`, or
   `RESCHEDULED`. Exclude failed, paid/completed, and cancelled
   installments.
4. **Update Plan** opens the existing payment-plan builder without
   immediately modifying the current plan. Confirming uses the existing
   plan-creation backend, creates a **new plan ID**, retires the previous
   plan, and leaves exactly one active plan. Cancelled or failed updates
   leave the existing plan unchanged. Guard in-flight retries so they
   cannot create duplicate plans.
5. After success, refetch the summary and active plans and show the new
   plan and next payment.
6. Live tests must call the **deployed feature API and DEV Persist**,
   with no mocks and no skipped tests. Performance soaks count **HTTP 200
   only** and must actually run for five minutes. Amplify preview is the
   frontend, not the API. Payments APIs that attach to shared `/api/v2`
   deploy from their existing API workflow (`workflow_dispatch` on the
   **feature branch**, or merge to the integration branch). Do **not**
   merge to the integration branch just to test. Do **not** fail
   preflight/deploy because a new GitHub bearer secret is missing; after
   deploy, mint an HS256 token from the secret already on the Lambda (or
   the Secrets Manager id the stack already injects) and default the soak
   account to a named DEV fixture. Live/soak steps still fail if they
   cannot authenticate — they just must not invent `DEV_*_BEARER_TOKEN`
   secrets. Persist missing-debt must return **404**, not **502**: empty
   or not-found results map to `ACCOUNT_NOT_FOUND`. If that behavior requires
   a query change, stop and request a Hoothoot-produced replacement. Do not use
   `000000000` as a missing debt id.
7. When the story names DEV Persist fixture accounts, encode those
   expected summary shapes in contract tests and hit the same accounts
   on the deployed API. Do not treat a money-event `FAILURE` as the
   overlay signal.

## 3f. Feature-API deploy pipe (do not repeat these)

These failed when attaching a feature GET to a shared DEV HTTP API.
Treat them as hard increment rules, not one-off ops.

| Symptom | Cause | Do this instead |
| --- | --- | --- |
| `Alias already exists` `...:live` (409) | CDK `new lambda.Alias({ aliasName: 'live' })` on a function that already has `:live` outside this stack | New alias name (`provisioned`). Concurrency 1 still satisfies the AC. Do not delete `:live`. Do not merge to test |
| Preflight missing `DEV_*_BEARER_TOKEN` / `DEV_*_PERF_ACCOUNT_ID` | Invented GitHub secrets that were never configured | Do not block **deploy** on them. After deploy, mint HS256 from `PORTAL_JWT_SECRET` already on the Lambda. Default soak account to a named DEV fixture |
| `Route with key GET /accounts/{id}/... already exists` (409) | `CfnRoute` CREATE on the shared HTTP API | **Upsert** the existing route (target + `authorizationType: NONE`) |
| Live `invalid token expected 401, received 404` plus `{"message":"Not Found"}` | CloudFormation deleted the old `CfnRoute` logical ID **after** the upsert, taking the physical GET route with it | Do not drop a shared-API `CfnRoute` from the template without recreating the route. Force the upsert to run again after that delete |
| `WWW-Authenticate: signing method HS256 is invalid` | Shared API JWT authorizer still in front; Amplify preview did not deploy the Lambda | `workflow_dispatch` the API workflow on the **feature branch**. `authorizationType: NONE`. Confirm 200/401 from Lambda, not Gateway |
| Missing account expected 404, received 502 | Empty query result or Persist HTTP 404 remapped to `PERSIST_FAILURE` | Map existing empty/not-found results to `ACCOUNT_NOT_FOUND`. If the query must change, stop and request a Hoothoot replacement. Use a 9-digit missing id, not `000000000` |
| Preview BrowserStack landing design fail on React `#418`/`#423`/`#425` | iOS Safari hydration console; this change did not touch landing | Ignore those minified hydration codes in the real-device design spec. Do not treat it as a payments/overlay regression |

Green PR checks are frontend/unit only. They do not put a sibling API
Lambda on the shared DEV HTTP API.

## 3b. Persist / Gremlin queries

Hoothoot is the mandatory source for every new or changed portal data query,
including Persist/Gremlin, SQL, report definitions, aggregates, filters, and
query fragments. Hoopa cannot call Hoothoot in this version.

At the first query dependency:

1. Stop before writing query-dependent implementation or tests.
2. Ask the user to run Hoothoot and return the exact query, parameters,
   expected result shape, and efficiency constraints.
3. Do not author, infer, complete, repair, optimize, translate, or copy a
   sibling query. Do not include query pseudocode or operator suggestions in
   the handoff.
4. Resume only after the user supplies Hoothoot's output. Wire the query
   unchanged and test its parameter/result contract. Any semantic correction
   or query error requires another Hoothoot handoff.

An existing query may remain unchanged when the requested work does not alter
its behavior. Hoopa may adapt the surrounding client, error mapping, and API
contract without changing query semantics.

## 3c. Story acceptance criteria vs local hard-stops

Missing local `AWS_ACCESS_KEY_ID`, soak bearer tokens, BrowserStack
secrets, or `API_V2_HTTP_API_ID` is **not** an agent hard stop. Those are
CI-owned. It is also **not** a waiver of acceptance criteria.

| Story asks for | Increment still requires |
| --- | --- |
| Live integration or feature-branch API tests | Contract tests on the real Express/Lambda handler **and** a post-deploy CI step against the deployed DEV API. If the story forbids skipped live tests, the **live/soak steps** must fail when they cannot authenticate. Do not fail **preflight** on GitHub secrets the repo does not already have — mint a token from the deployed Lambda secret instead of inventing `DEV_*_BEARER_TOKEN`. Optional `skipIf` is only for stories that do not require live DEV proof |
| p95 soak (for example 200 requests / 5 minutes) | A sibling-style script **and** a step in the existing deploy or preview workflow. Count **HTTP 200 only**. The soak must actually run for the named duration. Default the soak account to a named DEV fixture when `DEV_*_PERF_ACCOUNT_ID` is unset. If the story forbids skipping, fail the soak step when it cannot mint or send a Bearer token; do not log-and-skip |
| Real feature-branch API | Follow this repo. Dispatch the existing API workflow on the **feature branch** (`workflow_dispatch`). Do not merge to the integration branch to test. Do not pretend a portal Amplify preview deployed the API |

If the story names a specialist Hoopa cannot call, complete a safe in-repo
substitute only when another hard boundary does not forbid it. There is no
substitute for Hoothoot query output: stop and ask the user.

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
- a new or changed data/report query is required and the user has not supplied
  Hoothoot's output

List only blockers relevant to the requested scope. A missing UI design is not
a backend-change blocker, and missing deployment access does not prevent a
code-only PR when deployment was not requested.

If secrets, datasets, or credentials are missing only for a requested live
deployment or verification step, continue the safe local implementation and PR.
Report that gate as blocked and stop immediately before the external action.
