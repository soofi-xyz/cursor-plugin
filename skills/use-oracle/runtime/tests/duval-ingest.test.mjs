import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createRequire } from "node:module";

import { parseCsvRecords } from "../src/core/csv.mjs";
import { readTransformedZipJsonFiles } from "../src/core/query-table.mjs";
import { loadRetryableFailures, runStatePaths } from "../src/core/run-state.mjs";
import { runReplay } from "../src/core/replay.mjs";
import {
  extractCanonicalRe,
  assertCojDetailHtml,
  assertHtmlMatchesRequestedRe,
  toCojCaptureUrl,
  buildPropertySeed,
  buildUnnormalizedAddress,
  assertTransformedCounty,
  classifyDuvalFailure,
  hasCompletedTransform,
  captureAndTransform,
  validateRun,
  buildPublicationArtifacts,
  duvalAdapter,
  ZIP_LOCAL_FILE_MAGIC,
  TRANSFORMS_DIR,
} from "../src/counties/duval/adapter.mjs";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const { ParquetReader } = require("@dsnp/parquetjs");

const RUNTIME_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = path.join(RUNTIME_ROOT, "fixtures", "duval-replay");
const CLI_PATH = path.join(RUNTIME_ROOT, "bin", "elephant-county.mjs");
const PARCEL_ID = "0969250000";
const RE_NUMBER = "0969250000R";

async function loadFixtureSeedRows() {
  return parseCsvRecords(await readFile(path.join(FIXTURE_DIR, "seed.csv"), "utf8"));
}

async function readParquetRows(parquetPath) {
  const reader = await ParquetReader.openFile(parquetPath);
  try {
    const cursor = reader.getCursor();
    const rows = [];
    let record = await cursor.next();
    while (record) {
      rows.push(record);
      record = await cursor.next();
    }
    return rows;
  } finally {
    await reader.close();
  }
}

describe("Duval capture request/seed-file construction", () => {
  it("builds the COJ capture URL with the RE query param from multiValueQueryString", async () => {
    const [row] = await loadFixtureSeedRows();
    const url = toCojCaptureUrl(row);
    expect(url).toBe(`https://paopropertysearch.coj.net/Basic/Detail.aspx?RE=${RE_NUMBER}`);
  });

  it("falls back to source_identifier when multiValueQueryString is unusable", () => {
    expect(toCojCaptureUrl({ source_identifier: RE_NUMBER, url: "https://paopropertysearch.coj.net/Basic/Detail.aspx" })).toBe(
      `https://paopropertysearch.coj.net/Basic/Detail.aspx?RE=${RE_NUMBER}`,
    );
    expect(() => toCojCaptureUrl({ source_identifier: "" })).toThrow(/missing source_identifier/);
  });

  it("builds property_seed.json / unnormalized_address.json from the fixture row", async () => {
    const [row] = await loadFixtureSeedRows();
    const propertySeed = buildPropertySeed(row);
    expect(propertySeed.parcel_id).toBe(PARCEL_ID);
    expect(propertySeed.request_identifier).toBe(RE_NUMBER);
    expect(propertySeed.source_http_request.url).toContain(`RE=${RE_NUMBER}`);

    const unnormalizedAddress = buildUnnormalizedAddress(row);
    expect(unnormalizedAddress.full_address).toBe("4200 RIVERSIDE AVE, JACKSONVILLE FL 32205");
    expect(unnormalizedAddress.county_jurisdiction).toBe("Duval");
    expect(unnormalizedAddress.latitude).toBeCloseTo(30.31);
  });

  it("reports no completed transform for a directory with no transformed.zip", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "duval-no-zip-"));
    try {
      expect(await hasCompletedTransform(tempDir)).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("COJ detail-page guards", () => {
  const validHtml = '<span id="ctl00_cphBody_lblRealEstateNumber">096925-0000</span>';

  it("extracts the canonical RE # from a labeled span", () => {
    expect(extractCanonicalRe(validHtml)).toBe("096925-0000");
  });

  it("fails closed on empty or blocked-looking HTML", () => {
    expect(() => assertCojDetailHtml("")).toThrow(/empty/);
    expect(() => assertCojDetailHtml("<html>Request Blocked</html>")).toThrow(/blocked or challenged/);
    expect(() => assertCojDetailHtml("<html>no RE number here</html>")).toThrow(/missing a canonical RE Number/);
  });

  it("fails closed when the captured RE # does not match the requested parcel", () => {
    expect(() => assertHtmlMatchesRequestedRe(validHtml, "0000000001R")).toThrow(/does not match requested/);
    expect(assertHtmlMatchesRequestedRe(validHtml, RE_NUMBER)).toBe("096925-0000");
  });
});

describe("assertTransformedCounty (Global Constraint)", () => {
  it("passes for a Duval address record", () => {
    expect(() => assertTransformedCounty({ county_name: "Duval" })).not.toThrow();
  });

  it("fails closed on a missing or wrong county_name", () => {
    expect(() => assertTransformedCounty(null)).toThrow(/county_name Duval/);
    expect(() => assertTransformedCounty({ county_name: "Columbia" })).toThrow(/must be Duval, got Columbia/);
  });
});

describe("classifyDuvalFailure (failure classification)", () => {
  it("classifies Duval-specific permanent patterns", () => {
    expect(classifyDuvalFailure(new Error("COJ RE Number 1 does not match requested 2"))).toBe("permanent");
    expect(classifyDuvalFailure(new Error("COJ detail page is empty"))).toBe("permanent");
    expect(classifyDuvalFailure(new Error("coordinate 1,1 is outside the Duval bbox"))).toBe("permanent");
    expect(classifyDuvalFailure(new Error("transformed county_name must be Duval, got Columbia"))).toBe("permanent");
  });

  it("defers to the shared transient/unknown classification otherwise", () => {
    expect(classifyDuvalFailure(new Error("fetch failed: ECONNRESET"))).toBe("transient");
    expect(classifyDuvalFailure(new Error("something unexpected happened"))).toBe("unknown");
  });
});

describe("captureAndTransform (Gate B fixture, no network)", () => {
  it("only ships the five allow-listed production transform scripts (no backup/node_modules)", async () => {
    const { readdir } = await import("node:fs/promises");
    const entries = (await readdir(TRANSFORMS_DIR)).filter(
      (name) => name !== "package.json" && !name.endsWith(".test.js"),
    );
    expect(entries.sort()).toEqual(
      ["data_extractor.js", "layoutMapping.js", "ownerMapping.js", "structureMapping.js", "utilityMapping.js"].sort(),
    );
  });

  it("transforms the synthetic parcel from fixture HTML into a valid ZIP with the required JSON", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "duval-ingest-"));
    try {
      const seedRows = await loadFixtureSeedRows();
      const outputDir = path.join(tempDir, "ingest");
      const manifest = await captureAndTransform({
        seedRows,
        htmlDir: path.join(FIXTURE_DIR, "html"),
        outputDir,
        liveFetch: false,
      });

      expect(manifest.county).toBe("duval");
      expect(manifest.results).toEqual([
        {
          parcelId: PARCEL_ID,
          transformSuccess: true,
          classification: "success",
          propertyUsageType: "Residential",
          error: null,
        },
      ]);
      expect(manifest.reconciled).toEqual({ seedRows: 1, success: 1, permanentFailure: 0, retryableFailure: 0 });

      const zipPath = path.join(outputDir, PARCEL_ID, "transformed.zip");
      const zipBytes = await readFile(zipPath);
      expect(zipBytes.subarray(0, 4)).toEqual(ZIP_LOCAL_FILE_MAGIC);
      expect(await hasCompletedTransform(path.join(outputDir, PARCEL_ID))).toBe(true);

      const files = readTransformedZipJsonFiles(zipPath);
      for (const required of ["property.json", "address.json", "parcel.json", "geometry.json"]) {
        expect(files[required], `missing data/${required}`).toBeDefined();
      }
      expect(files["address.json"].county_name).toBe("Duval");

      const manifestOnDisk = JSON.parse(await readFile(path.join(outputDir, "manifest.json"), "utf8"));
      expect(manifestOnDisk).toEqual(manifest);

      const validation = await validateRun(manifest);
      expect(validation).toEqual({ valid: true, checked: 1, issues: [] });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails closed when a parcel has no local HTML fixture and liveFetch is not requested", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "duval-missing-html-"));
    try {
      const [fixtureRow] = await loadFixtureSeedRows();
      const missingRow = { ...fixtureRow, parcel_id: "9999999999", source_identifier: "9999999999R" };
      const outputDir = path.join(tempDir, "ingest");
      const manifest = await captureAndTransform({
        seedRows: [missingRow],
        htmlDir: path.join(FIXTURE_DIR, "html"),
        outputDir,
        liveFetch: false,
      });
      expect(manifest.results).toHaveLength(1);
      expect(manifest.results[0].transformSuccess).toBe(false);
      expect(manifest.results[0].classification).toBe("retryable_failure");
      expect(manifest.results[0].error).toMatch(/No local HTML fixture/);
      expect(manifest.results[0].error).toMatch(/--live-fetch was not supplied/);

      // A 1-of-1 all-failure run is NOT a valid export by default (fail-closed
      // gate, review finding #1): `checked` stays 0 (nothing to structurally
      // check), but the run as a whole is reported invalid rather than
      // trivially "valid".
      const validation = await validateRun(manifest);
      expect(validation.valid).toBe(false);
      expect(validation.checked).toBe(0);
      expect(validation.issues.some((issue) => /0 of 1 seed rows produced a successful parcel/.test(issue.reason))).toBe(
        true,
      );

      // `{ allowEmpty: true }` (CLI: --allow-empty) explicitly opts back into
      // treating the all-failure run as valid.
      const allowedValidation = await validateRun(manifest, { allowEmpty: true });
      expect(allowedValidation.valid).toBe(true);
      expect(allowedValidation.checked).toBe(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not attempt a live COJ fetch (no network call) for a fixture-covered parcel even without --live-fetch", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("captureAndTransform must not call fetch() when a fixture HTML file is present");
    };
    const tempDir = await mkdtemp(path.join(tmpdir(), "duval-no-network-"));
    try {
      const seedRows = await loadFixtureSeedRows();
      const manifest = await captureAndTransform({
        seedRows,
        htmlDir: path.join(FIXTURE_DIR, "html"),
        outputDir: path.join(tempDir, "ingest"),
        liveFetch: false,
      });
      expect(manifest.results[0].transformSuccess).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("exposes the same captureAndTransform/validateRun functions on the duvalAdapter object", () => {
    expect(duvalAdapter.captureAndTransform).toBe(captureAndTransform);
    expect(duvalAdapter.validateRun).toBe(validateRun);
    expect(duvalAdapter.buildPublicationArtifacts).toBe(buildPublicationArtifacts);
    expect(duvalAdapter.key).toBe("duval");
    expect(duvalAdapter.countyName).toBe("Duval");
  });
});

describe("manifest reconciliation + retry ledger (Global Constraint)", () => {
  it("reconciles seed = success + permanent_failure + retryable_failure and persists every failure to the retry ledger", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "duval-reconcile-"));
    try {
      const [fixtureRow] = await loadFixtureSeedRows();
      const fixtureHtml = await readFile(path.join(FIXTURE_DIR, "html", `${PARCEL_ID}.html`), "utf8");

      // A second, distinct parcel id whose captured HTML is (deliberately)
      // the *same* fixture page: its embedded RE # will not match the
      // requested parcel, so this is a permanent failure (RE mismatch).
      const permanentRow = { ...fixtureRow, parcel_id: "0000000001", source_identifier: "0000000001R" };
      // A third parcel id with no HTML fixture at all and no --live-fetch:
      // an "unknown" classification, i.e. retryable.
      const retryableRow = { ...fixtureRow, parcel_id: "9999999999", source_identifier: "9999999999R" };

      const htmlDir = path.join(tempDir, "html");
      await mkdir(htmlDir, { recursive: true });
      await writeFile(path.join(htmlDir, `${PARCEL_ID}.html`), fixtureHtml, "utf8");
      await writeFile(path.join(htmlDir, `${permanentRow.parcel_id}.html`), fixtureHtml, "utf8");

      const outputDir = path.join(tempDir, "ingest");
      const jobId = "duval-reconcile-test";
      const manifest = await captureAndTransform({
        seedRows: [fixtureRow, permanentRow, retryableRow],
        htmlDir,
        outputDir,
        liveFetch: false,
        jobId,
      });

      expect(manifest.reconciled).toEqual({
        seedRows: 3,
        success: 1,
        permanentFailure: 1,
        retryableFailure: 1,
      });
      const byParcelId = Object.fromEntries(manifest.results.map((result) => [result.parcelId, result]));
      expect(byParcelId[PARCEL_ID].classification).toBe("success");
      expect(byParcelId[permanentRow.parcel_id].classification).toBe("permanent_failure");
      expect(byParcelId[permanentRow.parcel_id].error).toMatch(/does not match requested/);
      expect(byParcelId[retryableRow.parcel_id].classification).toBe("retryable_failure");

      // Every seed row is unique and the manifest reconciles structurally too.
      const validation = await validateRun(manifest);
      expect(validation.valid).toBe(true);
      expect(validation.checked).toBe(1);

      // The retry ledger recorded both failures, and only the retryable one
      // comes back from loadRetryableFailures by default.
      const { failuresPath } = runStatePaths(outputDir, jobId);
      const failureLines = (await readFile(failuresPath, "utf8")).trim().split("\n");
      expect(failureLines).toHaveLength(2);

      const retryable = await loadRetryableFailures(outputDir, jobId);
      expect(retryable).toHaveLength(1);
      expect(retryable[0].parcelId).toBe(retryableRow.parcel_id);
      expect(retryable[0].classification).toBe("unknown");

      const everyFailure = await loadRetryableFailures(outputDir, jobId, { includePermanent: true });
      expect(everyFailure.map((row) => row.parcelId).sort()).toEqual(
        [permanentRow.parcel_id, retryableRow.parcel_id].sort(),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails closed when manifest results contain a duplicate parcelId", async () => {
    const [fixtureRow] = await loadFixtureSeedRows();
    const manifest = {
      outputDir: "/unused",
      results: [
        { parcelId: PARCEL_ID, classification: "success" },
        { parcelId: PARCEL_ID, classification: "success" },
      ],
      reconciled: { seedRows: 2, success: 2, permanentFailure: 0, retryableFailure: 0 },
    };
    const validation = await validateRun(manifest);
    expect(validation.valid).toBe(false);
    expect(validation.issues.some((issue) => /duplicate parcelId/.test(issue.reason))).toBe(true);
    void fixtureRow;
  });
});

describe("all-fail empty-export gate (Review finding #1, fail-closed by default)", () => {
  it("validateRun rejects a 1-of-1 all-permanent-failure run by default, and accepts it with allowEmpty", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "duval-all-fail-validate-"));
    try {
      const [fixtureRow] = await loadFixtureSeedRows();
      const fixtureHtml = await readFile(path.join(FIXTURE_DIR, "html", `${PARCEL_ID}.html`), "utf8");
      // Same HTML fixture served under a mismatched parcel id: this is a
      // deterministic *permanent* failure (RE Number mismatch), not just a
      // missing-fixture retryable one, so the only reason `checked` stays 0
      // is that nothing succeeded — not that nothing was attempted.
      const permanentRow = { ...fixtureRow, parcel_id: "0000000001", source_identifier: "0000000001R" };
      const htmlDir = path.join(tempDir, "html");
      await mkdir(htmlDir, { recursive: true });
      await writeFile(path.join(htmlDir, `${permanentRow.parcel_id}.html`), fixtureHtml, "utf8");

      const outputDir = path.join(tempDir, "ingest");
      const manifest = await captureAndTransform({
        seedRows: [permanentRow],
        htmlDir,
        outputDir,
        liveFetch: false,
      });
      expect(manifest.reconciled).toEqual({ seedRows: 1, success: 0, permanentFailure: 1, retryableFailure: 0 });

      const rejected = await validateRun(manifest);
      expect(rejected.valid).toBe(false);
      expect(rejected.checked).toBe(0);
      expect(
        rejected.issues.some((issue) => /0 of 1 seed rows produced a successful parcel/.test(issue.reason)),
      ).toBe(true);

      const accepted = await validateRun(manifest, { allowEmpty: true });
      expect(accepted.valid).toBe(true);
      expect(accepted.checked).toBe(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("validateRun does not require allowEmpty for a genuinely empty seed (seedRows === 0)", async () => {
    const manifest = {
      outputDir: "/unused",
      results: [],
      reconciled: { seedRows: 0, success: 0, permanentFailure: 0, retryableFailure: 0 },
    };
    const validation = await validateRun(manifest);
    expect(validation).toEqual({ valid: true, checked: 0, issues: [] });
  });

  it("buildPublicationArtifacts throws on a 1-of-1 all-failure run by default, and writes a zero-row table with allowEmpty", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "duval-all-fail-export-"));
    try {
      const [fixtureRow] = await loadFixtureSeedRows();
      const missingRow = { ...fixtureRow, parcel_id: "9999999999", source_identifier: "9999999999R" };
      const outputDir = path.join(tempDir, "ingest");
      await captureAndTransform({
        seedRows: [missingRow],
        htmlDir: path.join(FIXTURE_DIR, "html"),
        outputDir,
        liveFetch: false,
      });

      const publishDir = path.join(tempDir, "publish");
      await expect(
        buildPublicationArtifacts({ outputDir, seedRows: [missingRow], publishDir }),
      ).rejects.toThrow(/Refusing to publish an empty Duval query table/);

      // Nothing was written on the rejected attempt.
      const { access } = await import("node:fs/promises");
      await expect(access(path.join(publishDir, "query-table.parquet"))).rejects.toThrow();

      const artifacts = await buildPublicationArtifacts({
        outputDir,
        seedRows: [missingRow],
        publishDir,
        allowEmpty: true,
      });
      expect(artifacts.rowCount).toBe(0);
      expect(artifacts.expectedCount).toBe(1);

      const rows = await readParquetRows(artifacts.parquetPath);
      expect(rows).toHaveLength(0);

      const coverage = JSON.parse(await readFile(artifacts.coveragePath, "utf8"));
      expect(coverage.datasets[0].ingested_count).toBe(0);
      expect(coverage.datasets[0].expected_count).toBe(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("buildPublicationArtifacts never throws the empty-export error for a genuinely empty seed (seedRows === 0)", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "duval-zero-seed-export-"));
    try {
      const artifacts = await buildPublicationArtifacts({
        outputDir: path.join(tempDir, "ingest"),
        seedRows: [],
        publishDir: path.join(tempDir, "publish"),
      });
      expect(artifacts.rowCount).toBe(0);
      expect(artifacts.expectedCount).toBe(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("runReplay (in-process pipeline)", () => {
  it("runs the full offline pipeline: seed -> capture/transform -> artifacts -> credential-free dry-run", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "duval-replay-inprocess-"));
    try {
      const replay = await runReplay({ adapter: duvalAdapter, fixtureDir: FIXTURE_DIR, outputDir: tempDir, skipValidate: false });

      expect(replay.seedRows).toHaveLength(1);
      expect(replay.manifest.results).toEqual([
        {
          parcelId: PARCEL_ID,
          transformSuccess: true,
          classification: "success",
          propertyUsageType: "Residential",
          error: null,
        },
      ]);
      expect(replay.validation).toEqual({ valid: true, checked: 1, issues: [] });
      expect(replay.artifacts.rowCount).toBe(1);
      expect(replay.artifacts.expectedCount).toBe(1);
      expect(replay.publishResult).toEqual({
        dryRun: true,
        bucket: "elephant-oracle-query-table",
        queryTableIpnsLabel: "oracle-query-table-duval",
        coverageIpnsLabel: "oracle-dataset-coverage-duval",
      });

      const rows = await readParquetRows(replay.artifacts.parquetPath);
      expect(rows).toHaveLength(1);
      expect(rows[0].source_system).toBe("duval_appraiser");
      expect(rows[0].request_identifier).toBe(RE_NUMBER);
      expect(rows[0].county_name).toBe("Duval");

      const coverage = JSON.parse(await readFile(replay.artifacts.coveragePath, "utf8"));
      expect(coverage.datasets).toHaveLength(1);
      expect(coverage.datasets[0].ingested_count).toBe(1);
      expect(coverage.datasets[0].expected_count).toBe(1);
      expect(coverage.datasets[0].county).toBe("duval");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("elephant-county replay (public CLI, subprocess)", () => {
  it("produces required transformed JSON, a valid ZIP, one Parquet row, matching one-row coverage, and a dry-run publish for --county duval", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "duval-replay-cli-"));
    const cwdDir = await mkdtemp(path.join(tmpdir(), "duval-replay-cwd-"));
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [CLI_PATH, "replay", "--county", "duval", "--fixture", FIXTURE_DIR, "--output", tempDir],
        { cwd: cwdDir },
      );
      const summary = JSON.parse(stdout);
      expect(summary.event).toBe("replay_complete");
      expect(summary.county).toBe("duval");
      expect(summary.manifest.results[0].transformSuccess).toBe(true);

      expect(summary.artifacts.bucket).toBe("elephant-oracle-query-table");
      expect(summary.artifacts.queryTableIpnsLabel).toBe("oracle-query-table-duval");
      expect(summary.artifacts.coverageIpnsLabel).toBe("oracle-dataset-coverage-duval");
      expect(summary.artifacts.rowCount).toBe(1);
      expect(summary.artifacts.expectedCount).toBe(1);

      expect(summary.publishResult).toEqual({
        dryRun: true,
        bucket: "elephant-oracle-query-table",
        queryTableIpnsLabel: "oracle-query-table-duval",
        coverageIpnsLabel: "oracle-dataset-coverage-duval",
      });

      const zipPath = path.join(tempDir, "ingest", PARCEL_ID, "transformed.zip");
      const zipBytes = await readFile(zipPath);
      expect(zipBytes.subarray(0, 4)).toEqual(ZIP_LOCAL_FILE_MAGIC);

      const AdmZip = require("adm-zip");
      const zip = new AdmZip(zipPath);
      const entryNames = zip.getEntries().map((entry) => entry.entryName.replaceAll("\\", "/"));
      for (const required of ["data/property.json", "data/address.json", "data/parcel.json"]) {
        expect(entryNames).toContain(required);
      }

      const rows = await readParquetRows(summary.artifacts.parquetPath);
      expect(rows).toHaveLength(1);
      expect(rows[0].request_identifier).toBe(RE_NUMBER);
      expect(rows[0].source_system).toBe("duval_appraiser");

      const coverage = JSON.parse(await readFile(summary.artifacts.coveragePath, "utf8"));
      expect(coverage.datasets).toHaveLength(1);
      expect(coverage.datasets[0].ingested_count).toBe(rows.length);
      expect(coverage.datasets[0].expected_count).toBe(1);

      const writtenSummary = JSON.parse(await readFile(path.join(tempDir, "replay-summary.json"), "utf8"));
      expect(writtenSummary.manifest).toEqual(summary.manifest);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
      await rm(cwdDir, { recursive: true, force: true });
    }
  });

  it("resolves the Duval transform scripts from its own file location, not the caller's cwd", async () => {
    const cwdDir = await mkdtemp(path.join(tmpdir(), "duval-cwd-independent-"));
    const outputDir = await mkdtemp(path.join(tmpdir(), "duval-replay-cwd-independent-out-"));
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [CLI_PATH, "replay", "--county", "duval", "--fixture", FIXTURE_DIR, "--output", outputDir],
        { cwd: cwdDir },
      );
      expect(JSON.parse(stdout).event).toBe("replay_complete");
    } finally {
      await rm(cwdDir, { recursive: true, force: true });
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
