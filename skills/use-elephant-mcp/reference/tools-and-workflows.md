# MCP tools and workflows

All tools are registered in
[`elephant-mcp/src/tools/registry.ts`](https://github.com/elephant-xyz/elephant-mcp/blob/main/src/tools/registry.ts).

## Tool catalog

### Oracle open data

| Tool | Purpose | Key inputs |
|------|---------|------------|
| `getOracleDatasetInfo` | Dataset provenance and freshness | `county?` (default Lee) |
| `listOracleProperties` | Paginated slim property list | `county?`, `limit` (default 50, max 500), `offset` |
| `getOracleProperty` | Full consolidated JSON from IPFS | `county?` plus exactly one of: `parcelIdentifier`, `propertyId`, `cid` |
| `listPublishedCounties` | Canonical published-county catalog | _(none)_ |
| `getPropertyPermits` | On-demand permit harvest | `parcelId`, `countyFips?` (default `12071` Lee). Harvest needs pipeline ingress; otherwise report unavailable. |

Slim list entry fields: `propertyId`, `parcelIdentifier`, `cid`, `county`, `fileSizeBytes`.

### Overture places query (catalog-authorized public parquet)

| Tool | Purpose | Key inputs |
|------|---------|------------|
| `getPlaceQuerySchema` | Lists the real places parquet columns, exact structured query contract, release/licence provenance, safety limits, and null completeness — **call FIRST per county** | `county` |
| `queryPlaces` | Returns filtered place rows, a total count, or grouped primary-category aggregates without accepting SQL or URLs | `county`, `mode?`, `filters?`, `sortBy?`, `sortDirection?`, `limit?`, `offset?` |

`queryPlaces` modes:

- `rows` — deterministic page plus `totalCount`
- `count` — exact filtered `totalCount`
- `groupByPrimaryCategory` — deterministic `taxonomy_primary` groups and counts

Important filters:

- `taxonomyPrimary: { value, match: "exact" | "contains" }` — one primary label; use this
  dimension for exact category counts and grouped output.
- `taxonomyHierarchyMember` — exact case-insensitive segment anywhere in the `/`-delimited
  hierarchy; use this for a roll-up such as `restaurant`.
- `basicCategory`, `nameContains`, `normalizedNameContains`, `locality`, `postcode`,
  `operatingStatus`, and `minConfidence`.
- `hostedService: "include" | "exclude" | "only"` — MCP defaults to `include`. Donphan defaults
  business-location/co-location counts and lists to `exclude` and explains that advisory hosted
  ATMs/kiosks/services were removed. Use `include` to reconcile the full published source count.

Do not use taxonomy alternates for counts: they are not part of the public query contract and
are not a reliable count dimension. Default rows omit public business `websites`, `phones`, and
`emails`. Query responses include release/provenance, publication index/notice URLs, and
`completionPercent: null`; there is no authoritative denominator for all business locations.
The MCP resolves `placesTableUrl` only from `listPublishedCounties`' canonical catalog and
rejects caller SQL/URLs.

### Property SQL query (open parquet via DuckDB)

| Tool | Purpose | Key inputs |
|------|---------|------------|
| `getPropertyQuerySchema` | Lists the property query-table columns + descriptions, including `elephant_uuid` / `elephant_token` when published — **call FIRST** to learn columns | `county?` (default `lee`) |
| `queryProperties` | Runs ONE read-only `SELECT`/`WITH…SELECT` over the `properties` view (per-county Parquet read from IPFS via DuckDB) and returns rows | `county?` (default `lee`), `sql`, `limit?` |

This is the **PRIMARY path for attribute / aggregate / count / filter questions** — "how
many", by owner, by zip, by city, by value, by acreage, by material. It runs SQL over the
**OPEN IPFS parquet via MCP (NOT Neon)** — do not hand these questions off to
`use-elephant-query-db`.

Constraints on `queryProperties`:

- **Single statement, `SELECT`/CTE only.** Mutations and multi-statement SQL are rejected.
- A **row cap auto-applies** (default 100, max 1000) via `limit`.
- The queried view is always named **`properties`**.
- Use `ILIKE '%…%'` for text matching: owner (`owners_text`), city (`address_city`),
  material (`exterior_wall_material`).
- Use `elephant_uuid` / `elephant_token` for stable address identity (`address:v1`: country,
  state, ZIP5, street, unit). Do not treat `normalized_address_hash` as the same id.
  Columns may be NULL until a county republish includes them.
- `county` must match the MCP server's `PROPERTY_QUERY_TABLE_MAP` (default `lee`).

**Data coverage varies by county.** Lee has no acreage/material (those columns are NULL);
HOA (`hoa_flag`) is NULL in every county. `elephant_uuid` / `elephant_token` are NULL until
a republish. Call `getPropertyQuerySchema` or run a
`SELECT count(col)` to confirm a column is populated, and state "not available for this
county" rather than inventing values. On Lee, owner / city / value / count questions work.

### Permit SQL query

| Tool | Purpose | Key inputs |
|------|---------|------------|
| `getPermitQuerySchema` | Columns + contract for the permit query table | `county` |
| `queryPermits` | Read-only SQL over the published permit parquet | `county`, `sql`, `limit?` |

Only counties in `PERMIT_QUERY_TABLE_MAP` have a published permit table. Do not use
`getPropertyPermits` for county-wide permit counts.

### Geo (query table, optional derived-index fallback)

| Tool | Purpose | Key inputs |
|------|---------|------------|
| `findPropertiesInArea` | Properties whose centroid is inside area | `county?`, exactly one of: `bbox`, `polygon` |
| `sumPropertyValueInArea` | Sum of `current_avm_value` in area | `county?`, exactly one of: `bbox`, `polygon` |

`bbox`: `{ minLat, minLng, maxLat, maxLng }`

`polygon`: array of `{ lat, lng }` vertices (≥ 3), closed ring implied.

These tools read the per-county property query table when the county is in
`PROPERTY_QUERY_TABLE_MAP`. Omitting `county` uses the default (Lee).
`ORACLE_GEO_INDEX_IPNS` / `ORACLE_GEO_INDEX_CID` is an optional fallback for counties not in
the map — it is a Lee reference index, not a substitute for passing `county`.

### Lexicon / schema

| Tool | Purpose | Key inputs |
|------|---------|------------|
| `listClassesByDataGroup` | Classes in a data group | `groupName` (e.g. `County`) |
| `listPropertiesByClassName` | Property keys on a class | `className` |
| `getPropertySchema` | Full JSON Schema for one property | `className`, `propertyName` |

### Transform examples

| Tool | Purpose | Key inputs |
|------|---------|------------|
| `getVerifiedScriptExamples` | Semantic search over verified mapping scripts | `query`, `topK?` (default 5, max 50) |

Requires embedding provider (OpenAI or Bedrock).

## Decision tree

```
User question
├─ Overture business/place/category count, list, or group
│   └─ getPlaceQuerySchema (learn fields, release, licence, null completeness)
│   └─ queryPlaces (structured filters; no SQL/URL)
│       ├─ count → mode=count
│       ├─ list → mode=rows
│       ├─ group → mode=groupByPrimaryCategory
│       ├─ exact primary label → taxonomyPrimary
│       └─ roll-up → taxonomyHierarchyMember
├─ "How many …" / by owner / by zip / by city / by value / by acreage / by material
│   (attribute · aggregate · count · filter) — PRIMARY PATH
│   └─ getPropertyQuerySchema (learn columns)
│   └─ queryProperties (ONE SELECT/CTE over the `properties` view; ILIKE for text)
│       — SQL over the OPEN IPFS parquet via MCP, NOT Neon; do not hand off to query-db
├─ "What fields exist on class X?" / schema semantics
│   └─ listClassesByDataGroup → listPropertiesByClassName → getPropertySchema
├─ "How do I map source Y to Elephant?"
│   └─ getVerifiedScriptExamples (+ schema tools as needed)
├─ "How many permits …" / permit aggregates for a county in PERMIT_QUERY_TABLE_MAP
│   └─ getPermitQuerySchema then queryPermits
├─ "In [city/area] …" (geo scoped, bbox/polygon)
│   └─ getOracleDatasetInfo (county)
│   └─ findPropertiesInArea (county + bbox/polygon)
│   └─ getOracleProperty on hits (county; filter in reasoning)
├─ "Total value in [area]" (geo)
│   └─ sumPropertyValueInArea (county)
├─ "Full record for parcel/property X"
│   └─ getOracleProperty (county + one identifier)
├─ "Address mismatch …"
│   └─ getOracleProperty → compare address fields (see consolidated-property-shape)
└─ "Permits for parcel …" (missing in consolidated JSON)
    └─ getPropertyPermits (parcelId + countyFips) → poll only if harvest is configured
```

## Pagination strategy

- `queryPlaces`: use `limit`/`offset`; every row page includes the complete filtered
  `totalCount`. Sort is deterministic with GERS id as the tie-breaker. Group pages are ordered
  by count descending then primary category ascending.
- `listOracleProperties`: use `limit=500` and walk `offset` until you have enough candidates or
  hit a practical cap (state cap in exploration-patterns).
- Prefer **geo narrow first** when the user names a city or neighborhood — fewer
  `getOracleProperty` calls.

## Error handling

- Tool errors return MCP text content — tell the user the cause and the recovery step from
  `mcp-setup.md`; keep the raw MCP message as a diagnostic, not as the only answer.
- A county with `placesTableUrl: null` has no published places table; report that unavailable
  state rather than switching to direct IPFS/Neon.
- `getPropertyPermits` returns harvest-in-progress only when pipeline ingress is configured;
  wait ~90s and retry in that case. If harvest is not configured, say so.
- Geo tools without `county` search the default county (Lee). Pass `county` for every
  non-default question.
