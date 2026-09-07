#!/usr/bin/env node
/**
 * `elephant-county` CLI: county-agnostic ingest / export / publish / replay
 * commands over the county adapters in `src/counties/*`.
 *
 * All script-relative paths (transforms, fixtures, flow definitions) resolve
 * from this file's own location via `import.meta.url`, never from
 * `process.cwd()`, so the CLI behaves the same regardless of the caller's
 * working directory (Global Constraint).
 *
 * @module bin/elephant-county
 */

import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { parseCsvRecords } from "../src/core/csv.mjs";
import {
  publishFilebase,
  publishPermitFilebase,
} from "../src/core/filebase.mjs";
import { runReplay } from "../src/core/replay.mjs";
import { pinellasAdapter } from "../src/counties/pinellas/adapter.mjs";
import { duvalAdapter } from "../src/counties/duval/adapter.mjs";
import { requireEnrichmentProfile } from "../src/counties/enrichment-profiles.mjs";
import {
  filterSunbizDirectory,
  transformSunbizExtract,
} from "../src/enrichment/sunbiz.mjs";
import { prepareSunbizArchive } from "../src/enrichment/sunbiz-archive.mjs";
import { enrichQueryTableWithSunbiz } from "../src/enrichment/query-table-sunbiz.mjs";
import { harvestBbbCategory } from "../src/enrichment/bbb.mjs";
import { reconcileBbbHarvests } from "../src/enrichment/bbb-reconcile.mjs";
import { finalizeEnrichmentArtifacts } from "../src/enrichment/enrichment-finalize.mjs";
import { requirePermitProfile } from "../src/counties/permit-profiles.mjs";
import { permitProfileDigest } from "../src/counties/permit-profile.mjs";
import {
  harvestPermitProperties,
  probePermitSources,
} from "../src/permits/harvest.mjs";
import { readPermitPropertyInputs } from "../src/permits/inputs.mjs";
import {
  exportPermitArtifacts,
  reconcilePermitHarvest,
} from "../src/permits/artifacts.mjs";
import { exportJaxPermitBulkArtifacts } from "../src/permits/bulk-export.mjs";
import { writePermitRunRevision } from "../src/permits/orchestration.mjs";
import {
  atomicWriteJson,
  fileIntegrity,
  readJson,
} from "../src/permits/storage.mjs";

const execFileAsync = promisify(execFile);
const RUNTIME_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** @type {Record<string, import("../src/core/replay.mjs").CountyAdapter>} */
const ADAPTERS = {
  pinellas: pinellasAdapter,
  duval: duvalAdapter,
};

/**
 * @param {string} key - County key from `--county`.
 * @returns {import("../src/core/replay.mjs").CountyAdapter} Registered adapter.
 */
function requireAdapter(key) {
  const adapter = ADAPTERS[key];
  if (!adapter) {
    throw new Error(`Unknown --county "${key}". Known counties: ${Object.keys(ADAPTERS).join(", ")}`);
  }
  return adapter;
}

/**
 * Parse `--flag value` / boolean `--flag` CLI arguments.
 *
 * @param {readonly string[]} argv - Arguments after the subcommand.
 * @param {readonly string[]} booleanFlags - Flag names that take no value.
 * @returns {Record<string, string | boolean>} Parsed flag map (leading `--` stripped).
 */
export function parseFlags(argv, booleanFlags = []) {
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const name = token.slice(2);
    if (booleanFlags.includes(name)) {
      flags[name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${name}`);
    }
    flags[name] = value;
    index += 1;
  }
  return flags;
}

/**
 * @param {string} seedPath - CSV file path.
 * @returns {Promise<Record<string, string>[]>} Parsed seed rows.
 */
async function readSeedRows(seedPath) {
  const text = await readFile(seedPath, "utf8");
  const rows = parseCsvRecords(text);
  if (rows.length === 0) {
    throw new Error(`Seed CSV has no data rows: ${seedPath}`);
  }
  return rows;
}

/**
 * `elephant-county ingest --county <key> --seed <csv> --html-dir <dir> [--skip-validate] [--live-fetch] [--allow-empty] --output <run-dir>`
 *
 * Fails closed on live fetch: a missing local HTML file is an error unless
 * `--live-fetch` is explicitly supplied (Global Constraint). Also fails
 * closed on an all-failure run: if every seed row failed, `validateRun`
 * reports the run invalid unless `--allow-empty` is explicitly supplied
 * (adapters that don't recognize `allowEmpty`, e.g. Pinellas, ignore it).
 *
 * @param {readonly string[]} argv - Arguments after `ingest`.
 * @returns {Promise<void>} Resolves once the run manifest is written and printed.
 */
async function runIngest(argv) {
  const flags = parseFlags(argv, ["skip-validate", "live-fetch", "allow-empty"]);
  const adapter = requireAdapter(String(flags.county));
  const seedRows = await readSeedRows(String(flags.seed));
  const manifest = await adapter.captureAndTransform({
    seedRows,
    htmlDir: String(flags["html-dir"]),
    outputDir: String(flags.output),
    liveFetch: flags["live-fetch"] === true,
  });
  if (flags["skip-validate"] !== true) {
    const validation = await adapter.validateRun(manifest, { allowEmpty: flags["allow-empty"] === true });
    if (!validation.valid) {
      console.error(JSON.stringify({ event: "ingest_validation_failed", validation }));
      process.exitCode = 1;
      return;
    }
  }
  console.log(JSON.stringify({ event: "ingest_complete", manifest }, null, 2));
}

/**
 * `elephant-county export --county <key> --seed <csv> --run <run-dir> --output <publish-dir> [--allow-empty]`
 *
 * Fails closed on an empty export: if every seed row failed to produce a
 * complete parcel, this refuses to publish a zero-row query table unless
 * `--allow-empty` is explicitly supplied (Global Constraint).
 *
 * @param {readonly string[]} argv - Arguments after `export`.
 * @returns {Promise<void>} Resolves once publication artifacts are written and printed.
 */
async function runExport(argv) {
  const flags = parseFlags(argv, ["allow-empty"]);
  const adapter = requireAdapter(String(flags.county));
  const seedRows = await readSeedRows(String(flags.seed));
  const artifacts = await adapter.buildPublicationArtifacts({
    outputDir: String(flags.run),
    seedRows,
    publishDir: String(flags.output),
    allowEmpty: flags["allow-empty"] === true,
  });
  console.log(JSON.stringify({ event: "export_complete", artifacts }, null, 2));
}

/**
 * `elephant-county publish --county <key> --input <publish-dir> [--dry-run] [--approve <manifest>]`
 *
 * A live publish (no `--dry-run`) is rejected unless `--approve <manifest>`
 * points at an existing file, and unless Filebase credentials are present
 * in the environment (Global Constraint).
 *
 * @param {readonly string[]} argv - Arguments after `publish`.
 * @returns {Promise<void>} Resolves once the dry-run report or live publish result is printed.
 */
async function runPublish(argv) {
  const flags = parseFlags(argv, ["dry-run"]);
  requireAdapter(String(flags.county));
  const manifestPath = path.join(String(flags.input), "manifest.json");
  const artifacts = JSON.parse(await readFile(manifestPath, "utf8"));
  const result = await publishFilebase(artifacts, {
    dryRun: flags["dry-run"] === true,
    approvalManifestPath: typeof flags.approve === "string" ? flags.approve : null,
    env: process.env,
  });
  console.log(JSON.stringify({ event: "publish_complete", result }, null, 2));
}

/**
 * `elephant-county replay --county <key> --fixture <dir> --output <dir>`
 *
 * @param {readonly string[]} argv - Arguments after `replay`.
 * @returns {Promise<void>} Resolves once the replay summary is written and printed.
 */
async function runReplayCommand(argv) {
  const flags = parseFlags(argv);
  const adapter = requireAdapter(String(flags.county));
  const outputDir = String(flags.output);
  await mkdir(outputDir, { recursive: true });
  const replay = await runReplay({ adapter, fixtureDir: String(flags.fixture), outputDir });
  const summaryPath = path.join(outputDir, "replay-summary.json");
  const summary = {
    county: adapter.key,
    manifest: replay.manifest,
    artifacts: replay.artifacts,
    publishResult: replay.publishResult,
  };
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ event: "replay_complete", ...summary }, null, 2));
}

function optionalPositiveInteger(value, name, fallback = null) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

function requireStringFlag(flags, name) {
  const value = flags[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function optionalNonNegativeInteger(value, name, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return parsed;
}

async function runSunbizFilterCommand(argv) {
  const flags = parseFlags(argv);
  const county = requireStringFlag(flags, "county");
  const profile = requireEnrichmentProfile(county);
  const quarter = requireStringFlag(flags, "quarter");
  if (!/^\d{4}Q[1-4]$/.test(quarter)) {
    throw new Error("--quarter must use YYYYQ1..YYYYQ4");
  }
  const manifest = await filterSunbizDirectory({
    countyKey: profile.countyKey,
    sourceDir: requireStringFlag(flags, "source-dir"),
    outputDir: requireStringFlag(flags, "output"),
    zipPrefixes: profile.sunbiz.zipPrefixes,
    chunkRecordLimit: optionalPositiveInteger(
      flags["chunk-record-limit"],
      "chunk-record-limit",
      5_000,
    ),
    maxRecords: optionalPositiveInteger(flags["max-records"], "max-records"),
    maxSourceRecords: optionalPositiveInteger(
      flags["max-source-records"],
      "max-source-records",
    ),
    jobId:
      typeof flags["job-id"] === "string"
        ? flags["job-id"]
        : `sunbiz-${county}-${quarter.toLowerCase()}`,
    quarter,
  });
  console.log(JSON.stringify({ event: "sunbiz_filter_complete", manifest }, null, 2));
}

async function runSunbizPrepareCommand(argv) {
  const flags = parseFlags(argv);
  const receipt = await prepareSunbizArchive({
    archivePath: requireStringFlag(flags, "archive"),
    outputDir: requireStringFlag(flags, "output"),
    expectedSha256: requireStringFlag(flags, "sha256"),
  });
  console.log(JSON.stringify({ event: "sunbiz_prepare_complete", receipt }, null, 2));
}

async function runSunbizTransformCommand(argv) {
  const flags = parseFlags(argv, ["allow-incomplete"]);
  const summary = await transformSunbizExtract({
    inputDir: requireStringFlag(flags, "input"),
    outputDir: requireStringFlag(flags, "output"),
    partRecordLimit: optionalPositiveInteger(
      flags["part-record-limit"],
      "part-record-limit",
      5_000,
    ),
    allowIncomplete: flags["allow-incomplete"] === true,
  });
  console.log(JSON.stringify({ event: "sunbiz_transform_complete", summary }, null, 2));
}

async function runSunbizEnrichCommand(argv) {
  const flags = parseFlags(argv);
  const profile = requireEnrichmentProfile(
    requireStringFlag(flags, "county"),
  );
  const outputDir = requireStringFlag(flags, "output-dir");
  const summary = await enrichQueryTableWithSunbiz({
    countyKey: profile.countyKey,
    schemaFields: profile.queryTable.schemaFields,
    inputParquet: requireStringFlag(flags, "input-parquet"),
    inputCoverage: requireStringFlag(flags, "input-coverage"),
    sunbizExtractDir: requireStringFlag(flags, "sunbiz-extract"),
    outputParquet: path.join(outputDir, "query-table.parquet"),
    outputCoverage: path.join(outputDir, "dataset-coverage.json"),
    linksPath: path.join(outputDir, "sunbiz-property-links.jsonl"),
    manifestPath: path.join(outputDir, "sunbiz-enrichment-manifest.json"),
  });
  console.log(JSON.stringify({ event: "sunbiz_enrich_complete", summary }, null, 2));
}

async function runBbbHarvestCommand(argv) {
  const flags = parseFlags(argv, ["headful", "no-html", "resume"]);
  const profile = requireEnrichmentProfile(
    requireStringFlag(flags, "county"),
  );
  const categoryKey = requireStringFlag(flags, "category");
  const category = profile.bbb.categories.find(
    (candidate) => candidate.key === categoryKey,
  );
  if (!category) {
    throw new Error(
      `Unknown --category "${categoryKey}" for ${profile.countyKey}. Expected one of: ${profile.bbb.categories.map((candidate) => candidate.key).join(", ")}`,
    );
  }
  const maxPages = optionalPositiveInteger(flags["max-pages"], "max-pages");
  const maxProfiles = optionalPositiveInteger(
    flags["max-profiles"],
    "max-profiles",
  );
  if (maxPages === null || maxProfiles === null) {
    throw new Error("BBB harvest requires explicit --max-pages and --max-profiles bounds");
  }
  const subpages =
    typeof flags["profile-subpages"] !== "string"
      ? ["customer-reviews", "complaints", "more-info"]
      : flags["profile-subpages"] === "none"
        ? []
        : flags["profile-subpages"]
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean);
  const allowedSubpages = new Set([
    "customer-reviews",
    "complaints",
    "more-info",
  ]);
  for (const subpage of subpages) {
    if (!allowedSubpages.has(subpage)) {
      throw new Error(`Unsupported BBB profile subpage: ${subpage}`);
    }
  }
  const executablePath =
    typeof flags["chromium-executable-path"] === "string"
      ? flags["chromium-executable-path"]
      : process.env.CHROME_EXECUTABLE_PATH ??
        (process.platform === "darwin"
          ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
          : "/usr/bin/chromium");
  const summary = await harvestBbbCategory({
    countyKey: profile.countyKey,
    reviewedCategory: category,
    reviewedCategories: profile.bbb.categories,
    jobId: requireStringFlag(flags, "job-id"),
    categoryKey,
    categoryUrl: category.url,
    outputDir: requireStringFlag(flags, "output"),
    chromiumExecutablePath: executablePath,
    headless: flags.headful !== true,
    maxPages,
    maxProfiles,
    partRecordLimit: optionalPositiveInteger(
      flags["part-record-limit"],
      "part-record-limit",
      25,
    ),
    pageDelayMs: optionalNonNegativeInteger(
      flags["page-delay-ms"],
      "page-delay-ms",
      2_000,
    ),
    profileDelayMs: optionalNonNegativeInteger(
      flags["profile-delay-ms"],
      "profile-delay-ms",
      1_500,
    ),
    navigationTimeoutMs: optionalPositiveInteger(
      flags["navigation-timeout-ms"],
      "navigation-timeout-ms",
      90_000,
    ),
    challengeAttempts: optionalPositiveInteger(
      flags["challenge-attempts"],
      "challenge-attempts",
      5,
    ),
    challengeCheckIntervalMs: optionalNonNegativeInteger(
      flags["challenge-check-interval-ms"],
      "challenge-check-interval-ms",
      3_000,
    ),
    challengeChecksPerAttempt: optionalPositiveInteger(
      flags["challenge-checks-per-attempt"],
      "challenge-checks-per-attempt",
      12,
    ),
    maxRequests: optionalPositiveInteger(
      flags["max-requests"],
      "max-requests",
      250,
    ),
    maxDurationMs:
      optionalPositiveInteger(
        flags["max-duration-minutes"],
        "max-duration-minutes",
        30,
      ) *
      60 *
      1_000,
    includeHtml: flags["no-html"] !== true,
    profileSubpages: subpages,
    resume: flags.resume === true,
  });
  console.log(JSON.stringify({ event: "bbb_harvest_complete", summary }, null, 2));
}

async function runBbbReconcileCommand(argv) {
  const flags = parseFlags(argv);
  const profile = requireEnrichmentProfile(
    requireStringFlag(flags, "county"),
  );
  const harvestRoot = requireStringFlag(flags, "harvest-root");
  const outputDir = requireStringFlag(flags, "output-dir");
  const summary = await reconcileBbbHarvests({
    countyKey: profile.countyKey,
    categories: profile.bbb.categories,
    harvestDirs: profile.bbb.categories.map((category) =>
      path.join(harvestRoot, category.key),
    ),
    inputCoverage: requireStringFlag(flags, "input-coverage"),
    outputCoverage: path.join(outputDir, "dataset-coverage.json"),
    outputProfiles: path.join(outputDir, "bbb-profiles.jsonl"),
    outputFailures: path.join(outputDir, "bbb-failures.jsonl"),
    outputManifest: path.join(outputDir, "bbb-reconciliation-manifest.json"),
  });
  console.log(JSON.stringify({ event: "bbb_reconcile_complete", summary }, null, 2));
}

async function runEnrichmentFinalizeCommand(argv) {
  const flags = parseFlags(argv);
  const profile = requireEnrichmentProfile(
    requireStringFlag(flags, "county"),
  );
  const artifacts = await finalizeEnrichmentArtifacts({
    inputDir: requireStringFlag(flags, "input"),
    profile,
  });
  console.log(
    JSON.stringify({ event: "enrichment_finalize_complete", artifacts }, null, 2),
  );
}

async function gitValue(args, fallback) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: RUNTIME_DIR,
    });
    return stdout.trim() || fallback;
  } catch {
    return fallback;
  }
}

async function permitRunContext({ profile, jobId }) {
  const sourceCatalogPath = path.join(
    RUNTIME_DIR,
    "docs",
    `${profile.countyKey}-sources.yaml`,
  );
  return {
    runId: jobId,
    countyKey: profile.countyKey,
    branch: await gitValue(
      ["branch", "--show-current"],
      "unknown-branch",
    ),
    commitSha: await gitValue(
      ["rev-parse", "HEAD"],
      "0000000",
    ),
    profileSha256: permitProfileDigest(profile),
    sourceCatalogPath,
    sourceCatalogSha256: (await fileIntegrity(sourceCatalogPath)).sha256,
  };
}

async function latestPermitRunManifest(runDir) {
  const files = (await readdir(runDir))
    .filter((name) => /^run-manifest-r\d{6}\.json$/.test(name))
    .sort();
  return files.length
    ? readJson(path.join(runDir, files.at(-1)))
    : null;
}

async function runPermitProbeCommand(argv) {
  const flags = parseFlags(argv);
  const profile = requirePermitProfile(
    requireStringFlag(flags, "county"),
  );
  const results = await probePermitSources({ profile });
  console.log(
    JSON.stringify(
      { event: "permit_probe_complete", county: profile.countyKey, results },
      null,
      2,
    ),
  );
}

async function runPermitHarvestCommand(argv, resume) {
  const flags = parseFlags(argv);
  const profile = requirePermitProfile(
    requireStringFlag(flags, "county"),
  );
  const jobId = requireStringFlag(flags, "job-id");
  const outputDir = requireStringFlag(flags, "output");
  const limit = optionalPositiveInteger(flags.limit, "limit");
  if (limit === null) {
    throw new Error(
      "Permit bounded harvest requires an explicit positive --limit",
    );
  }
  const properties = await readPermitPropertyInputs(
    requireStringFlag(flags, "input-parquet"),
    {
      offset: optionalNonNegativeInteger(flags.offset, "offset", 0),
      limit,
    },
  );
  await mkdir(outputDir, { recursive: true });
  const previous = resume
    ? await latestPermitRunManifest(outputDir)
    : null;
  const context = await permitRunContext({ profile, jobId });
  const running = await writePermitRunRevision({
    runDir: outputDir,
    previous,
    state: "RUNNING",
    nextAction: "Process bounded permit parcel set",
    context,
  });
  const harvest = await harvestPermitProperties({
    properties,
    profile,
    outputDir,
    jobId,
    concurrency: optionalPositiveInteger(
      flags.concurrency,
      "concurrency",
      1,
    ),
    resume,
  });
  const readinessBlocked =
    harvest.summary.doneCount === 0 &&
    harvest.summary.blockedCount > 0;
  const terminal = await writePermitRunRevision({
    runDir: outputDir,
    previous: running,
    state: readinessBlocked ? "READINESS_BLOCKED" : "WAITING_HUMAN",
    nextAction: readinessBlocked
      ? "Resolve documented source access and parcel-enumeration gaps"
      : "Review bounded harvest evidence before scaling",
  });
  console.log(
    JSON.stringify(
      {
        event: resume
          ? "permit_resume_complete"
          : "permit_bounded_harvest_complete",
        summary: harvest.summary,
        runManifest: terminal,
      },
      null,
      2,
    ),
  );
}

async function runPermitReconcileCommand(argv) {
  const flags = parseFlags(argv);
  const profile = requirePermitProfile(
    requireStringFlag(flags, "county"),
  );
  const harvestDir = requireStringFlag(flags, "harvest");
  const reconciled = await reconcilePermitHarvest({
    harvestDir,
    profile,
  });
  const summary = {
    schemaVersion: "elephant.permit-reconciliation.v1",
    countyKey: profile.countyKey,
    reconciledAt: new Date().toISOString(),
    permitCount: reconciled.records.length,
    statusCount: reconciled.statuses.length,
    linkedPropertyCount: new Set(
      reconciled.records
        .map((record) => record.property_id)
        .filter(Boolean),
    ).size,
  };
  await atomicWriteJson(
    path.join(harvestDir, "permit-reconciliation.json"),
    summary,
  );
  console.log(
    JSON.stringify(
      { event: "permit_reconcile_complete", summary },
      null,
      2,
    ),
  );
}

async function runPermitExportCommand(argv) {
  const flags = parseFlags(argv, ["allow-empty"]);
  const county = requireStringFlag(flags, "county");
  const profile = requirePermitProfile(county);
  const enrichmentProfile = requireEnrichmentProfile(county);
  const artifacts = await exportPermitArtifacts({
    harvestDir: requireStringFlag(flags, "harvest"),
    inputPropertyParquet: requireStringFlag(flags, "input-parquet"),
    inputCoveragePath: requireStringFlag(flags, "input-coverage"),
    outputDir: requireStringFlag(flags, "output"),
    profile,
    propertySchemaFields: enrichmentProfile.queryTable.schemaFields,
    jobId: requireStringFlag(flags, "job-id"),
    allowEmpty: flags["allow-empty"] === true,
  });
  console.log(
    JSON.stringify(
      {
        event: "permit_export_complete",
        manifest: artifacts.manifest,
        approval: artifacts.approval,
      },
      null,
      2,
    ),
  );
}

async function runPermitBulkExportCommand(argv) {
  const flags = parseFlags(argv);
  const county = requireStringFlag(flags, "county");
  const profile = requirePermitProfile(county);
  const enrichmentProfile = requireEnrichmentProfile(county);
  const artifacts = await exportJaxPermitBulkArtifacts({
    inputPropertyParquet: requireStringFlag(flags, "input-parquet"),
    inputCoveragePath: requireStringFlag(flags, "input-coverage"),
    outputDir: requireStringFlag(flags, "output"),
    profile,
    propertySchemaFields: enrichmentProfile.queryTable.schemaFields,
    jobId: requireStringFlag(flags, "job-id"),
    maxPages: optionalPositiveInteger(flags["max-pages"], "max-pages"),
    progress: (progress) =>
      console.log(
        JSON.stringify({ event: "permit_bulk_progress", ...progress }),
      ),
  });
  console.log(
    JSON.stringify(
      {
        event: "permit_bulk_export_complete",
        counters: artifacts.counters,
        manifest: artifacts.manifest,
        approval: artifacts.approval,
      },
      null,
      2,
    ),
  );
}

async function runPermitPublishCommand(argv) {
  const flags = parseFlags(argv);
  const county = requireStringFlag(flags, "county");
  const inputDir = requireStringFlag(flags, "input");
  const profile = requirePermitProfile(county);
  const receipt = await publishPermitFilebase(
    {
      county,
      bucket: profile.publication.bucket,
      permitTableIpnsLabel:
        profile.publication.permitTableIpnsLabel,
      queryTableIpnsLabel:
        profile.publication.propertyQueryTableIpnsLabel,
      coverageIpnsLabel: profile.publication.coverageIpnsLabel,
      permitTablePath: path.join(inputDir, "permit-table.parquet"),
      queryTablePath: path.join(inputDir, "query-table.parquet"),
      coveragePath: path.join(inputDir, "dataset-coverage.json"),
      permitCoveragePath: path.join(inputDir, "permit-coverage.json"),
    },
    {
      approvalManifestPath: requireStringFlag(flags, "approve"),
      receiptPath: requireStringFlag(flags, "receipt"),
      env: process.env,
    },
  );
  console.log(
    JSON.stringify(
      { event: "permit_publish_complete", receipt },
      null,
      2,
    ),
  );
}

/**
 * @returns {Promise<void>} Resolves once the requested subcommand finishes.
 */
async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "ingest") return runIngest(rest);
  if (command === "export") return runExport(rest);
  if (command === "publish") return runPublish(rest);
  if (command === "replay") return runReplayCommand(rest);
  if (command === "sunbiz-prepare") return runSunbizPrepareCommand(rest);
  if (command === "sunbiz-filter") return runSunbizFilterCommand(rest);
  if (command === "sunbiz-transform") return runSunbizTransformCommand(rest);
  if (command === "sunbiz-enrich") return runSunbizEnrichCommand(rest);
  if (command === "bbb-harvest") return runBbbHarvestCommand(rest);
  if (command === "bbb-reconcile") return runBbbReconcileCommand(rest);
  if (command === "enrichment-finalize") {
    return runEnrichmentFinalizeCommand(rest);
  }
  if (command === "permit-probe") return runPermitProbeCommand(rest);
  if (command === "permit-bounded-harvest") {
    return runPermitHarvestCommand(rest, false);
  }
  if (command === "permit-resume") {
    return runPermitHarvestCommand(rest, true);
  }
  if (command === "permit-reconcile") {
    return runPermitReconcileCommand(rest);
  }
  if (command === "permit-export") return runPermitExportCommand(rest);
  if (command === "permit-bulk-export") {
    return runPermitBulkExportCommand(rest);
  }
  if (command === "permit-publish") {
    return runPermitPublishCommand(rest);
  }
  console.error(
    "Usage: elephant-county <ingest|export|publish|replay|sunbiz-prepare|sunbiz-filter|sunbiz-transform|sunbiz-enrich|bbb-harvest|bbb-reconcile|enrichment-finalize|permit-probe|permit-bounded-harvest|permit-resume|permit-reconcile|permit-export|permit-bulk-export|permit-publish> [...flags]\n" +
      "  ingest  --county <key> --seed <csv> --html-dir <dir> [--skip-validate] [--live-fetch] [--allow-empty] --output <run-dir>\n" +
      "  export  --county <key> --seed <csv> --run <run-dir> --output <publish-dir> [--allow-empty]\n" +
      "  publish --county <key> --input <publish-dir> [--dry-run] [--approve <manifest>]\n" +
      "  replay  --county <key> --fixture <dir> --output <dir>\n" +
      "  sunbiz-prepare --archive <cordata.zip> --sha256 <digest> --output <expanded-dir>\n" +
      "  sunbiz-filter --county <profile-key> --quarter <YYYYQn> --source-dir <expanded-dir> --output <dir> [--max-source-records N]\n" +
      "  sunbiz-transform --input <extract-dir> --output <dir> [--part-record-limit N]\n" +
      "  sunbiz-enrich --county <profile-key> --input-parquet <parquet> --input-coverage <json> --sunbiz-extract <dir> --output-dir <dir>\n" +
      "  bbb-harvest --county <profile-key> --category <reviewed-key> --job-id <id> --max-pages N --max-profiles N --max-requests N --max-duration-minutes N --output <dir>\n" +
      "  bbb-reconcile --county <profile-key> --harvest-root <category-dirs-root> --input-coverage <json> --output-dir <dir>\n" +
      "  enrichment-finalize --county <profile-key> --input <publish-dir>\n" +
      "  permit-probe --county <profile-key>\n" +
      "  permit-bounded-harvest --county <profile-key> --job-id <id> --input-parquet <parquet> --limit N --output <dir>\n" +
      "  permit-resume --county <profile-key> --job-id <id> --input-parquet <parquet> --limit N --output <dir>\n" +
      "  permit-reconcile --county <profile-key> --harvest <dir>\n" +
      "  permit-export --county <profile-key> --job-id <id> --harvest <dir> --input-parquet <parquet> --input-coverage <json> --output <dir>\n" +
      "  permit-bulk-export --county <profile-key> --job-id <id> --input-parquet <parquet> --input-coverage <json> --output <dir> [--max-pages N]\n" +
      "  permit-publish --county <profile-key> --input <dir> --approve <manifest> --receipt <json>",
  );
  process.exitCode = 1;
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export {
  main,
  requireAdapter,
  runIngest,
  runExport,
  runPublish,
  runReplayCommand,
  runSunbizPrepareCommand,
  runSunbizFilterCommand,
  runSunbizTransformCommand,
  runSunbizEnrichCommand,
  runBbbHarvestCommand,
  runBbbReconcileCommand,
  runEnrichmentFinalizeCommand,
  runPermitProbeCommand,
  runPermitHarvestCommand,
  runPermitReconcileCommand,
  runPermitExportCommand,
};
