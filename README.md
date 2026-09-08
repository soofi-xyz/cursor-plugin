# soofi-xyz plugin kit

A [Cursor plugin](https://cursor.com/docs/plugins), [GitHub Copilot CLI plugin](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-creating), and OpenAI Codex plugin packaging company-wide project subagents and skills for AI-assisted development.

## Install

### Cursor

Clone this repository into Cursor's local plugins directory so it is auto-discovered as `soofi-xyz-team-kit`:

```bash
mkdir -p ~/.cursor/plugins/local
git clone https://github.com/soofi-xyz/cursor-plugin.git ~/.cursor/plugins/local/soofi-xyz-team-kit
```

Then reload Cursor. The plugin will load from `~/.cursor/plugins/local/soofi-xyz-team-kit` and register all agents, skills, and the bundled **`elephant`** MCP server (`mcp.json`) automatically.

**Donphan / Elephant MCP:** Requires Node **22.18+**. Bundled `mcp.json` installs **elephant-mcp `main`** from GitHub (`npx --package=github:elephant-xyz/elephant-mcp#main`) because **npm `@elephant-xyz/mcp@latest` is still 1.6.0** (lacks `queryProperties` and multi-county tools). After install or `git pull`, reload Cursor and confirm **`elephant`** is enabled under **Settings → MCP** (first start may take 1–3 minutes). Bundled counties come from Oracle's published-county catalog — call `listPublishedCounties` for the live list, and always pass `county` explicitly, since omitting it answers for Lee. Do not set an empty `OPENAI_API_KEY` on the MCP server — it is optional and only used by `getVerifiedScriptExamples`.

**Elephant routing:** `donphan` + `use-elephant-mcp` = explore open data via MCP; `oracle` + `use-oracle` = ingest/refresh sources; `use-transform-evaluator` = run the upstream LangGraph transform helper under Oracle; `watchog` + `build-elephant-hero-facts` = build the scheduled homepage hero-facts service (monitor → verify → Asana approval → content-only PR); `use-elephant-query-db` = SQL over Neon.

**Self-contained ingestion runtime:** `oracle` drives a fully bundled, self-contained ingestion
runtime at `skills/use-oracle/runtime/` (Node **22.18+**, `npm ci && npm test` there). It never
requires a sibling `oracle-node`, `Counties-trasform-scripts`, or `elephant-query-db` checkout,
and never runs `npx skills add`. See
[`skills/use-oracle/reference/self-contained-ingestion.md`](./skills/use-oracle/reference/self-contained-ingestion.md)
for install, offline replay, bounded live pilot, publish dry-run, approval-gated publish,
catalog update, and MCP smoke commands, and run `python3 scripts/check-plugin-clean-room.py`
before opening a PR that touches it.

### GitHub Copilot CLI

Add the marketplace first, then install the plugin from that marketplace:

```bash
copilot plugin marketplace add soofi-xyz/cursor-plugin
copilot plugin install soofi-xyz-team-kit@soofi-xyz
```

### OpenAI Codex

From this checkout, add the repo marketplace and install the Codex plugin:

```bash
codex plugin marketplace add ./
codex plugin add soofi-xyz-team-kit@soofi-xyz-team-kit
```

The Codex plugin packages the skills in `skills/`. Project-scoped Codex custom agents are materialized in `.codex/agents/` when you work in this repository.

## Update Or Remove

### Cursor

Pull the latest agents and skills from the same directory:

```bash
git -C ~/.cursor/plugins/local/soofi-xyz-team-kit pull
```

Reload Cursor after pulling so updated agents, skills, MCP config, and the manifest are picked up.

### GitHub Copilot CLI

When you are inside the plugin in GitHub Copilot CLI, update it with the plugin-qualified slash command:

```text
/plugin update soofi-xyz-team-kit@soofi-xyz
```

Uninstall the plugin by name:

```bash
copilot plugin uninstall soofi-xyz-team-kit
```

### OpenAI Codex

Refresh the marketplace and reinstall from a new Codex thread:

```bash
codex plugin marketplace upgrade soofi-xyz-team-kit
codex plugin add soofi-xyz-team-kit@soofi-xyz-team-kit
```

Remove the installed Codex plugin by name:

```bash
codex plugin remove soofi-xyz-team-kit
```

## Quick start

When in doubt, **start with [`arceus`](./agents/arceus.md)** — the master router. Arceus reads this README, the agent definitions, and the skill metadata, then tells you which specialist(s) and skill(s) to use for your task. It does not perform the work itself; it hands you a copy-pasteable invocation hint for the right agent.

In Cursor, invoke it explicitly with the slash form:

```text
/arceus I need to add Google Tag Manager to a Vite app and want regression coverage
```

Or mention it naturally in chat:

```text
Use the arceus subagent to recommend the right specialist for migrating an SMS template inventory.
```

In GitHub Copilot CLI, select the custom agent with `/agent` and choose `soofi-xyz-team-kit:arceus`, or start directly with `--agent soofi-xyz-team-kit:arceus`.

In Codex, start a new thread from this repository and ask Codex to spawn the `arceus` custom agent:

```text
Spawn the arceus custom agent to recommend the right specialist for migrating an SMS template inventory.
```

Cursor's Agent can also delegate to `arceus` automatically at the start of a task when no specific specialist has been named — so simply describing your task in plain English usually triggers the right routing.

If you already know which specialist you need, skip the router and call them directly — for example `/sylveon` in Cursor, `soofi-xyz-team-kit:sylveon` in Copilot, or "spawn the `sylveon` custom agent" in Codex for Figma-to-code work. The full roster, with triggers and descriptions, lives in the [Agents](#agents) and [Skills](#skills) tables below.

## Agents

| Mascot | Agent | Description | Start With |
| :---: | --- | --- | --- |
| <img src="https://assets.pokemon.com/assets/cms2/img/pokedex/detail/063.png" alt="Abra" width="96"> | [`abra`](./agents/abra.md) | Designs and scaffolds solver services with Glue PySpark, pure Python OR-Tools solvers, and CDK-backed infrastructure. | `/abra Build an optimization solver for...` |
| <img src="https://assets.pokemon.com/assets/cms2/img/pokedex/detail/065.png" alt="Alakazam" width="96"> | [`alakazam`](./agents/alakazam.md) | RAG agent builder — directs reusable AWS RAG agents with Bedrock, OpenSearch, DynamoDB, S3, SAM local, and Docker OpenSearch replay. | `/alakazam Build RAG for...` |
| <img src="https://assets.pokemon.com/assets/cms2/img/pokedex/detail/493.png" alt="Arceus" width="96"> | [`arceus`](./agents/arceus.md) | The Alpha Pokémon — master router that reads `README.md`, agent definitions, and skills, then directs the user to the right specialist(s) and skill(s) for any task. Does not implement the work. | `/arceus Which agent should handle...` |
| <img src="https://archives.bulbagarden.net/media/upload/3/3a/Ash_OS_2.png" alt="Ash" width="96"> | [`ash`](./agents/ash.md) | Designs and implements Asana-triggered Lambda agents using the established Bedrock and telemetry patterns. | `/ash Build an Asana agent that...` |
| <img src="https://assets.pokemon.com/assets/cms2/img/pokedex/detail/531.png" alt="Audino" width="96"> | [`audino`](./agents/audino.md) | Frontend bug-fix specialist — design comparison, override archaeology, minimal fixes, and regression-proof tests. | `/audino Fix this UI bug...` |
| <img src="https://assets.pokemon.com/assets/cms2/img/pokedex/detail/628.png" alt="Braviary" width="96"> | [`braviary`](./agents/braviary.md) | Google marketing stack v1 orchestrator — GTM + GA4 + Search Console + Ads linking, stakeholder access, QA handoff; delegates site GTM wiring to `castform`. | `/braviary Set up Google marketing...` |
| <img src="https://assets.pokemon.com/assets/cms2/img/pokedex/detail/351.png" alt="Castform" width="96"> | [`castform`](./agents/castform.md) | Injects Google Tag Manager (`GTM-…`) into any frontend — official head + body snippets, framework-appropriate root shell, env-aware IDs; does not add standalone GA4 unless you opt out. | `/castform Add GTM-XXXX to...` |
| <img src="https://assets.pokemon.com/assets/cms2/img/pokedex/detail/441.png" alt="Chatot" width="96"> | [`chatot`](./agents/chatot.md) | Owns the communication-activity lifecycle — provider setup, routing, send handoff, delivery events, and response ingestion. | `/chatot Build send workflow for...` |
| <img src="https://assets.pokemon.com/assets/cms2/img/pokedex/detail/534.png" alt="Conkeldurr" width="96"> | [`conkeldurr`](./agents/conkeldurr.md) | Platform engineer — owns the SOCAPITAL platform product map across Account, Bootstrap, Marketplace, Deployer, Puller, Persist, Connect, Translate, Product, and Rules; always asks "integrate existing or provision new?" before building. | `/conkeldurr Design platform capability...` |
| <img src="https://assets.pokemon.com/assets/cms2/img/pokedex/detail/225.png" alt="Delibird" width="96"> | [`delibird`](./agents/delibird.md) | Report catalog app builder — single AWS-hosted catalog page listing report URLs, plus a CLI for registering, updating, validating, and publishing report entries. | `/delibird Build report catalog...` |
| <img src="https://assets.pokemon.com/assets/cms2/img/pokedex/detail/132.png" alt="Ditto" width="96"> | [`ditto`](./agents/ditto.md) | S3 → external file-share sync workflow builder — EventBridge Scheduler starts a Step Functions Distributed Map (plan + cost gate → per-file workers → aggregate) that copies a configured S3 bucket/prefix into Citrix Endpoint Management (default), Citrix ShareFile, or another pluggable destination, with per-env SSM + Secrets Manager configuration and DEV/PROD CI/CD. | `/ditto Sync S3 files to...` |
| <img src="https://archives.bulbagarden.net/media/upload/thumb/4/44/0232Donphan.png/500px-0232Donphan.png" alt="Donphan" width="96"> | [`donphan`](./agents/donphan.md) | Elephant MCP data exploration agent — answers natural-language questions about Oracle open-data properties (appraisal, permits, Sunbiz, BBB contractors, geo filters, lexicon schemas) via bundled `@elephant-xyz/mcp` tools. Not for Neon SQL or county ingestion. | `/donphan How many sub-par electric contractors in Lee County?` |
| <img src="https://assets.pokemon.com/assets/cms2/img/pokedex/detail/133.png" alt="Eevee" width="96"> | [`eevee`](./agents/eevee.md) | Editorial sub-agent backed by the Eevee RAG — retrieves from the live knowledge base (Guidance library + founder articles) and drafts pitches, propositions, website copy, and decks in Eevee's voice. Does not publish. | `/eevee Draft a proposition for...` |
| <img src="https://assets.pokemon.com/assets/cms2/img/pokedex/detail/196.png" alt="Espeon" width="96"> | [`espeon`](./agents/espeon.md) | End-to-end RAG system builder — local TypeScript CLI POC first, then AWS OpenSearch migration, historical backfill, webhook ingestion, and rollout. | `/espeon Build an end-to-end RAG system...` |
| <img src="https://assets.pokemon.com/assets/cms2/img/pokedex/detail/040.png" alt="Wigglytuff" width="96"> | [`wigglytuff`](./agents/wigglytuff.md) | Template-management specialist — Git-backed template inventory, source discovery, metadata normalization, sync workflows, and Asana-facing template operations. | `/wigglytuff Manage templates for...` |
| <img src="https://assets.pokemon.com/assets/cms2/img/pokedex/detail/097.png" alt="Hypno" width="96"> | [`hypno`](./agents/hypno.md) | Google Chat Asana initiative portfolio bot **and** WOW personal CLI (tasks, stories, consolidation) on the hypno-agent runtime. | `/hypno Add initiative creation from war-plan PDF` |
| <img src="https://assets.pokemon.com/assets/cms2/img/pokedex/detail/707.png" alt="Klefki" width="96"> | [`klefki`](./agents/klefki.md) | Files portal builder — Cognito Managed Login, private S3 folder browsing, per-user grants, custom-domain CloudFront hosting, and Figma-driven UI. | `/klefki Build file portal...` |
| <img src="https://assets.pokemon.com/assets/cms2/img/pokedex/detail/281.png" alt="Kirlia" width="96"> | [`kirlia`](./agents/kirlia.md) | WOW Story Quality operator for `soofi-xyz/kirlia-agent` — Asana `@mention` rewriter that formats Story tasks into WOW structure, with project enablement, ledger diagnosis, prompt changes, and cutover from wow-website. Not Hypno's personal CLI. | `/kirlia Diagnose a missed story rewrite...` |
| <img src="https://assets.pokemon.com/assets/cms2/img/pokedex/detail/448.png" alt="Lucario" width="96"> | [`lucario`](./agents/lucario.md) | M2D operations agent builder — target-environment resolution from user/profile context, stack discovery, Asana-triggered run orchestration, replay and approval flows, Interprose API/DB verification, and PR-first config/code workflows. | `/lucario Build an M2D operations agent...` |
| <img src="https://assets.pokemon.com/assets/cms2/img/pokedex/detail/068.png" alt="Machamp" width="96"> | [`machamp`](./agents/machamp.md) | Designs and implements AWS batch workflows with strategy selection, cost gates, throttling, idempotency, and staged test pipelines. | `/machamp Build batch workflow...` |
| <img src="https://assets.pokemon.com/assets/cms2/img/pokedex/detail/462.png" alt="Magnezone" width="96"> | [`magnezone`](./agents/magnezone.md) | Workspace relationship-intelligence scaffold on the `magnezone-agent` runtime — web query UI plus Google Chat and Google Workspace webhook ingestion, with explicit partial-implementation boundaries and OpenClaw-aware deployment. | `/magnezone Extend the Google Workspace ingestion scaffold...` |
| <img src="https://assets.pokemon.com/assets/cms2/img/pokedex/detail/052.png" alt="Meowth" width="96"> | [`meowth`](./agents/meowth.md) | Cursor spend-limit approval workflow builder — EventBridge Scheduler starts a Step Functions Standard state machine (Plan → Map over candidate users → `WaitForTaskToken` Asana approval per user → VerifyAndApply → Aggregate). Opens an Asana task in a configured project assigned to a configured approver when a user crosses a configurable threshold of their `monthlyLimitDollars`, and on task completion the webhook Lambda completes the task token so the state machine raises the user's limit by a configurable increment via `POST /teams/user-spend-limit`, with per-env SSM + Secrets Manager configuration, a DynamoDB cycle ledger, and DEV/PROD CI/CD. | `/meowth Build spend approval...` |
| <img src="https://assets.pokemon.com/assets/cms2/img/pokedex/detail/376.png" alt="Metagross" width="96"> | [`metagross`](./agents/metagross.md) | Designs and scaffolds fullstack frontend-backend monorepos with Turborepo, Amplify, tRPC, Lambda, and CDK. | `/metagross Scaffold fullstack app...` |
| <img src="https://assets.pokemon.com/assets/cms2/img/pokedex/detail/164.png" alt="Noctowl" width="96"> | [`noctowl`](./agents/noctowl.md) | Builds general S3-backed audit anomaly analyzers from versioned audit profiles and evidence-backed rule outputs. | `/noctowl Build audit analyzer...` |
| 🔮 | [`oracle`](./agents/oracle.md) | Public-data ingestion agent — discovers, ingests, validates, and refreshes county property/permit records plus Florida Sunbiz and BBB contractor reputation into the Elephant query DB by driving bundled stage skills under `skills/` against `skills/use-oracle/runtime/` (local Restate + Postgres by default; AWS when the runtime contains oracle-node markers), then publishes the county query table and coverage snapshot and wires them into the `elephant` MCP. Fail-closed YAML readiness is required before seed or ingest. Lee County, FL is the reference. On-chain indexing beyond the query table and NEO are out of scope. | `/oracle Onboard Lee County, FL...` |
| <img src="https://assets.pokemon.com/assets/cms2/img/pokedex/detail/765.png" alt="Oranguru" width="96"> | [`oranguru`](./agents/oranguru.md) | Communication-runtime assembler — composes audience, template, and activity capabilities into deterministic end-to-end channel services. | `/oranguru Assemble runtime for...` |
| <img src="https://assets.pokemon.com/assets/cms2/img/pokedex/detail/279.png" alt="Pelipper" width="96"> | [`pelipper`](./agents/pelipper.md) | Asana-integrated or directly callable dataset export agent — turns board-scoped or trusted direct requests into company-scoped standard debt CSV exports backed by so-persist, with scope validation, private S3 links, and status checks. | `/pelipper Export standard company debt CSV...` |
| <img src="https://assets.pokemon.com/assets/cms2/img/pokedex/detail/137.png" alt="Porygon" width="96"> | [`porygon`](./agents/porygon.md) | Unifies and analyzes metrics across vendors and data sources with a lexicon-first, audit-friendly workflow. | `/porygon Compare metrics for...` |
| <img src="https://assets.pokemon.com/assets/cms2/img/pokedex/detail/486.png" alt="Regigigas" width="96"> | [`regigigas`](./agents/regigigas.md) | SaaS marketplace architect — centralized marketplace account governing per-customer AWS tenant accounts, CloudFormation bundle distribution (`cdk synth` artifacts), and component register/release/rollback/list/subscribe/unsubscribe operations. | `/regigigas Design marketplace...` |
| <img src="https://assets.pokemon.com/assets/cms2/img/pokedex/detail/479.png" alt="Rotom" width="96"> | [`rotom`](./agents/rotom.md) | Weekly stakeholder email agent on the `rotom-agent` runtime — drafts formal progress emails in Google Chat from Asana facts plus saved template/example memory, with per-user Asana OAuth and hosted HTML output. | `/rotom Improve weekly stakeholder email drafting...` |
| <img src="https://assets.pokemon.com/assets/cms2/img/pokedex/detail/199.png" alt="Slowking" width="96"> | [`slowking`](./agents/slowking.md) | Candidate assignment evaluation orchestrator — derives the story's business intent first, computes elapsed delivery time from the latest GitHub commit, enforces gates (PR to the designated assignment repo, deployed runtime, credentials, demo) with a hard runtime fail that rejects locally run apps and requires a candidate-deployed hosted runtime, drives the live deployed runtime with Playwright to prove the outcome via working/data/output/demo evidence, checks assignment-specific access boundaries, then evaluates implementation and kit usage. Returns a factual 100-point score and hiring signal, verdict first. | `/slowking Evaluate this candidate assignment...` |
| <img src="https://assets.pokemon.com/assets/cms2/img/pokedex/detail/235.png" alt="Smeargle" width="96"> | [`smeargle`](./agents/smeargle.md) | Responsive design-testing specialist — Playwright design specs across breakpoints, with mocked and real-device lane selection. | `/smeargle Add responsive tests...` |
| <img src="https://assets.pokemon.com/assets/cms2/img/pokedex/detail/700.png" alt="Sylveon" width="96"> | [`sylveon`](./agents/sylveon.md) | Figma-to-code specialist — updates existing frontend code to match Figma while preserving business logic and locking breakpoints. | `/sylveon Apply Figma design...` |
| <img src="https://assets.pokemon.com/assets/cms2/img/pokedex/detail/504.png" alt="Watchog" width="96"> | [`watchog`](./agents/watchog.md) | Elephant hero-facts agent builder — builds a separate `watchog-agent` runtime that monitors published Elephant open property data on a schedule, detects new counties/dataset changes, generates source-backed candidate facts for the elephant.xyz homepage hero, verifies each against a pinned data revision, routes recommendations to Asana for human approval, and publishes approved facts through a content-only GitHub PR (no auto-merge). | `/watchog Build the hero-facts service...` |
| <img src="https://assets.pokemon.com/assets/cms2/img/pokedex/detail/178.png" alt="Xatu" width="96"> | [`xatu`](./agents/xatu.md) | Audience-selection specialist — eligibility boundaries, runtime intake contracts, and filter-to-runtime handoffs. | `/xatu Define audience for...` |

## Skills

| Skill | Description |
| --- | --- |
| [`access-orchestrate-call-outputs`](./skills/access-orchestrate-call-outputs/) | Query approved production Athena communication/calling/payment entities (`phone_call`, `email_message`, `text_message`, `payment`), payment-plan lifecycle events (`payment_plan_lifecycle_events`, through 2026-07-21), and payment-plan snapshots for counts and date filters with live Glue discovery, partition pruning, explicit workflow lineage, read-only safety, and compact CLI/SQL examples. |
| [`apply-engineering-guidelines`](./skills/apply-engineering-guidelines/) | Apply the Golden Path engineering standards for tech stack, infrastructure, testing, observability, mandatory PagerDuty alerting on critical failures, self-resolving DLQ channel alarms, and AI implementation choices. |
| [`assemble-communication-runtime`](./skills/assemble-communication-runtime/) | Runtime-assembly skill for composing audience, template, and communication-activity capabilities into deterministic end-to-end channel services. |
| [`asana-initiatives`](./skills/asana-initiatives/) | Extend hypno — initiative bot (prompt-in-Markdown, CRUD, analysis) **and** WOW personal CLI (`my-tasks`, `create-story`, `store-*`). |
| [`atomic-data`](./skills/atomic-data/) | Atomic row-level facts plus vendor daily rollups for contact-center and operational metrics, Parquet-first storage, CloudWatch + lexicon lineage, and reconciliation patterns. |
| [`babysit-release`](./skills/babysit-release/) | Extends PR babysitting through merge, production release monitoring, and evidence-backed follow-up fix PRs while stopping for unknown production configuration. |
| [`bbb-harvest`](./skills/bbb-harvest/) | Harvest BBB business profiles by category for contractor reputation enrichment in the query DB, with throughput checks before long crawls. |
| [`bootstrap-oracle-infra`](./skills/bootstrap-oracle-infra/) | Verify and bootstrap the local pipeline stack — Restate, Postgres, data directories, and services registered with Restate under `skills/use-oracle/runtime/`. |
| [`build-ai-agents`](./skills/build-ai-agents/) | Build AI agents with the rules-agent pattern: Lambda runtime, Asana webhooks, Bedrock + Vercel AI SDK `ToolLoopAgent`, Bedrock prompt caching, LangSmith telemetry, and AgentCore memory. |
| [`build-batch-workflows`](./skills/build-batch-workflows/) | Design and implement AWS batch workflows with Step Functions Distributed Map, Glue PySpark, cost gates, throttling, idempotency, staged test pipelines, and mandatory PagerDuty alerting on critical failures. |
| [`build-build-service`](./skills/build-build-service/) | Build the Build service — TypeScript CDK source intake, CodeBuild synth and validation, CDK cloud assembly artifacts, artifact provenance, build manifests, and marketplace-ready bundle outputs. |
| [`build-bootstrap-cli`](./skills/build-bootstrap-cli/) | Build the Bootstrap CLI — operator-run TypeScript tooling that reads the Account bootstrap manifest, installs the first Deployer locally, then installs Marketplace Puller through that Deployer. |
| [`build-elephant-hero-facts`](./skills/build-elephant-hero-facts/) | Build the Watchog hero-facts service — dataset catalog and change detection, deterministic fact recipes with an immutable evidence gate, an Asana approval state model, and a content-only GitHub publish hand-off (no auto-merge) for the elephant.xyz homepage hero. |
| [`build-connect-service`](./skills/build-connect-service/) | Build the Connect partner-integration platform — declarative flow specs compiled into Step Functions state machines, partner credential / token registries, on-demand static-IP fabric, webhook task tokens, batch executions, and AWS Transfer Family SFTP connectors. |
| [`build-frontend-backends`](./skills/build-frontend-backends/) | Build fullstack monorepos with Turborepo, AWS Amplify frontends, and tRPC + Lambda backends deployed via CDK. |
| [`build-html-to-pdf`](./skills/build-html-to-pdf/) | Build HTML-to-PDF generation workflows on AWS Lambda using Playwright and Chromium, with typed request contracts, deterministic HTML rendering, runtime packaging, and verification. |
| [`build-inbound-sftp-workflows`](./skills/build-inbound-sftp-workflows/) | Build inbound SFTP workflows on AWS with Transfer Family, a Lambda poller, and listing-first transfer validation. |
| [`build-lexicon-product`](./skills/build-lexicon-product/) | Build the Lexicon product — governed graph vocabulary, ruleset data, metric definitions, source-system mapping artifacts, S3/SSM artifact publication, and read-only schema browsing. |
| [`build-local-rag-pocs`](./skills/build-local-rag-pocs/) | Build local TypeScript RAG proof-of-concepts as simple query-only CLIs with libSQL databases, embeddings, JSON output, and `AGENTS.md` usage instructions. |
| [`build-marketplace-puller`](./skills/build-marketplace-puller/) | Build the Marketplace Puller standalone product — tenant-side scheduled reconciler that polls marketplace desired state, detects drift on subscribed components, and converges via `POST /deploys` (push-primary mode) or a tenant-local CFN executor (pull-only mode). |
| [`build-persist-service`](./skills/build-persist-service/) | Build the Persist graph-persistence platform service — Amazon Neptune backend with SigV4-authorised `/persist/*` HTTP API, lexicon-validated GraphSON v3 ingest (sync + async), content-addressed Persist Blobs, Neptune CSV bulk-load workflow, sync + async Gremlin query channels, and a lexicon-generated polymorphic GraphQL read surface resolving fields to Neptune, DynamoDB, or Interprose; specified as a short PRD index plus code-derived references for stacks and configuration, GraphSON ingest, identity hashing and blobs, async ingest and graph facts, sync and async Gremlin, the CSV bulk-load workflow, derived index maintenance, the GraphQL read surface, error catalogue, engineering conventions, operations playbook, Athena debt-index export, Neptune stream export to Athena tables, the Athena index stream consumer, Neptune snapshot recovery and reader topology, Gremlin explain, GraphQL PII access policy, cross-account VPC peering, operations dashboards/alerting, derived-index discovery/catch-up, and the OpenSearch full-text-search mirror. |
| [`build-product-deployer`](./skills/build-product-deployer/) | Build the Product Deployer standalone product — defines the common CDK contract every product implements, owns the canonical `EnvironmentContext`, and runs the Step Function that turns `(component, version, env_slug)` into a deployed stack via StackSets or assume-role + raw CloudFormation. |
| [`build-product-service`](./skills/build-product-service/) | Build the Product service — product definitions, schemas, OpenAPI metadata, product flow templates, template-backed flows, invocations, waterfalls, reports, SMS, email, widgets, blobs, and operational telemetry. |
| [`build-rag-systems`](./skills/build-rag-systems/) | Build reusable AWS RAG systems with Bedrock embeddings, OpenSearch retrieval, DynamoDB review state, S3 corpora, local POC migration, historical ingestion, webhooks, SAM local, and Docker OpenSearch replay. |
| [`build-rules-product`](./skills/build-rules-product/) | Build the Rules product — tenant-local batch decisioning over Persist graph facts, lexicon-backed rule evaluation, callable-population S3 outputs, audit reports, Glue preparation jobs, and CloudWatch metrics. |
| [`build-saas-marketplace`](./skills/build-saas-marketplace/) | Build a multi-tenant SaaS distribution marketplace on AWS — Organizations-backed per-customer accounts, a central marketplace control plane, a `cdk synth`-artifact component registry, cross-account CloudFormation StackSet deploys, and the six register / release / rollback / list / subscribe / unsubscribe operations. |
| [`build-solver-services`](./skills/build-solver-services/) | Build optimization services combining AWS Glue PySpark data prep with Google OR-Tools solvers using the three-layer architecture. |
| [`build-tenant-account-manager`](./skills/build-tenant-account-manager/) | Build the Tenant Account Manager standalone product — owns customers, environments, and per-environment API keys; mints the bootstrap key issued by the provider for a new customer; supports overlap rotation; ships the shared Lambda authorizer every other marketplace API consumes. |
| [`build-tenant-domain-router`](./skills/build-tenant-domain-router/) | Build the Tenant Domain Router standalone product — root domain `provider.xyz` in marketplace Route 53, per-environment subdomains delegated via NS to a child hosted zone in each tenant account, ACM strategy, and the SSM-backed base-path contract every other product uses to publish HTTP endpoints. |
| [`build-translate-service`](./skills/build-translate-service/) | Build the Translate service — registered partner languages, versioned TypeScript mappings, validation, preview, asynchronous translation executions, mapping packs, and execution telemetry. |
| [`county-appraisal-onboarding`](./skills/county-appraisal-onboarding/) | Wire a county's appraisal scraping — browser flows, prepare config, transform sync, and throughput gates. |
| [`county-discovery`](./skills/county-discovery/) | Research a new US county before onboarding — appraiser portal, permit vendor, parcel id format, bulk sources, and feasibility. |
| [`county-ingest-run`](./skills/county-ingest-run/) | Operate the end-to-end property-first ingestion run — pilot, feasibility gate, backpressure-aware full run, and incremental load+publish. |
| [`county-open-data-publish`](./skills/county-open-data-publish/) | Publish county property data from the query DB to IPFS via Filebase with a stable IPNS pointer. |
| [`county-permit-adapter`](./skills/county-permit-adapter/) | Build a county permit-portal harvester as a vendor module for the permit-harvest service. |
| [`county-query-table-publish`](./skills/county-query-table-publish/) | Build, validate, publish, and MCP-wire a county's columnar query-table Parquet. |
| [`county-readiness-preflight`](./skills/county-readiness-preflight/) | Fail-closed validator for `skills/use-oracle/runtime/docs/<county>-sources.yaml`. `onboard-county`, `county-seed-data`, and `county-ingest-run` must run it before seed, pilot, or full ingest. Gates GIS vs tax-roll, permit classification, destination identity, records-request recipients, and BBB advertised-count traps. |
| [`county-seed-data`](./skills/county-seed-data/) | Produce and stage the parcel seed CSV that drives county ingestion. |
| [`deploy-open-data-mcp`](./skills/deploy-open-data-mcp/) | Deploy a self-hosted Elephant open-data MCP server pointing at published IPNS data. |
| [`durable-workflow-builder`](./skills/durable-workflow-builder/) | Author durable Restate pipeline workflows — service topology, skeletons, and pattern library. |
| [`evaluate-candidate-implementation`](./skills/evaluate-candidate-implementation/) | Implementation phase (subagent), judged third — evaluate architecture, code structure, and AC technical depth against any reference repos (e.g. investors-mcp), then score kit-usage conformance by consulting arceus + README and the relevant builder agents for read-only coding scores. |
| [`evaluate-candidate-intent`](./skills/evaluate-candidate-intent/) | First phase — derive the story's one-sentence business intent before scoring, compute elapsed delivery time from the latest GitHub commit and assignment-sent datetime, and build the evidence model, the gates (PR to the designated repo, runtime, credentials, demo), and the weighted 100-point model. |
| [`evaluate-candidate-product`](./skills/evaluate-candidate-product/) | Evidence/functional phase (subagent) — enforce gates (missing PR/runtime/creds/demo = Failed/Blocked; non-exercisable runtime = hard fail/0), drive the live runtime with Playwright to prove the outcome via working/data/output/demo evidence, check access boundaries, and score functional outcome (toy data scores extremely low), evidence quality, runtime/demo quality, and reproducibility. |
| [`figma-to-code`](./skills/figma-to-code/) | Frontend engineering workflow to update existing code from Figma designs while preserving logic and adding responsive design test coverage. |
| [`frontend-bug-fix`](./skills/frontend-bug-fix/) | Frontend bug triage and fix workflow with design comparison, commit analysis, test updates, and verification. |
| [`integrate-ci-cd`](./skills/integrate-ci-cd/) | Integrate the shared GitHub Actions workflows into a project using the required `justfile` recipes and caller workflows. |
| [`lucario-m2d-doc-replay`](./skills/lucario-m2d-doc-replay/) | Lucario runtime skill for M2D failed-document replay, run-status polling, manual approval callbacks, and restart-from-beginning rules. |
| [`lucario-m2d-staging-config`](./skills/lucario-m2d-staging-config/) | Lucario runtime skill for M2D portfolio staging-config updates, environment-specific S3 publication, PR creation, and sample-media verification. |
| [`manage-channel-templates`](./skills/manage-channel-templates/) | Reusable template-management skill for channel template CRUD, metadata normalization, Git-backed inventory, and source-to-Git template synchronization. |
| [`manage-communication-activity`](./skills/manage-communication-activity/) | Reusable communication-activity skill that keeps provider setup, routing, execution handoff, delivery events, and response feedback in one lifecycle. |
| [`manage-story-quality`](./skills/manage-story-quality/) | Operating guide for Kirlia in `soofi-xyz/kirlia-agent` — LLM rewrite of @mentioned Asana Story tasks into the WOW story format with a mention-author review subtask; covers org/project onboarding, webhook + sweeper triggers, the idempotent ledger, diagnosis, format changes, and cutover from wow-website. |
| [`monitoring-county-ingestion`](./skills/monitoring-county-ingestion/) | Monitor a running local-stack county ingestion — workflow progress, artifact counts, DB counts, ETAs, and stall diagnosis. |
| [`monitoring-oracle-ingestion`](./skills/monitoring-oracle-ingestion/) | Monitor legacy AWS oracle-node ingestion tracks — SQS/Lambda health, S3 artifact counts, and ETAs. |
| [`onboard-county`](./skills/onboard-county/) | Orchestrate end-to-end county onboarding — intake, discovery, seed, appraisal, permits, run, enrichment, and publish stages. |
| [`overture-places-ingest`](./skills/overture-places-ingest/) | Ingest Overture Maps places for a county with taxonomy, boundary, coverage, and publication gates. |
| [`query-db-loading-matching`](./skills/query-db-loading-matching/) | Load county artifacts into the Postgres query DB and cross-match records by parcel id and address hash. |
| [`responsive-design-tests`](./skills/responsive-design-tests/) | Write Playwright design tests for Figma-driven responsive UI updates across mocked and real-device lanes. |
| [`select-communication-audience`](./skills/select-communication-audience/) | Reusable audience-selection skill for defining eligibility boundaries and packaging filtered communication populations for downstream runtimes. |
| [`sunbiz-corporate-ingest`](./skills/sunbiz-corporate-ingest/) | Ingest Florida Sunbiz corporate registration bulk data scoped to a county. |
| [`transform-v2-builder`](./skills/transform-v2-builder/) | Build, run, and debug Elephant CLI transform v2 handler packages. |
| [`unify-metrics`](./skills/unify-metrics/) | Lexicon-first metric unification: comparability gates, normalization, analysis, and audit-friendly outputs. |
| [`use-eevee`](./skills/use-eevee/) | Operate the Eevee editorial agent from Cursor: retrieve from the live Eevee RAG (Guidance library + founder articles) via the agent-eevee CLI, then draft in Eevee's voice using Eevee's prompts. Read-only; does not publish. |
| [`use-elephant-query-db`](./skills/use-elephant-query-db/) | User guide for consuming the Vercel Neon `elephant-query-db` database with `@elephant-xyz/query-db` schema imports and TypeScript/Drizzle query code for parcels, permits, Sunbiz companies, places, and addresses. |
| [`use-elephant-mcp`](./skills/use-elephant-mcp/) | Operating guide for exploring Elephant Oracle open-data via bundled `@elephant-xyz/mcp` in Cursor — property/contractor/business questions, geo filters, schema tools, and MCP setup. Not for Neon SQL or ingestion. |
| [`use-magnezone`](./skills/use-magnezone/) | Operate the Magnezone relationship-intelligence scaffold from Cursor: web query UI, Google Chat, Google Workspace webhook ingestion, OpenClaw-aware deployment, and honest partial-implementation boundaries for the `magnezone-agent` runtime. |
| [`use-oracle`](./skills/use-oracle/) | Continuous Oracle ingestion contract: immediately fan out enumeration, adapter preparation, AWS-remote BBB execution, destination and Filebase/IPNS readiness; auto-advance durable stages, recover safe stale work, validate immutable handoffs/provenance, and finish only after load, publish readback, and MCP visibility. On-chain indexing and NEO out of scope. |
| [`use-rotom`](./skills/use-rotom/) | Operate the Rotom weekly stakeholder email runtime from Cursor: Google Chat drafting, template/example memory, per-user Asana OAuth, hosted HTML output, and the runtime contract in `elephant-xyz/rotom-agent`. |
| [`use-transform-evaluator`](./skills/use-transform-evaluator/) | Wrap the upstream `elephant-xyz/AI-Agent` LangGraph CLI so Oracle users can generate, repair, and validate county or seed transform outputs without turning the evaluator into a separate runtime agent. |
| [`use-translate-service`](./skills/use-translate-service/) | User guide for calling a deployed Translate service — what a language and a runtime mapping are, the JSON shapes required to register them, the input/output shapes Translate expects, and how to validate, preview, and run asynchronous executions over `/translate/*`. |
| [`validate-county-transform`](./skills/validate-county-transform/) | Prove a county's transform scripts extract 100% of available appraiser-site data across property-type variability. |

## License

[MIT](./LICENSE) © Soofi XYZ
