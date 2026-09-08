# Cross-Account VPC Peering for Partner Neptune Access

Persist can grant one trusted partner AWS account private, network-level access to its Neptune cluster: a VPC peering connection between the Persist VPC (`stacks-configuration-and-iam.md` §3) and the partner's VPC, return routes in the Neptune isolated subnets, a security-group rule for the partner CIDR on the Gremlin port, and an IAM DB-auth role the partner assumes to sign Gremlin (and Neptune full-text-search) requests. The feature is committed deployment state, gated to exactly one stage/account/region, and carried onto the snapshot-recovery cluster so a cutover does not silently drop partner access. This document describes the mechanism generically; substitute `<partner-account>`, `<partner-cidr>`, `<persist-cidr>`, `<pcx-id>` and `<region>` for a concrete deployment.

## 1. Purpose & scope

- Let a partner workload that lives in another AWS account run Gremlin directly against Persist's Neptune cluster over private IP space, authenticated with Neptune IAM DB auth (`iamAuthEnabled: true`, `stacks-configuration-and-iam.md` §3).
- Keep the grant explicit and reviewable: the partner account, CIDR, and peering ID are constants in source; nothing is discovered at deploy time.
- Keep the partner able to follow a recovery cutover (`neptune-recovery-and-persistence-target.md`) without a second onboarding.

Non-goals:

- Not a public endpoint. Neptune stays in `PRIVATE_ISOLATED` subnets; the only new ingress is `<partner-cidr>` on TCP `8182`.
- Not API-level access. The partner bypasses the Persist HTTP API, IAM authoriser, response envelope and ingest validation (`graphson-ingest-contract.md`, `error-catalogue-and-responses.md`); Persist's hashed-ID, lexicon and single-cardinality rules are the partner's responsibility when they write.
- Not a multi-partner framework. One partner block per stack; a second partner is a second constant set and a second role.
- Not partner-side infrastructure. The partner owns peering creation (requester side), their own routes to `<persist-cidr>`, and the `sts:AssumeRole` call into the DB-auth role.

## 2. Architecture

```
Partner account <partner-account>                 Persist account
┌──────────────────────────────┐                  ┌────────────────────────────────────────────┐
│ Partner VPC <partner-cidr>   │   VPC peering    │ Persist VPC <persist-cidr>                  │
│                              │◄═══ <pcx-id> ═══►│  public / app (egress) / db (isolated)      │
│  workload ──sts:AssumeRole──┼──────────────────┼─► PartnerNeptuneDbAuthRole                  │
│      │ SigV4 Gremlin :8182   │                  │     trust: arn:aws:iam::<partner-account>:root│
│      ▼                       │                  │     neptune-db: connect, Read/Write/Delete   │
│  route <persist-cidr> → pcx  │                  │     es:ESHttp* on the FTS domain             │
└──────────────────────────────┘                  │                                              │
                                                  │  db route tables: <partner-cidr> → <pcx-id>  │
   Wave 1 only:                                   │  NeptuneSg ingress <partner-cidr> tcp/8182   │
   PartnerVpcPeeringAccepterRole                  │  Neptune cluster (primary)                   │
   trust: <partner-account>, ec2:AcceptVpc…       │  Neptune recovery cluster (same subnets,     │
                                                  │    same SG rule, same role via extra policy) │
                                                  └────────────────────────────────────────────┘
```

Both Neptune clusters (primary and recovery) live in the same isolated subnets, so peering and return routes are created once in `NeptuneStack`; the recovery stack only adds its own security group rule and an extra IAM policy on the shared role.

## 3. Contract

### 3.1 Committed state and CDK props

`bin/app.ts` holds a committed object `{ enabled: boolean, peeringConnectionId: string }`. It derives `NeptuneStack` props:

| Prop (`NeptuneStackProps.partnerPeering`) | Type | Meaning |
| --- | --- | --- |
| `enabled` | `boolean` | Create SG ingress, DB-auth role, outputs. |
| `createAccepterRole` | `boolean`, default `true` | Keep the one-shot accepter role. The app sets it to `peeringConnectionId.length === 0`, so committing a peering ID removes the role. |
| `peeringConnectionId` | `string` (`pcx-…`), optional | When set, create one return route per isolated subnet route table. |

Constants in `lib/neptune-stack.ts`: `PARTNER_REQUESTER_ACCOUNT_ID`, `PARTNER_REQUESTER_VPC_CIDR`, `PARTNER_GREMLIN_PORT = 8182`. Account IDs for Persist's own environments live in `lib/deployment-environment.ts` as named constants (`<DEV_ACCOUNT_ID>`, `<PROD_ACCOUNT_ID>`) plus an `isDevAccount(account)` helper; never inline them elsewhere.

### 3.2 Deploy-time guards (`bin/app.ts`)

- `applies = enabled && stage === "prod" && (env.account === undefined || env.account === <PROD_ACCOUNT_ID>)`. Props are passed to the stack only when `applies` is true; every other stage synthesises no partner resources.
- `requested = enabled && stage === "prod"`. When requested: if `env.account` is set and differs from `<PROD_ACCOUNT_ID>`, throw `"<partner> peering can only be deployed to the production account <PROD_ACCOUNT_ID>."`; if `env.region` is set and differs from the designated `<region>`, throw `"<partner> peering can only be deployed in <region>."`.
- The recovery stack independently throws when `stage === "prod"` and the account is not `<PROD_ACCOUNT_ID>`, so the role can never be extended to a cluster in the wrong account.
- `env.account`/`env.region` come from `CDK_DEFAULT_ACCOUNT`/`CDK_DEFAULT_REGION`. An unresolved account passes the peering guard itself, but in `stage=prod` the recovery-cluster selection in `bin/app.ts` throws for an unresolved account before any consumer stack is built, so a prod synth always needs a resolved account.

### 3.3 Network rules

- `NeptuneSg` ingress: `<partner-cidr>` → TCP `8182`, in addition to the existing `LambdaSg` and `<persist-cidr>` rules (`stacks-configuration-and-iam.md` §3). The recovery cluster's `NeptuneRecoverySg` pre-stages the identical rule.
- Return routes: for each `vpc.isolatedSubnets[i]`, a `CfnRoute` on that subnet's route table with `destinationCidrBlock: <partner-cidr>` and `vpcPeeringConnectionId: <pcx-id>`. With `maxAzs: 2` this is two routes. App subnets get no route; only Neptune is reachable.
- `<partner-cidr>` and `<persist-cidr>` MUST NOT overlap; peering rejects overlapping CIDRs and the SG rule would be meaningless.

### 3.4 IAM roles

Accepter role (wave 1 only): `assumedBy: AccountPrincipal(<partner-account>)`, policy `ec2:AcceptVpcPeeringConnection` on `resources: ["*"]`. Do not add an `ec2:AccepterVpc` condition — it was tried and broke acceptance; the role's one-shot lifecycle is the control instead.

DB-auth role (`PartnerNeptuneDbAuthRole`): `assumedBy: ArnPrincipal("arn:aws:iam::<partner-account>:root")` so the partner can delegate to any principal in their account. Resource for all Neptune statements: `arn:<partition>:neptune-db:<region>:<account>:<cluster-resource-id>/*`.

| Statement | Actions | Why |
| --- | --- | --- |
| Read | `neptune-db:connect`, `neptune-db:ReadDataViaQuery` | Baseline Gremlin reads. |
| Write | `neptune-db:WriteDataViaQuery`, `neptune-db:DeleteDataViaQuery` | Persist-style upserts replace single-cardinality properties, which Neptune authorises as a delete; a write grant without `DeleteDataViaQuery` denies every such write. Drop this statement for a read-only partner. |
| FTS | `es:ESHttpGet/Post/Put/Head/Delete` on the FTS domain and `<domain>/*` | Neptune signs outbound `Neptune#fts` calls as the connecting identity, so the partner role needs OpenSearch HTTP permissions to use full-text search (`opensearch-fts-mirror.md` §4.6–§4.7). |

Recovery cluster: `NeptuneStack` exposes `partnerNeptuneDbAuthRole?: iam.IRole`; the app passes it as `NeptuneRecoveryStackProps.partnerNeptuneDbAuthRole`, and the recovery stack attaches an additional `iam.Policy` with the same four `neptune-db:*` actions scoped to the recovery cluster's resource ID. The role therefore authorises both clusters at all times.

Non-prod variant: in the dev account (`isDevAccount`) a separate integration role trusts the partner's non-prod account with `neptune-db:*` plus the FTS actions, and is published as an output and an SSM parameter `/persist/dev/<partner-int>/neptune-db-auth-role-arn` (the `dev` segment is a literal, not derived from `stage`). It has no peering; it exists so the partner can test IAM DB auth before prod.

### 3.5 What is shared with the partner

Outputs added when enabled: `PartnerRequesterAccountId`, `PartnerRequesterVpcCidr`, `PartnerVpcPeeringAccepterRoleArn` (while the accepter exists), `PartnerNeptuneDbAuthRoleArn`, `PartnerVpcPeeringConnectionId` (once committed). Send alongside the existing outputs `VpcId` (export `NeptuneVpcId`), `VpcCidr` (export `NeptuneVpcCidr`), `NeptuneWriterEndpoint`, `NeptuneReaderEndpoint` (or a dedicated reader endpoint), `NeptuneClusterResourceId`, `NeptunePort`, and `NeptuneBulkLoadRoleArn` only if bulk loading is in scope (`stacks-configuration-and-iam.md` §6, `operations-playbook.md` §3). Neptune endpoint hostnames resolve to private IPs from any VPC, so no private hosted zone is needed on the partner side.

## 4. Runtime behaviour

1. **Wave 1 (no peering ID committed)** — deploy creates the SG ingress, accepter role, DB-auth role and outputs. The partner creates the peering request from their VPC to `NeptuneVpcId` in the Persist account, assumes `PartnerVpcPeeringAccepterRoleArn`, accepts it, and adds routes for `<persist-cidr>` via the peering in their own route tables.
2. **Wave 2 (peering ID committed)** — the next normal deploy creates the return routes and, because `createAccepterRole` is now false, deletes the accepter role. From here on redeploys are no-ops for this feature; the state is fully versioned in source so the CI/CD pipeline stays repeatable with no one-off inputs.
3. **Steady state** — the partner assumes `PartnerNeptuneDbAuthRole`, signs Gremlin requests with SigV4 and connects to the endpoint hostname on `8182`. Neptune's own audit log records the calling identity.
4. **Recovery cutover** (`--context neptunePersistenceTarget=recovery|blue`) — Persist's own consumers move; peering, routes and the role are untouched because both clusters share the subnets and the role already carries a policy for each cluster resource ID. The partner only has to switch to the recovery cluster's endpoint hostnames, which Persist sends them from the recovery stack outputs.

## 5. Observability

- Neptune `audit` and `slowquery` CloudWatch log exports (see `operations-dashboards-and-alerting.md` §3.6) show every partner query with its IAM identity; filter on the role name.
- CloudTrail `AssumeRole` events for `PartnerNeptuneDbAuthRole` and the one-shot accepter role are the access audit trail.
- Partner load lands on the shared reader/writer fleet and is covered by the sustained reader-CPU page (`operations-dashboards-and-alerting.md` §3.2). Give a heavy partner a dedicated reader endpoint (`neptune-reader-topology.md` §2) rather than raising thresholds.
- Peering health: `aws ec2 describe-vpc-peering-connections --vpc-peering-connection-ids <pcx-id>` should report `active`; VPC Flow Logs on the isolated subnets are optional but the only way to see rejected packets.

## 6. Operations / runbook

- **Onboard a partner**: agree a non-overlapping `<partner-cidr>`; add the three constants; set `{ enabled: true, peeringConnectionId: "" }`; deploy (wave 1); send outputs; wait for the accepted `<pcx-id>`; commit it; deploy (wave 2); run §7 checks.
- **Change the grant**: edit the policy statements (for example remove the Write statement) and redeploy; IAM changes apply to existing sessions within minutes — no partner action needed.
- **Rotate**: the role has no long-lived secret. Partner-side credential rotation is theirs. To move the partner to a new account, change `PARTNER_REQUESTER_ACCOUNT_ID`, redeploy (new trust policy), and repeat wave 1–2 for the new VPC.
- **Revoke**: set `enabled: false` and deploy — SG ingress, routes, both roles and the recovery-cluster policy are removed together. Then delete the peering connection (either side can); removing routes alone is not revocation because the SG rule and role would remain.
- **Emergency cut**: remove the `<partner-cidr>` ingress rule from `NeptuneSg` and `NeptuneRecoverySg` by hand, then follow with the source change so the next deploy does not restore it.

## 7. Verification & acceptance criteria

CDK template tests (`test/cdk/persist-stack.test.ts`, `test/cdk/neptune-recovery-stack.test.ts`):

- Wave 1: template contains `ec2:AcceptVpcPeeringConnection` and does not contain `ec2:AccepterVpc`; the DB-auth role's write statement includes `neptune-db:DeleteDataViaQuery`; outputs `PartnerVpcPeeringAccepterRoleArn`, `PartnerNeptuneDbAuthRoleArn`, `PartnerRequesterAccountId`, `PartnerRequesterVpcCidr` exist.
- Wave 2: exactly one `AWS::EC2::Route` per isolated subnet (two with `maxAzs: 2`) with `DestinationCidrBlock = <partner-cidr>` and `VpcPeeringConnectionId = <pcx-id>`; output `PartnerVpcPeeringConnectionId` exists.
- `createAccepterRole: false` removes the accepter policy while routes remain.
- Recovery stack: an `AWS::IAM::Policy` attached to the passed role grants `connect`, `ReadDataViaQuery`, `WriteDataViaQuery`, `DeleteDataViaQuery` on the recovery cluster resource.
- Stacks without the prop contain no partner resources. The recovery stack's account guard is covered by `test/cdk/neptune-recovery-stack.test.ts`; the app-level account/region guards in `bin/app.ts` have no template test.

Live acceptance (run by the partner, confirmed by Persist):

1. `nc -zv <writer-endpoint> 8182` from a partner subnet succeeds; the same from a non-peered VPC times out.
2. With assumed-role credentials, a SigV4-signed `g.V().limit(1).count()` returns `200`; unsigned or wrong-role calls return `403`.
3. A property upsert on an existing vertex with `single` cardinality succeeds (proves `DeleteDataViaQuery`).
4. A `Neptune#fts` query returns results (proves the FTS statement).
5. After a rehearsal cutover, steps 2–4 pass against the recovery endpoints.

## 8. Source map

| Concern | Path (persist repo) |
| --- | --- |
| Committed peering state, stage/account/region guards, recovery-stack wiring | `bin/app.ts` |
| Props interface, constants, SG rule, accepter role, return routes, DB-auth role, outputs, dev integration role | `lib/neptune-stack.ts` |
| Recovery SG rule and extra DB-auth policy | `lib/neptune-recovery-stack.ts` |
| Environment account constants and `isDevAccount` | `lib/deployment-environment.ts` |
| Operator walkthrough (wave 1 / wave 2) | `README.md` §"prod VPC peering" |
| Template tests | `test/cdk/persist-stack.test.ts`, `test/cdk/neptune-recovery-stack.test.ts` |
| Related references | `stacks-configuration-and-iam.md` §3 and §6 (VPC, SGs, outputs), `gremlin-sync-query.md` §7 (Gremlin connections), `operations-playbook.md` §3 (deploy) |
