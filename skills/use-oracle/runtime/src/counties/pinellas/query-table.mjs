/**
 * Pinellas query-table row mapping, Parquet schema, and Filebase publication
 * targets.
 *
 * Adapted from `oracle-node@ff68b0b6`
 * `scripts/publish-pinellas-pilot-to-filebase.mjs`
 * (`mapTransformedFilesToQueryTableRow`, `propertyIdForStrap`,
 * `ownerNameFromRecord`, `buildQueryTableParquetSchema`,
 * `buildPinellasPilotCoverage`). Two fixes vs. the source script, both
 * driven by what `data_extractor.js` actually writes (see the Task 2
 * report): structure data lives in `structure_<n>.json`, not a singular
 * `structure.json`, and `property.json` omits `built_year` /
 * `livable_floor_area` / `total_area` (those fields are commented out in
 * the production extractor), so this module falls back to the primary
 * `layout_<n>.json` "Building" entry for them.
 *
 * @module counties/pinellas/query-table
 */

import { createHash } from "node:crypto";
import { parseUnnormalizedAddress, toInteger, toNumber, toText } from "../../core/query-table.mjs";

export const SOURCE_SYSTEM = "pinellas_appraiser";
export const COUNTY_KEY = "pinellas";
export const COUNTY_NAME = "Pinellas";
export const STATE_CODE = "FL";
export const QUERY_TABLE_BUCKET = "elephant-oracle-query-table-pinellas";
export const QUERY_TABLE_IPNS_LABEL = "oracle-query-table-pinellas";
export const COVERAGE_IPNS_LABEL = "oracle-dataset-coverage-pinellas";

/**
 * Stable UTF-8 property id derived from a Pinellas STRAP.
 *
 * @param {string} strap - 18-digit STRAP.
 * @returns {string} Deterministic UUID-shaped id.
 */
export function propertyIdForStrap(strap) {
  const digest = createHash("sha1").update(`${SOURCE_SYSTEM}:${strap}`).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Read an owner display name from a person or company JSON object.
 *
 * @param {Record<string, unknown>} record - Transform owner file.
 * @returns {string | null} Display name.
 */
export function ownerNameFromRecord(record) {
  const direct = toText(record.name) ?? toText(record.full_name) ?? toText(record.company_name);
  if (direct !== null) return direct;
  const parts = [record.first_name, record.middle_name, record.last_name]
    .map((part) => toText(part))
    .filter((part) => part !== null);
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * Pick the lowest-numbered `structure_<n>.json` entry, matching how
 * `structureMapping.js` numbers buildings starting at 1.
 *
 * @param {Record<string, Record<string, unknown>>} files - `data/*.json` keyed by basename.
 * @returns {Record<string, unknown>} The primary structure record, or `{}`.
 */
function primaryStructure(files) {
  const entries = Object.entries(files)
    .filter(([name]) => /^structure_\d+\.json$/.test(name))
    .sort(([left], [right]) => Number(left.match(/\d+/)?.[0]) - Number(right.match(/\d+/)?.[0]));
  return entries[0]?.[1] ?? {};
}

/**
 * Pick the primary "Building" `layout_<n>.json` entry (building_number 1),
 * the source of built year / area when `property.json` omits them.
 *
 * @param {Record<string, Record<string, unknown>>} files - `data/*.json` keyed by basename.
 * @returns {Record<string, unknown>} The primary building layout record, or `{}`.
 */
function primaryBuildingLayout(files) {
  const entries = Object.entries(files)
    .filter(([name, record]) => /^layout_\d+\.json$/.test(name) && record.space_type === "Building")
    .sort((left, right) => (toInteger(left[1].building_number) ?? 0) - (toInteger(right[1].building_number) ?? 0));
  return entries[0]?.[1] ?? {};
}

/**
 * Map one transformed-zip JSON dictionary plus optional seed row into a
 * Pinellas query-table row.
 *
 * @param {object} params - Mapping inputs.
 * @param {string} params.strap - Canonical 18-digit STRAP.
 * @param {Record<string, Record<string, unknown>>} params.files - `data/*.json` keyed by basename.
 * @param {Record<string, string> | null} params.seedRow - Matching seed row, when present.
 * @returns {Record<string, unknown>} Flat query-table row.
 */
export function mapTransformedFilesToQueryTableRow({ strap, files, seedRow }) {
  const property = files["property.json"] ?? {};
  const address = files["address.json"] ?? {};
  const unnormalized = files["unnormalized_address.json"] ?? {};
  const lot = files["lot.json"] ?? {};
  const structure = primaryStructure(files);
  const buildingLayout = primaryBuildingLayout(files);

  const situsText =
    toText(unnormalized.full_address) ??
    toText(address.unnormalized_address) ??
    toText(seedRow?.situs_address) ??
    toText(seedRow?.address);
  const parsed = parseUnnormalizedAddress(situsText);
  const situsHasContent =
    parsed.city !== null || parsed.postalCode !== null || (parsed.street !== null && /\d/.test(parsed.street));

  const taxRows = Object.entries(files)
    .filter(([name]) => /^tax_\d+\.json$/.test(name))
    .map(([, record]) => record)
    .sort((left, right) => (toNumber(right.tax_year) ?? 0) - (toNumber(left.tax_year) ?? 0));
  const latestTax = taxRows[0] ?? {};

  const salesRows = Object.entries(files)
    .filter(([name]) => /^sales_history_\d+\.json$/.test(name))
    .map(([, record]) => record)
    .sort((left, right) =>
      String(toText(right.ownership_transfer_date) ?? "").localeCompare(
        String(toText(left.ownership_transfer_date) ?? ""),
      ),
    );
  const latestSale = salesRows[0] ?? {};

  const owners = Object.entries(files)
    .filter(([name]) => /^(person|company)_\d+\.json$/.test(name))
    .map(([, record]) => ownerNameFromRecord(record))
    .filter((name) => name !== null);
  const uniqueOwners = [...new Set(owners)];

  const permitCount = Object.keys(files).filter((name) => /^property_improvement_\d+\.json$/.test(name)).length;

  const lotAreaSqft = toNumber(lot.lot_area_sqft);
  const lotSizeAcre =
    toNumber(lot.lot_size_acre) ?? toNumber(seedRow?.acres) ?? (lotAreaSqft !== null ? lotAreaSqft / 43_560 : null);

  return {
    property_id: propertyIdForStrap(strap),
    property_cid: null,
    request_identifier: strap,
    parcel_identifier: toText(property.parcel_identifier) ?? toText(files["parcel.json"]?.parcel_identifier) ?? strap,
    source_system: SOURCE_SYSTEM,
    county_name: COUNTY_NAME,
    state_code: STATE_CODE,
    address_street: (situsHasContent ? parsed.street : null) ?? parsed.street,
    address_city: (situsHasContent ? parsed.city : null) ?? toText(seedRow?.city) ?? parsed.city,
    address_zip: (situsHasContent ? parsed.postalCode : null) ?? toText(seedRow?.zip) ?? parsed.postalCode,
    latitude: toNumber(seedRow?.latitude),
    longitude: toNumber(seedRow?.longitude),
    lot_size_acre: lotSizeAcre,
    lot_area_sqft: lotAreaSqft,
    exterior_wall_material: toText(structure.exterior_wall_material_primary) ?? toText(structure.exterior_wall_material),
    roof_covering_material: toText(structure.roof_covering_material),
    roof_date: toText(structure.roof_date),
    roof_age_years: toInteger(structure.roof_age_years),
    roof_date_source: toText(structure.roof_date_source),
    roof_date_lineage:
      structure.roof_date_lineage === null ||
      structure.roof_date_lineage === undefined
        ? null
        : JSON.stringify(structure.roof_date_lineage),
    property_type: toText(property.property_type),
    property_usage_type: toText(property.property_usage_type),
    built_year: toInteger(property.property_structure_built_year) ?? toInteger(buildingLayout.built_year),
    livable_floor_area: toNumber(property.livable_floor_area) ?? toNumber(buildingLayout.livable_area_sq_ft),
    total_area: toNumber(property.total_area) ?? toNumber(buildingLayout.total_area_sq_ft),
    assessed_value: toNumber(latestTax.property_assessed_value_amount),
    market_value: toNumber(latestTax.property_market_value_amount),
    land_value: toNumber(latestTax.property_land_amount),
    avm_value: null,
    owner_name: uniqueOwners[0] ?? null,
    owners_text: uniqueOwners.length > 0 ? uniqueOwners.join(" | ") : null,
    owner_count: uniqueOwners.length > 0 ? uniqueOwners.length : null,
    owner_occupied: null,
    last_sale_date: toText(latestSale.ownership_transfer_date),
    last_sale_price: toNumber(latestSale.purchase_price_amount),
    subdivision: toText(property.subdivision),
    has_permits: permitCount > 0,
    permit_count: permitCount,
    has_sunbiz_tenant: false,
    has_bbb_contractor: false,
    hoa_flag: null,
  };
}

/**
 * `@dsnp/parquetjs` scalar-only schema fields for the Pinellas query table.
 *
 * @type {Record<string, { type: string, optional?: boolean }>}
 */
export const QUERY_TABLE_SCHEMA_FIELDS = Object.freeze({
  property_id: { type: "UTF8" },
  property_cid: { type: "UTF8", optional: true },
  request_identifier: { type: "UTF8", optional: true },
  parcel_identifier: { type: "UTF8", optional: true },
  source_system: { type: "UTF8", optional: true },
  county_name: { type: "UTF8", optional: true },
  state_code: { type: "UTF8", optional: true },
  address_street: { type: "UTF8", optional: true },
  address_city: { type: "UTF8", optional: true },
  address_zip: { type: "UTF8", optional: true },
  latitude: { type: "DOUBLE", optional: true },
  longitude: { type: "DOUBLE", optional: true },
  lot_size_acre: { type: "DOUBLE", optional: true },
  lot_area_sqft: { type: "DOUBLE", optional: true },
  exterior_wall_material: { type: "UTF8", optional: true },
  roof_covering_material: { type: "UTF8", optional: true },
  roof_date: { type: "UTF8", optional: true },
  roof_age_years: { type: "INT64", optional: true },
  roof_date_source: { type: "UTF8", optional: true },
  roof_date_lineage: { type: "UTF8", optional: true },
  property_type: { type: "UTF8", optional: true },
  property_usage_type: { type: "UTF8", optional: true },
  built_year: { type: "INT64", optional: true },
  livable_floor_area: { type: "DOUBLE", optional: true },
  total_area: { type: "DOUBLE", optional: true },
  assessed_value: { type: "DOUBLE", optional: true },
  market_value: { type: "DOUBLE", optional: true },
  land_value: { type: "DOUBLE", optional: true },
  avm_value: { type: "DOUBLE", optional: true },
  owner_name: { type: "UTF8", optional: true },
  owners_text: { type: "UTF8", optional: true },
  owner_count: { type: "INT64", optional: true },
  owner_occupied: { type: "BOOLEAN", optional: true },
  last_sale_date: { type: "UTF8", optional: true },
  last_sale_price: { type: "DOUBLE", optional: true },
  subdivision: { type: "UTF8", optional: true },
  has_permits: { type: "BOOLEAN", optional: true },
  permit_count: { type: "INT64", optional: true },
  has_sunbiz_tenant: { type: "BOOLEAN", optional: true },
  has_bbb_contractor: { type: "BOOLEAN", optional: true },
  hoa_flag: { type: "BOOLEAN", optional: true },
});
