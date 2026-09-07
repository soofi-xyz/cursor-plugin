/**
 * Duval query-table row mapping, Parquet schema, and Filebase publication
 * targets.
 *
 * Adapted from `oracle-node@ff68b0b6` `scripts/duval/query-table-lib.mjs`
 * (`DUVAL_QUERY_TABLE_SCHEMA`, `duvalPropertyId`, `pickLatestTax`,
 * `pickLatestSale`, `formatOwnerName`, `rowFromDuvalArtifacts`), generalized
 * to read from this package's `transformed.zip` layout via
 * `core/query-table.mjs#readTransformedZipJsonFiles` instead of a live
 * `data/` directory tree.
 *
 * @module counties/duval/query-table
 */

import { createHash } from "node:crypto";
import { parseUnnormalizedAddress, toInteger, toNumber, toText } from "../../core/query-table.mjs";

export const SOURCE_SYSTEM = "duval_appraiser";
export const COUNTY_KEY = "duval";
export const COUNTY_NAME = "Duval";
export const STATE_CODE = "FL";

/**
 * Stable property id derived from a Duval DOR parcel id (sha256, matching
 * `duvalPropertyId` upstream — unlike Pinellas's UUID-shaped
 * `propertyIdForStrap`, this stays a bare hex string on purpose so a byte-
 * level port doesn't silently change identity).
 *
 * @param {string} parcelId - Canonical DOR parcel id (e.g. `0969250000R`).
 * @returns {string} 32-hex-character id.
 */
export function duvalPropertyId(parcelId) {
  return createHash("sha256").update(`duval:${parcelId}`).digest("hex").slice(0, 32);
}

/**
 * @param {readonly Record<string, unknown>[]} taxes - `tax_<n>.json` records.
 * @returns {Record<string, unknown> | null} The record with the highest `tax_year`, or null.
 */
export function pickLatestTax(taxes) {
  let best = null;
  let bestYear = Number.NEGATIVE_INFINITY;
  for (const tax of taxes) {
    const year = toNumber(tax?.tax_year);
    if (year == null) continue;
    if (year >= bestYear) {
      bestYear = year;
      best = tax;
    }
  }
  return best;
}

/**
 * @param {readonly Record<string, unknown>[]} sales - `sales_history_<n>.json` records.
 * @returns {Record<string, unknown> | null} The record with the latest `ownership_transfer_date`, or null.
 */
export function pickLatestSale(sales) {
  let best = null;
  let bestDate = "";
  for (const sale of sales) {
    const date = String(sale?.ownership_transfer_date ?? "");
    if (!date) continue;
    if (date >= bestDate) {
      bestDate = date;
      best = sale;
    }
  }
  return best;
}

/**
 * Read an owner display name from a `person_<n>.json`/`company_<n>.json` record.
 *
 * @param {Record<string, unknown>} record - Transform owner file.
 * @returns {string | null} Display name.
 */
export function formatOwnerName(record) {
  if (!record || typeof record !== "object") return null;
  const direct = toText(record.name);
  if (direct !== null) return direct;
  const parts = [record.first_name, record.middle_name, record.last_name]
    .map((part) => toText(part))
    .filter((part) => part !== null);
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * Pick the lowest-numbered `structure_<n>.json` entry.
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
 * Map one transformed-zip JSON dictionary plus its seed row into a Duval
 * query-table row.
 *
 * @param {object} params - Mapping inputs.
 * @param {string} params.parcelId - Canonical DOR parcel id (e.g. `0969250000R`).
 * @param {Record<string, Record<string, unknown>>} params.files - `data/*.json` keyed by basename.
 * @param {Record<string, string> | null} params.seedRow - Matching seed row, when present.
 * @returns {Record<string, unknown>} Flat query-table row.
 */
export function mapTransformedFilesToQueryTableRow({ parcelId, files, seedRow }) {
  const property = files["property.json"] ?? {};
  const address = files["address.json"] ?? {};
  const geometry = files["geometry.json"] ?? {};
  const lot = files["lot.json"] ?? {};
  const structure = primaryStructure(files);

  const situsText = toText(address.unnormalized_address) ?? toText(seedRow?.address);
  const parsed = parseUnnormalizedAddress(situsText);

  const taxes = Object.entries(files)
    .filter(([name]) => /^tax_\d+\.json$/.test(name))
    .map(([, record]) => record);
  const tax = pickLatestTax(taxes) ?? {};

  const sales = Object.entries(files)
    .filter(([name]) => /^sales_history_\d+\.json$/.test(name))
    .map(([, record]) => record);
  const sale = pickLatestSale(sales);

  const ownerNames = Object.entries(files)
    .filter(([name]) => /^(person|company)_\d+\.json$/.test(name))
    .map(([, record]) => formatOwnerName(record))
    .filter((name) => name !== null);
  const uniqueOwners = [...new Set(ownerNames)];

  const lotAreaSqft = toNumber(lot.lot_area_sqft);
  const lotSizeAcre = toNumber(lot.lot_size_acre) ?? (lotAreaSqft !== null ? lotAreaSqft / 43_560 : null);

  return {
    property_id: duvalPropertyId(parcelId),
    property_cid: null,
    request_identifier: toText(property.request_identifier) ?? parcelId,
    parcel_identifier: toText(property.parcel_identifier) ?? toText(seedRow?.parcel_id) ?? parcelId,
    source_system: SOURCE_SYSTEM,
    county_name: COUNTY_NAME,
    state_code: STATE_CODE,
    address_street: parsed.street,
    address_city: parsed.city ?? toText(seedRow?.city),
    address_zip: parsed.postalCode ?? toText(seedRow?.zip),
    latitude: toNumber(geometry.latitude) ?? toNumber(seedRow?.latitude),
    longitude: toNumber(geometry.longitude) ?? toNumber(seedRow?.longitude),
    lot_size_acre: lotSizeAcre,
    lot_area_sqft: lotAreaSqft,
    exterior_wall_material: toText(structure.exterior_wall_material_primary),
    roof_covering_material: toText(structure.roof_covering_material),
    property_type: toText(property.property_type),
    property_usage_type: toText(property.property_usage_type),
    built_year: toInteger(property.property_structure_built_year),
    livable_floor_area: toNumber(property.livable_floor_area),
    total_area: toNumber(property.total_area),
    assessed_value: toNumber(tax.property_assessed_value_amount),
    market_value: toNumber(tax.property_market_value_amount),
    land_value: toNumber(tax.property_land_amount),
    avm_value: null,
    owner_name: uniqueOwners[0] ?? null,
    owners_text: uniqueOwners.length > 0 ? uniqueOwners.join(" | ") : null,
    owner_count: uniqueOwners.length,
    owner_occupied: null,
    last_sale_date: sale ? toText(sale.ownership_transfer_date) : null,
    last_sale_price: sale ? toNumber(sale.purchase_price_amount) : null,
    subdivision: toText(property.subdivision),
    has_permits: false,
    permit_count: 0,
    has_sunbiz_tenant: false,
    has_bbb_contractor: false,
    has_pa_corp_tenant: false,
    hoa_flag: null,
  };
}
