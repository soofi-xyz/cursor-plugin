# Neptune Snapshot Recovery and Persistence-Target Switching

Persist can run its graph on one of two Neptune clusters: the original **blue** cluster owned by `NeptuneStack` (`stacks-configuration-and-iam.md` §3) and a **recovery** cluster restored from a native cluster snapshot by a second, production-only CDK stack. A single CDK context key, `neptunePersistenceTarget`, decides at synth time which cluster every data-plane consumer (API stack, search stack, export stack, cross-account DB-auth grants) points at; the switch rewires endpoints and the IAM cluster-resource ARN together, in one deployment, without deleting either cluster. While the recovery cluster is active the blue cluster runs in a **retention mode** that shrinks it to two minimal instances but keeps its storage, backups, and deletion protection so a one-word context change can roll production back. Custom reader endpoints, which have no CloudFormation resource, are resolved by a provider-backed custom resource shared by both stacks. This file covers the recovery stack, the target switch, retention mode, the endpoint custom resource, and the cutover/rollback runbook. Reader-instance topology is described in `neptune-reader-topology.md`.

## 1. Purpose and scope

- Restore production from a Neptune snapshot **through CDK**, so the restored cluster is owned, tagged, parameterised, and protected the same way as the original, rather than created by hand and imported later.
- Make the choice of active cluster a **deploy-time switch** with a symmetrical rollback: `--context neptunePersistenceTarget=blue` is the entire rollback lever.
- Keep the inactive cluster **cheap but restorable** (retention mode) instead of deleting it, until the recovery is judged final.
- Guarantee that a cutover moves **every** consumer of cluster identity together: hostnames, cluster identifier (metrics), and cluster resource ID (IAM DB auth). A partial switch leaves Lambdas connected but unauthorised.

Non-goals:

- Point-in-time restore automation, cross-region restore, or snapshot lifecycle management (snapshots are taken by Neptune automated backups, `stacks-configuration-and-iam.md` §3).
- Migrating stream cursors, derived-index checkpoints, or the OpenSearch mirror between clusters. Section 4.6 states what the code does and does not do.
- Multi-cluster read fan-out or running both clusters as live targets. Exactly one cluster serves persistence at a time.
- Non-production stages: the recovery path is production-only; other stages have one cluster.

## 2. Architecture

### 2.1 Two cluster stacks

```
bin/app.ts (stage=prod)
│
├── NeptuneStack                      # blue: VPC, LambdaSg, NeptuneSg, bulk-load role,
│     │                               #        cluster (+ retention mode), partner DB-auth role
│     │  vpc / lambdaSecurityGroup / bulkLoadRoleArn / partnerDbAuthRole
│     ▼
├── NeptuneRecovery<Tag>Stack         # recovery: CfnDBCluster{snapshotIdentifier}, own SG,
│     (addDependency NeptuneStack)    #   own subnet + parameter groups, writer + readers,
│                                     #   auto-scaling target, custom endpoints, outputs
│
│   persistenceNeptune = target === "recovery" ? recoveryStack : neptuneStack
│
├── PersistSearchStack   ← persistenceNeptune.{writer, generalReader|reader, clusterResourceId}
├── PersistStack         ← persistenceNeptune.{writer, generalReader|reader, asyncReader,
│                            dedicatedReaders, clusterResourceId, clusterIdentifier}
└── <Export>Stack        ← persistenceNeptune.{generalReader|reader, asyncReader, clusterResourceId}
```

Shared (always from `NeptuneStack`, never duplicated): the VPC and isolated subnets, `LambdaSg`, `neptunePort`, the bulk-load IAM role ARN, and the partner cross-account DB-auth role object. Duplicated per cluster: security group, subnet group, cluster parameter group (streams on, audit/slow-query logs, cluster query timeout, `neptune_autoscaling_config` tags), instance parameter groups, writer and reader instances, Application Auto Scaling target and policy, the custom-endpoint provider and its three endpoints, and stack outputs.

The recovery stack is a **sibling** of `NeptuneStack`, not a child: it takes `vpc`, `lambdaSecurityGroup`, `neptuneBulkLoadRoleArn`, and the optional partner DB-auth role as props, declares `addDependency(neptuneStack)`, and exposes the same public surface (`neptuneWriterEndpoint`, `neptuneReaderEndpoint`, `neptuneAsyncReaderEndpoint`, `neptuneGeneralReaderEndpoint`, dedicated reader endpoints, `neptuneClusterIdentifier`, `neptuneClusterResourceId`) so `bin/app.ts` can substitute it for the blue stack without the consumers knowing.

### 2.2 Target selection in `bin/app.ts`

1. Read `stage` and `neptunePersistenceTarget` from context. Default the target to `recovery` when `stage=prod` and to `blue` otherwise.
2. Validate: value must be `blue` or `recovery`; `recovery` outside `stage=prod` throws.
3. Derive `blueRetentionMode = stage === "prod" && target === "recovery"` and pass it to `NeptuneStack`.
4. When `stage=prod`, assert `env.account` equals the production account constant (an unresolved account throws too, so prod synth always needs `CDK_DEFAULT_ACCOUNT`) and instantiate `NeptuneRecovery<Tag>Stack` **unconditionally**, so both clusters always exist in prod and the switch never creates or deletes a cluster.
5. Bind `persistenceNeptune` to the chosen stack and feed its endpoints, cluster identifier, and cluster resource ID into `PersistSearchStack`, `PersistStack`, and the export stack. Reader-endpoint mode (`custom` vs `cluster`) is resolved against `persistenceNeptune`, so the general-reader custom endpoint of the active cluster is what consumers receive.
6. Add `persistSearchStack.addDependency(persistenceNeptune)` when the target is not blue, so the recovery stack is fully available before consumers deploy.

Consumers rewired by the switch (all in one `cdk deploy`): the API/ingest/poller/workflow Lambdas and Fargate tasks in `PersistStack`, the OpenSearch backfill/poller Lambdas in `PersistSearchStack`, the export stack's extraction and key-list readers, every `neptune-db:*` IAM statement that embeds the cluster resource ID, the reader-CPU alarm that embeds the cluster identifier, and the partner DB-auth role (section 3.4). The bulk-load role is not rewired: both clusters associate the same role ARN, so the loader's `iamRoleArn` stays valid on either.

## 3. Contracts

### 3.1 CDK context keys

| Key | Values | Default | Guard |
| --- | --- | --- | --- |
| `stage` | free string | unset | `prod` enables the recovery stack, deletion protection, and the `recovery` default |
| `neptunePersistenceTarget` | `blue` \| `recovery` | `recovery` if `stage=prod`, else `blue` | anything else throws; `recovery` with `stage!=prod` throws |
| `neptuneReaderEndpointMode` | `cluster` \| `custom` | `custom` when the active cluster has a general-reader endpoint | evaluated against the **active** cluster (see `neptune-reader-topology.md`) |
| `neptuneStreamsExpiryDays` | 1–90 | 30 | blue reads context; recovery takes a `streamsExpiryDays` prop, clamped the same way |
| `neptuneBackupRetentionDays` | 1–35 | 35 | blue only; recovery pins 35 |

Stack-level guards in `NeptuneRecovery<Tag>Stack`: constructor throws unless the stack account equals the production account constant in `lib/deployment-environment.ts`, the region equals the production region, and `props.snapshotIdentifier` equals the exported pinned constant. The snapshot identifier is a **code constant**, not context: changing or removing `snapshotIdentifier` on `CfnDBCluster` replaces the cluster, so the pin makes an accidental edit a synth failure rather than a replacement.

### 3.2 Stack outputs and SSM parameters

- `NeptuneStack` (blue) exports named outputs `NeptuneWriterEndpoint`, `NeptuneReaderEndpoint`, `NeptuneAsyncReaderEndpoint`, `NeptunePort`, `NeptuneClusterResourceId`, `NeptuneClusterIdentifier`, `NeptuneBulkLoadRoleArn`, `NeptuneVpcId`, `NeptuneVpcCidr`, and publishes the custom-endpoint hostnames to SSM under `/persist/neptune/{general-reader,portal-reader,agency-reader}-endpoint` (`stacks-configuration-and-iam.md` §6, `operations-playbook.md` §3).
- `NeptuneRecovery<Tag>Stack` emits unnamed outputs `RecoverySnapshotIdentifier`, `RecoveryClusterIdentifier`, `RecoveryClusterResourceId`, `RecoveryWriterEndpoint`, `RecoveryReaderEndpoint`, `RecoveryAsyncReaderEndpoint`, `RecoveryGeneralReaderEndpoint`, and one output per dedicated reader endpoint. It publishes **no** SSM parameters and does not touch the blue export names, so external readers of the blue outputs are unaffected by its existence.
- **Export pinning rule.** `NeptuneStack` calls `this.exportValue(...)` with no name on the writer, cluster-ro, async-reader, and cluster-resource-ID tokens and on every custom endpoint it creates. CDK prunes auto-generated cross-stack exports when the last in-app import disappears, but `NeptuneStack` deploys before the consumers that still import blue values, and CloudFormation refuses to delete an in-use export. Without the pin the cutover deploy ends in `UPDATE_ROLLBACK_COMPLETE`. Calling `exportValue` without a `name` reuses the identical generated logical ID and export name, so the pin is a no-op to CloudFormation.
- External consumers (partner systems) read the blue outputs and SSM parameters by name. After a cutover they must be given the `Recovery*` values explicitly; nothing rewrites those names.

### 3.3 Cluster-endpoint custom resource

Neptune custom endpoints have no CloudFormation resource, so both cluster stacks manage them with `Custom::NeptuneClusterEndpoint` backed by a `custom-resources` `Provider` (`onEvent` + `isComplete`, 30 s poll, 15 min total). Provider per cluster; the provider's write policy is scoped to that cluster's ARN plus `cluster-endpoint:*`.

Properties: `ClusterIdentifier`, `EndpointIdentifier` (becomes the DNS name; lowercase, ≤ 63 chars, unique per account/region), `EndpointType` (`READER` | `WRITER` | `ANY`), exactly one of `StaticMembers` / `ExcludedMembers` non-empty, `Tags` (passed explicitly because stack tags do not reach API-created resources). Attribute: `Endpoint` (hostname, populated only once status is `available`).

Behaviour: `Create` calls `CreateDBClusterEndpoint`; an `AlreadyExists` fault converges membership instead of failing. `Update` with an unchanged identifier calls `ensureMembership`, which describes first and skips `ModifyDBClusterEndpoint` when type and member sets already match (a modify makes the endpoint unusable for minutes, and CloudFormation sends `Update` for tag-only changes). A changed identifier returns a new `PhysicalResourceId`, so CloudFormation replaces then deletes the old endpoint. `Delete` tolerates `NotFound`. `isComplete` fails fast on status `inactive`. Read the live type from `CustomEndpointType`, and compare members as unordered sets. IAM uses the `rds:` prefix (`rds:CreateDBClusterEndpoint`, `rds:ModifyDBClusterEndpoint`, `rds:DeleteDBClusterEndpoint`, `rds:AddTagsToResource`, unscoped `rds:DescribeDBClusterEndpoints`).

Recovery endpoint identifiers carry the recovery tag (for example `persist-recovery-<tag>-general-readers`) so both clusters' endpoints coexist in the same region and creating the recovery stack never renames or edits a blue endpoint.

### 3.4 IAM (generalised)

- Every Persist principal that opens a Gremlin or Streams connection holds `neptune-db:connect` (plus `ReadDataViaQuery` / `WriteDataViaQuery` / `DeleteDataViaQuery` as needed) on `arn:<partition>:neptune-db:<region>:<account>:<clusterResourceId>/*`. The switch changes `clusterResourceId`, so every such statement is regenerated; keeping the old ID leaves the new hostname reachable but every request `403`.
- The partner cross-account DB-auth role is created by `NeptuneStack` against blue's resource ID. The recovery stack attaches an additional `iam.Policy` to that same role for the recovery resource ID, including `DeleteDataViaQuery` (Persist upserts replace single-cardinality properties, which Neptune bills as deletes). Network reachability is not authorisation.
- Both clusters list the shared bulk-load role in `associatedRoles`.
- The recovery security group mirrors blue's: egress `443` for S3 bulk load and OpenSearch, ingress `8182` from `LambdaSg`, from the VPC CIDR, and from the peered partner CIDR.

## 4. Runtime behaviour

### 4.1 Restore from snapshot

1. Add `NeptuneRecovery<Tag>Stack` with `CfnDBCluster.snapshotIdentifier = <snapshot-id>`, `deletionProtection: true`, `RemovalPolicy.RETAIN`, `iamAuthEnabled`, `storageEncrypted`, audit + slow-query log exports, 35-day backups, and the same backup/maintenance windows as blue.
2. Attach the writer first; every reader `addDependency(writerInstance)`. The first instance attached to a restored cluster becomes its writer, so an unserialised dedicated reader could become the primary.
3. Recreate the async reader (long query timeout parameter group), the dedicated readers (short timeout), the auto-scaling target (min = permanent replicas + 1 headroom, max ceiling), and the three custom endpoints. Snapshots do not carry custom endpoints, instances, parameter groups, or scaling policies; the stack must declare all of them.
4. Deploy with the target still `blue`. Creating the stack changes no routing.

### 4.2 Cutover (blue → recovery)

One deployment with `neptunePersistenceTarget=recovery` does, in CloudFormation order: `NeptuneStack` shrinks blue to retention mode (section 4.4) while keeping every export; the recovery stack is unchanged; `PersistSearchStack`, `PersistStack`, and the export stack receive the recovery hostnames, cluster identifier, and cluster resource ID. Lambda environment changes force fresh execution environments, so pooled Gremlin connections to blue are dropped rather than aged out. Fargate tasks and Step Functions executions in flight at deploy time keep their old configuration and fail or complete against blue; drain them first (section 6).

### 4.3 Rollback (recovery → blue)

`--context neptunePersistenceTarget=blue` reverses the same deployment. `blueRetentionMode` becomes false, so `NeptuneStack` first restores blue's full topology (writer and async reader back to production classes, dedicated readers and their endpoints recreated, headroom and max-7 scale-out restored), and only then do consumers move back, because `NeptuneStack` deploys before them. Writes made to the recovery cluster after the cutover are **not** replayed into blue; rollback is a return to blue's state at the moment of the cutover plus whatever was written to it since.

### 4.4 Blue retention mode

When `blueRetentionMode` is true, `NeptuneStack`: sets the writer and async-reader instance classes to the smallest supported class; passes `undefined` for both dedicated readers, which removes their instances, parameter groups, and custom endpoints; disables general-reader headroom; and pins the scaling target to `min = max = permanentReplicaCount` (1). The cluster, its storage, automated backups, parameter groups, security group, subnet group, bulk-load association, and every export survive. Cost drops to two small instances plus storage; recovery back to full size is a class change, not a restore.

### 4.5 Deletion protection

Both clusters carry `deletionProtection: true` in prod and `RemovalPolicy.RETAIN`, so neither `cdk destroy` nor a failed update can remove them. Removing the recovery stack from `bin/app.ts` orphans, not deletes, the restored cluster; decommission is an explicit console/CLI action after protection is lifted (section 6.4).

### 4.6 Streams, checkpoints, derived indexes, and OpenSearch after a cutover

Be explicit about what the code does **not** do. The derived-index poller (`derived-index-maintenance.md` §5, item shape §6.1) and OpenSearch poller (`opensearch-fts-mirror.md` §5, item shape §4.4) store `{commitNum, opNum}` under a fixed `pk=stream / sk=checkpoint` item with **no cluster identity**; `bin/app.ts` does not reset, tag, or validate those cursors when the target changes. The stream client treats Neptune's end-of-stream `404` (`StreamRecordsNotFoundException` / "Reached the end of the stream") as "caught up", and Neptune answers a position beyond its newest record exactly as it answers the tip. Consequences:

- After a cutover the pollers resume from blue's cursor against the recovery stream. If that cursor is beyond the recovery cluster's tip, every poll reports caught-up while the derived indexes and the OpenSearch mirror silently freeze. If it is inside the recovery stream but at an unrelated position, the pollers replay or skip an arbitrary window.
- Only the Athena stream consumer asserts `checkpointIsBeyondStream` on idle ticks and fails closed; the index and OpenSearch pollers do not.
- Derived-index properties live in the graph and travel with the snapshot; they are consistent as of the snapshot, not as of the cutover.
- OpenSearch documents reflect blue's graph at cutover time and may reference vertices that do not exist in the recovery graph.

Required operator action, not automated: treat a target switch as "checkpoint missing" and re-establish both cursors from the active cluster by running `PersistIndexRebuildWorkflow` and `PersistOpenSearchBackfillWorkflow` in `WRITE` (`derived-index-maintenance.md` §4, `opensearch-fts-mirror.md` §4.5, `operations-playbook.md` §7) with the pollers' schedules disabled until each workflow has recorded its watermark. Async Gremlin jobs, CSV workflow items, and blob storage are cluster-agnostic (DynamoDB/S3) but any execution in flight during the deploy targets the old cluster.

## 5. Observability

- Recovery stack outputs `RecoveryClusterIdentifier` / `RecoveryClusterResourceId` are the identifiers to verify against Lambda environment (`NEPTUNE_HOST`, `NEPTUNE_READER_HOST`, `NEPTUNE_ASYNC_READER_HOST`, dedicated reader hosts) and IAM policy resources after a deploy.
- `AWS/Neptune` metrics are dimensioned by `DBClusterIdentifier`; the reader-CPU alarm in `PersistStack` follows `persistenceNeptune.neptuneClusterIdentifier`, so dashboards and alarms that name the blue cluster by hand go blind after a cutover. Recovery's scale-out target is 20 % reader CPU (idle dedicated readers dilute the unweighted average), so do not read a low average as headroom.
- The endpoint provider logs under service name `persist-neptune-cluster-endpoint` with `neptuneEndpointOperation` / `neptuneEndpointIdentifier` annotations; a modify is logged at `warning` because it is an outage.
- Stream lag metrics from both pollers and the Athena consumer's `checkpointIsBeyondStream` failure are the only signals for section 4.6; a caught-up poll with zero records is not proof of health.
- Both clusters export `audit` and `slowquery` logs; blue's stay useful during retention for forensic comparison.

## 6. Operations / runbook

### 6.1 Restore

```bash
aws neptune describe-db-cluster-snapshots --db-cluster-identifier <blue-cluster-id>   # pick <snapshot-id>
# pin <snapshot-id> in lib/neptune-recovery-stack.ts, add the stack in bin/app.ts, tests green
pnpm cdk:synth -- --context stage=<stage> --context neptunePersistenceTarget=blue
pnpm cdk:deploy -- --context stage=<stage> --context neptunePersistenceTarget=blue   # creates recovery, routing unchanged
aws neptune describe-db-clusters --db-cluster-identifier <recovery-cluster-id>        # Status available, 1 writer + 3 readers
aws neptune describe-db-cluster-endpoints --db-cluster-identifier <recovery-cluster-id>  # every custom endpoint available
```

Verify the restored graph before cutover: run a read-only Gremlin count or a known-key lookup against `RecoveryReaderEndpoint` from inside the VPC with `neptune-db:connect` on the recovery resource ID.

### 6.2 Cutover

1. Freeze ingest: pause the CSV workflow schedule, async-bulk consumers, and both stream pollers; wait for `RUNNING` async Gremlin jobs and Fargate tasks to finish or cancel them.
2. Deploy: `pnpm cdk:deploy -- --context stage=<stage> --context neptunePersistenceTarget=recovery` (or omit the key in prod, where `recovery` is the default). Expect `NeptuneStack` to shrink blue, then the three consumer stacks to update.
3. Verify routing: `aws lambda get-function-configuration --function-name <persist-api-fn> --query Environment.Variables` shows recovery hostnames; `aws iam get-role-policy` on a data-plane role shows the recovery resource ID.
4. Smoke (`operations-playbook.md` §5): `POST /persist/gremlin` read, `POST /persist/ingest` write, one async Gremlin round trip.
5. Re-establish cursors: run `PersistIndexRebuildWorkflow` and `PersistOpenSearchBackfillWorkflow` in `WRITE`, confirm each recorded a watermark, then re-enable the pollers and ingest.
6. Hand partners the `Recovery*` outputs and confirm their cross-account role reaches the recovery cluster.

### 6.3 Rollback

`pnpm cdk:deploy -- --context stage=<stage> --context neptunePersistenceTarget=blue`, preceded by the same freeze and followed by the same verification and cursor re-establishment. Budget for blue's instance resizes and endpoint recreation (tens of minutes) before consumers move.

### 6.4 Decommission the inactive cluster

Do this only after the recovery has been accepted (section 7) and the retention window no longer matters: take a final manual snapshot of blue, remove `blueRetentionMode` handling only if blue is being deleted permanently, lift `deletionProtection`, delete the cluster out of band, then delete the retention-mode branches and the export pins in a follow-up deploy. Reverse the roles if blue wins and the recovery cluster is retired.

## 7. Verification and acceptance criteria

- `cdk synth` with `neptunePersistenceTarget=recovery` and `stage!=prod` fails; with an invalid value fails; in prod with no key resolves to `recovery`.
- Recovery stack template: `AWS::Neptune::DBCluster` has `SnapshotIdentifier=<pinned>`, `DeletionProtection=true`, `DeletionPolicy=Retain`, `IamAuthEnabled`, `StorageEncrypted`, 35-day backups; 4 `DBInstance`s, every non-writer `DependsOn` the writer; scaling target `min 4 / max 7`, policy target 20 %; three `Custom::NeptuneClusterEndpoint`s with recovery-tagged identifiers; general endpoint `DependsOn` the async reader; `AssociatedRoles` contains the shared bulk-load ARN; partner policy resource is `Fn::GetAtt [NeptuneRecoveryCluster, ClusterResourceId]`; constructor throws for a non-production account.
- Blue template in retention mode: exactly 2 `DBInstance`s on the retention class, zero custom endpoints, scaling `min 1 / max 1`; blue template with both dedicated readers still emits 7 auto-generated `ExportsOutput*` exports.
- After a cutover deploy, no stack is in `UPDATE_ROLLBACK_COMPLETE`, every data-plane Lambda's Neptune host variables and IAM resources reference the active cluster, smoke tests pass, and both stream pollers hold watermarks recorded against the active cluster.
- A rollback deploy restores blue to 1 writer + 3 permanent readers + headroom and passes the same checks.

## 8. Design decisions

- **Restore through CDK, not import.** `snapshotIdentifier` on `CfnDBCluster` makes the restored cluster a first-class stack resource with the same tags, protection, and parameter groups. The price is that the identifier must stay pinned forever; a code constant plus a constructor guard enforces that.
- **Sibling stack, shared network.** Reusing the VPC, `LambdaSg`, and bulk-load role means consumers do not change security-group membership during a cutover and the loader keeps one role ARN. Everything cluster-scoped is duplicated so neither stack can accidentally mutate the other.
- **Switch at synth time, not in DNS.** A context key rewrites endpoints and IAM in one deploy; there is no runtime indirection to keep consistent and the rollback is the same command with a different value.
- **Both stacks always exist in prod.** The switch never creates or deletes a cluster, so it is fast and reversible; export pinning is what makes the producer-before-consumer ordering survive.
- **Retention instead of deletion.** Shrinking blue to two small instances keeps a full rollback path and blue's own backups at low cost; deletion is a separate, deliberate step.
- **Stream cursors are deliberately untouched.** Guessing a cursor on a new cluster silently discards history; failing closed and requiring a rebuild/backfill is the documented contract (`operations-playbook.md` §7). Add a cluster-identity field to the checkpoint items if automated detection is wanted.
- **Convergent endpoint custom resource.** Describe-before-modify is what allows tag-only updates and create retries without a reader outage.

## 9. Source map

| Path (persist repo) | Responsibility |
| --- | --- |
| `bin/app.ts` | Context parsing and guards, `blueRetentionMode` derivation, recovery stack instantiation, `persistenceNeptune` selection, consumer wiring and dependencies |
| `lib/neptune-recovery-stack.ts` | `NeptuneRecovery<Tag>Stack`: pinned snapshot constant, guards, SG/subnet/parameter groups, instances, scaling, custom endpoints, partner DB-auth grant, outputs |
| `lib/neptune-stack.ts` | Blue cluster; `blueRetentionMode` and `deletionProtection` props, shared VPC/SG/bulk-load role/partner role, `exportValue` pins, named outputs and SSM parameters |
| `lib/neptune-configuration.ts` | Parameter-group family, query timeouts, instance classes (including the retention class), replica capacity floor and ceiling |
| `lib/deployment-environment.ts` | Account constants and helpers used by the prod-only guards |
| `lib/neptune-cluster-endpoint.ts` | `NeptuneClusterEndpointProvider` (Lambda pair, RDS-namespaced IAM, Provider framework) and `NeptuneClusterEndpoint` construct |
| `lambda/neptune-cluster-endpoint/handler.ts` | `onEvent` / `isComplete` handlers: create-or-converge, rename-as-replace, idempotent delete, availability polling |
| `lambda/services/NeptuneClusterEndpointService.ts` | Neptune control-plane client: `create`, `describe`, `ensureMembership`, `modify`, `remove`, membership comparison |
| `lambda/services/IndexCheckpointStoreService.ts`, `lambda/services/OpenSearchCheckpointStoreService.ts` | Cluster-agnostic `{commitNum, opNum}` checkpoint items (section 4.6) |
| `lambda/services/IndexStreamClientService.ts` | Streams fetch; end-of-stream `404` treated as caught-up |
| `test/cdk/neptune-recovery-stack.test.ts` | Snapshot pin, topology, endpoint, IAM, and account-guard assertions |
| `test/cdk/neptune-stack.test.ts` | Retention-mode shrink, export-pinning count, SSM parameter assertions |
| `README.md` (Deployment, Stack outputs) | Operator-facing outputs and deploy commands |
