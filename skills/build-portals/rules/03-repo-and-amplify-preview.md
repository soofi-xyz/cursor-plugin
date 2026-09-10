---
title: Repository Creation and Amplify Preview
impact: CRITICAL
tags: github, repository, amplify, preview, turborepo
---

# Repository Workflow and Amplify Preview

Prepare either a new repository or an existing-project feature branch only
after `portal-spec.json` is schema-valid and contains `openQuestions: []`.
Never infer a destination.

## Preflight

Run the GitHub access checks before repository writes:

```bash
gh auth status
gh repo view "$TARGET_REPOSITORY"
```

Run AWS checks only when deployment is in scope:

```bash
AWS_PROFILE="$SELECTED_AWS_PROFILE" aws sts get-caller-identity
AWS_PROFILE="$SELECTED_AWS_PROFILE" aws configure get region
```

Confirm the AWS account and region match the portal spec when applicable.

For `existing_repository`, inspect the selected project and follow
`rules/06-existing-repository-changes.md`. Do not run `gh repo create`, replace
its workspace layout, or add Amplify/CDK unless the change request requires it.

For `new_repository`, if the destination already exists, stop and ask whether
the user intended `existing_repository`; do not overwrite, delete, or silently
choose another name.

## Create the repository and branch

In `new_repository` mode, after preflight and explicit confirmation:

```bash
gh repo create "$GITHUB_ORG/$REPOSITORY_NAME" \
  --"$REPOSITORY_VISIBILITY" \
  --description "$USER_SUPPLIED_DESCRIPTION" \
  --add-readme \
  --clone
cd "$REPOSITORY_NAME"
BASE_BRANCH="$(git branch --show-current)"
git switch -c feat/portal-v1
```

The initial README commit establishes the repository's actual default/base
branch before feature work begins. Do not assume its name is `main`.

Use `private`, `internal`, or `public` only when that exact visibility is in
the portal spec. Do not add organization-specific defaults to this skill.

## Scaffold

Generate this minimum Turborepo layout on `feat/portal-v1`:

The required workspaces are `apps/web`, `apps/api`, and `packages/shared`.

```text
apps/
  web/                  # frontend application
  api/                  # Lambda handler and API tests
    cdk/
      lib/              # PortalApiStack
      bin/              # deployment entry point
packages/
  shared/               # API contracts and shared types
.github/
  workflows/
    ci.yml              # lint, typecheck, tests/coverage, build, CDK synth
amplify.yml             # frontend preview build configuration
package.json
pnpm-workspace.yaml
turbo.json
```

Copy the normalized `portal-spec.md` and `portal-spec.json` into the new
repository. Copy the deterministic Lambda reference into `apps/api/cdk` and
place it at `apps/api/cdk/lib/portal-api-stack.ts`; replace placeholders only
from the portal spec.

The generated `ci.yml` must run the repository's formatter/linter, typecheck,
unit tests with coverage, production build, and CDK synthesis on pull requests.

Commit the scaffold, push the feature branch, and open its PR against the
resolved base branch:

```bash
git add .
git commit -m "feat: scaffold portal frontend and API"
git push --set-upstream origin feat/portal-v1
gh pr create \
  --base "$BASE_BRANCH" \
  --head feat/portal-v1 \
  --title "$PR_TITLE" \
  --body "$PR_BODY"
```

## Amplify preview

Apply this section only to new portals or existing-project changes whose scope
includes hosting or deployment.

Stop unless `deliveryContext.deploymentAuthorized` is `true`.

Use the operator's selected AWS profile and the Amplify app named or approved
in the portal spec. If no app exists, create it only when the spec explicitly
authorizes Amplify provisioning. Connect `feat/portal-v1` as a preview branch
and use the repository's `amplify.yml`.

Set the frontend runtime API variable, such as `NEXT_PUBLIC_API_URL`, to the
deployed **feature-branch API** URL. Preview verification must reject a
production API URL, a localhost URL, or a mock endpoint. Record the feature API
deployment output before starting the frontend build.

Read the Amplify app's returned `defaultDomain` and the created branch name from
resource metadata. Derive the preview origin only from those returned values;
never use an embedded app ID, customer domain, or guessed hostname. Confirm the
actual branch/job URL matches that origin and store it in handoff evidence.

## Required order

1. Create or connect the approved Amplify app and `feat/portal-v1` branch.
2. Read the branch name and app `defaultDomain`; derive and record the preview origin from that returned metadata.
3. Deploy `apps/api/cdk` with that exact origin in `allowedOrigins`.
4. Capture the API URL from CloudFormation deployment output.
5. Configure the Amplify preview branch with that API URL and start its build.
6. Confirm the returned branch/job URL matches the recorded preview origin.
7. Run integration and BrowserStack flows against that preview URL.

Stop if the API deployment fails or if the preview resolves to any API other
than the recorded feature environment.

## Version-one boundary

A custom domain, DNS records, certificates, and production cutover are out of scope
for version one. Deliver only the Amplify preview URL. Custom domain work requires
a separate approved story after preview acceptance.
