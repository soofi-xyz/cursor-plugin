---
name: sunbiz-corporate-ingest
description: "Ingest Florida Sunbiz corporate registration bulk data scoped to a county - bulk download, ZIP-prefix extraction, and lexicon transform as one durable batch job. Use when onboarding a Florida county's business-registration data, refreshing quarterly Sunbiz data, or matching corporate entities to county addresses."
metadata: {"author":"elephant-xyz"}
---
# Sunbiz Corporate Ingest

Sunbiz is STATEWIDE Florida data — the pipeline is fully reusable across FL counties.
County ZIP scope comes from the validated enrichment profile under
`skills/use-oracle/runtime/src/counties/`; do not pass an ad hoc production ZIP list.

## 1. Acquire the bulk file

- Source: Sunbiz Data Access Portal, quarterly corporate file `doc > quarterly > cor >
  cordata.zip` (~1.7 GB; expands to ~18 GB — check free disk first).
- The host is Cloudflare-challenged: plain `curl` fails; use a real browser (headless
  Chromium works, manual browser is fine).
- **Deflate64 pitfall**: `cordata.zip` uses ZIP method 9, which streaming unzip libraries
  (yauzl etc.) cannot read. Expand with system `unzip`:

```bash
unzip cordata.zip -d cordata-expanded/
```

Daily incremental files (`YYYYMMDDc.txt`) are plain text and work directly.

## 2. Run the executable ingest

The implementation lives in `skills/use-oracle/runtime/src/enrichment/` and is exposed
through `elephant-county`. It validates the archive entry list and SHA-256, expands with
system `unzip`, streams every fixed-width record once, writes checksummed JSONL chunks,
transforms them to lexicon records, and enriches the county query table.

```bash
cd skills/use-oracle/runtime
node bin/elephant-county.mjs sunbiz-prepare \
  --archive <cordata.zip> --sha256 <digest> --output <expanded-dir>
node bin/elephant-county.mjs sunbiz-filter \
  --county duval --quarter 2026Q3 --source-dir <expanded-dir> \
  --output <extract-dir>
node bin/elephant-county.mjs sunbiz-transform \
  --input <extract-dir> --output <lexicon-dir>
node bin/elephant-county.mjs sunbiz-enrich \
  --county duval \
  --input-parquet <query-table.parquet> \
  --input-coverage <dataset-coverage.json> \
  --sunbiz-extract <extract-dir> --output-dir <enriched-dir>
```

Production runs use an approved immutable AWS Batch request, content-addressed S3
inputs, checkpointed handoffs, least-privilege job roles, and the mandatory cost gate.
The request county must resolve to the same reviewed enrichment profile used by the
local commands.

Scale reference (Lee): 12.6M records scanned, ~379k matched, ~80 chunks.

## 3. Transform to lexicon

The transform step maps matched records to `business-registration-v1`: emits
`business_registration`, `business_registration_address` (role bridge),
`business_registration_party`, companies, de-duplicated addresses, and relationship
records — a single `classes/` + `relationships/` tree plus `summary.json` with counters.
Complete when `invalidRecordCount == 0` and `transformedRecordCount == sourceRecordCount`.

Load with the enrichment prefix per `query-db-loading-matching`:
`--sunbiz-prefix enrichment/sunbiz/<quarter>/<county>/business-registration-v1/classes/`.

## 4. Address matching (optional, later)

A follow-on step matches a supplied address batch (e.g. permit work locations) against
the corporate addresses — useful once enough permits have accumulated for the county.

## Known gaps (do not silently fix)

- `corevent.zip` (filing-history events) is not ingested — separate scope.
- `party_type_code` decoding is incomplete; officers are not normalized to person/company.
- Unmapped fields are intentionally preserved in the output for future lexicon expansion.

## Persist your work

Workflow code lives in `skills/use-oracle/runtime`. Any runbook notes, ZIP-prefix lists, or
mapping findings produced for a county get committed and PR'd to
`github.com/elephant-xyz/Counties-trasform-scripts` under `<county>/docs/`
(`gh pr create`) so they survive outside this machine.
