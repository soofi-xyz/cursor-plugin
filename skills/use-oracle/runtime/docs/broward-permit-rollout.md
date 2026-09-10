# Broward permit adapter rollout

This document separates adapter readiness from complete data capture. A source
listed as supported has a registered reusable adapter and a bounded anonymous
route; it does not mean every historical record has been captured.

## Executable coverage

The canonical executable inventory is
`src/counties/broward/permit-profile.mjs`. The readiness gate currently covers:

- 32 permit authorities: 18 supported, 13 blocked, and 1 custodian-only.
- 37 source surfaces: 20 harvestable and 17 explicitly blocked.
- Nine registered Broward adapter families: Accela, ArcGIS Feature/Map Service,
  BCS/POSSE, Citizenserve, Click2Gov, Coconut Creek municipal status,
  SmartGov, Tyler Civic Access, and Tyler eSuite.
- One primary route plus optional supplemental routes per jurisdiction. Fort
  Lauderdale uses Accela for detail and its official ArcGIS layer for
  parcel-linked bulk enumeration. Broward HCED has a separate bulk-only ArcGIS
  route because that layer has no certified BCPA folio field.
- A versioned `detailFingerprintVersion` on every harvestable route.

Print the machine-readable source-to-adapter matrix and readiness counts:

```bash
npm run permits:coverage --prefix skills/use-oracle/runtime -- --county broward
```

## Supported authorities

- BCS/POSSE: Unincorporated Broward County and delegated Lazy Lake.
- Accela: Hollywood, Plantation, Fort Lauderdale, Cooper City, and Weston.
- Tyler Civic Access: Pembroke Pines, Hallandale Beach, Miramar, Oakland Park
  post-2019, and Sunrise.
- Citizenserve: Lauderdale-by-the-Sea, Southwest Ranches, West Park, and Wilton
  Manors. The configured `www2` recovery surfaces are listing-only, so they do
  not claim contractor-detail completeness.
- Tyler eSuite: Davie legacy/public history. The separate 2026 Avolve
  submission route remains login-gated and is not treated as historical
  coverage.
- Municipal status: Coconut Creek, including public permit, contractor,
  inspection, and fee detail sections.

## Explicit blockers and remediation

- CAPTCHA: Coral Springs eTRAKiT, Deerfield Beach Gov-Easy/GeoCivix, and
  Pembroke Park Gov-Easy. Do not bypass; request an authorized export or use
  the municipal records route.
- Login: Hillsboro Beach CommunityCore, North Lauderdale Tyler, and Parkland
  MyGovernmentOnline. Obtain approved credentials/API access or request a
  custodian export.
- Source unavailable: Lauderdale Lakes OpenGov currently exposes an
  inaccessible application landing surface. Confirm a restored anonymous
  search or request an export.
- Identity unproven: Pompano Beach, Margate, and Tamarac Click2Gov are routed
  to the registered adapter but remain blocked until Broward folio segmentation
  and result reconciliation are certified. Hollywood BCLA remains a separate
  address-only predecessor source with no certified Accela cutoff.
- Positive-detail certification: Dania Beach eSuite and Lighthouse Point
  SmartGov route through registered adapters, but remain blocked until a
  positive live record verifies parcel/detail reconciliation.
- Insecure legacy transport: Lauderhill eGovPLUS is HTTP-only and resets HTTPS
  connections. The runtime refuses insecure source transport; request a secure
  export or replacement endpoint.
- Custodian-only predecessor/history: Sea Ranch Lakes has no public historical
  search. Oakland Park records before 2019-11-01 remain on the documented
  legacy/records route.
- API authorization: no current Broward source is classified as anonymous
  API-authorized-only. If a vendor issues credentials, register that route as
  authorization-required rather than embedding credentials or bypassing login.

## Bounded live pilot evidence

The 2026-09-09 pilots emitted summaries to the terminal only. They wrote no
captures and made no database calls.

- Hollywood Accela: the configured folio reported 1 record, extracted 1 unique
  detail, normalized 1 record, and extracted 1 public contractor.
- Broward BCS/POSSE: the configured folio reported and extracted 73 stable
  references; the two-detail ceiling normalized 2 records and 2 contractors.
- Fort Lauderdale official ArcGIS: the layer reported 91,027 records; one
  configured folio returned and normalized 2 records with no truncation.
- Broward HCED ArcGIS: the bulk-only layer reported 7,369 records; the
  two-record ceiling normalized 2 records and 2 permittees, and explicitly
  reported truncation.
- Accela search-form probes passed for Hollywood, Plantation (embedded
  `ACAFrame`), Fort Lauderdale, Cooper City, and Weston.
- Davie eSuite: exact autocomplete selection returned 9 references; the
  one-detail ceiling normalized 1 record and reconciled the requested folio.
- Coconut Creek municipal status: the configured folio returned 1 reference;
  the one-detail ceiling normalized 1 record and 1 public contractor plus
  inspection detail.

Run a bounded, summary-only probe:

```bash
npm run permits:probe-broward --prefix skills/use-oracle/runtime -- \
  --jurisdiction hollywood \
  --source accela-current \
  --parcel 514111160200 \
  --limit 2
```

## Approved delta and repair execution

The backfill command writes local private artifacts only. It has no database,
truncate, publication, or Filebase path, so it cannot mutate the existing
1,276,328 published Broward rows or the 16,084 rows retained from blocked
systems. Loading and publication remain separate reviewed operations.

### Required operator inputs

Keep all input and output paths outside Git:

- A schema-valid Broward property JSONL or Parquet file. Each row needs
  `property_id`, `parcel_identifier`, and city or address routing evidence.
- A source-checkpoint JSON file using
  `elephant.permit-source-checkpoints.v1`. Each successful source entry binds
  `jurisdictionKey`, `sourceKey`, `throughDate`, `profileSha256`,
  `detailFingerprintVersion`, and its prior `executionFingerprint`.
- For repair mode, a JSONL manifest using
  `elephant.permit-repair-candidate.v1`. Each row identifies one property/source
  and records prior status, profile digest, detail fingerprint, and whether
  full detail was completed.
- Independent review and approval of the generated `planDigest`. Do not put
  credentials, database URLs, cookies, private rows, or secret values in plans
  or logs.

For a first bounded run, the reviewed checkpoint file is:

```json
{
  "schemaVersion": "elephant.permit-source-checkpoints.v1",
  "countyKey": "broward",
  "generatedAt": "2026-09-10T00:00:00.000Z",
  "sources": []
}
```

Later runs use the executor-produced `source-checkpoints.json`; do not
hand-advance dates. A repair manifest is JSONL, one strict object per line:

```json
{"schemaVersion":"elephant.permit-repair-candidate.v1","countyKey":"broward","jurisdictionKey":"hollywood","sourceKey":"accela-current","property":{"propertyId":"00000000000000000000000000000001","parcelIdentifier":"514111160001","city":"Hollywood","workAddress":"1 Example Street"},"prior":{"status":"missing","profileSha256":null,"detailFingerprintVersion":null,"detailComplete":false}}
```

The planner reads and validates every input. It stores only byte counts, row
counts, content SHA-256 digests, candidate summaries, and execution
fingerprints—never local paths or property rows. Moving identical input bytes
does not change the plan.

### Delta plan

Every source with a compatible successful checkpoint starts one day before its
last `throughDate`, providing the required overlap. A source without a
compatible checkpoint is labeled `initial-bounded-backfill`; it is never called
a delta and requires both a bounded `--initial-from` date and a separate
execution approval flag.

```bash
npm run permits:backfill --prefix skills/use-oracle/runtime -- plan \
  --county broward \
  --mode delta \
  --through 2026-09-10 \
  --initial-from 2025-01-01 \
  --properties /approved/private/broward-properties.parquet \
  --checkpoints /approved/private/source-checkpoints.json \
  --output /approved/private/plans/broward-delta-plan.json
```

Omit `--initial-from` only when every selected source has a compatible
successful checkpoint. Use repeatable `--jurisdiction <key>` arguments to
create a deliberately narrower plan.

### Repair plan

Repair selection includes missing, failed, transient, stale-profile,
stale-detail-fingerprint, and summary-only candidates when full contractor
detail is required. Matching completed detail is excluded, and explicit access
blockers remain blocked. If an ArcGIS bulk task has any selected repair
candidate, its approved repair executes a full reconciled source enumeration;
the bulk-only HCED source cannot safely repair by parcel.

```bash
npm run permits:backfill --prefix skills/use-oracle/runtime -- plan \
  --county broward \
  --mode repair \
  --manifest /approved/private/broward-repair-candidates.jsonl \
  --output /approved/private/plans/broward-repair-plan.json
```

### Execute an approved plan

Review the immutable plan and copy its exact `planDigest` into the approval
record. Execution re-reads and hashes the supplied inputs, rejects a changed
plan or input, and binds the output directory to that plan.

Delta:

```bash
npm run permits:backfill --prefix skills/use-oracle/runtime -- execute \
  --plan /approved/private/plans/broward-delta-plan.json \
  --approved-plan-sha256 <reviewed-plan-digest> \
  --properties /approved/private/broward-properties.parquet \
  --checkpoints /approved/private/source-checkpoints.json \
  --output /approved/private/runs/broward-delta-2026-09-10 \
  --owner broward-delta-2026-09-10 \
  --concurrency 2 \
  --page-concurrency 2 \
  --lease-seconds 120 \
  --approve-initial-backfill
```

Remove `--approve-initial-backfill` when the plan contains only true delta
tasks. Repair:

```bash
npm run permits:backfill --prefix skills/use-oracle/runtime -- execute \
  --plan /approved/private/plans/broward-repair-plan.json \
  --approved-plan-sha256 <reviewed-plan-digest> \
  --manifest /approved/private/broward-repair-candidates.jsonl \
  --output /approved/private/runs/broward-repair-2026-09-10 \
  --owner broward-repair-2026-09-10 \
  --concurrency 2 \
  --page-concurrency 2 \
  --lease-seconds 120
```

Run only after review, approved source access, and approved US egress are in
place. Do not run either execute command as part of code review.

### Durable completion rules

- All 20 automatable source surfaces are separate source tasks; the 17 explicit
  blockers are recorded in the plan and never instantiated.
- The output directory contains a durable lease with a monotonically
  increasing fencing token, per-work receipts, stable-ID record receipts,
  source checkpoints, and a final summary. A stale or expired writer cannot
  commit after takeover.
- Resume skips only matching completed detail. Failed work is retried,
  matching access blockers are preserved, and stale summary-only work is
  retried when the source requires contractor detail.
- The two ArcGIS routes freeze and hash the complete object-ID inventory,
  partition it into pages of at most 1,000 with concurrency at most two,
  checkpoint each reconciled page, and compare the ending inventory to the
  starting inventory. A cap, missing row, duplicate ID, count mismatch, or
  source drift prevents a successful source checkpoint.

Monitor durable rollups rather than rescanning record files. Read
`<run-dir>/_control/lease.json` for owner, expiry, and fencing token;
`<run-dir>/_checkpoints/<task-id>/progress.json` or `task-summary.json` for
property-first progress; and page checkpoints in the same task directory for
ArcGIS progress. `backfill-summary.json` is terminal only. A failed or blocked
summary is not a completeness claim and must not be handed to a loader.
