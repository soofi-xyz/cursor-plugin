---
name: build-persist-service
description: "Implementing or changing the Persist service from its PRD — graph persistence, validated ingest, bulk load, query interfaces, read surfaces, Athena exports, Neptune topology and recovery, operations. Read reference/PRD.md first, then the feature reference the task touches."
disable-model-invocation: true
---

# Build Persist Service

This skill is intentionally thin. Use it as a loader for [`reference/PRD.md`](./reference/PRD.md) and the per-feature references below, not as a requirements copy.

## Required Reading

1. Read [`reference/PRD.md`](./reference/PRD.md) first. It is short: §1 defines the mission, public surface, and non-goals; every later section is a pointer into the reference files.
2. Read the reference file for every area the task touches (see the routing table). The reference files are authoritative for contracts, resource shapes, IAM, env vars, workflows, and verification; each was derived from the service code, not from the old PRD text.
3. Read [`../apply-engineering-guidelines/SKILL.md`](../apply-engineering-guidelines/SKILL.md) for Golden Path constraints.
4. Read lexicon skills when the task changes graph schema validation, vertex/edge contracts, properties, enums, index declarations, or immutability rules.

## Feature Reference Routing

| Task mentions | Read |
| --- | --- |
| CDK app topology, stack list, NeptuneStack or PersistStack resources, Lambda sizing, queues, tables, IAM roles, stack outputs, SSM parameters, any environment variable | [`reference/stacks-configuration-and-iam.md`](./reference/stacks-configuration-and-iam.md) |
| GraphSON v3 payload shape, typed values, vertex references, lexicon property rules, validation issue codes, `POST /persist/ingest`, `POST /persist/validate`, candidate lexicon | [`reference/graphson-ingest-contract.md`](./reference/graphson-ingest-contract.md) |
| Hashed element IDs, what changes an ID, Persist Blob URIs and S3 runtime, date and date-time handling, CSV type widening | [`reference/identity-hashing-and-blobs.md`](./reference/identity-hashing-and-blobs.md) |
| `POST /persist/ingest-async`, async bulk workers, `GraphFactProduced` events, event bus, DLQs, ingest metrics | [`reference/async-graphson-ingest-and-graph-facts.md`](./reference/async-graphson-ingest-and-graph-facts.md) |
| Choosing a query timeout, which reader or channel a query belongs on, whether an error should be retried, what a caller should do on 429, 503, or 504, tuning timeout or retry knobs | [`reference/timeouts-and-retries.md`](./reference/timeouts-and-retries.md) |
| `POST /persist/gremlin`, read-only query policy, evaluation timeout, 429 or 504 outcomes, Gremlin connection pools, retry classes, transactions | [`reference/gremlin-sync-query.md`](./reference/gremlin-sync-query.md) |
| `POST /persist/gremlin-async`, job status or cancel, the async state machine, Fargate executor, heartbeats and timeouts | [`reference/async-gremlin.md`](./reference/async-gremlin.md) |
| Neptune CSV bulk load, `PersistNeptuneCsvWorkflow`, cost gate, Glue rehash, stage and dispatch steps, direct versus aggregate load, bulk loader status, loader queue full | [`reference/csv-bulk-load-workflow.md`](./reference/csv-bulk-load-workflow.md) |
| Lexicon `indexes` rules, index catalog, index writer, `PersistIndexRebuildWorkflow`, stream indexer poller, index checkpoint | [`reference/derived-index-maintenance.md`](./reference/derived-index-maintenance.md) |
| `POST /persist/graphql`, schema generation, resolution map, resolvers and adapters, Interprose or DynamoDB sources, GraphQL limits and metrics | [`reference/graphql-read-surface.md`](./reference/graphql-read-surface.md) |
| Response envelope, tagged error to HTTP status mapping, error sanitisation | [`reference/error-catalogue-and-responses.md`](./reference/error-catalogue-and-responses.md) |
| Effect-TS service and layer conventions, logging and metrics primitives, repository layout, test harness and suites, CI recipes, re-creation checklist | [`reference/engineering-conventions-and-testing.md`](./reference/engineering-conventions-and-testing.md) |
| Prerequisites, deploy or destroy commands, invoking the API, smoke tests, rollback, runbook, service-wide acceptance criteria | [`reference/operations-playbook.md`](./reference/operations-playbook.md) |
| Athena reporting table of debt derived indexes, blue/green table publishing, key-list scan, export run after a bulk load | [`reference/athena-debt-index-export.md`](./reference/athena-debt-index-export.md) |
| Raw Neptune Streams capture to S3, `waiting-for-export` buffer, Glue stream-export jobs, per-label Athena/Iceberg tables, daily compaction, stream position published to consumers | [`reference/neptune-stream-export.md`](./reference/neptune-stream-export.md) |
| Incremental Athena index stream, vertex-to-debt map table, delta Parquet, applied-status rows, smoke consumer | [`reference/athena-index-stream-consumer.md`](./reference/athena-index-stream-consumer.md) |
| Restoring Neptune from a snapshot, second cluster stack, `neptunePersistenceTarget` cutover or rollback, retention mode on the inactive cluster | [`reference/neptune-recovery-and-persistence-target.md`](./reference/neptune-recovery-and-persistence-target.md) |
| Dedicated reader instances, one reader per consumer role, adding or removing a consumer reader, custom reader endpoints, `readerTarget`, per-endpoint query timeouts, `neptuneReaderEndpointMode` | [`reference/neptune-reader-topology.md`](./reference/neptune-reader-topology.md) |
| `POST /persist/gremlin/explain`, query plans, Neptune explain API | [`reference/gremlin-explain.md`](./reference/gremlin-explain.md) |
| PII fields in GraphQL, per-principal access levels, masking policy document | [`reference/graphql-pii-access-policy.md`](./reference/graphql-pii-access-policy.md) |
| Partner account reaching Neptune over VPC peering, Neptune IAM DB-auth role for another account | [`reference/cross-account-vpc-peering.md`](./reference/cross-account-vpc-peering.md) |
| CloudWatch dashboards, alarms, paging integration, Neptune CPU alerting, metric catalogue | [`reference/operations-dashboards-and-alerting.md`](./reference/operations-dashboards-and-alerting.md) |
| OpenSearch full-text-search mirror, `Neptune#fts` queries, FTS definition file, backfill or reindex, stream poller lag, search collection replacement | [`reference/opensearch-fts-mirror.md`](./reference/opensearch-fts-mirror.md) |
| Index definition discovery, trigger-first rebuilds, definition fingerprints, index catch-up inside the CSV workflow | [`reference/derived-index-discovery-and-catchup.md`](./reference/derived-index-discovery-and-catchup.md) |

## Use With Plugin Agents

- Use `conkeldurr` first for platform product classification, existing-deployment checks, and build-vs-integrate decisions.
- Use `machamp` for the Neptune CSV workflow, async processing, cost gates, throttling, idempotency, and workflow verification.
- Use `regigigas` only when Persist must be packaged, released, subscribed, or deployed through the marketplace ecosystem.
- For Interprose-sourced GraphQL fields, use the vendor adapter contract in [`reference/graphql-read-surface.md`](./reference/graphql-read-surface.md) §6 and the PII gate in [`reference/graphql-pii-access-policy.md`](./reference/graphql-pii-access-policy.md); there is no separate vendor-integration skill in this kit.

## Implementation Rules

- Treat the loaded reference files as the single source of truth for routes, GraphSON contracts, Persist Blob handling, data contracts, resource shapes, IAM scopes, env vars, error tags, workflows, and verification. The PRD's §1 is the source of truth for scope and non-goals only.
- Do not implement from this `SKILL.md` alone.
- For an existing Persist deployment, integrate through the `/persist/*` API contracts in the reference files instead of provisioning a duplicate service.
- Keep every reference generic: never add account identifiers, ARNs, peering or snapshot identifiers, or customer and partner names. Use placeholders such as `<account>`, `<stage>`, `<snapshot-id>`.
- If any old skill or rule file conflicts with a reference file, the reference wins; update stale guidance instead of layering compatibility shims. When a reference file and the service code disagree, the code is right and the reference must be corrected.

## Expected Output

Return the product fit, existing-vs-new deployment verdict, reference files used, files/stacks/contracts to change, companion agents/skills loaded, and the verification path drawn from each loaded reference.
