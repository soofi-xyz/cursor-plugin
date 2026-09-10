#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  analyzeRoofingCohort,
  BROWARD_ROOFING_WINDOWS,
} from "../src/investigations/roofing-cohort.mjs";
import {
  investigationGapSchema,
  parseCohortInputRecords,
  ROOFING_COHORT_REPORT_VERSION,
} from "../src/investigations/roofing-cohort-schema.mjs";

function usage() {
  return [
    "Analyze immutable private Broward permit evidence without network or database access.",
    "",
    "  broward-roofing-cohort --input <evidence.jsonl> --gap-ledger <gap-ledger.jsonl> --output <new-private-directory>",
    "    --expected-catalog-sha256 <sha256>",
    "    --expected-profile-sha256 <sha256>",
    "    --expected-repository-commit <40-char-sha>",
    "",
    "The fixed inclusive windows are 2025-09-10..2026-09-10 for projects and",
    "2016-09-10..2026-09-10 for old-roof controls. Output must be under a",
    "path named downloads, private, or .private. Existing output is never overwritten.",
  ].join("\n");
}

function parseArguments(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const allowed = new Set([
    "--input",
    "--gap-ledger",
    "--output",
    "--expected-catalog-sha256",
    "--expected-profile-sha256",
    "--expected-repository-commit",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!allowed.has(key)) throw new Error(`Unknown option "${key}"`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${key}`);
    }
    values.set(key, value);
    index += 1;
  }
  const required = [...allowed];
  for (const key of required) {
    if (!values.has(key)) throw new Error(`${key} is required`);
  }
  return {
    help: false,
    inputPath: values.get("--input"),
    gapLedgerPath: values.get("--gap-ledger"),
    outputPath: values.get("--output"),
    expectedCatalogSha256: values.get("--expected-catalog-sha256"),
    expectedProfileSha256: values.get("--expected-profile-sha256"),
    expectedRepositoryCommit: values.get(
      "--expected-repository-commit",
    ),
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseJsonl(bytes, label) {
  const lines = bytes
    .toString("utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim());
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(
        `${label} line ${index + 1} is invalid JSON: ${error.message}`,
      );
    }
  });
}

function assertExpected(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label} drift: input=${actual}, expected=${expected}`,
    );
  }
}

function assertPrivateOutputPath(outputPath) {
  const segments = path.resolve(outputPath).split(path.sep);
  if (
    !segments.some((segment) =>
      ["downloads", "private", ".private"].includes(segment),
    )
  ) {
    throw new Error(
      "Output path must be under a downloads, private, or .private directory",
    );
  }
}

async function requireAbsent(filePath) {
  try {
    await access(filePath);
    throw new Error(`Output already exists: ${filePath}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
  });
}

async function writeJsonl(filePath, rows) {
  const body = rows.length
    ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`
    : "";
  await writeFile(filePath, body, { flag: "wx" });
}

async function run(args) {
  assertPrivateOutputPath(args.outputPath);
  await requireAbsent(args.outputPath);
  const [inputBytes, gapBytes] = await Promise.all([
    readFile(args.inputPath),
    readFile(args.gapLedgerPath),
  ]);
  const input = parseCohortInputRecords(
    parseJsonl(inputBytes, "Cohort input"),
  );
  const gapLedger = parseJsonl(gapBytes, "Gap ledger").map((row) =>
    investigationGapSchema.parse(row),
  );
  assertExpected(
    input.manifest.sourceCatalogSha256,
    args.expectedCatalogSha256,
    "Source catalog SHA-256",
  );
  assertExpected(
    input.manifest.sourceProfileSha256,
    args.expectedProfileSha256,
    "Source profile SHA-256",
  );
  assertExpected(
    input.manifest.repositoryCommit,
    args.expectedRepositoryCommit,
    "Repository commit",
  );

  const result = analyzeRoofingCohort({
    ...input,
    gapLedger,
    trailingWindow: BROWARD_ROOFING_WINDOWS.trailing,
    oldRoofWindow: BROWARD_ROOFING_WINDOWS.oldRoof,
  });
  await mkdir(args.outputPath, { recursive: true });
  const cohortRows = [
    ...result.openCohort.map((row) => ({
      cohort: "recommended-unassigned-open-roofing-lead",
      ...row,
    })),
    ...result.oldRoofControls.map((row) => ({
      cohort: "proactive-estimated-old-roof-lead",
      ...row,
    })),
  ];
  const reportManifest = {
    schemaVersion: ROOFING_COHORT_REPORT_VERSION,
    countyKey: "broward",
    generatedAt: new Date().toISOString(),
    input: {
      sha256: sha256(inputBytes),
      rowCount: input.records.length + 1,
      seedFolios: input.manifest.seedFolios,
      expansionLicenseNumbers:
        input.manifest.expansionLicenseNumbers,
      expansionCompanyNames: input.manifest.expansionCompanyNames,
      sourceCatalogSha256: input.manifest.sourceCatalogSha256,
      sourceProfileSha256: input.manifest.sourceProfileSha256,
      repositoryCommit: input.manifest.repositoryCommit,
    },
    windows: {
      trailingYear: BROWARD_ROOFING_WINDOWS.trailing,
      oldRoof: BROWARD_ROOFING_WINDOWS.oldRoof,
    },
    privacy: "private",
    reportPurpose:
      "Prospective roofing leads for handoff; open permits are not Z Roofing projects and receive no Z Roofing license association.",
    openLeadEligibility:
      "Confirmed roofing, currently open, linked property, stable source identity, in-window filing date, and complete evidence that no contractor is assigned.",
    publicationPerformed: false,
    databaseWritesPerformed: false,
  };
  await Promise.all([
    writeJson(path.join(args.outputPath, "report-manifest.json"), reportManifest),
    writeJson(path.join(args.outputPath, "analysis-summary.json"), result.summary),
    writeJsonl(
      path.join(args.outputPath, "seed-evidence.jsonl"),
      result.seedEvidence,
    ),
    writeJsonl(
      path.join(
        args.outputPath,
        "verified-contractor-license-identities.jsonl",
      ),
      result.identities,
    ),
    writeJsonl(
      path.join(args.outputPath, "trailing-year-projects.jsonl"),
      result.trailingProjects,
    ),
    writeJsonl(
      path.join(args.outputPath, "current-open-permits.jsonl"),
      result.currentOpenPermits,
    ),
    writeJsonl(
      path.join(args.outputPath, "cohort-5-plus-5.jsonl"),
      cohortRows,
    ),
    writeJsonl(
      path.join(args.outputPath, "source-reconciliation.jsonl"),
      result.reconciliation,
    ),
    writeJsonl(
      path.join(args.outputPath, "repair-candidates.jsonl"),
      result.repairCandidates,
    ),
    writeJsonl(
      path.join(args.outputPath, "complete-gap-ledger.jsonl"),
      result.gapLedger,
    ),
  ]);
  process.stdout.write(
    `${JSON.stringify({
      event: "broward_roofing_cohort_complete",
      outputPath: args.outputPath,
      inputSha256: reportManifest.input.sha256,
      ...result.summary,
    })}\n`,
  );
}

try {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
  } else {
    await run(args);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n\n${usage()}\n`);
  process.exitCode = 1;
}
