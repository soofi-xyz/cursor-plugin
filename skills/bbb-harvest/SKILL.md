---
name: bbb-harvest
description: "Harvest BBB (Better Business Bureau) business profiles by category for contractor reputation and quality enrichment in the elephant query DB, with throughput checks before long crawls. Use when asked to collect BBB profiles, contractor reputation data, or refresh bbb_* tables."
metadata: {"author":"elephant-xyz"}
---
# BBB Harvest

National data source — county-agnostic. The executable harvester is
`skills/use-oracle/runtime/src/enrichment/bbb.mjs`, exposed by the
`elephant-county bbb-harvest` command and the AWS Batch worker. County market and
category URLs must come from a validated enrichment profile. Output feeds
contractor reputation/quality enrichment and is joined to permits in a later stage.

BBB's `robots.txt` disallows general crawler access to query-string URLs (`/*?`), which
includes category pagination. Treat HTTP 403 as a source-access boundary: stop all
remaining BBB requests, preserve the exact evidence, and request approved access through
the official BBB API at `https://developer.bbb.org/`. Do not change egress, proxies,
browser fingerprints, or challenge behavior to evade the block.

## Run

```bash
cd skills/use-oracle/runtime
node bin/elephant-county.mjs bbb-harvest \
  --county duval \
  --category roofing-contractors \
  --job-id duval-roofing-probe \
  --max-pages 2 --max-profiles 5 --max-requests 100 \
  --max-duration-minutes 30 --output downloads/bbb/duval-roofing-probe
```

Production runs use an approved immutable Batch request whose county and category keys
resolve to the same reviewed enrichment profile.

Important bounds:

- `maxPages` / `maxProfiles` / `maxRequests` / `maxDurationMinutes` — hard crawl bounds
- `profileSubpages` (array) — capture extra tabs per profile
- `pageDelayMs` / `profileDelayMs` — conservative pacing
- `includeHtml` — retain source HTML when access is permitted

AWS Batch writes immutable content-addressed artifacts and a handoff per category.
Checkpoints permit an exact resume after transient infrastructure failure. Permanent
source blocks are not retried.

## Output layout

Under `data/artifacts/enrichment/bbb/<jobId>/` (probes can just use a scratch
subdir there):

- `profiles/profiles-part-NNNN.jsonl` — extracted profile records (chunked)
- `failures/failed-profiles.jsonl` — only classified PERMANENT profile failures are
  recorded here (rather than aborting the crawl); re-run with the failed URLs after a
  reviewed source-access change. TRANSIENT failures (network/5xx) never silently count
  as complete; the Batch job fails and its checkpoint remains available for exact resume
- `manifest/summary.json` — counters for reconciliation

## Workflow

1. Pick the category relevant to the enrichment goal (e.g. construction/contractor
   categories for permit contractor matching).
   - **Multi-Trade Harvesting**: Expand contractor collection across all high-value building trades:
     - Roofing Contractors (`roofing-contractors`)
     - Solar Energy Contractors (`solar-energy-system-contractors`)
     - Heating and Air Conditioning / HVAC (`heating-and-air-conditioning`)
2. Run a small probe (`maxPages: 2`, scratch output subdir). If BBB returns 403, stop
   without further requests and retain the status, URL, timestamp, category, request
   digest, and Batch job ID as source-access evidence.
3. Estimate total crawl time from probe latency, page/profile counts, delays, retries,
   and safe concurrency. If the estimate is more than 48 hours, ask whether to download
   BBB artifacts anyway, ingest them into the query DB, or retrieve BBB profile data at
   runtime from the owning app/service. For runtime retrieval, capture the expected API
   or scrape path, cache/freshness needs, and failure behavior. Stop here if the
   operator chose ingest-only or runtime retrieval — do not proceed to step 4.
4. Run the full category with conservative delays only when the bounded probe is allowed.
5. Reconcile `summary.json` counts vs profiles parts, retry failures.
6. Load into the `bbb_*` tables per the `query-db-loading-matching` skill.

Reconcile a completed profile-category directory set using the profile's category keys:

```bash
node bin/elephant-county.mjs bbb-reconcile \
  --county duval \
  --harvest-root <root-containing-category-key-directories> \
  --input-coverage <dataset-coverage.json> \
  --output-dir <reconciled-dir>
```

For a reviewed 403 outcome, submit browser-free zero-profile artifacts and reconciliation:

```bash
npm run batch:recover-blocked -- \
  --config <request.json> \
  --receipt <prior-submission.json> \
  --evidence <blocked-evidence.json>
```

The evidence must match the exact run, request digest, category, and failed Batch job.
Coverage must remain `source_access_status: blocked`, `source_access_complete: false`,
and `incomplete_reason: http_403_source_block`.

### 3-Tier Multi-Source CRM Cross-Matching Cascade

When matching BBB contractor profiles to municipal permit records or Sunbiz business entities, apply a strict 3-tier cascade:
1. **Tier 1 — State License Number Match**: Match exact state license strings (e.g. `CCC1328456`, `CAC1815924`). Highest confidence (1.0).
2. **Tier 2 — Standardized Phone Number Match**: Normalize 10-digit phone strings (strip punctuation and country code `+1`). High confidence (0.95).
3. **Tier 3 — Cleaned Business Name Match**: Strip corporate suffixes (`LLC`, `INC`, `CORP`, `SERVICES`, `ROOFING`), trim whitespace, and match normalized names with Jaro-Winkler similarity ≥ 0.90. Medium confidence (0.80).

The crawler module has vitest tests in `skills/use-oracle/runtime` — keep them passing if it is
modified. Category lists, run notes, and any
source-specific docs produced for a county or category also get committed and PR'd to
`github.com/elephant-xyz/Counties-trasform-scripts` (`gh pr create`) so they aren't lost.
