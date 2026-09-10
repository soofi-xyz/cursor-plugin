---
name: county-query-table-publish
description: "Build, validate, publish, and MCP-wire a county's columnar \"query table\" — a one-row-per-property Parquet exported from the query DB, published to public IPFS behind its OWN IPNS pointer, and read by the elephant MCP's embedded DuckDB so the donphan agent can answer arbitrary SQL questions (counts, filters, aggregates by ZIP/owner/material). Use after a county is loaded + reconciled in the query DB to make it queryable through the MCP. Reference implementation: Lee County, FL."
metadata: {"author":"elephant-xyz"}
---
# County Query-Table Publish (DuckDB-on-IPFS)

Turns a county that is already loaded in the query DB into a **SQL-queryable open
dataset**. Exports a flat, scalar-only **Parquet "query table"** (one row per property,
including `elephant_uuid` / `elephant_token`), publishes it to **public IPFS via Filebase** behind the county's **own IPNS
pointer**, and wires it into the `elephant` MCP so its embedded DuckDB range-reads the
Parquet straight off an IPFS gateway. The **donphan** agent then answers arbitrary
questions ("how many concrete homes in 33410", counts / filters / aggregates) as plain
SQL over the `properties` view.

Runs **after** the county is loaded + reconciled (`query-db-loading-matching`) and after
the property-consolidation export (`county-open-data-publish`, which produces the
manifest carrying each property's CID).

> **Lee County, FL** is the reference run (~511,695 folios). Everything is county-generic
> — every command takes `--county <county>`; Lee/Palm Beach appear only as examples.

## ⚠️ PII / human-in-the-loop — the durable approve gate

The query table is per-property PII (owner names, addresses). Publishing runs through the
county's **`Publish` virtual object**, which stays a **dry-run** (export + validate, no
S3 PUT, no IPNS write) until a human calls:

```bash
curl localhost:8080/restate/call/Publish/<county>/approve --json '{}'
```

Durable state on the object — set once, survives restarts. The agent prepares, validates,
and may run `--dry-run`; **only a human approves**.

## Pipeline overview

```
query DB  (county loaded + reconciled; consolidation manifest exists)
  │  npm run export:query-table   -- --county <c> --manifest <consolidation manifest.json>
  ▼
data/artifacts/publish/<c>/query-table.parquet  (one flat row per folio, including elephant_uuid / elephant_token)
  │  npm run validate:query-table -- --county <c> --parquet <path>        ← GATE
  ▼
validated parquet  (rows == distinct folio in the DB, 0 dup/null folios)
  │  npm run publish:query-table  -- --county <c> --env-file <publish-env> ← gated
  ▼
Filebase bucket + IPNS label  oracle-query-table-<c>  (network_key = k51…)
  │  prints  PROPERTY_QUERY_TABLE_MAP={"<c>":"https://ipfs.filebase.io/ipns/<key>"}
  ▼
elephant MCP  (env PROPERTY_QUERY_TABLE_MAP)  → DuckDB view `properties`  → donphan SQL
```

All commands run in the **`elephant-query-db`** checkout, county-generic via
`appraisalSourceForCounty(--county)` → `source_system='<county>_appraiser'`.

### Fast Alternative: Direct In-Process Parquet Export Pipeline

When publishing speed to IPFS/Filebase is prioritized, bypass relational database bulk loading entirely using the **Direct In-Process Parquet Consolidation** script (`export-<county>-direct-parquet.ts`):
1. Loads parcel seeds and scans transformed appraisal artifacts (`transformed_output.zip` or JSON).
2. Builds in-memory lookup maps for:
   - Deep-enriched municipal/county permits.
   - Sunbiz corporate entity registrations (by address hash & business name).
   - Multi-trade BBB contractor quality scores (by license, phone, & name).
3. Directly writes the flat Parquet file (`data/artifacts/publish/<county>/query-table.parquet`) in **~15 minutes** (compared to 10+ hours for relational bulk staging and SQL joins).

### DuckDB HTTPFS IPNS Range Read Resilience

When querying mutable IPNS Parquet URLs over HTTPFS via DuckDB or the MCP, gateways can return changing ETags or Range 416 responses when IPNS pointers update.

**Always configure DuckDB connection settings**:
```sql
INSTALL httpfs;
LOAD httpfs;
SET unsafe_disable_etag_checks = true;
SET s3_use_ssl = true;
```
This disables strict ETag caching in DuckDB's HTTPFS range reader, ensuring stable querying across IPNS pointer mutations without unexpected HTTP 412/416 stream aborts.

> The RTK proxy is an internal HTTP-proxy wrapper some operators route commands through;
> if you don't use it, ignore this. If commands go through it, invoke as
> `rtk proxy npm run export:query-table -- --county …` so the `--` passthrough flags
> reach the script unmangled.

## County slug — use ONE lowercase-hyphen slug end-to-end (the #1 new-county breaker)

Choose the slug ONCE as **lowercase, hyphen-separated** (`lee`, `palm-beach`) and use that
**exact string** in every command, as the `PROPERTY_QUERY_TABLE_MAP` key, AND as the
`county` donphan passes. Do **not** mix in the underscore form. Two *different*
normalizers sit on the two ends, and only the hyphen slug satisfies both:

- **Export/validate/publish side** — `appraisalSourceForCounty` collapses every run of
  non-alphanumerics to `_` and appends `_appraiser`, so BOTH `palm-beach` and
  `palm_beach` yield `source_system='palm_beach_appraiser'`. The DB query works either
  way — which is exactly the trap.
- **MCP side** — `normalizeCountyKey` only lowercases and collapses **whitespace** to
  hyphens; it does **NOT** convert `_`→`-`. Map keys `palm_beach` and `palm-beach` are
  two DIFFERENT counties to the MCP. donphan naturally sends `"Palm Beach"` →
  `palm-beach`, so a map published under `palm_beach` resolves to **"county not served"**.

This trap survives every infra change — it lives in the two normalizers, not the runner.
Since export writes `data/artifacts/publish/<slug>/query-table.parquet` and
validate/publish default `--parquet` from `--county`, one identical slug string keeps all
three stages pointed at one file.

## Prerequisites (all must hold before Stage 1)

1. **County loaded + reconciled.** Rows exist under `source_system='<county>_appraiser'`
   and the distinct-folio count reconciles against the source roll — see
   `query-db-loading-matching` (validate BY FOLIO `request_identifier`, never the
   normalized parcel id).
2. **Consolidation export + manifest exist** (`county-open-data-publish`). The query
   table left-joins that `manifest.json` (`propertyId → cid`) to populate `property_cid`;
   without it every `property_cid` is NULL (export still "succeeds").
3. **Own Filebase bucket + IPNS label** (`oracle-query-table-<county>`) — never reuse
   another county's.
4. **`DATABASE_URL`** points at the same query DB the load and consolidation export used
   (the local Postgres from `skills/use-oracle/runtime/.env` by default).

## Stage 1 — Export (query DB → Parquet)

```bash
npm run export:query-table -- \
  --county <county> \
  --out-dir "$DATA_DIR/artifacts/publish" \
  --manifest <path/to/consolidation manifest.json>
```

(`DATA_DIR` is the `skills/use-oracle/runtime` data dir, so staging lands at
`data/artifacts/publish/<county>/query-table.parquet`.)

One flat row per **folio** (`request_identifier`), scalar columns including
`elephant_uuid` / `elephant_token`, DuckDB-readable.
A single SQL pass pre-dedups every many-to-one relation, then folds via
`DISTINCT ON (folio)` — it never reads the heavy consolidated JSON. The run logs
`query_table_export_finished` with `rowCount` and `rowsWithCid`; **`rowsWithCid` = 0
means you forgot `--manifest`** (or pointed at the wrong one) — fix before publishing.

### Baked-in gotchas (HARD-WON — do not re-hit)

- **Situs vs mailing address.** The property-location (situs) address comes from the
  free-text `unnormalized_addresses.full_address` (joined on `request_identifier`),
  parsed apart — NOT the structured `addresses.street_*/city/postal` columns, which are
  the **owner-mailing** address (a Palm Beach owner's mailing ZIP can be a New York ZIP).
  The export resolves situs first, structured columns only as fallback.
- **Folio dedup by `request_identifier`, never `parcel_identifier`.** Deduping on the
  normalized parcel id collapses distinct properties (multiple folios can share one
  normalized id). One row per folio is the contract the validator enforces.
- **Acreage from sqft.** `lot_size_acre` preferred, derived from `lot_area_sqft / 43,560`
  when absent — for `palm_beach_appraiser`, `lot_size_acre` is ~0% populated while
  `lot_area_sqft` is ~92%. "acres > 2" would return nothing reading only the direct
  column.
- **`property_cid` lives in the consolidation manifest, not the DB** — computed at
  consolidation-export time; hence `--manifest` and the ordering after
  `county-open-data-publish`.
- **`elephant_uuid` / `elephant_token` are `address:v1` ids**, minted at export from
  country `us`, Oracle `state_code`, ZIP5, situs street, and unit. Do not expand ROAD→RD.
  They are not `normalized_address_hash`. The kit runtime helper is
  `skills/use-oracle/runtime/src/core/address-signature.mjs`.

### ⚠️ `--manifest` is optional — and the local CID-join fallback

Without `--manifest` the export succeeds with every `property_cid` NULL. If a concurrent
bulk load is saturating the DB, the manifest re-export can hang on the `SELECT` — skip
the DB entirely and join on disk:

- **pyarrow**: read the already-exported parquet, build `propertyId → cid` from the
  manifest's `entries[]`, join onto `property_id`, write back with `property_cid` filled.
  (System python is PEP-668 externally-managed — use a venv.)
- **Assert the CID fill BEFORE publishing:** non-null `property_cid` == row count
  (Orange: filled 489,557 / missing 0). `--parquet-only` does **not** check CIDs, so a
  wrong manifest or `property_id` mismatch leaves every CID NULL while row + folio checks
  still pass. Also open one row's `property_cid` on IPFS and confirm it returns the
  matching property.
- Then `validate:query-table … --parquet-only` — safe **only here** because the folio
  reconcile was already proven pre-join and the DB is the contended resource. **RECORD the
  pre-join reconciliation** (the DB distinct-folio count, the parquet row count, and when
  you ran it) — that record + the CID-fill assert + the row-level IPFS spot check above
  are the "evidence path 2" that Stage 2 accepts in place of a fresh DB reconcile.

## Stage 2 — Validate (THE GATE)

Prove the folio-cardinality contract before anyone publishes PII. Fails loud (`exit 1`)
on any mismatch or duplicate/null folio:

```bash
npm run validate:query-table -- \
  --county <county> \
  --parquet "$DATA_DIR/artifacts/publish/<county>/query-table.parquet"
```

1. **Parquet-internal:** `rowCount == distinct request_identifier`, 0 null/empty folios —
   no DB needed.
2. **Reconcile vs the DB (the real gate):** parquet `rowCount ==` distinct
   `request_identifier` in the DB, computed with the same COALESCE key the export dedups
   on. Skippable with `--parquet-only` (logs `neon_reconciliation_skipped` — the literal
   legacy log string the `elephant-query-db` script emits, regardless of DB). The export
   is publishable on **either evidence path**: **(1)** this fresh DB reconciliation
   passes, or **(2)** a RECORDED pre-join DB reconciliation (the CID-join fallback above)
   + the CID-fill assert + the row-level IPFS spot check all hold. What is forbidden is
   publishing a parquet that was **never reconciled against the DB at all** — a bare
   `--parquet-only` with no path-2 record is exactly that. Against the local DB the count
   is instant — default to path 1.

Pass = `query_table_validation_passed`. **Any failure ⇒ STOP.** A mismatch means dropped
or duplicated folios — publishing would ship a corrupt index.

## Stage 3 — Publish (gated: PII → public IPFS)

The `Publish` object's tick runs this once the county is approved; the agent may
`--dry-run` any time (no S3 PUT, no IPNS write) to confirm bucket, key, label, local CID:

```bash
npm run publish:query-table -- --county <county> --env-file <publish-env> --dry-run
# real publish runs only after  curl localhost:8080/restate/call/Publish/<county>/approve --json '{}'
npm run publish:query-table -- --county <county> --env-file <publish-env>
```

The real (non-dry-run) command is a **break-glass manual path** — normal publishes run
exclusively through the `Publish` object's `tick` after the durable approval; use the
manual command only when the services process is down, and only after independently
confirming the county's approval state in the Restate UI.

Uploads the **single** parquet to `query-tables/<county>/query-table.parquet` in the
Filebase bucket, upserts the IPNS label `oracle-query-table-<county>`, re-points it at
the new CID, and prints the object CID, the resolvable **`network_key`** (`k51…`), the
gateway URLs, and the ready-to-paste `PROPERTY_QUERY_TABLE_MAP` line.

This Filebase S3 client (`@aws-sdk/client-s3` pointed at `https://s3.filebase.io`) is the
pipeline's **only remaining S3-protocol dependency** — it talks to Filebase's upload API
for IPFS pinning (an external publishing service), not to storage we run.

Required env in `<publish-env>` (Filebase creds from `skills/use-oracle/runtime/.env` or a local
secrets file): `S3_ENDPOINT=https://s3.filebase.io`, `S3_BUCKET` (the county's **own**
bucket), `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`, `FILEBASE_API_TOKEN` (derived, not
separate: `base64(S3_ACCESS_KEY_ID:S3_SECRET_ACCESS_KEY)` — the same derivation
`county-open-data-publish` documents; a script-specific interface difference — the
consolidation uploader derives the same bearer internally, while this script takes it
via env), optional
`FILEBASE_QUERY_TABLE_IPNS_LABEL` override (defaults to `oracle-query-table-<county>`).

**Per-county env convention (what the `Publish` object reads).** Because one services
process publishes multiple counties and two datasets, the bucket is configured per county
per dataset: **`FILEBASE_QUERY_TABLE_BUCKET_<COUNTY>`** (this skill's dataset;
`county-open-data-publish` uses `FILEBASE_OPEN_DATA_BUCKET_<COUNTY>`), with shared
`FILEBASE_ACCESS_KEY` / `FILEBASE_SECRET_KEY` (or `..._<COUNTY>` variants when a county's
credentials differ). `<COUNTY>` is the envPart normalization — slug uppercased, every
non-alphanumeric run → `_` (`palm-beach` → `PALM_BEACH`). The `Publish` object resolves
these from its own key (`ctx.key` = the county slug) per dataset and **rejects
missing/mismatched config with a `TerminalError`** — never falls back to a generic
`S3_BUCKET`. IPNS labels stay derived (`oracle-query-table-<county>`), not configured.
The generic `S3_*` names above are what the underlying script consumes; the object (or
your `<publish-env>` file) maps the per-county vars onto them.

### Baked-in gotchas

- **Per-county bucket + label — never reuse.** The upload writes a fixed key; reuse
  clobbers the other county's data or pointer.
- **The publisher HARD-REFUSES the property and geo labels** — it throws on
  `oracle-open-data-<county>` and `oracle-geo-index-<county>`; re-pointing either would
  wipe that dataset. The query table keeps its own `oracle-query-table-<county>`
  namespace.
- **Filebase gateway for DuckDB `httpfs` range reads.** Prefer
  `https://ipfs.filebase.io/ipns/<key>` in the MCP map; `dweb.link` Range support is
  flaky.
- **IPNS is addressed by LABEL** via `https://api.filebase.io/v1/names`; the resolvable
  name is the `network_key` field. Create-or-update is automatic.

## Stage 4 — Wire the MCP + donphan

The `elephant` MCP resolves county → Parquet from **`PROPERTY_QUERY_TABLE_MAP`** (JSON
`{"<county>":"<gateway url>", …}`). The key MUST be the exact lowercase-hyphen slug (see
above). To add a county, **MERGE** its entry into the existing map — never overwrite
(the "dropped Palm Beach" trap: overwriting silently un-serves every other county) — in
**two** places:

1. **elephant-mcp Vercel *production* env** → then **REDEPLOY**. Env binds only on new
   deployments; an updated var does nothing until you redeploy. This hosted MCP is itself
   just one consumer deployment (the one the team maintains); per-consumer deploys via
   `deploy-open-data-mcp` are independent and need no shared backend.
2. **Local Cursor `~/.cursor/mcp.json`** — there can be 3 overlapping servers
   (`elephant` / `elephant-hosted` / `elephant-local`); put the full map on the one
   donphan actually uses and consolidate the rest.

The MCP opens in-process DuckDB, creates a `properties` view over the Parquet (httpfs
range reads), and serves two tools, both taking `county`:

- **`getPropertyQuerySchema { county }`** — columns + DuckDB types + descriptions (call
  first, don't guess SQL).
- **`queryProperties { county, sql, limit? }`** — single read-only `SELECT`/`WITH`
  (mutating/file/extension keywords rejected; rows capped).

**Verify each county's IPNS is a real Parquet** before declaring done:
`curl -r 0-3 https://ipfs.filebase.io/ipns/<key>` → first bytes must be **`PAR1`**.
Point `ORACLE_MCP_URL` at the STABLE MCP alias, not a pinned deploy URL.

### NEO catalog wiring (repo `elephant-xyz/catalog`)

The MCP map makes donphan queryable; NEO's catalog UI is separate wiring in
`elephant-xyz/catalog`. Base changes off latest **`master`**. Per county:
`app/<county>/page.tsx` (**mirror the latest merged county page** — county-aware MCP,
`dynamic`, `maxDuration = 60`, DB fallback; don't hand-roll), a `COUNTY_OPTIONS` entry in
`components/county-switcher.tsx`, `tests/<county>-page.test.tsx` + a
`neo-county-catalog-path` assertion. Gotchas:

- **NEO brand is DOMAIN-based, not an env flag.** `neo.prismteam.ai/<county>` renders
  NEO; everything else renders SpeedBay. Do NOT set `BRAND=neo` on shared prod.
- **Vercel "Deployment was blocked / Git author must have access"** = the commit author's
  GitHub account isn't linked to a Vercel member with project access; not fixable by
  changing the commit email, and it doesn't block the merge.

## Data-coverage caveat — validate + report honestly

The schema is stable across counties, but **column coverage varies** — report NULL
columns rather than implying full coverage:

- **`hoa_flag` is a reserved placeholder NULL for EVERY county** — no HOA data is
  ingested yet; the column exists only for schema stability.
- **Lee**: no acreage, no structure-material coverage (`lot_size_acre`,
  `exterior_wall_material`, `roof_covering_material` largely NULL).
- **Palm Beach**: `lot_size_acre` ~0% but `lot_area_sqft` ~92% → acreage derived from
  sqft; situs address 100% from `unnormalized_addresses.full_address`.

Spot-check with DuckDB `count(*) FILTER (WHERE col IS NOT NULL)` per notable column and
state the gaps in the handoff.

## Where it runs

Export + validate + publish run on the **local services process** as the county's
`Publish` object handlers — journaled steps, resume on restart, and no platform hard cap
once the service's inactivity/abort timeouts are raised (Restate's defaults abort a
handler stuck ~11 min inside one `ctx.run`; see `durable-workflow-builder` authoring
rule 3). With the
**local Postgres** the export is fast (the old ~18-min laptop figure was trans-Atlantic
DB latency, gone now). If `DATABASE_URL` points at a remote DB, expect every round-trip
to slow the export — keep the machine awake (`caffeinate -i -s`) for long runs.

The **incremental publish loop** is the `Publish` object's self-scheduling `tick()`
(`durable-workflow-builder` pattern 10): `Loader` calls `requestPublish()` as coverage
grows, the tick re-exports and re-points `oracle-query-table-<county>` — honoring the
same durable approve gate (dry-run until `Publish/<county>/approve`).

## Done = both are true

1. **Validation gate passes** (`query_table_validation_passed`): parquet rows == distinct
   folio in the DB, 0 dup/null folios — DB reconciliation proven via path 1 (fresh, in
   this validation) or path 2 (recorded pre-join reconcile + CID fill + spot check).
   "Never reconciled" is the only disqualifier.
2. **donphan answers a smoke question through the MCP**, e.g.
   `queryProperties { county, sql: "SELECT count(*) FROM properties WHERE address_zip = '33410'" }`
   returns a real count and `getPropertyQuerySchema { county }` lists the columns. If
   donphan says the county "is not served": the map entry is missing or the MCP wasn't
   redeployed.

## Related skills

- `query-db-loading-matching` — loads + reconciles the data this skill indexes (validate
  distinct-folio BY `request_identifier` first).
- `county-open-data-publish` — produces the `manifest.json` (CID map) Stage 1 needs; same
  Filebase mechanics and the same `Publish` approve gate.
- `deploy-open-data-mcp` — deploying the `elephant` MCP that reads
  `PROPERTY_QUERY_TABLE_MAP`.
- `durable-workflow-builder` — virtual-object single-writer, durable approval gate,
  self-scheduling tick.
