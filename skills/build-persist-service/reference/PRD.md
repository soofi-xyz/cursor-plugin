# Persist Service — Product Requirements Document (PRD)

Scope statement and index for the **Persist** graph-persistence service. Section 1 defines what Persist is, its public surface, and its non-goals. Every later section is a pointer to the reference file that specifies that area from the code; those files are authoritative for contracts, resource shapes, IAM, env vars, workflows, and verification. Section numbers are kept so cross-references in the reference files resolve.

How to read: start with §1, then open the reference named under the section your task touches. The skill's `SKILL.md` routes by task keyword to the same files.

---

## 1. Product Overview

### 1.1 Mission

Persist is a serverless graph-persistence layer that fronts an Amazon Neptune cluster behind a SigV4-authenticated HTTPS API and an EventBridge fact-ingestion surface. It accepts lexicon-compliant graph data in two shapes (GraphSON v3 documents and Neptune bulk-load CSV), exposes both synchronous and asynchronous Gremlin query channels, and maintains lexicon-declared derived index properties on durable graph elements.

Persist additionally exposes a **polymorphic GraphQL read surface** whose object types are generated deterministically from the lexicon. Each field resolves against the data source declared in a Persist-owned resolution map — the Neptune graph, a configured DynamoDB table, or the Interprose vendor API — without the caller knowing or choosing the source. GraphQL is strictly read-only; all writes stay on the existing GraphSON/CSV/event ingest contracts.

Around that core, Persist runs several derived planes that are specified in their own references: an OpenSearch full-text-search mirror, Athena exports of derived indexes and of the raw Neptune stream, a snapshot-recovery cluster, dedicated reader instances, cross-account partner access, and operations dashboards and alerting.

### 1.2 Primary user surface

A single AWS API Gateway HTTP API under `/persist/*`, IAM-authorised. The API is exposed through its execute-api URL, published to SSM together with a cross-account invoke role; there is no custom domain mapping ([`stacks-configuration-and-iam.md`](./stacks-configuration-and-iam.md) §4.7).

| Verb     | Path                                | Purpose | Reference |
| -------- | ----------------------------------- | ------- | --------- |
| `POST`   | `/persist/ingest`                   | Synchronous, transactional GraphSON v3 ingest with hashed IDs and lexicon validation | [`graphson-ingest-contract.md`](./graphson-ingest-contract.md) |
| `POST`   | `/persist/ingest-async`             | Validate + enqueue GraphSON v3 ingest; payload stored in S3, pointer enqueued to SQS | [`async-graphson-ingest-and-graph-facts.md`](./async-graphson-ingest-and-graph-facts.md) |
| `POST`   | `/persist/validate`                 | Validate a GraphSON v3 document against the lexicon **without persisting** (supports candidate lexicon) | [`graphson-ingest-contract.md`](./graphson-ingest-contract.md) |
| `POST`   | `/persist/gremlin`                  | Run a **read-only** Gremlin query against a Neptune reader (`readerTarget` selects which) and return GraphSON v3 | [`gremlin-sync-query.md`](./gremlin-sync-query.md), [`neptune-reader-topology.md`](./neptune-reader-topology.md) |
| `POST`   | `/persist/gremlin/explain`          | Return Neptune's query plan for a read-only Gremlin query without executing it | [`gremlin-explain.md`](./gremlin-explain.md) |
| `POST`   | `/persist/gremlin-async`            | Submit a long-running Gremlin query for asynchronous execution; returns `requestId` | [`async-gremlin.md`](./async-gremlin.md) |
| `GET`    | `/persist/gremlin-async/:requestId` | Get terminal/in-flight job state and metadata | [`async-gremlin.md`](./async-gremlin.md) |
| `DELETE` | `/persist/gremlin-async/:requestId` | Idempotent cancel; persists `cancelRequested` intent or terminal `CANCELLED` depending on state | [`async-gremlin.md`](./async-gremlin.md) |
| `POST`   | `/persist/graphql`                  | Read-only GraphQL query execution over lexicon-generated types with per-field data-source resolution | [`graphql-read-surface.md`](./graphql-read-surface.md), [`graphql-pii-access-policy.md`](./graphql-pii-access-policy.md) |
| `GET`    | `/persist/graphql/schema`           | Return the active generated GraphQL SDL plus lexicon and resolution-map version metadata | [`graphql-read-surface.md`](./graphql-read-surface.md) |

Out-of-band, the service also exposes:

- An **EventBridge rule** for `GraphFactProduced` events emitted by other products. Persist validates the embedded GraphSON v3 payload and routes by size: small facts (vertices + edges <= `SYNC_INGEST_MAX_ELEMENTS`, default 50) are written synchronously in one Neptune transaction, while larger payloads take the async GraphSON ingest path. Payloads carrying `vertexRefs` always take the sync path because references must be verified before any write. [`async-graphson-ingest-and-graph-facts.md`](./async-graphson-ingest-and-graph-facts.md)
- A **Step Functions state machine** (the **Neptune CSV workflow**) for bulk CSV ingest from S3. [`csv-bulk-load-workflow.md`](./csv-bulk-load-workflow.md)
- A **Step Functions state machine** (the **Derived Index Rebuild workflow**) for selected re-indexing of lexicon-declared derived indexes, driven by an index-definition discovery poller. [`derived-index-maintenance.md`](./derived-index-maintenance.md), [`derived-index-discovery-and-catchup.md`](./derived-index-discovery-and-catchup.md)
- An **EventBridge Scheduler rule** that invokes a Neptune Streams poller for incremental derived-index updates after graph writes commit, plus a lag probe. [`derived-index-maintenance.md`](./derived-index-maintenance.md), [`operations-dashboards-and-alerting.md`](./operations-dashboards-and-alerting.md)
- Full-text search over the graph (`Neptune#fts` through `POST /persist/gremlin`, backed by an OpenSearch mirror). [`opensearch-fts-mirror.md`](./opensearch-fts-mirror.md)
- Athena reporting planes: a debt derived-index export, a raw Neptune stream export into per-label tables, and an incremental index stream consumer. [`athena-debt-index-export.md`](./athena-debt-index-export.md), [`neptune-stream-export.md`](./neptune-stream-export.md), [`athena-index-stream-consumer.md`](./athena-index-stream-consumer.md)

### 1.3 Non-goals

- Persist's public read surfaces are Gremlin and the lexicon-generated GraphQL API — nothing else. There is no `/persist/search` endpoint.
- The GraphQL surface does **not** accept caller-defined types, caller-defined resolvers, mutations, or subscriptions. The schema is generated from the lexicon; the field-to-source routing comes only from the Persist-owned resolution map. Callers cannot select or override a data source per request.
- Persist does **not** proxy arbitrary Interprose operations. Interprose is reachable only as a resolution target for fields declared in the resolution map, through the cached, concurrency-bounded resolver client in [`graphql-read-surface.md`](./graphql-read-surface.md) — never as a passthrough API.
- Persist does **not** provide the legacy document-store surface (`/persistence/transactions`, `/persistence/collections`) or accept API-key authentication. Callers use SigV4 against `/persist/*`; deployment correlation and log records stay in the owning service's storage.
- Persist does **not** create or own an API custom domain. It publishes its execute-api URL and a cross-account invoke role to SSM for consumers ([`stacks-configuration-and-iam.md`](./stacks-configuration-and-iam.md) §4.7).
- Persist does **not** own the shared lexicon document; it consumes Lexicon product artifacts from S3 through the `/lexicon/data-uri` SSM parameter.
- Persist does **not** consume arbitrary EventBridge traffic. It subscribes only to versioned graph-fact events that carry GraphSON v3 and pass the same lexicon and integrity rules as HTTP ingest.

---
## 2. Architecture

Specified in [`stacks-configuration-and-iam.md`](./stacks-configuration-and-iam.md). The sub-sections below map the former PRD structure onto that file and its siblings.

### 2.1 Stacks (AWS CDK)

[`stacks-configuration-and-iam.md`](./stacks-configuration-and-iam.md) §2 — the full CDK app topology (seven stacks), deployment order, context keys, and SSM handoffs.

### 2.2 NeptuneStack contents

[`stacks-configuration-and-iam.md`](./stacks-configuration-and-iam.md) §3 — VPC, security groups, cluster parameters, instances, bulk-load role, outputs. Dedicated readers and endpoints: [`neptune-reader-topology.md`](./neptune-reader-topology.md). Recovery cluster: [`neptune-recovery-and-persistence-target.md`](./neptune-recovery-and-persistence-target.md). Partner peering and DB-auth role: [`cross-account-vpc-peering.md`](./cross-account-vpc-peering.md).

### 2.3 PersistSearchStack

[`opensearch-fts-mirror.md`](./opensearch-fts-mirror.md) — the full-text-search mirror stack.

### 2.4 PersistStack contents

[`stacks-configuration-and-iam.md`](./stacks-configuration-and-iam.md) §4 — storage, queues, DynamoDB, compute, Fargate, routing fabric, API exposure.

#### 2.4.1 Storage

[`stacks-configuration-and-iam.md`](./stacks-configuration-and-iam.md) §4.1.

#### 2.4.2 Queues

[`stacks-configuration-and-iam.md`](./stacks-configuration-and-iam.md) §4.2.

#### 2.4.3 DynamoDB

[`stacks-configuration-and-iam.md`](./stacks-configuration-and-iam.md) §4.3.

#### 2.4.4 Compute

[`stacks-configuration-and-iam.md`](./stacks-configuration-and-iam.md) §4.4 and §4.5.

#### 2.4.5 Routing fabric

[`stacks-configuration-and-iam.md`](./stacks-configuration-and-iam.md) §4.6 and §4.7.

#### 2.4.6 IAM (high-level)

[`stacks-configuration-and-iam.md`](./stacks-configuration-and-iam.md) §5.

### 2.5 Configuration surface (env vars)

[`stacks-configuration-and-iam.md`](./stacks-configuration-and-iam.md) §7 — the single canonical environment-variable table (code defaults and CDK overrides).

---

## 3. Data Model & Contracts

### 3.1 Response envelope

[`error-catalogue-and-responses.md`](./error-catalogue-and-responses.md) §2.

### 3.2 GraphSON v3 typed values

[`graphson-ingest-contract.md`](./graphson-ingest-contract.md) §2.

#### 3.2.1 Persist Blob typed values

Contract: [`graphson-ingest-contract.md`](./graphson-ingest-contract.md) §2. Derivation and runtime: [`identity-hashing-and-blobs.md`](./identity-hashing-and-blobs.md) §3.

#### 3.2.2 Vertex reference optionality

[`graphson-ingest-contract.md`](./graphson-ingest-contract.md) §3.

### 3.3 Lexicon (single source of truth and shared ontology)

Consumption and property rules: [`graphson-ingest-contract.md`](./graphson-ingest-contract.md) §4. Index rules and catalog: [`derived-index-maintenance.md`](./derived-index-maintenance.md) §2. Authoring the lexicon itself belongs to the `build-lexicon-product` skill.

### 3.4 Hashed IDs (deterministic)

[`identity-hashing-and-blobs.md`](./identity-hashing-and-blobs.md) §2.

#### 3.4.1 Blob URI derivation

[`identity-hashing-and-blobs.md`](./identity-hashing-and-blobs.md) §3.

### 3.5 GraphSON ingest semantic + integrity rules

[`graphson-ingest-contract.md`](./graphson-ingest-contract.md) §5.

#### 3.5.1 Cross-authority vertex references

[`graphson-ingest-contract.md`](./graphson-ingest-contract.md) §3.

### 3.6 Error catalogue → HTTP status

[`error-catalogue-and-responses.md`](./error-catalogue-and-responses.md) §3 and §4.

### 3.7 EventBridge `GraphFactProduced` event

[`async-graphson-ingest-and-graph-facts.md`](./async-graphson-ingest-and-graph-facts.md) §3.

### 3.8 Full-text-search index model

[`opensearch-fts-mirror.md`](./opensearch-fts-mirror.md) §4.

### 3.9 GraphQL schema generation and the resolution map

[`graphql-read-surface.md`](./graphql-read-surface.md) §3 and §4.

#### 3.9.1 Schema generation from the lexicon

[`graphql-read-surface.md`](./graphql-read-surface.md) §3.

#### 3.9.2 Resolution map (Persist-owned artifact)

[`graphql-read-surface.md`](./graphql-read-surface.md) §4.

---

## 4. Synchronous APIs

### 4.1 `POST /persist/gremlin`

[`gremlin-sync-query.md`](./gremlin-sync-query.md). Reader selection: [`neptune-reader-topology.md`](./neptune-reader-topology.md). Full-text hints: [`opensearch-fts-mirror.md`](./opensearch-fts-mirror.md) §4.6. Query plans: [`gremlin-explain.md`](./gremlin-explain.md).

### 4.2 `POST /persist/ingest`

[`graphson-ingest-contract.md`](./graphson-ingest-contract.md) §6.

### 4.3 `POST /persist/validate`

[`graphson-ingest-contract.md`](./graphson-ingest-contract.md) §7.

### 4.4 Service composition / dependency wiring

Conventions: [`engineering-conventions-and-testing.md`](./engineering-conventions-and-testing.md) §2. Per router: [`graphson-ingest-contract.md`](./graphson-ingest-contract.md) §8, [`gremlin-sync-query.md`](./gremlin-sync-query.md) §6, [`async-gremlin.md`](./async-gremlin.md) §2, [`graphql-read-surface.md`](./graphql-read-surface.md) §5.

### 4.5 `POST /persist/graphql` and `GET /persist/graphql/schema`

[`graphql-read-surface.md`](./graphql-read-surface.md) §2, §5 to §9. PII gate: [`graphql-pii-access-policy.md`](./graphql-pii-access-policy.md).

#### 4.5.1 Resolver architecture

As shipped: [`graphql-read-surface.md`](./graphql-read-surface.md) §5 and §6. Target state and gap list: [`graphql-read-surface.md`](./graphql-read-surface.md) §11.

---

## 5. Asynchronous Pipelines

### 5.1 GraphSON async ingest (`POST /persist/ingest-async`)

[`async-graphson-ingest-and-graph-facts.md`](./async-graphson-ingest-and-graph-facts.md).

#### 5.1.1 Stage-1 — `PersistAsyncBulkWorker`

[`async-graphson-ingest-and-graph-facts.md`](./async-graphson-ingest-and-graph-facts.md) §4.

#### 5.1.2 Stage-2 — `PersistAsyncBulkAggregateWorker`

[`async-graphson-ingest-and-graph-facts.md`](./async-graphson-ingest-and-graph-facts.md) §4.

#### 5.1.3 EventBridge fact ingest

[`async-graphson-ingest-and-graph-facts.md`](./async-graphson-ingest-and-graph-facts.md) §4.

### 5.2 Async Gremlin (`POST /persist/gremlin-async`, `GET …`, `DELETE …`)

[`async-gremlin.md`](./async-gremlin.md) §3, §5, §6.

### 5.3 Step Functions: GremlinAsyncStateMachine

[`async-gremlin.md`](./async-gremlin.md) §4.

### 5.4 Step Functions: PersistNeptuneCsvWorkflow

[`csv-bulk-load-workflow.md`](./csv-bulk-load-workflow.md).

#### 5.4.1 Inputs (accepted shapes)

[`csv-bulk-load-workflow.md`](./csv-bulk-load-workflow.md) §3.

#### 5.4.2 Cost gate

[`csv-bulk-load-workflow.md`](./csv-bulk-load-workflow.md) §4.

#### 5.4.3 Validation (Distributed Map over Glue input prefix)

[`csv-bulk-load-workflow.md`](./csv-bulk-load-workflow.md) §4.

#### 5.4.4 Rehash (Glue)

[`csv-bulk-load-workflow.md`](./csv-bulk-load-workflow.md) §4.

#### 5.4.5 Phase Distributed Maps (vertices first, then edges)

[`csv-bulk-load-workflow.md`](./csv-bulk-load-workflow.md) §2 and §4.

#### 5.4.6 Dedup

[`csv-bulk-load-workflow.md`](./csv-bulk-load-workflow.md) §4.

### 5.5 Neptune bulk loader (`NeptuneBulkLoaderService`)

[`csv-bulk-load-workflow.md`](./csv-bulk-load-workflow.md) §4.

### 5.6 Derived index maintenance

Core (catalog, writer, rebuild workflow, stream indexer): [`derived-index-maintenance.md`](./derived-index-maintenance.md). Discovery, definition state, trigger-first rebuilds, workflow catch-up: [`derived-index-discovery-and-catchup.md`](./derived-index-discovery-and-catchup.md).

#### 5.6.1 Step Functions: PersistIndexRebuildWorkflow

[`derived-index-maintenance.md`](./derived-index-maintenance.md) §4.

#### 5.6.2 Neptune Streams incremental indexer

[`derived-index-maintenance.md`](./derived-index-maintenance.md) §5.

### 5.7 Full-text-search replication

[`opensearch-fts-mirror.md`](./opensearch-fts-mirror.md).

#### 5.7.1 Step Functions: PersistOpenSearchBackfillWorkflow

[`opensearch-fts-mirror.md`](./opensearch-fts-mirror.md) §3 and §4.5.

#### 5.7.2 Neptune Streams to OpenSearch poller

[`opensearch-fts-mirror.md`](./opensearch-fts-mirror.md) §3 and §5.

---

## 6. Internal Data Schemas

### 6.1 Async-bulk queue messages

GraphSON messages: [`async-graphson-ingest-and-graph-facts.md`](./async-graphson-ingest-and-graph-facts.md) §3. CSV batch messages: [`csv-bulk-load-workflow.md`](./csv-bulk-load-workflow.md) §3. Async Gremlin queue message: [`async-gremlin.md`](./async-gremlin.md) §3.

### 6.2 Workflow item records

[`csv-bulk-load-workflow.md`](./csv-bulk-load-workflow.md) §3.

### 6.3 Async Gremlin job state (DynamoDB)

[`async-gremlin.md`](./async-gremlin.md) §3.

### 6.4 Async Gremlin result document (S3)

[`async-gremlin.md`](./async-gremlin.md) §3.

### 6.5 EventBridge graph-fact event schema

[`async-graphson-ingest-and-graph-facts.md`](./async-graphson-ingest-and-graph-facts.md) §3.

### 6.6 Derived index schemas

[`derived-index-maintenance.md`](./derived-index-maintenance.md) §6. Definition-state and checkpoint-store items: [`derived-index-discovery-and-catchup.md`](./derived-index-discovery-and-catchup.md) §3.

### 6.7 Persist Blob schemas

[`identity-hashing-and-blobs.md`](./identity-hashing-and-blobs.md) §3.

### 6.8 Full-text-search schemas

[`opensearch-fts-mirror.md`](./opensearch-fts-mirror.md) §4.4 and §4.5.

---

## 7. Cross-cutting Concerns

### 7.1 Temporal handling

[`identity-hashing-and-blobs.md`](./identity-hashing-and-blobs.md) §4.

### 7.2 Gremlin connection management

[`gremlin-sync-query.md`](./gremlin-sync-query.md) §7.

### 7.3 Retry classification

Classification as implemented: [`gremlin-sync-query.md`](./gremlin-sync-query.md) §8. Decision guide for timeouts and retries across every surface: [`timeouts-and-retries.md`](./timeouts-and-retries.md).

### 7.4 Transactions

[`gremlin-sync-query.md`](./gremlin-sync-query.md) §9.

### 7.5 Observability

Primitives and core metrics: [`engineering-conventions-and-testing.md`](./engineering-conventions-and-testing.md) §3. Alarms, dashboards, paging: [`operations-dashboards-and-alerting.md`](./operations-dashboards-and-alerting.md). Per-subsystem metrics live in each subsystem's reference.

### 7.6 Long-running command discipline

[`engineering-conventions-and-testing.md`](./engineering-conventions-and-testing.md) §3.

### 7.7 Service / module structure

[`engineering-conventions-and-testing.md`](./engineering-conventions-and-testing.md) §2.

### 7.8 Testing strategy

[`engineering-conventions-and-testing.md`](./engineering-conventions-and-testing.md) §5.

### 7.9 CI/CD

[`engineering-conventions-and-testing.md`](./engineering-conventions-and-testing.md) §6.

---

## 8. Operational Playbook

### 8.1 Prerequisites

[`operations-playbook.md`](./operations-playbook.md) §2.

### 8.2 Deploy / destroy

[`operations-playbook.md`](./operations-playbook.md) §3. Cluster cutover and rollback: [`neptune-recovery-and-persistence-target.md`](./neptune-recovery-and-persistence-target.md). Reader endpoint rollback: [`neptune-reader-topology.md`](./neptune-reader-topology.md).

### 8.3 Smoke tests

[`operations-playbook.md`](./operations-playbook.md) §5.

### 8.4 Rollback

[`operations-playbook.md`](./operations-playbook.md) §6.

### 8.5 Common runbook items

[`operations-playbook.md`](./operations-playbook.md) §7. Alarm responses: [`operations-dashboards-and-alerting.md`](./operations-dashboards-and-alerting.md).

---

## 9. Re-creation Checklist (in order)

[`engineering-conventions-and-testing.md`](./engineering-conventions-and-testing.md) §7.

## 10. Acceptance Criteria

[`operations-playbook.md`](./operations-playbook.md) §8 collects the service-wide criteria and points to the acceptance section of every reference file.
