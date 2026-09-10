---
name: use-elephant-mcp
description: "Operating guide for exploring Elephant open data through the bundled elephant MCP server. Use for county property questions, business-category counts and groups, contractor quality, address mismatches, or schema fields. Not for direct database access or county ingestion."
---

# Use Elephant MCP

This skill governs how to **explore Elephant data through the MCP server** published as
[`@elephant-xyz/mcp`](https://github.com/elephant-xyz/elephant-mcp). The agent reads Oracle
open-data (IPFS), geo indexes, and lexicon schemas by calling MCP tools — never by shelling
out to IPFS, AWS, or ad-hoc HTTP.

Do **not** use this skill for:

- **Neon SQL** over ingested rows → [`use-elephant-query-db`](../../use-elephant-query-db/SKILL.md)
- **County ingestion / refresh** → [`use-oracle`](../../use-oracle/SKILL.md)

## Always read first

1. [`reference/mcp-setup.md`](./reference/mcp-setup.md) — Cursor MCP install, env vars, regenerating the county maps from the catalog
2. [`reference/tools-and-workflows.md`](./reference/tools-and-workflows.md) — tool catalog and decision tree
3. [`reference/exploration-patterns.md`](./reference/exploration-patterns.md) — worked patterns and limitations
4. [`reference/consolidated-property-shape.md`](./reference/consolidated-property-shape.md) — JSON paths for filtering

## Prerequisites

- **Node.js 22.18+** (Node ≥26 requires the built `dist/index.js`; do not import `package.json`
  from raw TypeScript)
- **Elephant MCP** via this plugin's bundled `mcp.json` (server name **`elephant`**), installing
  **`main`** from `github:elephant-xyz/elephant-mcp#main` until npm publishes a build with
  `queryProperties` and current Oracle open-data/geo tools. Reload Cursor after installing/updating
  the kit; confirm **`elephant`** is enabled under MCP settings.
- **Optional env** (for teammates, not hard-coded in skill text):
  - `OPENAI_API_KEY` in the shell for `getVerifiedScriptExamples`, or AWS creds for Bedrock. Do
    **not** set an empty key — the server crashes on a blank `OPENAI_API_KEY`.
  - Geo index, county maps, and open-data IPNS are preconfigured in the plugin `mcp.json`
- **Default dataset:** Lee County, FL (reference). Confirm if the user names another county.

## MCP gate (mandatory)

Before exploring data:

1. Confirm MCP server **`elephant`** is connected (MCP panel shows tools enabled).
2. Call `getOracleDatasetInfo` on server **`elephant`** with the county under discussion
   (`county` is optional and defaults to Lee). If tools are missing or the call fails
   with a connection error, **STOP** and point to
   [`reference/mcp-setup.md`](./reference/mcp-setup.md) (reload Cursor, enable `elephant`, manual
   fallback). Do not bypass with shell, IPFS CLI, or direct CID fetches.

When calling tools in Cursor, use `CallMcpTool` with `server`: **`elephant`** and `toolName` set
to the exact registered tool name (e.g. `getOracleDatasetInfo`).

**Pass `county` on every tool that accepts it.** Omitting it silently falls back to the default
county (Lee) and answers the wrong question. `listPublishedCounties` returns the canonical
catalog of counties the server can serve.

## Exploration playbook

For **property attribute / aggregate / count / filter** questions (how many, by owner, by zip,
by city, by value, by acreage, by material) use the property SQL query path below.
For **Overture business place/category** questions, use the structured places query path.
For geo-scoped or per-record questions, narrow geographically or paginate, then fetch
consolidated JSON.

0. **Business places / categories** — `getPlaceQuerySchema` for the county → `queryPlaces`.
   Use `mode: "count"` for counts, `"rows"` for lists, and `"groupByPrimaryCategory"` for
   grouped primary categories. Use exact `taxonomyPrimary` for a single primary label and
   `taxonomyHierarchyMember` for roll-ups (for example, `restaurant` anywhere in the
   `/`-delimited hierarchy). Do not count taxonomy alternates. For business/co-location counts
   and lists, default `hostedService` to `"exclude"` and disclose that advisory hosted
   ATMs/kiosks/services were excluded; use `"include"` when the user requests every source row.
   Report Overture release/licence provenance and honest `completionPercent: null` because no
   authoritative all-business denominator exists. Never read the places IPFS URL or Neon
   directly; the MCP resolves the catalog-authorized parquet.
1. **Property attribute / aggregate / count / filter** — `getPropertyQuerySchema` (learn the
   published columns, including `elephant_uuid` / `elephant_token`) → `queryProperties` with ONE read-only `SELECT`/`WITH…SELECT` over the
   `properties` view. Single statement, SELECT/CTE only; row cap auto-applies (default 100,
   max 1000). Use `ILIKE '%…%'` for owner (`owners_text`), city (`address_city`), material
   (`exterior_wall_material`). Use `elephant_uuid` or `elephant_token` for deterministic
   `address:v1` matching (country, state, ZIP5, street, unit) — do not reuse
   `normalizedAddressHash`. This runs SQL over the **OPEN IPFS parquet via MCP (NOT Neon)** —
   do **not** hand these off to `use-elephant-query-db`. `county` defaults to `lee` and must
   match the MCP's `PROPERTY_QUERY_TABLE_MAP`. Coverage varies by county: Lee has no
   acreage/material (NULL); HOA (`hoa_flag`) is NULL everywhere; identity columns are NULL
   until a republish includes them — confirm with
   `getPropertyQuerySchema` / `SELECT count(col)` and say "not available for this county"
   rather than inventing.
2. **Dataset context** — `getOracleDatasetInfo` → county, `propertyCount`, freshness timestamps
3. **Geo-scoped questions** — `findPropertiesInArea` with `county` plus bbox or polygon →
   parcel/property IDs in area → `getOracleProperty` with `county` on candidates. Omitting
   `county` searches the default (Lee) query table.
4. **County-wide discovery** — `listOracleProperties` with pagination (`limit` max 500,
   increase `offset`) → selective `getOracleProperty`
5. **Value aggregates in area** — `sumPropertyValueInArea` with `county` when the question is
   AVM sum/count in a bbox/polygon
6. **Contractor / business quality** — `getOracleProperty` → inspect BBB blocks and Sunbiz
   registrations (see consolidated-property-shape)
7. **Address mismatches** — compare appraisal, permit, and Sunbiz address fields in consolidated
   JSON; cite field paths and normalized keys when present
8. **Permits** — if the county is in `PERMIT_QUERY_TABLE_MAP`, use `getPermitQuerySchema` →
   `queryPermits`; that is the only path for county-wide permit counts. Otherwise
   `getPropertyPermits` with `parcelId` **and `countyFips`** (default `12071` = Lee). On-demand
   harvest needs pipeline ingress on the MCP; if that is not configured, report harvest
   unavailable instead of polling for 90s.
9. **Schema semantics** — `listClassesByDataGroup`, `listPropertiesByClassName`,
   `getPropertySchema` when the user asks what a field means or which class owns it
10. **Transform / mapping help** — `getVerifiedScriptExamples` (requires embedding credentials)

## Non-negotiables

- **MCP tools only** for Elephant data reads in this workflow.
- Never access places parquet/index/NOTICE through direct IPFS/HTTP or query Neon from Donphan.
- Never hard-code or print API keys, AWS secrets, or IPFS credentials.
- Never claim a **full-count** answer without stating geo scope, pagination limits, and how many
  records were actually inspected.
- Report **methodology**: tools called, area/bbox used, sample size, filter rules applied.
- Open-data attribute/aggregate/filter SQL runs here via `queryProperties` (open IPFS parquet,
  not Neon) — only hand off to `use-elephant-query-db` for Neon-only rows/joins not in the parquet.
- Overture places rows/counts/groups run through structured `queryPlaces`, not `queryProperties`.
- Hand off to `use-oracle` when the user wants to ingest or refresh source data.

## Expected output

When answering exploration questions, return:

- Restated question and inferred filters (geo, business type, quality threshold)
- MCP tools called (in order) and key parameters (bbox, offset/limit, parcel IDs sampled)
- Answer with counts or list (parcel ID, address snippet, evidence field)
- Coverage limits (e.g. "inspected 120 of ~45k properties in Fort Myers bbox")
- Gaps or blockers with exact fix (MCP not connected, missing `ORACLE_GEO_INDEX_IPNS`, etc.)
