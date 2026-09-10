# Exploration patterns

These patterns use **MCP tools only**. There is no bulk search API — always state how many
records you inspected versus total dataset size from `getOracleDatasetInfo`.

## Reference bounding boxes (Lee County, FL)

Use `findPropertiesInArea` with a `bbox` unless the user supplies a polygon.

| Area | minLat | minLng | maxLat | maxLng | Notes |
|------|--------|--------|--------|--------|-------|
| Fort Myers (city core) | 26.50 | -81.92 | 26.68 | -81.78 | Good default for "Fort Myers" |
| Lee County (wide) | 26.30 | -82.35 | 26.95 | -81.55 | Large; many properties |

Tune bbox if results look wrong; report the bbox you used.

## Practical caps

To keep sessions responsive:

- After `findPropertiesInArea`, cap `getOracleProperty` fetches at **200** unless the user
  explicitly needs exhaustive enumeration (warn about time).
- For county-wide `listOracleProperties` scans, cap at **500–1000** property fetches per
  answer unless the user accepts a longer run.
- Always report: `inspected N of M properties in scope`.

## Pattern 1: Sub-par electric contractors

**Example:** "How many sub-par electric contractors?"

1. `getOracleDatasetInfo` — confirm county and scale.
2. Define **sub-par** explicitly (default if user omits):
   - BBB `bbbRating` in `C`, `D`, `F`, or `NR`
   - OR `ratingScore` &lt; 3.0 when numeric
   - OR `contractorQualityScores` below team threshold when present
3. Define **electric contractor**:
   - BBB `businessReputationCategories` / `categoryName` contains `electric` (case-insensitive)
   - OR Sunbiz NAICS / business description mentions electrical contracting
4. Fetch strategy:
   - County-wide: paginate `listOracleProperties` with `county` OR sample geo tiles
   - Prefer multiple smaller bboxes if county-wide is too large
5. `getOracleProperty` with `county` on each candidate → scan BBB and linked contractor blocks.
6. Return: count, list of business names + parcel links, filter definition, sample size.

**Note:** BBB profiles may attach to permits/properties via enrichment — one property may surface
multiple contractors; count businesses, not parcels, unless the user asks per-property.

## Pattern 2: Nail salons in Fort Myers

**Example:** "List nail salons in Fort Myers."

1. `getPlaceQuerySchema` with `county: "lee"` — record release, licence gate, and null completion.
2. `queryPlaces` with:
   - `county: "lee"`
   - `mode: "rows"`
   - `filters.taxonomyPrimary: { value: "nail_salon", match: "exact" }`
   - `filters.locality: { value: "Fort Myers", match: "exact" }`
   - `filters.hostedService: "exclude"` (default business-location policy; disclose it)
   - deterministic `sortBy: "name"`, increasing `offset` if the user needs every row
3. Return: `totalCount`, the page size/offset, GERS id, name, category, address/locality,
   operating status, confidence, hosted-service evidence, and Overture release.

Do not call these "commercial properties with nail salons." The places table is business-point
data and the published parcel-link step is not complete. A commercial-property join is a
different question and must be reported unavailable until a published MCP linkage exists.

## Pattern 3: Address mismatches

**Example:** "Find properties with address mismatches."

1. `getOracleDatasetInfo`
2. Narrow scope: user-named city (bbox) or paginated sample if county-wide
3. `getOracleProperty` on candidates
4. Compare normalized keys when available:
   - Appraisal site address vs permit `unnormalizedAddress` / permit search fields
   - Appraisal vs Sunbiz `businessRegistrationAddresses`
   - `normalizedAddressKey` / `normalizedAddressHash` inequality across sources
5. Flag **mismatch** when:
   - Normalized keys differ across sources, OR
   - Same parcel but materially different `cityName`, `streetName`, or `postalCode`
6. Return: parcel ID, each source address string, which fields diverged, count in sample.

See [`consolidated-property-shape.md`](./consolidated-property-shape.md) for field paths.

## Pattern 4: Permit gap on a known parcel

1. `getOracleProperty` with `county` — if `permits` empty or stale
2. If the county is in `PERMIT_QUERY_TABLE_MAP`, `queryPermits` for that parcel
3. Else `getPropertyPermits` with `parcelId` **and `countyFips`** (the Lee default `12071` is
   wrong for every other county). If harvest is not configured on the MCP, stop and say so.
4. If harvest is in progress, wait ~90s and retry once, then re-fetch consolidated data or use
   the permit payload from the tool response

## Pattern 5: Restaurant count in Lee County

**Example:** "How many restaurants are in Lee County?"

1. `getPlaceQuerySchema` with `county: "lee"`.
2. Interpret "restaurants" as a taxonomy roll-up, not only the exact
   `taxonomy_primary = restaurant` label.
3. `queryPlaces` with:
   - `mode: "count"`
   - `filters.taxonomyHierarchyMember: "restaurant"`
   - `filters.hostedService: "exclude"` unless the user requests hosted services
4. Report the exact roll-up rule, hosted-service exclusion, `totalCount`, Overture release,
   licence-gate status, county, and `completionPercent: null`.

If the user explicitly asks for the exact primary category `restaurant`, use
`taxonomyPrimary: { value: "restaurant", match: "exact" }` instead and say that it excludes
specialized descendants such as cafe or seafood restaurant.

## Pattern 6: Group Lee businesses by primary category

1. `getPlaceQuerySchema` with `county: "lee"`.
2. `queryPlaces` with:
   - `mode: "groupByPrimaryCategory"`
   - `filters.hostedService: "exclude"` by default, disclosed
   - `limit`/`offset` until all `totalGroups` are returned when the user requests a full table
3. Preserve the MCP order: `placeCount` descending, `taxonomyPrimary` ascending for ties.
4. Report `totalCount`, `totalGroups`, page coverage, release, licence gate, and null completion.

Group only `taxonomy_primary`. Do not merge alternates into counts and do not claim the grouped
rows are a complete census of Lee businesses.

## Pattern 7: Address identity (`elephant_uuid` / `elephant_token`)

**Example:** "Does this situs match an OpenDoor / external address id?"

1. `getPropertyQuerySchema` — confirm `elephant_uuid` and `elephant_token` exist and are populated.
2. If those columns are NULL for the county, say they are not published yet. Do not hash locally
   and do not use `normalizedAddressHash` as a substitute.
3. `queryProperties` with `county` and a filter on `elephant_uuid` (UUIDv5) or
   `elephant_token` (SHA-256 hex). The contract is `address:v1`: country `us`, Oracle
   `state_code`, ZIP5, street, unit. No ROAD→RD expansion.
4. Return: matching `parcel_identifier`, published street/ZIP, uuid, token, and whether the
   column was present.

## Honest limitations

- Overture place category/name/location/status/hosted/confidence filters are server-side through
  structured `queryPlaces`; BBB rating still requires consolidated property evidence.
- No published place-to-parcel link is exposed through MCP yet, so place rows cannot prove a
  business occupies a specific commercial parcel.
- Overture `completionPercent` is intentionally NULL because no authoritative all-business
  denominator exists.
- Geo tools without `county` search the default county (Lee), even when the bbox is elsewhere.
- Geo matching uses property **centroid** only (not building footprint).
- Dataset may lag live county portals — cite `exportedAt` / `completedAt` from dataset info.
- For heavy analytics (joins, SQL, dashboards), hand off to `use-elephant-query-db`.
