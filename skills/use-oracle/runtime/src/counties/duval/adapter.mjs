/**
 * Duval county adapter: capture + transform, run validation, and
 * publication-artifact building. Registers `--county duval` alongside
 * Pinellas on the same `elephant-county` CLI verbs.
 *
 * `captureAndTransform` is adapted from `oracle-node@ff68b0b6`
 * `scripts/duval-local-pilot.mjs` (`runTransformScripts`,
 * `packageTransformedZip`, `validateParcelOutputs`, the per-parcel capture
 * flow) and `scripts/duval/pilot-lib.mjs` (`toCojCaptureUrl`,
 * `buildPropertySeed`, `buildUnnormalizedAddress`, `extractCanonicalRe`,
 * `assertCojDetailHtml`, `assertHtmlMatchesRequestedRe`,
 * `assertTransformedCounty`, `classifyDuvalFailure`), trimmed to a
 * single-parcel-at-a-time flow (no worker pool / concurrency — same scope
 * decision Pinellas made; see the Task 2 report) and generalized to run
 * from this package's own `counties/duval/transforms` rather than a sibling
 * `../Counties-trasform-scripts` checkout (Global Constraint).
 *
 * Unlike Pinellas (Gate B: exactly one always-succeeds fixture parcel),
 * Duval's manifest carries a three-way `success` / `permanent_failure` /
 * `retryable_failure` classification per parcel and persists every failure
 * to the shared `core/run-state.mjs` retry ledger, because a real Duval run
 * has both kinds of failure by construction (Global Constraint: `seed =
 * success + permanent_failure + retryable_failure`).
 *
 * @module counties/duval/adapter
 */

import AdmZipCtor from "adm-zip";
import { mkdir, readdir, readFile, writeFile, access, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCountyTransform } from "../../core/transform-runner.mjs";
import { readTransformedZipJsonFiles, writeQueryTableParquet, buildCoverageSnapshot } from "../../core/query-table.mjs";
import { classifyFailure, appendFailure } from "../../core/run-state.mjs";
import {
  mapTransformedFilesToQueryTableRow,
  COUNTY_KEY,
  COUNTY_NAME,
} from "./query-table.mjs";
import { duvalEnrichmentProfile } from "./enrichment-profile.mjs";
import { buildSeed as buildDuvalSeedFiles, COJ_DETAIL_URL, toCojDetailUrl, toCanonicalReDisplay, toText } from "./seed.mjs";
import { collectGeometryPoints, assertGeometryInCounty, assertManifestReconciled, assertUniqueParcelIds } from "./validate.mjs";

const RUNTIME_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const QUERY_TABLE_SCHEMA_FIELDS = duvalEnrichmentProfile.queryTable.schemaFields;
const {
  bucket: QUERY_TABLE_BUCKET,
  queryTableIpnsLabel: QUERY_TABLE_IPNS_LABEL,
  coverageIpnsLabel: COVERAGE_IPNS_LABEL,
} = duvalEnrichmentProfile.publication;
export const TRANSFORMS_DIR = path.join(RUNTIME_ROOT, "counties", "duval", "transforms");
export const FLOW_PATH = path.join(RUNTIME_ROOT, "counties", "duval", "flow.json");
export const STATIC_PARTS_PATH = path.join(RUNTIME_ROOT, "counties", "duval", "static-parts.csv");

/** Script order production `duval-local-pilot.mjs` uses (mapping scripts, then `data_extractor.js`). */
export const TRANSFORM_SCRIPTS = Object.freeze([
  "ownerMapping.js",
  "structureMapping.js",
  "utilityMapping.js",
  "layoutMapping.js",
  "data_extractor.js",
]);
/** Every successful Duval parcel must have both of these (`validateParcelOutputs` upstream). */
export const REQUIRED_DATA_ARTIFACTS = Object.freeze(["property.json", "address.json"]);
export const MIN_TRANSFORMED_ZIP_BYTES = 200;
export const ZIP_LOCAL_FILE_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
export const DEFAULT_JOB_ID = "duval-ingest";

const COJ_FETCH_HEADERS = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent": "Mozilla/5.0 (compatible; ElephantDuvalPilot/1.0; +https://github.com/elephant-xyz/oracle-node)",
};

const BLOCKED_PAGE_PATTERN = /access denied|request blocked|cloudflare|attention required|just a moment|captcha|enable javascript/i;
const RE_LABEL_PATTERN = /id=["']ctl00_cphBody_lblRealEstateNumber["'][^>]*>\s*([^<]+)/i;
const DISPLAY_RE_PATTERN = /\b(\d{6}-\d{4})\b/;

/**
 * @param {string} html - COJ detail-page HTML.
 * @returns {string} The dashed `RE #` display value (e.g. `096925-0000`).
 */
export function extractCanonicalRe(html) {
  const labeled = String(html).match(RE_LABEL_PATTERN);
  const candidate = toText(labeled?.[1] ?? "");
  if (DISPLAY_RE_PATTERN.test(candidate)) {
    return candidate.match(DISPLAY_RE_PATTERN)?.[1] ?? "";
  }
  const fallback = String(html).match(DISPLAY_RE_PATTERN);
  if (fallback) return fallback[1];
  throw new Error("COJ detail page is missing a canonical RE Number");
}

/**
 * Fail closed if a captured page looks blocked/challenged, is empty, or has
 * no canonical `RE #` label at all (independent of which parcel was
 * requested).
 *
 * @param {string} html - COJ detail-page HTML.
 * @returns {void}
 */
export function assertCojDetailHtml(html) {
  const body = String(html ?? "");
  if (BLOCKED_PAGE_PATTERN.test(body)) {
    throw new Error("COJ detail page looks blocked or challenged");
  }
  if (body.trim().length === 0) {
    throw new Error("COJ detail page is empty");
  }
  extractCanonicalRe(body);
}

/**
 * Fail closed unless the captured page's `RE #` matches the parcel this
 * capture requested (production incident guard: a swapped/misrouted COJ
 * response must never be silently transformed under the wrong parcel id).
 *
 * @param {string} html - Captured COJ detail-page HTML.
 * @param {unknown} sourceIdentifier - Canonical DOR parcel id the capture requested (e.g. `0969250000R`).
 * @returns {string} The matched `RE #` display value.
 */
export function assertHtmlMatchesRequestedRe(html, sourceIdentifier) {
  assertCojDetailHtml(html);
  const got = extractCanonicalRe(html).replace(/-/g, "");
  const expected = toCanonicalReDisplay(sourceIdentifier).replace(/-/g, "");
  if (got !== expected) {
    throw new Error(`COJ RE Number ${got} does not match requested ${expected}`);
  }
  return extractCanonicalRe(html);
}

/**
 * Build the COJ capture URL for one seed row (Detail.aspx `RE` query param,
 * carried in `multiValueQueryString` so `url` itself stays query-free).
 *
 * @param {Record<string, string>} row - Seed record.
 * @returns {string} Absolute COJ detail URL including the `RE` query param.
 */
export function toCojCaptureUrl(row) {
  const identifier = toText(row.source_identifier);
  if (!identifier) {
    throw new Error("missing source_identifier");
  }
  const baseUrl = toText(row.url) || COJ_DETAIL_URL;
  if (baseUrl.includes("Detail.aspx")) {
    let re = identifier;
    const rawQs = toText(row.multiValueQueryString);
    if (rawQs) {
      try {
        const parsed = JSON.parse(rawQs);
        const fromSeed = parsed?.RE?.[0];
        if (fromSeed != null && String(fromSeed).trim() !== "") re = String(fromSeed).trim();
      } catch {
        re = identifier;
      }
    }
    return `${baseUrl.split("?")[0]}?RE=${re}`;
  }
  return toCojDetailUrl(identifier);
}

/**
 * Build `property_seed.json` for one seed row.
 *
 * @param {Record<string, string>} row - Seed record.
 * @returns {{ parcel_id: string, source_http_request: { method: string, url: string }, request_identifier: string }} Seed file.
 */
export function buildPropertySeed(row) {
  const identifier = toText(row.source_identifier);
  return {
    parcel_id: toText(row.parcel_id) || identifier,
    source_http_request: { method: toText(row.method) || "GET", url: toCojCaptureUrl(row) },
    request_identifier: identifier,
  };
}

/**
 * Build `unnormalized_address.json` for one seed row. Capture-side address
 * objects use `county_jurisdiction`; transformed `address.json` uses
 * `county_name` (see {@link assertTransformedCounty}) — the two are never
 * interchangeable (Global Constraint: transformed county must be Duval).
 *
 * @param {Record<string, string>} row - Seed record.
 * @returns {Record<string, unknown>} Seed file.
 */
export function buildUnnormalizedAddress(row) {
  const fullAddress = toText(row.address);
  const lat = toText(row.latitude) === "" ? Number.NaN : Number(row.latitude);
  const lon = toText(row.longitude) === "" ? Number.NaN : Number(row.longitude);
  return {
    full_address: fullAddress,
    unnormalized_address: fullAddress,
    city: toText(row.city) || null,
    state: toText(row.state) || "FL",
    zip: toText(row.zip) || null,
    county_jurisdiction: COUNTY_NAME,
    latitude: Number.isFinite(lat) ? lat : null,
    longitude: Number.isFinite(lon) ? lon : null,
    request_identifier: toText(row.source_identifier || row.parcel_id),
  };
}

/**
 * Fail closed unless a transformed `address.json` carries `county_name:
 * "Duval"` (the Columbia-county incident this guards against was a
 * transform emitting the wrong county; a missing or differently-named key
 * must fail rather than fall back).
 *
 * @param {Record<string, unknown> | null | undefined} record - Transformed `data/address.json`.
 * @returns {void}
 */
export function assertTransformedCounty(record) {
  if (!record || typeof record !== "object") {
    throw new Error("transformed address is missing; expected county_name Duval");
  }
  if (record.county_name !== COUNTY_NAME) {
    throw new Error(`transformed county_name must be ${COUNTY_NAME}, got ${String(record.county_name)}`);
  }
}

/**
 * Classify a capture/transform failure for retry policy, layering
 * Duval-specific permanent patterns (blocked page, RE mismatch, wrong
 * county, out-of-bbox geometry) on top of the shared
 * `core/run-state.mjs#classifyFailure` transient/permanent/unknown rules.
 *
 * @param {unknown} error - Error or message.
 * @returns {"transient" | "permanent" | "unknown"} Retry classification.
 */
export function classifyDuvalFailure(error) {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (
    /empty|blocked|challenged|missing a canonical re|does not match requested|http 403|http 404|http 400|missing source_identifier|county_name|county_jurisdiction|enoent|outside the duval bbox/.test(
      message,
    )
  ) {
    return "permanent";
  }
  return classifyFailure(error);
}

/**
 * @param {string} candidate - Filesystem path.
 * @returns {Promise<boolean>} Whether the path exists and is readable.
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
 * @param {string} parcelDir - Per-parcel output directory.
 * @returns {Promise<boolean>} Whether a usable `transformed.zip` exists.
 */
export async function hasCompletedTransform(parcelDir) {
  const zipPath = path.join(parcelDir, "transformed.zip");
  try {
    const buffer = await readFile(zipPath);
    return buffer.length >= MIN_TRANSFORMED_ZIP_BYTES && buffer.subarray(0, 4).equals(ZIP_LOCAL_FILE_MAGIC);
  } catch {
    return false;
  }
}

/**
 * Fetch COJ detail-page HTML for one canonical capture URL. Only called
 * when the caller has explicitly opted into `--live-fetch`; see
 * {@link captureAndTransform}.
 *
 * @param {string} url - Absolute COJ detail URL.
 * @returns {Promise<string>} Raw HTML.
 */
export async function fetchCojDetailHtml(url) {
  const response = await fetch(url, { headers: COJ_FETCH_HEADERS, redirect: "follow" });
  if (!response.ok) {
    throw new Error(`COJ detail HTTP ${response.status} for ${url}`);
  }
  return response.text();
}

/**
 * Zip a parcel's `data/` directory into `transformed.zip`, matching the
 * `data/<file>` entry layout `packageTransformedZip` produces upstream.
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
 * @property {string} htmlDir - Directory of `<parcel_id>.html` fixture/cache files.
 * @property {string} outputDir - Run directory; one `<parcel_id>/` subdirectory is created per parcel.
 * @property {boolean} [liveFetch] - When true, fetch missing HTML from COJ. Defaults to false (fail closed).
 * @property {string} [jobId] - Retry-ledger job id (see `core/run-state.mjs`). Defaults to {@link DEFAULT_JOB_ID}.
 */

/**
 * @typedef {"success" | "permanent_failure" | "retryable_failure"} ParcelClassification
 */

/**
 * @typedef {object} ParcelTransformResult
 * @property {string} parcelId - 10-digit undashed DOR parcel id.
 * @property {boolean} transformSuccess - Whether the transform completed.
 * @property {ParcelClassification} classification - Three-way outcome bucket (Global Constraint).
 * @property {string | null} propertyUsageType - Transformed `property.json` usage type.
 * @property {string | null} error - Failure message, when unsuccessful.
 */

/**
 * Capture (or reuse fixture) HTML and run the Duval transform scripts for
 * every seed row, writing `<outputDir>/<parcel_id>/{input.html,data/,transformed.zip}`
 * plus a run `manifest.json`. Every failure — permanent or retryable — is
 * also appended to the shared retry ledger (`core/run-state.mjs#appendFailure`)
 * under `jobId` so a future run can call `loadRetryableFailures` to resume.
 *
 * Fails closed: a missing local HTML file is a hard error unless
 * `liveFetch` is explicitly `true` (Global Constraint).
 *
 * @param {CaptureAndTransformOptions} options - Seed rows, HTML source, and output directory.
 * @returns {Promise<{ county: string, outputDir: string, jobId: string, results: ParcelTransformResult[], reconciled: import("./validate.mjs").ManifestReconciliation }>}
 *   Run manifest, also written to `<outputDir>/manifest.json`.
 */
export async function captureAndTransform({ seedRows, htmlDir, outputDir, liveFetch = false, jobId = DEFAULT_JOB_ID }) {
  await mkdir(outputDir, { recursive: true });
  /** @type {ParcelTransformResult[]} */
  const results = [];
  for (const row of seedRows) {
    const parcelId = row.parcel_id;
    const parcelDir = path.join(outputDir, parcelId);
    await mkdir(parcelDir, { recursive: true });
    try {
      const fixtureHtmlPath = path.join(htmlDir, `${parcelId}.html`);
      const inputHtmlPath = path.join(parcelDir, "input.html");
      let html;
      if (await pathExists(fixtureHtmlPath)) {
        html = await readFile(fixtureHtmlPath, "utf8");
        await copyFile(fixtureHtmlPath, inputHtmlPath);
      } else if (liveFetch === true) {
        html = await fetchCojDetailHtml(toCojCaptureUrl(row));
        await writeFile(inputHtmlPath, html, "utf8");
      } else {
        throw new Error(
          `No local HTML fixture for parcel ${parcelId} at ${fixtureHtmlPath} and --live-fetch was not supplied; refusing to contact COJ.`,
        );
      }

      assertHtmlMatchesRequestedRe(html, row.source_identifier);

      const propertySeed = buildPropertySeed(row);
      const unnormalizedAddress = buildUnnormalizedAddress(row);
      await writeFile(path.join(parcelDir, "property_seed.json"), `${JSON.stringify(propertySeed, null, 2)}\n`, "utf8");
      await writeFile(
        path.join(parcelDir, "unnormalized_address.json"),
        `${JSON.stringify(unnormalizedAddress, null, 2)}\n`,
        "utf8",
      );

      const { result, dataDir } = runCountyTransform({
        scriptsDir: TRANSFORMS_DIR,
        scriptNames: TRANSFORM_SCRIPTS,
        workDir: parcelDir,
        resultFile: "data/property.json",
      });

      const address = JSON.parse(await readFile(path.join(dataDir, "address.json"), "utf8"));
      assertTransformedCounty(address);

      /** @type {Array<{ latitude: number, longitude: number }>} */
      const geometryPoints = [];
      const geometryPath = path.join(dataDir, "geometry.json");
      if (await pathExists(geometryPath)) {
        geometryPoints.push(...collectGeometryPoints(JSON.parse(await readFile(geometryPath, "utf8"))));
      }
      assertGeometryInCounty(geometryPoints);

      await zipDataDirectory(dataDir, path.join(parcelDir, "transformed.zip"));

      results.push({
        parcelId,
        transformSuccess: true,
        classification: "success",
        propertyUsageType: typeof result.property_usage_type === "string" ? result.property_usage_type : null,
        error: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failureClass = classifyDuvalFailure(error);
      const classification = failureClass === "permanent" ? "permanent_failure" : "retryable_failure";
      await appendFailure(outputDir, jobId, {
        parcelId,
        error: message,
        classification: failureClass,
        attempts: 1,
        at: new Date().toISOString(),
        jobId,
      });
      results.push({ parcelId, transformSuccess: false, classification, propertyUsageType: null, error: message });
    }
  }
  const reconciled = {
    seedRows: seedRows.length,
    success: results.filter((row) => row.classification === "success").length,
    permanentFailure: results.filter((row) => row.classification === "permanent_failure").length,
    retryableFailure: results.filter((row) => row.classification === "retryable_failure").length,
  };
  const manifest = { county: COUNTY_KEY, outputDir, jobId, results, reconciled };
  await writeFile(path.join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

/**
 * @typedef {object} RunValidationIssue
 * @property {string | null} parcelId
 * @property {string} reason
 */

/**
 * @typedef {object} ValidateRunOptions
 * @property {boolean} [allowEmpty] - When true, a run with `seedRows > 0` and
 *   zero successful parcels is not treated as an error (Global Constraint
 *   fail-closed gate; see {@link validateRun}). Defaults to false.
 */

/**
 * Structurally validate an ingest run: the manifest reconciles
 * (`seed = success + permanent_failure + retryable_failure`), every
 * `parcelId` is unique, at least one parcel succeeded (unless the seed was
 * empty or `options.allowEmpty` is set), and every `success` parcel has a
 * real `transformed.zip` containing `data/property.json` and
 * `data/address.json`. Never calls `@elephant-xyz/cli validate` (Global
 * Constraint).
 *
 * A run where every seed row failed (`checked === 0` with a non-empty seed)
 * is fail-closed by default: it is reported as invalid rather than
 * trivially "valid" (there is nothing to check), because a caller that
 * doesn't inspect `checked` could otherwise treat a 100%-failure run as a
 * green light to publish. Pass `{ allowEmpty: true }` to explicitly permit
 * this (e.g. a deliberate empty/no-op export).
 *
 * @param {{ outputDir: string, results: ParcelTransformResult[], reconciled?: import("./validate.mjs").ManifestReconciliation }} manifest - Ingest run manifest.
 * @param {ValidateRunOptions} [options] - Validation options.
 * @returns {Promise<{ valid: boolean, checked: number, issues: RunValidationIssue[] }>}
 *   Validation summary.
 */
export async function validateRun(manifest, options = {}) {
  const allowEmpty = options.allowEmpty === true;
  /** @type {RunValidationIssue[]} */
  const issues = [];
  let checked = 0;

  const reconciled = manifest.reconciled ?? {
    seedRows: manifest.results.length,
    success: manifest.results.filter((row) => row.classification === "success").length,
    permanentFailure: manifest.results.filter((row) => row.classification === "permanent_failure").length,
    retryableFailure: manifest.results.filter((row) => row.classification === "retryable_failure").length,
  };
  try {
    assertManifestReconciled(reconciled);
  } catch (error) {
    issues.push({ parcelId: null, reason: error instanceof Error ? error.message : String(error) });
  }
  try {
    assertUniqueParcelIds(manifest.results);
  } catch (error) {
    issues.push({ parcelId: null, reason: error instanceof Error ? error.message : String(error) });
  }
  if (reconciled.seedRows > 0 && reconciled.success === 0 && !allowEmpty) {
    issues.push({
      parcelId: null,
      reason:
        `0 of ${reconciled.seedRows} seed rows produced a successful parcel; refusing to treat an all-failure ` +
        `run as valid. Pass { allowEmpty: true } (CLI: --allow-empty) to permit an empty export.`,
    });
  }

  for (const parcel of manifest.results) {
    if (parcel.classification !== "success") continue;
    checked += 1;
    const parcelDir = path.join(manifest.outputDir, parcel.parcelId);
    if (!(await hasCompletedTransform(parcelDir))) {
      issues.push({ parcelId: parcel.parcelId, reason: "transformed.zip missing or not a valid PKZIP" });
      continue;
    }
    const files = readTransformedZipJsonFiles(path.join(parcelDir, "transformed.zip"));
    for (const required of REQUIRED_DATA_ARTIFACTS) {
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
 * @typedef {object} BuildPublicationArtifactsOptions
 * @property {string} outputDir - Ingest run directory (holds `<parcel_id>/transformed.zip` per parcel).
 * @property {readonly Record<string, string>[]} seedRows - Seed rows the ingest run attempted.
 * @property {string} publishDir - Destination directory for the Parquet/coverage/manifest files.
 * @property {boolean} [allowEmpty] - When true, permit writing a zero-row
 *   query table for a non-empty seed (Global Constraint fail-closed gate;
 *   see {@link buildPublicationArtifacts}). Defaults to false.
 */

/**
 * Build the query-table Parquet + dataset-coverage JSON from a completed
 * ingest run. Unlike Pinellas (which requires every seed row to have
 * succeeded), Duval query-table rows are exactly the successfully
 * transformed, complete parcels (Global Constraint: `query-table rows =
 * successful complete parcels`) — a permanently or retryably failed parcel
 * is silently excluded rather than failing the export.
 *
 * Fails closed on an empty export: if the seed was non-empty but zero
 * parcels produced a row (e.g. every parcel failed), this throws *before*
 * writing any Parquet/coverage file, rather than silently publishing a
 * zero-row table, unless `options.allowEmpty` is explicitly `true`.
 *
 * @param {BuildPublicationArtifactsOptions} run - Ingest output, seed rows, destination directory, and options.
 * @returns {Promise<PublicationArtifacts>} Written artifact paths and counts.
 */
export async function buildPublicationArtifacts({ outputDir, seedRows, publishDir, allowEmpty = false }) {
  const expectedCount = seedRows.length;
  /** @type {Record<string, unknown>[]} */
  const rows = [];
  for (const row of seedRows) {
    const zipPath = path.join(outputDir, row.parcel_id, "transformed.zip");
    try {
      const files = readTransformedZipJsonFiles(zipPath);
      if (files["property.json"] === undefined) continue;
      rows.push(
        mapTransformedFilesToQueryTableRow({
          parcelId: row.source_identifier || row.parcel_id,
          files,
          seedRow: row,
        }),
      );
    } catch {
      continue;
    }
  }
  const identifiers = rows.map((row) => row.request_identifier);
  if (new Set(identifiers).size !== identifiers.length) {
    throw new Error("Query table would contain duplicate request_identifier values");
  }
  if (expectedCount > 0 && rows.length === 0 && allowEmpty !== true) {
    throw new Error(
      `Refusing to publish an empty Duval query table: 0 of ${expectedCount} seed rows produced a successful, ` +
        `complete parcel. Pass { allowEmpty: true } (CLI: --allow-empty) to permit an empty export.`,
    );
  }

  await mkdir(publishDir, { recursive: true });
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
 * Duval adapter object consumed by the generic CLI/replay orchestration in
 * `bin/elephant-county.mjs` and `core/replay.mjs`.
 */
export const duvalAdapter = {
  key: COUNTY_KEY,
  countyName: COUNTY_NAME,
  transformsDir: TRANSFORMS_DIR,
  flowPath: FLOW_PATH,
  buildSeed: buildDuvalSeedFiles,
  captureAndTransform,
  validateRun,
  buildPublicationArtifacts,
};
