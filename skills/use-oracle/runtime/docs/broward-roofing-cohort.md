# Southwest Ranches roofing investigation

Use this procedure to reproduce the private, fail-closed investigation of
folio `504032160260` at 16715 Berkshire Court. It never publishes data. The
offline analysis command makes no network or database calls.

## Fixed scope

- County: Broward County, Florida only.
- Project work window: inclusive `2025-09-10..2026-09-10`.
- Old-roof proof window: inclusive `2016-09-10..2026-09-10`.
- Target property ID: `fe026ab5-6927-4dbb-b27a-c5f219ffa3c6`.
- Exclude the target folio from any derived projects or cohort.
- Expansion keys: exact, verified `CCC` or `RC` credentials only. Never expand
  unless a target-folio permit proves the roofing role and license.
- Countywide verdict: `supported_partial` while any cataloged authority or
  predecessor source is blocked.
- Do not query or substitute evidence from the former Pembroke Pines or
  Sunrise seed parcels in this focused run.

## Freeze the reviewed base

Run from the repository root. The three values must agree before exporting
private evidence.

```bash
git fetch origin feat/broward-all-permit-adapters-pr
BASE_COMMIT="$(gh pr view 161 --json headRefOid -q .headRefOid)"
test "$BASE_COMMIT" = "$(git rev-parse origin/feat/broward-all-permit-adapters-pr)"
CATALOG_SHA256="$(shasum -a 256 skills/use-oracle/runtime/docs/broward-sources.yaml | cut -d' ' -f1)"
PROFILE_SHA256="$(shasum -a 256 skills/use-oracle/runtime/src/counties/broward/permit-profile.mjs | cut -d' ' -f1)"
python3 skills/use-oracle/scripts/validate-county-readiness.py \
  skills/use-oracle/runtime/docs/broward-sources.yaml
```

The reviewed 2026-09-10 baseline was commit
`3527d71668ac79d9d7200f6f7c41b33419e7364c`, catalog digest
`de9e98782475afcf6fb46d451f3bab1b0ed6fb379551cd8d88c052bf563058d8`,
and profile digest
`3c084e8b41aa79d22dc2f5972ea48afccbdeb403f83a8825d96e3e2303f77f03`.
Reject changed values until the new inputs receive review.

## Prepare focused identity evidence

Keep every evidence file under an ignored `downloads/` directory. Start with
an empty identity file because the Citizenserve fallback exposes no contractor
and none of the 16 scopes is roofing:

```bash
PRIVATE="skills/use-oracle/runtime/downloads/investigations/broward-roofing-cohort"
mkdir -p "$PRIVATE"
: > "$PRIVATE/empty-identity-evidence.jsonl"
```

Only after source evidence identifies a roofing license, verify that exact
license through official DBPR and the associated company through Sunbiz. Keep
permit contact, license holder, qualifier, qualifying business, and company ID
as separate time-sliced identities.

## Export the private query slice

Run this in the same terminal where the real `DATABASE_URL` is set. The command
starts a PostgreSQL `READ ONLY` transaction, searches exact licenses before
names, exports every permit on the three seed folios, and omits owner,
applicant, contractor phone, and contractor email fields.

```bash
PRIVATE="skills/use-oracle/runtime/downloads/investigations/broward-roofing-cohort"
npm run roofing:export --prefix skills/use-oracle/runtime -- \
  --database-url-env DATABASE_URL \
  --identity-evidence "$PRIVATE/empty-identity-evidence.jsonl" \
  --output "$PRIVATE/southwest-ranches-private-query-evidence.jsonl" \
  --catalog-sha256 "$CATALOG_SHA256" \
  --profile-sha256 "$PROFILE_SHA256" \
  --repository-commit "$BASE_COMMIT" \
  --as-of 2026-09-10 \
  --folio 504032160260
```

An unset URL or refused connection is a blocker, not zero rows. Do not copy a
URL from another process or terminal. The export reports linked and unlinked
counts but makes no matcher or loader updates.

## Run the offline analysis

The output directory must not already exist. Input, catalog, profile, and
repository digests are checked before analysis.

```bash
REPORT="$PRIVATE/southwest-ranches-focused-report-2026-09-10"
npm run roofing:analyze --prefix skills/use-oracle/runtime -- \
  --input "$PRIVATE/southwest-ranches-focused-evidence.jsonl" \
  --gap-ledger "$PRIVATE/southwest-ranches-gap-ledger.jsonl" \
  --output "$REPORT" \
  --expected-catalog-sha256 "$CATALOG_SHA256" \
  --expected-profile-sha256 "$PROFILE_SHA256" \
  --expected-repository-commit "$BASE_COMMIT"
```

The command writes private JSON/JSONL for seed evidence, verified identities,
trailing-year projects, current open permits, the defensible 5+5 cohort,
repair candidates, source reconciliation, and the completed gap ledger. An
application/open date alone is never work evidence. Invalid or future dates,
unknown lifecycle statuses, conflicting source duplicates, incomplete
predecessor coverage, and ambiguous identity time slices fail to review.

## Run only content-bound repairs

Review `repair-candidates.jsonl`, then create a content-bound repair plan. The
planner excludes cataloged access blockers.

```bash
npm run permits:backfill --prefix skills/use-oracle/runtime -- plan \
  --county broward \
  --mode repair \
  --jurisdiction southwest-ranches \
  --manifest "$REPORT/repair-candidates.jsonl" \
  --output "$PRIVATE/southwest-ranches-repair-plan.json"
```

After an independent reviewer approves the printed plan digest, execute with
concurrency one or two:

```bash
npm run permits:backfill --prefix skills/use-oracle/runtime -- execute \
  --plan "$PRIVATE/southwest-ranches-repair-plan.json" \
  --approved-plan-sha256 '<reviewed-plan-digest>' \
  --manifest "$REPORT/repair-candidates.jsonl" \
  --output "$PRIVATE/southwest-ranches-repair-run-2026-09-10" \
  --owner southwest-ranches-roofing-2026-09-10 \
  --concurrency 1 \
  --page-concurrency 1 \
  --lease-seconds 900
```

Do not broaden a blocked property-first source into an all-property scrape.
Do not send a request automatically. If a reviewer approves outreach, send the
Town of Southwest Ranches Building Department a records-first request through
the official Broward building-contact route:
`https://www.broward.org/CodeAppeals/Pages/BuildingContacts.aspx`.

Request a native Town/CAP export for all 16 permits on folio `504032160260`,
including permit number, exact type/work class/scope, status/lifecycle and
inspection dates, contractor role/company/license, predecessor history, field
definitions, and source-system record IDs. Prefer CSV or XLSX.

## Evidence limits

The public Elephant permit table is candidate evidence only. Its 2026-09-10
snapshot had 1,276,328 Broward permits, source-dependent null dates, and
future-invalid source dates.

Citizenserve www2 reports and returns 16 unique, linked listings for the target,
but exposes zero contractor rows. All 16 scopes are non-roofing. Without a
source-backed roofing license, contractor expansion and the 5+5 cohort must
remain empty. A missing Town/CAP or private-DB export remains `null`, never
zero. No catalog, IPNS, Filebase, publication, owner-data,
property-consolidation, or NEO change belongs to this investigation.
