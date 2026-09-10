/**
 * Pinellas county adapter: seed construction, capture + transform, run
 * validation, and publication-artifact building.
 *
 * `captureAndTransform` is adapted from `oracle-node@ff68b0b6`
 * `scripts/run-pinellas-local-ingest.mjs` (`buildSourceHttpRequest`,
 * `buildSeedJsonFiles`, `buildPrintPageUrl`, `stripQueryFromSourceHttpRequestTree`,
 * the `ingestParcel`/`transformWithCountyScripts`/`zipDataDirectory` flow)
 * and `scripts/pinellas-transform-worker.cjs` (script ordering), trimmed to
 * a single-parcel-at-a-time flow (no worker pool / rate-limit gate — those
 * are concurrency concerns for a full county run and are intentionally out
 * of scope for the packaged CLI; see the Task 2 report).
 *
 * @module counties/pinellas/adapter
 */

import AdmZipCtor from "adm-zip";
import { mkdir, readdir, readFile, writeFile, access, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCountyTransform } from "../../core/transform-runner.mjs";
import {
  readTransformedZipJsonFiles,
  writeQueryTableParquet,
  buildCoverageSnapshot,
} from "../../core/query-table.mjs";
import { normalizeAsOfDate } from "../../roof-age/rule.mjs";
import {
  mapTransformedFilesToQueryTableRow,
  QUERY_TABLE_SCHEMA_FIELDS,
  QUERY_TABLE_BUCKET,
  QUERY_TABLE_IPNS_LABEL,
  COVERAGE_IPNS_LABEL,
  COUNTY_KEY,
  COUNTY_NAME,
} from "./query-table.mjs";
import { buildSeed as buildPinellasSeedFiles, PRINT_URL } from "./seed.mjs";

const RUNTIME_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const TRANSFORMS_DIR = path.join(RUNTIME_ROOT, "counties", "pinellas", "transforms");
export const FLOW_PATH = path.join(RUNTIME_ROOT, "counties", "pinellas", "flow.json");

/** Script order production `pinellas-transform-worker.cjs` uses (mapping scripts, then the extractor). */
export const MAPPING_SCRIPT_NAMES = Object.freeze([
  "ownerMapping.js",
  "structureMapping.js",
  "layoutMapping.js",
  "utilityMapping.js",
]);
export const ALL_TRANSFORM_SCRIPTS = Object.freeze([...MAPPING_SCRIPT_NAMES, "data_extractor.js"]);
export const MIN_TRANSFORMED_ZIP_BYTES = 200;
export const ZIP_LOCAL_FILE_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const PRINT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * Parse a seed `multiValueQueryString` cell.
 *
 * @param {string | undefined} raw - JSON object text.
 * @param {string} strap - Fallback STRAP for `s`.
 * @returns {Record<string, string[]>} Query map.
 */
export function parseSeedQueryString(raw, strap) {
  if (typeof raw === "string" && raw.trim().length > 0) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        /** @type {Record<string, string[]>} */
        const out = {};
        for (const [key, value] of Object.entries(parsed)) {
          if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
            out[key] = value;
          }
        }
        if (Object.keys(out).length > 0) return out;
      }
    } catch {
      // Fall through to the STRAP default.
    }
  }
  return { is_print: ["1"], s: [strap] };
}

/**
 * Build the PCPAO print URL for one STRAP, with `is_print`/`s` as query params.
 *
 * @param {string} strap - 18-digit STRAP.
 * @returns {string} Absolute print URL including query params.
 */
export function buildPrintPageUrl(strap) {
  const url = new URL(PRINT_URL);
  url.searchParams.set("is_print", "1");
  url.searchParams.set("s", strap);
  return url.toString();
}

/**
 * Build lexicon `source_http_request` for a Pinellas print GET. `url` stays
 * query-free; the query lives in `multiValueQueryString` (Global Constraint:
 * "print URL with no query").
 *
 * @param {Record<string, string>} row - Seed record.
 * @returns {{ url: string, method: string, headers: Record<string, string>, multiValueQueryString: Record<string, string[]> }}
 *   Path-only request metadata.
 */
export function buildSourceHttpRequest(row) {
  const strap = row.parcel_id;
  return {
    url: row.url && row.url.length > 0 ? row.url : PRINT_URL,
    method: row.method && row.method.length > 0 ? row.method : "GET",
    headers: { "User-Agent": PRINT_USER_AGENT, Accept: "text/html" },
    multiValueQueryString: parseSeedQueryString(row.multiValueQueryString, strap),
  };
}

/**
 * Build the seed JSON files the Pinellas transform scripts expect at the
 * root of the parcel work directory.
 *
 * @param {Record<string, string>} row - Seed record.
 * @returns {{ propertySeed: object, unnormalizedAddress: object }} Seed files.
 */
export function buildSeedJsonFiles(row) {
  const sourceHttpRequest = buildSourceHttpRequest(row);
  const strap = row.parcel_id;
  const situs = row.situs_address || row.address || "";
  return {
    propertySeed: { source_http_request: sourceHttpRequest, request_identifier: strap, parcel_id: strap },
    unnormalizedAddress: {
      source_http_request: sourceHttpRequest,
      request_identifier: strap,
      full_address: situs,
      county_jurisdiction: row.county || COUNTY_NAME,
    },
  };
}

/**
 * @param {string} candidate - Filesystem path.
 * @returns {Promise<boolean>} Whether the path exists.
 */
async function pathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when a parcel directory already has a non-empty PKZIP `transformed.zip`.
 *
 * @param {string} parcelDir - Per-STRAP output directory.
 * @returns {Promise<boolean>} Whether a usable `transformed.zip` exists.
 */
export async function hasCompletedTransform(parcelDir) {
  const zipPath = path.join(parcelDir, "transformed.zip");
  try {
    const buffer = await readFile(zipPath);
    return (
      buffer.length >= MIN_TRANSFORMED_ZIP_BYTES && buffer.subarray(0, 4).equals(ZIP_LOCAL_FILE_MAGIC)
    );
  } catch {
    return false;
  }
}

/**
 * Fetch PCPAO print HTML for one STRAP. Only called when the caller has
 * explicitly opted into `--live-fetch`; see {@link captureAndTransform}.
 *
 * @param {string} strap - 18-digit STRAP.
 * @returns {Promise<string>} Raw HTML.
 */
export async function fetchPropertyPrintHtml(strap) {
  const response = await fetch(buildPrintPageUrl(strap), {
    headers: { "User-Agent": PRINT_USER_AGENT, Accept: "text/html" },
  });
  if (!response.ok) {
    throw new Error(`PCPAO print HTTP ${response.status} for STRAP ${strap}`);
  }
  return response.text();
}

/**
 * Zip a parcel's `data/` directory into `transformed.zip`, matching the
 * `data/<file>` entry layout `zipDataDirectory` produces in
 * `run-pinellas-local-ingest.mjs`.
 *
 * @param {string} dataDir - Absolute path to the parcel's `data` directory.
 * @param {string} zipPath - Destination `.zip` path.
 * @returns {Promise<void>} Resolves once written.
 */
async function zipDataDirectory(dataDir, zipPath) {
  const zip = new AdmZipCtor();
  const names = await readdir(dataDir);
  for (const name of names.sort()) {
    zip.addLocalFile(path.join(dataDir, name), "data");
  }
  await new Promise((resolve, reject) => {
    zip.writeZip(zipPath, (error) => (error ? reject(error) : resolve(undefined)));
  });
}

/**
 * @typedef {object} CaptureAndTransformOptions
 * @property {readonly Record<string, string>[]} seedRows - Seed rows to ingest.
 * @property {string} htmlDir - Directory of `<strap>.html` fixture/cache files.
 * @property {string} outputDir - Run directory; one `<strap>/` subdirectory is created per parcel.
 * @property {boolean} [liveFetch] - When true, fetch missing HTML from PCPAO. Defaults to false (fail closed).
 * @property {string | Date} [asOfDate] - Frozen date for roof-age derivation. Defaults to the current UTC date.
 */

/**
 * @typedef {object} ParcelTransformResult
 * @property {string} parcelId - 18-digit STRAP.
 * @property {boolean} transformSuccess - Whether the transform completed.
 * @property {string | null} propertyUsageType - Transformed `property.json` usage type.
 * @property {string | null} error - Failure message, when unsuccessful.
 */

/**
 * Capture (or reuse fixture) HTML and run the Pinellas transform scripts for
 * every seed row, writing `<outputDir>/<strap>/{input.html,data/,transformed.zip}`
 * plus a run `manifest.json`.
 *
 * Fails closed: a missing local HTML file is a hard error unless
 * `liveFetch` is explicitly `true` (Global Constraint: "Live fetch and
 * publication fail closed unless explicit flags/approval are supplied").
 *
 * @param {CaptureAndTransformOptions} options - Seed rows, HTML source, and output directory.
 * @returns {Promise<{ county: string, outputDir: string, results: ParcelTransformResult[] }>}
 *   Run manifest, also written to `<outputDir>/manifest.json`.
 */
export async function captureAndTransform({
  seedRows,
  htmlDir,
  outputDir,
  liveFetch = false,
  asOfDate = new Date(),
}) {
  const roofAgeAsOfDate = normalizeAsOfDate(asOfDate);
  await mkdir(outputDir, { recursive: true });
  /** @type {ParcelTransformResult[]} */
  const results = [];
  for (const row of seedRows) {
    const strap = row.parcel_id;
    const parcelDir = path.join(outputDir, strap);
    await mkdir(parcelDir, { recursive: true });
    try {
      const fixtureHtmlPath = path.join(htmlDir, `${strap}.html`);
      const inputHtmlPath = path.join(parcelDir, "input.html");
      if (await pathExists(fixtureHtmlPath)) {
        await copyFile(fixtureHtmlPath, inputHtmlPath);
      } else if (liveFetch === true) {
        const html = await fetchPropertyPrintHtml(strap);
        await writeFile(inputHtmlPath, html, "utf8");
      } else {
        throw new Error(
          `No local HTML fixture for STRAP ${strap} at ${fixtureHtmlPath} and --live-fetch was not supplied; refusing to contact PCPAO.`,
        );
      }

      const seedFiles = buildSeedJsonFiles(row);
      await writeFile(
        path.join(parcelDir, "property_seed.json"),
        `${JSON.stringify(seedFiles.propertySeed, null, 2)}\n`,
        "utf8",
      );
      await writeFile(
        path.join(parcelDir, "unnormalized_address.json"),
        `${JSON.stringify(seedFiles.unnormalizedAddress, null, 2)}\n`,
        "utf8",
      );

      const { result, dataDir } = runCountyTransform({
        scriptsDir: TRANSFORMS_DIR,
        scriptNames: ALL_TRANSFORM_SCRIPTS,
        workDir: parcelDir,
        resultFile: "data/property.json",
        roofAgeAsOfDate,
      });

      await zipDataDirectory(dataDir, path.join(parcelDir, "transformed.zip"));

      results.push({
        parcelId: strap,
        transformSuccess: true,
        propertyUsageType: typeof result.property_usage_type === "string" ? result.property_usage_type : null,
        error: null,
      });
    } catch (error) {
      results.push({
        parcelId: strap,
        transformSuccess: false,
        propertyUsageType: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const manifest = {
    county: COUNTY_KEY,
    outputDir,
    roofAgeAsOfDate,
    results,
  };
  await writeFile(path.join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

/**
 * @typedef {object} RunValidationIssue
 * @property {string} parcelId
 * @property {string} reason
 */

/**
 * Structurally validate an ingest run: every successful parcel has a real
 * `transformed.zip` containing `data/property.json` and `data/parcel.json`.
 * Never calls `@elephant-xyz/cli validate` (Global Constraint).
 *
 * @param {{ outputDir: string, results: ParcelTransformResult[] }} manifest - Ingest run manifest.
 * @returns {Promise<{ valid: boolean, checked: number, issues: RunValidationIssue[] }>}
 *   Validation summary.
 */
export async function validateRun(manifest) {
  /** @type {RunValidationIssue[]} */
  const issues = [];
  let checked = 0;
  for (const parcel of manifest.results) {
    if (!parcel.transformSuccess) {
      issues.push({ parcelId: parcel.parcelId, reason: parcel.error ?? "transform did not succeed" });
      continue;
    }
    checked += 1;
    const parcelDir = path.join(manifest.outputDir, parcel.parcelId);
    if (!(await hasCompletedTransform(parcelDir))) {
      issues.push({ parcelId: parcel.parcelId, reason: "transformed.zip missing or not a valid PKZIP" });
      continue;
    }
    const files = readTransformedZipJsonFiles(path.join(parcelDir, "transformed.zip"));
    for (const required of ["property.json", "parcel.json"]) {
      if (files[required] === undefined) {
        issues.push({ parcelId: parcel.parcelId, reason: `transformed.zip is missing data/${required}` });
      }
    }
  }
  return { valid: issues.length === 0, checked, issues };
}

/**
 * @typedef {object} PublicationArtifacts
 * @property {string} county
 * @property {string} parquetPath
 * @property {string} coveragePath
 * @property {string} manifestPath
 * @property {string} bucket
 * @property {string} queryTableIpnsLabel
 * @property {string} coverageIpnsLabel
 * @property {number} rowCount
 * @property {number} expectedCount
 */

/**
 * Build the query-table Parquet + dataset-coverage JSON from a completed
 * ingest run.
 *
 * @param {{ outputDir: string, seedRows: readonly Record<string, string>[], publishDir: string }} run - Ingest output plus seed rows and destination directory.
 * @returns {Promise<PublicationArtifacts>} Written artifact paths and counts.
 */
export async function buildPublicationArtifacts({ outputDir, seedRows, publishDir }) {
  await mkdir(publishDir, { recursive: true });
  const expectedCount = seedRows.length;
  /** @type {Record<string, unknown>[]} */
  const rows = [];
  const missing = [];
  for (const row of seedRows) {
    const strap = row.parcel_id;
    const zipPath = path.join(outputDir, strap, "transformed.zip");
    try {
      const files = readTransformedZipJsonFiles(zipPath);
      if (files["property.json"] === undefined) {
        missing.push(strap);
        continue;
      }
      rows.push(mapTransformedFilesToQueryTableRow({ strap, files, seedRow: row }));
    } catch {
      missing.push(strap);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Missing transformed.zip/property.json for seed STRAPs: ${missing.join(", ")}`);
  }
  const identifiers = rows.map((row) => row.request_identifier);
  if (new Set(identifiers).size !== identifiers.length) {
    throw new Error("Query table would contain duplicate request_identifier values");
  }

  const parquetPath = path.join(publishDir, "query-table.parquet");
  const coveragePath = path.join(publishDir, "dataset-coverage.json");
  const manifestPath = path.join(publishDir, "manifest.json");
  await writeQueryTableParquet({ parquetPath, schemaFields: QUERY_TABLE_SCHEMA_FIELDS, rows });

  const exportedAt = new Date().toISOString();
  const coverage = buildCoverageSnapshot({
    county: COUNTY_KEY,
    source: "appraisal",
    ingestedCount: rows.length,
    expectedCount,
    exportedAt,
    ipnsLabel: COVERAGE_IPNS_LABEL,
  });
  await writeFile(coveragePath, `${JSON.stringify(coverage, null, 2)}\n`, "utf8");

  const artifacts = {
    county: COUNTY_KEY,
    parquetPath,
    coveragePath,
    manifestPath,
    bucket: QUERY_TABLE_BUCKET,
    queryTableIpnsLabel: QUERY_TABLE_IPNS_LABEL,
    coverageIpnsLabel: COVERAGE_IPNS_LABEL,
    rowCount: rows.length,
    expectedCount,
  };
  await writeFile(manifestPath, `${JSON.stringify(artifacts, null, 2)}\n`, "utf8");
  return artifacts;
}

/**
 * Pinellas adapter object consumed by the generic CLI/replay orchestration
 * in `bin/elephant-county.mjs` and `core/replay.mjs`.
 */
export const pinellasAdapter = {
  key: COUNTY_KEY,
  countyName: COUNTY_NAME,
  transformsDir: TRANSFORMS_DIR,
  flowPath: FLOW_PATH,
  buildSeed: buildPinellasSeedFiles,
  captureAndTransform,
  validateRun,
  buildPublicationArtifacts,
};
