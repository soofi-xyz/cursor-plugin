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

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseCsvRecords } from "../src/core/csv.mjs";
import { loadEnvFile, publishFilebase } from "../src/core/filebase.mjs";
import { runReplay } from "../src/core/replay.mjs";
import {
  exportCoverageArtifact,
  loadCoverageArtifact,
  publishCoverageFilebase,
  writeCoverageApproval,
} from "../src/core/coverage-publication.mjs";
import { pinellasAdapter } from "../src/counties/pinellas/adapter.mjs";
import { duvalAdapter } from "../src/counties/duval/adapter.mjs";

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
 * @param {Record<string, string | boolean>} flags
 * @param {string} name
 * @returns {string}
 */
function requiredFlag(flags, name) {
  const value = flags[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`--${name} is required`);
  }
  return value;
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
 * `elephant-county export-coverage --county <key> --evidence <json> --output <dir>`
 *
 * Builds only dataset-coverage.json from frozen, reconciled evidence. This
 * command is adapter-independent, so already-published counties such as Lee
 * do not need an ingest adapter registration.
 *
 * @param {readonly string[]} argv
 * @returns {Promise<void>}
 */
async function runExportCoverage(argv) {
  const flags = parseFlags(argv);
  const result = await exportCoverageArtifact({
    county: requiredFlag(flags, "county"),
    evidencePath: requiredFlag(flags, "evidence"),
    outputDir: requiredFlag(flags, "output"),
  });
  console.log(JSON.stringify({ event: "coverage_export_complete", result }, null, 2));
}

/**
 * `elephant-county sign-coverage-approval ...`
 *
 * Human-run action that binds an Ed25519 signature to one exact coverage
 * artifact, bucket, object key, existing IPNS label/network key, and time.
 *
 * @param {readonly string[]} argv
 * @returns {Promise<void>}
 */
async function runSignCoverageApproval(argv) {
  const flags = parseFlags(argv);
  const county = requiredFlag(flags, "county");
  const artifact = await loadCoverageArtifact({
    county,
    inputDir: requiredFlag(flags, "input"),
  });
  const outputPath = requiredFlag(flags, "output");
  const approval = await writeCoverageApproval({
    artifact,
    bucket: requiredFlag(flags, "bucket"),
    expectedIpnsName: requiredFlag(flags, "expected-ipns-name"),
    approver: requiredFlag(flags, "approver"),
    approvedAt:
      typeof flags["approved-at"] === "string"
        ? flags["approved-at"]
        : new Date().toISOString(),
    privateKeyPath: requiredFlag(flags, "private-key"),
    outputPath,
  });
  console.log(
    JSON.stringify(
      {
        event: "coverage_approval_signed",
        outputPath,
        payload: approval.payload,
        keyId: approval.signature.keyId,
      },
      null,
      2,
    ),
  );
}

/**
 * `elephant-county publish-coverage --county <key> --input <dir>
 *   --bucket <bucket> --expected-ipns-name <k51...> [--dry-run]
 *   [--approve <json> --approval-public-key <pem>] [--env-file <dotenv>]`
 *
 * Uploads one coverage JSON object and updates only the existing
 * oracle-dataset-coverage-<county> IPNS label.
 *
 * @param {readonly string[]} argv
 * @returns {Promise<void>}
 */
async function runPublishCoverage(argv) {
  const flags = parseFlags(argv, ["dry-run"]);
  const county = requiredFlag(flags, "county");
  const artifact = await loadCoverageArtifact({
    county,
    inputDir: requiredFlag(flags, "input"),
  });
  const env = { ...process.env };
  if (typeof flags["env-file"] === "string") {
    await loadEnvFile(flags["env-file"], env);
  }
  const result = await publishCoverageFilebase(artifact, {
    dryRun: flags["dry-run"] === true,
    bucket: requiredFlag(flags, "bucket"),
    expectedIpnsName: requiredFlag(flags, "expected-ipns-name"),
    approvalManifestPath: typeof flags.approve === "string" ? flags.approve : null,
    approvalPublicKeyPath:
      typeof flags["approval-public-key"] === "string"
        ? flags["approval-public-key"]
        : null,
    env,
  });
  console.log(JSON.stringify({ event: "coverage_publish_complete", result }, null, 2));
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

/**
 * @returns {Promise<void>} Resolves once the requested subcommand finishes.
 */
async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "ingest") return runIngest(rest);
  if (command === "export") return runExport(rest);
  if (command === "publish") return runPublish(rest);
  if (command === "export-coverage") return runExportCoverage(rest);
  if (command === "sign-coverage-approval") return runSignCoverageApproval(rest);
  if (command === "publish-coverage") return runPublishCoverage(rest);
  if (command === "replay") return runReplayCommand(rest);
  console.error(
    "Usage: elephant-county <ingest|export|publish|export-coverage|sign-coverage-approval|publish-coverage|replay> --county <key> [...flags]\n" +
      "  ingest  --county <key> --seed <csv> --html-dir <dir> [--skip-validate] [--live-fetch] [--allow-empty] --output <run-dir>\n" +
      "  export  --county <key> --seed <csv> --run <run-dir> --output <publish-dir> [--allow-empty]\n" +
      "  publish --county <key> --input <publish-dir> [--dry-run] [--approve <manifest>]\n" +
      "  export-coverage --county <key> --evidence <json> --output <publish-dir>\n" +
      "  sign-coverage-approval --county <key> --input <publish-dir> --bucket <bucket> --expected-ipns-name <k51...> --approver <identity> --private-key <ed25519.pem> --output <approval.json> [--approved-at <ISO-8601>]\n" +
      "  publish-coverage --county <key> --input <publish-dir> --bucket <bucket> --expected-ipns-name <k51...> [--dry-run] [--approve <approval.json> --approval-public-key <ed25519-public.pem>] [--env-file <dotenv>]\n" +
      "  replay  --county <key> --fixture <dir> --output <dir>",
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
  runExportCoverage,
  runSignCoverageApproval,
  runPublishCoverage,
  runReplayCommand,
};
