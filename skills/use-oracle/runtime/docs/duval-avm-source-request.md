# Duval licensed AVM source request

The Duval property table reserves `avm_value`, but appraisal
`market_value` is not an AVM and must never be copied into that field.

## Access request

> Which licensed AVM provider should Oracle use for Duval, and can Data
> Partnerships provide a folio-keyed bulk extract plus written permission to
> publish the AVM value in the public Filebase/IPFS query table?

The provider agreement must explicitly allow durable storage and public
redistribution or publication of the selected AVM value. A short-lived API
license or an API response with a caching limit is not sufficient.

## Required delivery contract

Provide newline-delimited JSON with:

- `parcel_identifier` — Duval folio/RE number
- `vendor_apn` — provider-returned APN; must normalize to the same Duval folio
- `county_fips` — must be `12031`
- `current_avm_value` — positive numeric estimate
- `valuation_date` — `YYYY-MM-DD`
- `valuation_method_type` — provider model/method identifier
- `vendor_property_id` — stable provider property identifier
- `confidence_score` — required number from 0 through 100
- `valuation_low` and `valuation_high` — required positive bounds

Provide a separate source manifest:

```json
{
  "schemaVersion": "elephant.avm-source-manifest.v1",
  "county": "duval",
  "countyFips": "12031",
  "sourceProfileId": "<code-reviewed source profile>",
  "provider": "<licensed provider>",
  "extractId": "<immutable delivery id>",
  "sourceRetrievedAt": "<ISO timestamp>",
  "licenseReviewReference": "<approved contract/review reference>",
  "publicationPermitted": true,
  "recordCount": 0,
  "recordsSha256": "<sha256 of exact JSONL bytes>"
}
```

## Publication gates

- Exact folio matching only; no address-only AVM attachment.
- The manifest must match a source profile approved in code; delivery
  self-assertions are not sufficient.
- Select the newest approved valuation per folio.
- Reject ambiguous same-date values, conflicting provider property IDs,
  appraiser/tax-roll methods, and future valuation dates.
- Reconcile source records, source folios, linked properties, and valid
  unlinked folios.
- Preserve appraisal `market_value` independently.
- Do not repoint Duval IPNS until the source bytes and publication rights are
  reviewed.
