# Duval MCP gap close

Use this procedure only for Duval (`12031`) after appraisal, permits, and
Sunbiz are already published. It must not recapture appraisal or permits, run
BBB, or update permit/coverage IPNS names.

## Fixed inputs and destinations

Read `runtime/docs/duval-mcp-gap-closure.yaml` before every run. Verify its
three protected IPNS tuples against both the Filebase Names API and public
gateway headers. Stop on drift.

Use only:

- `oracle-open-data-duval` in `elephant-oracle-open-data-duval` for the
  sharded consolidated-property index.
- `oracle-open-data-duval-places` in
  `elephant-oracle-open-data-duval-places` for contact-free places Parquet.
- One final update of `oracle-query-table-duval` after every property CID is
  available.

Never create a new label with an old network key. Never update
`oracle-permit-table-duval` or `oracle-dataset-coverage-duval`.

The frozen input query must be the corrected permit-mediated BBB artifact:
CID `QmTfaoKg7yUfHKLcsor1yc7cTZnBcW3CdkjG8je7JQwfSS`, SHA-256
`3f43ef083328d193ba55bee7ec4279f6a6ba371d8b6279ac6af01864419aa56a`.
The output must preserve 171,134 BBB properties, 336,451 permit properties,
42,184 Sunbiz properties, and zero BBB flags without permits.

## Preflight

```bash
python3 skills/use-oracle/scripts/validate-county-readiness.py \
  skills/use-oracle/runtime/docs/duval-sources.yaml
```

Set an operator-selected profile and region, then verify account identity.
Do not put a developer profile in committed files.

```bash
export AWS_PROFILE=<selected-profile>
export AWS_REGION=us-east-1
aws sts get-caller-identity
```

The account must match `runtime/docs/duval-mcp-gap-closure.yaml`.

## Prepare owner-occupied

The command downloads the pinned Florida DOR 2026 Preliminary NAL and retains
only folio plus `AV_HMSTD`. It does not ingest appraisal.

```bash
node skills/use-oracle/runtime/bin/elephant-county.mjs \
  gap-owner-occupied \
  --county duval \
  --cache <run>/cache \
  --frozen-at <run-iso-timestamp> \
  --source-sha256 4ae67aa7550d9d9051c44f01a52ab335897af4959e9625e9ae1e007d77521691 \
  --output <run>/owner-occupied
```

`AV_HMSTD > 0` is true, explicit zero is false, and blank, unparseable, or
unmatched is null.

## Build locally

Use the immutable complete Sunbiz extract and its
`sunbiz-property-links.jsonl`. Do not call `enrichment-finalize`; that path can
consume BBB artifacts.

```bash
AWS_PROFILE=<selected-profile> AWS_REGION=us-east-1 \
node skills/use-oracle/runtime/bin/elephant-county.mjs \
  gap-sunbiz-handoff \
  --bucket <artifact-bucket> \
  --handoff-key runs/duval-task8-2026q3-ddaa7c4d-r2/handoffs/sunbiz.json \
  --output <run>/sunbiz

node skills/use-oracle/runtime/bin/elephant-county.mjs \
  gap-consolidate \
  --county duval \
  --input-parquet <frozen-query-table.parquet> \
  --permit-parquet <frozen-permit-table.parquet> \
  --sunbiz-extract <run>/sunbiz/extract \
  --sunbiz-links <run>/sunbiz/enriched/sunbiz-property-links.jsonl \
  --owner-occupied <run>/owner-occupied/owner-occupied-nal.jsonl \
  --frozen-at <run-iso-timestamp> \
  --output <run>/property

node skills/use-oracle/runtime/bin/elephant-county.mjs \
  gap-query-table \
  --county duval \
  --input-parquet <frozen-query-table.parquet> \
  --cid-manifest <run>/property/manifest.json \
  --owner-occupied <run>/owner-occupied/owner-occupied-nal.jsonl \
  --frozen-at <run-iso-timestamp> \
  --output-parquet <run>/query-table.parquet \
  --output-manifest <run>/query-table-manifest.json

node skills/use-oracle/runtime/bin/elephant-county.mjs \
  gap-places \
  --county duval \
  --release 2026-08-19.0 \
  --boundary-source tiger/tl_2024_us_county \
  --cache <run>/cache \
  --frozen-at <run-iso-timestamp> \
  --output <run>/places
```

Do not pass `--hoa` or `--avm` until an approved reusable source satisfies the
contracts in `runtime/docs/duval-mcp-gap-closure.yaml`. Missing sources emit
durable blockers and leave both columns null.

## AWS batch

`gap-batch` accepts a separate strict request contract. It rejects every BBB
harvest or linkage stage while requiring the existing BBB flags to survive the
query-table rewrite. Point `inputs.sunbizHandoff` at the existing complete Sunbiz
handoff; the worker downloads its checksum-addressed extract chunks and links
without rerunning Sunbiz.

```bash
npm run gap:plan --prefix skills/use-oracle/runtime -- \
  --request <gap-request.json>

npm run gap:submit --prefix skills/use-oracle/runtime -- \
  --request <gap-request.json> \
  --stack <deployed-stack-name>
```

The request and deployed stack both enforce a conservative cost ceiling. The
plan includes the worst-case two-attempt Fargate estimate; obtain operator
approval for the ceiling before submission. Filebase subscription and storage
charges are reported separately because they are not AWS compute cost.

Deploy the CDK stack before submitting a new request. Supply
`filebaseSecretArn` only when the secret JSON contains
`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and `FILEBASE_API_TOKEN`. The
secret is injected at process start and is never placed in the request.
Deploy `DuvalMcpGapBatchStack` with the existing artifact bucket and job queue
passed as CDK context. This isolated stack adds only the gap job definition and
does not replace or revise the deployed Sunbiz, permit, reconciliation, or BBB
job definitions.

## Approval and publish

Generate a no-write plan first:

```bash
node skills/use-oracle/runtime/bin/elephant-county.mjs \
  gap-publish \
  --county duval \
  --property-output <run>/property \
  --places-output <run>/places \
  --query-table <run>/query-table.parquet \
  --receipt <run>/publication-receipt.json \
  --dry-run
```

A human must approve the exact property index, property manifest, places
Parquet/index/notice, and final query-table byte hashes using
`elephant.duval-mcp-gap-publish-approval.v1`. Only then rerun with
`--approve <approval.json>`. The approval also binds the destination names,
upload bounds, new-label creation, owner-occupied rule, contact-free Places
policy, and the exact Sunbiz public-field allowlist. Publication checkpoints
are versioned in the private AWS artifact bucket and resume across Batch
attempts. New dedicated
labels may be created once; any later attempt to repoint them fails closed.
The places label targets the generated bucket-directory CID so the catalog URL
can resolve `<ipns>/duval/places-table.parquet` with sibling `index.json` and
root `NOTICE.txt`.
The existing query label may move from its frozen CID to the approved final
CID once. Protected permit and coverage identities are rechecked before and
after publication.

## Completion smoke

After catalog/MCP deployment:

- Property rows and non-null CIDs are both `403885`.
- Appraisal remains `403885`; permits remain `3415527`.
- Sunbiz-linked properties remain `42184`, unless a reviewed correction
  manifest explains a change.
- BBB-linked properties remain `171134`, all with `has_permits=true`.
- Owner-occupied has the documented true/false/null split.
- HOA and AVM either have approved-source values or remain zero with durable
  blocker links.
- `getOracleProperty` returns nested Sunbiz for a linked property and no new
  BBB payload. Public Sunbiz excludes principal/mailing/agent/officer
  addresses, officer and agent identities, FEI, contacts, and raw payloads.
- `queryPlaces` works and the Parquet schema contains neither `emails` nor
  `phones`.
- The protected permit and coverage IPNS CIDs are unchanged.
