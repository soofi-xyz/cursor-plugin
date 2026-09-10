/**
 * County-agnostic query-table helpers: JSON coercion, transformed-zip
 * reading, Parquet row writing, and dataset-coverage snapshot building.
 *
 * Adapted from `oracle-node@ff68b0b6`
 * `scripts/publish-pinellas-pilot-to-filebase.mjs` (`toNumber`, `toText`,
 * `parseUnnormalizedAddress`, `readTransformedZipJsonFiles`,
 * `toParquetRecord`, `buildPinellasPilotCoverage`), generalized so any
 * county query-table module can reuse them.
 *
 * @module core/query-table
 */

import { createRequire } from "node:module";
import { ParquetSchema, ParquetWriter } from "@dsnp/parquetjs";

const require = createRequire(import.meta.url);
/** @type {typeof import("adm-zip")} */
const AdmZip = require("adm-zip");

const TRAILING_STATE_ZIP_RE = /\b[A-Za-z]{2}\s+(\d{5})(?:-\d{4})?\s*$/;
const TRAILING_ZIP_RE = /\b(\d{5})(?:-\d{4})?\s*$/;

/**
 * @typedef {object} ParsedAddress
 * @property {string | null} street
 * @property {string | null} city
 * @property {string | null} postalCode
 */

/**
 * Coerce a JSON scalar to a finite number.
 *
 * @param {unknown} value - Raw JSON value.
 * @returns {number | null} Finite number, or null.
 */
export function toNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Truncate a numeric value to an integer.
 *
 * @param {unknown} value - Raw JSON value.
 * @returns {number | null} Truncated integer, or null.
 */
export function toInteger(value) {
  const parsed = toNumber(value);
  return parsed === null ? null : Math.trunc(parsed);
}

/**
 * Coerce a JSON scalar to a non-empty trimmed string.
 *
 * @param {unknown} value - Raw JSON value.
 * @returns {string | null} Trimmed string, or null.
 */
export function toText(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Parse a US free-text single-line address into street / city / ZIP.
 *
 * @param {string | null | undefined} value - Single-line situs or mailing address.
 * @returns {ParsedAddress} Split address fields.
 */
export function parseUnnormalizedAddress(value) {
  /** @type {ParsedAddress} */
  const empty = { street: null, city: null, postalCode: null };
  if (value === null || value === undefined) return empty;
  const trimmed = value.trim();
  if (trimmed.length === 0) return empty;
  const segments = trimmed
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (segments.length === 0) return empty;
  let postalCode = null;
  const last = segments[segments.length - 1] ?? "";
  const stateZip = TRAILING_STATE_ZIP_RE.exec(last);
  const zipOnly = TRAILING_ZIP_RE.exec(last);
  if (stateZip?.[1] !== undefined) {
    postalCode = stateZip[1];
    const head = last.replace(TRAILING_STATE_ZIP_RE, "").trim();
    if (head.length > 0) segments[segments.length - 1] = head;
    else segments.pop();
  } else if (zipOnly?.[1] !== undefined) {
    postalCode = zipOnly[1];
    const head = last.replace(TRAILING_ZIP_RE, "").trim();
    if (head.length > 0) segments[segments.length - 1] = head;
    else segments.pop();
  }
  const street = segments.length > 0 ? (segments[0] ?? null) : null;
  const cityParts = segments.slice(1);
  const city = cityParts.length > 0 ? cityParts.join(", ") : null;
  return { street, city, postalCode };
}

/**
 * Read every `data/*.json` object from a transformed.zip (no relationship files).
 *
 * @param {string} zipPath - Path to `transformed.zip`.
 * @returns {Record<string, Record<string, unknown>>} Basename → parsed JSON.
 */
export function readTransformedZipJsonFiles(zipPath) {
  const zip = new AdmZip(zipPath);
  /** @type {Record<string, Record<string, unknown>>} */
  const files = {};
  for (const entry of zip.getEntries()) {
    const name = entry.entryName.replaceAll("\\", "/");
    const base = name.split("/").pop() ?? name;
    if (!name.startsWith("data/") || !name.endsWith(".json")) continue;
    if (base.startsWith("relationship_") || base.startsWith("bafk")) continue;
    const parsed = JSON.parse(entry.getData().toString("utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      files[base] = parsed;
    }
  }
  return files;
}

/**
 * Drop null/undefined keys so `@dsnp/parquetjs` optional fields write as NULL.
 *
 * @param {Record<string, unknown>} row - Query-table row.
 * @returns {Record<string, unknown>} Sparse parquet record.
 */
export function toParquetRecord(row) {
  /** @type {Record<string, unknown>} */
  const record = {};
  for (const [key, value] of Object.entries(row)) {
    if (value !== null && value !== undefined) record[key] = value;
  }
  return record;
}

/**
 * Write query-table rows to a Parquet file using the given scalar schema.
 *
 * @param {object} params - Write parameters.
 * @param {string} params.parquetPath - Destination `.parquet` path.
 * @param {Record<string, { type: string, optional?: boolean }>} params.schemaFields - `@dsnp/parquetjs` field definitions.
 * @param {readonly Record<string, unknown>[]} params.rows - Query-table rows (nulls allowed).
 * @returns {Promise<number>} Rows written.
 */
export async function writeQueryTableParquet({ parquetPath, schemaFields, rows }) {
  const schema = new ParquetSchema(structuredClone(schemaFields));
  const writer = await ParquetWriter.openFile(schema, parquetPath);
  try {
    for (const row of rows) {
      await writer.appendRow(toParquetRecord(row));
    }
  } finally {
    await writer.close();
  }
  return rows.length;
}

/**
 * @typedef {object} CoverageDataset
 * @property {string} county
 * @property {string} source
 * @property {number} ingested_count
 * @property {number | null} expected_count
 * @property {string | null} first_loaded_at
 * @property {string | null} last_loaded_at
 * @property {string | null} cid
 * @property {string | null} ipns_label
 */

/**
 * @typedef {object} CoverageSnapshot
 * @property {string} county
 * @property {string} exportedAt
 * @property {readonly CoverageDataset[]} datasets
 */

/**
 * Build a one-dataset MCP coverage snapshot for one county/source pair.
 *
 * @param {object} params - Coverage inputs.
 * @param {string} params.county - County key (e.g. `pinellas`).
 * @param {string} params.source - Dataset source name (e.g. `appraisal`).
 * @param {number} params.ingestedCount - Distinct parcel ids written to the query table.
 * @param {number} params.expectedCount - Seed row count.
 * @param {string} params.exportedAt - ISO timestamp.
 * @param {string} params.ipnsLabel - Filebase IPNS label for this coverage dataset.
 * @returns {CoverageSnapshot} Coverage JSON.
 */
export function buildCoverageSnapshot({ county, source, ingestedCount, expectedCount, exportedAt, ipnsLabel }) {
  return {
    county,
    exportedAt,
    datasets: [
      {
        county,
        source,
        ingested_count: ingestedCount,
        expected_count: expectedCount,
        first_loaded_at: exportedAt,
        last_loaded_at: exportedAt,
        cid: null,
        ipns_label: ipnsLabel,
      },
    ],
  };
}
