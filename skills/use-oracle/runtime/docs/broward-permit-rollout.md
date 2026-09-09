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

## Idempotent plan-only backfill

Create a delta plan without executing ingestion or writing a database:

```bash
npm run permits:backfill-plan --prefix skills/use-oracle/runtime -- \
  --county broward \
  --mode delta \
  --from 2026-09-01 \
  --through 2026-09-09 \
  --properties /approved/path/broward-properties.parquet
```

Create a repair plan for missing, failed, or stale detail fingerprints:

```bash
npm run permits:backfill-plan --prefix skills/use-oracle/runtime -- \
  --county broward \
  --mode repair \
  --manifest /approved/path/permit-artifact-manifest.json
```

Use repeatable `--jurisdiction <key>` arguments to bound either plan. The CLI
refuses `--execute`; broad capture and database writes require a separate
approved operator action and credentials.
