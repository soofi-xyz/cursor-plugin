---
title: Intake And Portal Spec
impact: CRITICAL
tags: [intake, portal-spec, figma, stop-rules]
---

# Intake And Portal Spec

Use this rule during Hoopa stage 1 (**Intake**) and stage 2 (**Normalize**).
Resolve whether the user wants a new repository or an incremental change first,
then write a schema-valid `portal-spec.json` with zero unresolved
`openQuestions` before implementation.

## Inputs

### Resolve delivery intent first

Set exactly one `deliveryMode`:

| `deliveryMode` | Use when | Required context |
| --- | --- | --- |
| `new_repository` | The user wants a new portal or explicitly asks for a new repository | One primary `designSource` plus new-repository delivery context |
| `existing_repository` | The user wants to add, change, fix, or manage code in a current project | Accessible repository, change request, base branch, feature branch, and PR authorization |

If the workspace is already a portal repository (frontend plus API apps and
existing CI), select `existing_repository` without forcing a question. If the
request explicitly says “in this repo,” “update the portal backend,” or names
an existing project to change, also select `existing_repository`. State the
selected mode before making changes. Create a new GitHub repository only when
the user explicitly confirms that. If intent is still unclear after that, ask:
**“Should I create a new repository or modify the existing project and open a
PR?”**

Every run also requires a `changeRequest` with a concise summary, affected
scopes (`frontend`, `backend`, `infrastructure`, `testing`, or `deployment`),
and supplied acceptance criteria. Backend-only work is valid and does not
require a Figma file or other UI design.

### `designSource` for `new_repository` (exactly one primary source)

Select exactly one row. Reject mixed primary sources. Ask the user to choose if they supply more than one.

| `sourceType` | Accept when | Read with | On inaccessible input |
| --- | --- | --- | --- |
| `figma` | User supplies a Figma file or frame URL | **Figma MCP**. Prefer section-level frames over a single full-page frame | Stop. Ask for access, a public file, or exported frames/screenshots |
| `portal_url` | User supplies a live portal URL | Fetch public pages for layout, routes, and copy | If sign-in is required, do not bypass auth. Ask for credentials, a session artifact, screenshots, or a `source_repo` |
| `other_design` | User supplies screenshots, written UX notes, a component inventory, or equivalent non-Figma artifacts | Structured notes plus any provided images or docs | Stop if screens and routes cannot be reconstructed. Ask for missing artifacts |
| `source_repo` | User supplies an existing application repository as the design reference | Read routes, components, and styling from the repo the user can access | Stop if the repo is inaccessible. Ask for access or alternate artifacts |

For `existing_repository`, set `sourceType: source_repo` and treat the project
being modified as the source. Design input is optional unless the change affects
UI behavior or visual acceptance criteria.

### Figma routing rule

- Route Figma URLs through **Figma MCP**. Do not scrape Figma in a browser or pretend a screenshot is a Figma file.
- Exported frames, PNGs, or PDFs from Figma are **`other_design`**, not `figma`.
- If **Figma MCP cannot read** the file, stop and ask for access or alternate artifacts.

### `deliveryContext` (never invented)

Collect these org-supplied values. Missing items become `openQuestions` entries and block scaffolding.

#### New repository

| Field | Required | Hard stop when missing |
| --- | --- | --- |
| GitHub org, visibility, and repository name | Yes | Stop. Ask for org, visibility, and new repository name |
| Permission to create a new repo | Yes | Stop. Confirm Hoopa should **create a new repo** |
| Permission to push and open a PR | Yes | Stop before repository writes when absent |
| Deployment authorization | Explicit true/false decision | A false value permits code/PR work but blocks deployment |
| AWS account and region | Yes, or explicit placeholder permission | Stop. Ask for account/region or permission to emit placeholders |
| Amplify preview target | Yes, or explicit permission to configure preview hosting | Stop. Ask which Amplify app to attach or for permission to configure preview hosting |
| Auth model and API contract | Yes, unless user instructs copy-from-reference | Stop. Ask for auth model and API contract, or name the reference portal/repo to copy |
| `testPersonas` and `datasetRef` | Yes | Stop. Ask for personas and a dataset location for live latency checks |
| BrowserStack credentials | Yes when full-flow verification is required and creds are not in the environment | Stop. Ask for BrowserStack project credentials |

#### Existing repository

| Field | Required | Hard stop when missing |
| --- | --- | --- |
| Repository path or URL and read/write access | Yes | Stop. Ask for an accessible checkout or repository |
| Change request and acceptance criteria | Yes | Stop. Ask what behavior or backend capability must change |
| Base branch and feature branch | Yes; discover repository default and derive a feature name when unambiguous | Stop only when the base or destination is ambiguous |
| Permission to push and open a PR | Yes | Stop before external writes if authorization is absent |
| Deployment context | Only when deployment is requested or needed for an acceptance criterion | Stop before deployment, not before local implementation |
| Dataset or BrowserStack credentials | Only when latency or browser-flow gates apply to the requested scope | Mark unrelated gates not applicable rather than blocking the change |
| Hoothoot-produced query, parameters, result shape, and constraints | Yes for every new or changed data/report query | Stop before query-dependent implementation. Ask the user to run Hoothoot; do not draft or copy a query |

Optional overrides: Lambda memory, timeout, provisioned concurrency, allowed
origins, frontend framework, PR title, and whether to update an existing PR.

For existing-project work, `openQuestions` contains only decisions required
before code can be changed safely. Missing credentials for a later, explicitly
requested deployment or live verification step do not block local
implementation; record those as gate blockers and stop before that external
step. Named acceptance criteria such as shared `/api/v2` attachment, soak, and
live integration remain required in-repo work: wire the existing workflows and
sibling-style scripts even when the agent cannot execute them. A new or changed
query is different: it is a hard Hoothoot handoff and cannot be substituted
with Hoopa-authored implementation.

## Normalize to `portal-spec.json`

After intake succeeds, validate the normalized contract against
`reference/portal-spec.schema.json`. In `new_repository` mode, write
`portal-spec.md` and `portal-spec.json` in the target repo. In
`existing_repository` mode, keep it transient unless the user or repository
convention requests a committed change spec.

Required top-level fields for every mode:

- `deliveryMode`
- `sourceType`
- `changeRequest`
- `queryDependencies[]`: empty when no new or changed query is needed;
  otherwise record each supplied Hoothoot query's target, source,
  reference/digest, parameters, expected result shape, and constraints
- `openQuestions[]`

`new_repository` additionally requires structured `designSource` and
`deliveryContext`, plus `screens`, `breakpoints`, `auth`, `apis`, `secrets`,
`infra`, `testPersonas`, `datasetRef`, and `hosting`.
`existing_repository` requires `repositoryContext`; include only the optional
portal fields relevant to the requested change.

### Stop-before-scaffold rule

- If `openQuestions` is non-empty, stop and ask the user. **Do not scaffold or
  modify code** past Normalize.
- Only prepare a repository workspace when the spec is schema-valid and
  `openQuestions` is an empty array.

## Correct vs incorrect intake

**Incorrect: treat exported PNG as Figma**

```text
User: Here is a PNG exported from Figma.
Agent: sourceType = figma
```

**Correct: classify exported art as other design**

```text
User: Here is a PNG exported from Figma.
Agent: sourceType = other_design; capture the image path in designSource artifacts
```

**Incorrect: invent org values**

```text
Missing: GitHub org and repository name
Agent: uses example-org/example-portal and continues to Scaffold
```

**Correct: hard stop with explicit questions**

```text
Missing: GitHub org and repository name
Agent: adds openQuestions entries, stops before scaffold, lists exact missing fields
```

**Incorrect: dual primary sources**

```text
User: Use this Figma URL and also copy https://example.com
Agent: sets sourceType = figma and silently copies the URL
```

**Correct: force a single primary source**

```text
User: Use this Figma URL and also copy https://example.com
Agent: asks which source is primary; records the other as supplemental context only
```

## Example minimal spec (tenant-neutral)

```json
{
  "deliveryMode": "new_repository",
  "sourceType": "other_design",
  "changeRequest": {
    "summary": "Create a portal from the supplied design",
    "scopes": ["frontend", "backend", "infrastructure"],
    "acceptanceCriteria": ["Open a reviewable pull request with all required gates passing"]
  },
  "queryDependencies": [],
  "designSource": {
    "reference": "https://example.com/reference-portal"
  },
  "deliveryContext": {
    "repository": "example-org/example-portal",
    "repositoryVisibility": "private",
    "createRepositoryAuthorized": true,
    "pullRequestAuthorized": true,
    "deploymentAuthorized": false,
    "aws": { "mode": "placeholders" },
    "amplify": { "mode": "configure" }
  },
  "screens": [
    {
      "route": "/",
      "purpose": "Marketing landing page",
      "states": ["logged-out"]
    }
  ],
  "breakpoints": [
    { "name": "mobile", "widthPx": 390 },
    { "name": "tablet", "widthPx": 768 },
    { "name": "desktop", "widthPx": 1280 }
  ],
  "auth": { "mode": "none", "callbackEnvKeys": [] },
  "apis": [],
  "secrets": [],
  "infra": {
    "apiName": "example-portal-api",
    "functionName": "example-portal-handler",
    "allowedOrigins": ["https://example.com"],
    "memoryMb": 512,
    "timeoutSeconds": 30,
    "provisionedConcurrency": 0,
    "logRetentionDays": 30,
    "alarmTopicArn": "SECRET_PLACEHOLDER_ALARM_TOPIC_ARN"
  },
  "testPersonas": [{ "name": "anonymous", "role": "visitor" }],
  "datasetRef": {
    "location": "s3://example-bucket/example-dataset",
    "format": "json"
  },
  "hosting": {
    "mode": "amplify-preview",
    "customDomain": "out_of_scope_v1"
  },
  "openQuestions": []
}
```

## Example existing-project backend change

```json
{
  "deliveryMode": "existing_repository",
  "sourceType": "source_repo",
  "changeRequest": {
    "summary": "Add a backend endpoint and its infrastructure",
    "scopes": ["backend", "infrastructure"],
    "acceptanceCriteria": ["Open a pull request with passing API tests"]
  },
  "queryDependencies": [],
  "repositoryContext": {
    "repository": "example-org/example-portal",
    "baseBranch": "main",
    "featureBranch": "feat/add-portal-endpoint",
    "writeAuthorized": true,
    "pullRequestAuthorized": true
  },
  "openQuestions": []
}
```
