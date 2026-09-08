import { createHash } from "node:crypto";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { S3Client } from "@aws-sdk/client-s3";

import {
  HANDOFF_SCHEMA_VERSION,
  handoffKey,
  handoffSchema,
  parseRegisteredBatchRequest,
  requestDigest,
  requestKey,
  type BatchHandoff,
  type BatchRequest,
} from "./contracts.js";
import { assertCostAllowed } from "./cost-plan.js";
import {
  downloadVerifiedObject,
  getVerifiedJson,
  getVerifiedJsonIfExists,
  putImmutableJson,
  uploadDirectoryImmutable,
} from "./s3-integrity.js";
import {
  requireArtifact,
  requiredStageNames,
  validateRequiredHandoffs,
} from "./reconciliation.js";

const runtimeRoot = path.resolve(
  process.env.ORACLE_RUNTIME_ROOT ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../.."),
);
const s3 = new S3Client({});

interface SunbizModule {
  filterSunbizDirectory(options: Record<string, unknown>): Promise<Record<string, unknown>>;
  transformSunbizExtract(options: Record<string, unknown>): Promise<Record<string, unknown>>;
}

interface SunbizArchiveModule {
  prepareSunbizArchive(options: Record<string, unknown>): Promise<Record<string, unknown>>;
}

interface SunbizEnrichmentModule {
  enrichQueryTableWithSunbiz(
    options: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

interface BbbModule {
  harvestBbbCategory(options: Record<string, unknown>): Promise<Record<string, unknown>>;
  validateBbbSourceAccessEvidence(
    value: unknown,
    config: Record<string, unknown>,
  ): Record<string, unknown>;
  writeBlockedBbbCategoryArtifact(
    options: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

interface BbbReconciliationModule {
  reconcileBbbHarvests(
    options: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

interface EnrichmentFinalizationModule {
  finalizeEnrichmentArtifacts(
    options: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

interface EnrichmentProfile {
  countyKey: string;
  sunbiz: { zipPrefixes: readonly string[] };
  bbb: {
    categories: readonly {
      key: string;
      url: string;
      reviewedPath: string;
    }[];
  };
  queryTable: { schemaFields: Record<string, unknown> };
  publication: Record<string, string>;
}

interface EnrichmentProfilesModule {
  requireEnrichmentProfile(countyKey: string): EnrichmentProfile;
}

async function runtimeModule<T>(relativePath: string): Promise<T> {
  return (await import(
    pathToFileURL(path.join(runtimeRoot, relativePath)).href
  )) as T;
}

async function loadEnrichmentProfile(
  countyKey: string,
): Promise<EnrichmentProfile> {
  const profilesModule = await runtimeModule<EnrichmentProfilesModule>(
    "src/counties/enrichment-profiles.mjs",
  );
  return profilesModule.requireEnrichmentProfile(countyKey);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function log(event: string, details: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      event,
      ...details,
    }),
  );
}

async function loadRequest(): Promise<{
  bucket: string;
  request: BatchRequest;
  digest: string;
}> {
  const bucket = requiredEnvironment("ARTIFACT_BUCKET");
  const key = requiredEnvironment("REQUEST_KEY");
  const expectedDigest = requiredEnvironment("REQUEST_SHA256");
  const request = await parseRegisteredBatchRequest(
    await getVerifiedJson(s3, bucket, key, expectedDigest),
  );
  const digest = requestDigest(request);
  if (
    digest !== expectedDigest ||
    key !== requestKey(request)
  ) {
    throw new Error("Batch request key or digest is not content-addressed correctly");
  }
  const deploymentCeiling = process.env.MAX_COST_CEILING_USD;
  const plan = assertCostAllowed(
    request,
    deploymentCeiling === undefined ? undefined : Number(deploymentCeiling),
  );
  log("cost_gate_passed", {
    runId: request.runId,
    estimatedUsd: plan.estimatedUsd,
    ceilingUsd: plan.ceilingUsd,
  });
  return { bucket, request, digest };
}

async function completedHandoff(
  bucket: string,
  request: BatchRequest,
  digest: string,
  stage: string,
): Promise<BatchHandoff | null> {
  const value = await getVerifiedJsonIfExists(
    s3,
    bucket,
    handoffKey(request, stage),
  );
  if (value === null) return null;
  const handoff = handoffSchema.parse(value);
  if (
    handoff.requestSha256 !== digest ||
    handoff.enrichmentProfileSha256 !== request.enrichmentProfileSha256 ||
    handoff.runId !== request.runId ||
    handoff.county !== request.county ||
    handoff.pipelineKey !== request.pipelineKey ||
    handoff.stage !== stage
  ) {
    throw new Error(`Existing ${stage} handoff has incompatible provenance`);
  }
  log("stage_already_complete", { runId: request.runId, stage });
  return handoff;
}

async function finishStage(
  bucket: string,
  request: BatchRequest,
  digest: string,
  stage: string,
  outputDir: string,
  summary: Record<string, unknown>,
  exclude?: (logicalPath: string) => boolean,
): Promise<BatchHandoff> {
  const artifacts = await uploadDirectoryImmutable(
    s3,
    bucket,
    `runs/${request.runId}/artifacts/${stage}`,
    outputDir,
    { exclude },
  );
  const handoff = handoffSchema.parse({
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    runId: request.runId,
    county: request.county,
    pipelineKey: request.pipelineKey,
    requestSha256: digest,
    enrichmentProfileSha256: request.enrichmentProfileSha256,
    stage,
    status: "complete",
    createdAt: new Date().toISOString(),
    artifacts,
    summary: {
      ...summary,
      runtimeImageProvenance: process.env.RUNTIME_IMAGE_PROVENANCE ?? null,
    },
  });
  await putImmutableJson(s3, bucket, handoffKey(request, stage), handoff);
  log("stage_complete", {
    runId: request.runId,
    stage,
    artifactCount: artifacts.length,
  });
  return handoff;
}

async function runSunbiz(
  bucket: string,
  request: BatchRequest,
  digest: string,
): Promise<void> {
  const stage = "sunbiz";
  if (await completedHandoff(bucket, request, digest, stage)) return;

  const workDir = "/work/sunbiz";
  await rm(workDir, { recursive: true, force: true });
  const sourceDir = path.join(workDir, "source");
  const expandedDir = path.join(workDir, "expanded");
  const extractDir = path.join(workDir, "output", "extract");
  const lexiconDir = path.join(workDir, "output", "lexicon");
  const enrichedDir = path.join(workDir, "output", "enriched");
  await mkdir(sourceDir, { recursive: true });

  const archivePath = path.join(sourceDir, "cordata.zip");
  const baseQueryTablePath = path.join(sourceDir, "query-table.parquet");
  const baseCoveragePath = path.join(sourceDir, "dataset-coverage.json");
  await Promise.all([
    downloadVerifiedObject(
      s3,
      bucket,
      request.sunbiz.archive,
      archivePath,
    ),
    downloadVerifiedObject(
      s3,
      bucket,
      request.inputs.queryTable,
      baseQueryTablePath,
    ),
    downloadVerifiedObject(
      s3,
      bucket,
      request.inputs.coverage,
      baseCoveragePath,
    ),
  ]);

  const archiveModule = await runtimeModule<SunbizArchiveModule>(
    "src/enrichment/sunbiz-archive.mjs",
  );
  const sunbizModule = await runtimeModule<SunbizModule>(
    "src/enrichment/sunbiz.mjs",
  );
  const enrichmentModule = await runtimeModule<SunbizEnrichmentModule>(
    "src/enrichment/query-table-sunbiz.mjs",
  );
  const profile = await loadEnrichmentProfile(request.county);
  const bounds = request.sunbiz.bounds;

  const sourceReceipt = await archiveModule.prepareSunbizArchive({
    archivePath,
    outputDir: expandedDir,
    expectedSha256: request.sunbiz.archive.sha256,
    maxArchiveBytes: bounds.maxArchiveBytes,
    maxExpandedBytes: bounds.maxExpandedBytes,
  });
  await mkdir(path.join(workDir, "output"), { recursive: true });
  await writeFile(
    path.join(workDir, "output", "source-receipt.json"),
    `${JSON.stringify(sourceReceipt, null, 2)}\n`,
  );

  const extract = await sunbizModule.filterSunbizDirectory({
    countyKey: profile.countyKey,
    sourceDir: expandedDir,
    outputDir: extractDir,
    zipPrefixes: request.sunbiz.zipPrefixes,
    chunkRecordLimit: bounds.chunkRecordLimit,
    maxRecords: null,
    maxSourceRecords: bounds.maxSourceRecords,
    jobId: `${request.runId}-sunbiz`,
    quarter: request.quarter,
  });
  const transformed = await sunbizModule.transformSunbizExtract({
    inputDir: extractDir,
    outputDir: lexiconDir,
    partRecordLimit: bounds.partRecordLimit,
    allowIncomplete: false,
  });
  const enrichment = await enrichmentModule.enrichQueryTableWithSunbiz({
    countyKey: profile.countyKey,
    schemaFields: profile.queryTable.schemaFields,
    inputParquet: baseQueryTablePath,
    inputCoverage: baseCoveragePath,
    sunbizExtractDir: extractDir,
    outputParquet: path.join(enrichedDir, "query-table.parquet"),
    outputCoverage: path.join(enrichedDir, "dataset-coverage.json"),
    linksPath: path.join(enrichedDir, "sunbiz-property-links.jsonl"),
    manifestPath: path.join(enrichedDir, "sunbiz-enrichment-manifest.json"),
  });

  await finishStage(
    bucket,
    request,
    digest,
    stage,
    path.join(workDir, "output"),
    { sourceReceipt, extract, transformed, enrichment },
  );
}

function checkpointKey(
  request: BatchRequest,
  digest: string,
  category: string,
  profileUrl: string,
): string {
  const profileDigest = createHash("sha256").update(profileUrl).digest("hex");
  return `runs/${request.runId}/checkpoints/bbb/${category}/${digest}/${profileDigest}.json`;
}

async function runBbb(
  bucket: string,
  request: BatchRequest,
  digest: string,
): Promise<void> {
  const category = requiredEnvironment("BBB_CATEGORY");
  const categoryDefinition = request.bbb.categories.find(
    (candidate) => candidate.key === category,
  );
  if (!categoryDefinition) {
    throw new Error(`Unsupported BBB_CATEGORY ${category}`);
  }
  const stage = `bbb-${category}`;
  if (await completedHandoff(bucket, request, digest, stage)) return;

  const outputDir = `/work/bbb/${category}`;
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const bbbModule = await runtimeModule<BbbModule>(
    "src/enrichment/bbb.mjs",
  );
  const resume = process.env.RESUME_BBB === "true";
  const bounds = request.bbb.bounds;
  const commonOptions = {
    countyKey: request.county,
    reviewedCategory: categoryDefinition,
    reviewedCategories: request.bbb.categories,
    jobId: `${request.runId}-${category}`,
    categoryKey: category,
    categoryUrl: categoryDefinition.url,
    outputDir,
    ...bounds,
    maxDurationMs: bounds.maxDurationMinutes * 60 * 1_000,
  };
  const blockedEvidenceJson = process.env.BBB_SOURCE_ACCESS_EVIDENCE;
  let summary: Record<string, unknown>;
  if (blockedEvidenceJson !== undefined) {
    let unvalidatedEvidence: unknown;
    try {
      unvalidatedEvidence = JSON.parse(blockedEvidenceJson);
    } catch {
      throw new Error("BBB_SOURCE_ACCESS_EVIDENCE must be valid JSON");
    }
    const sourceAccessEvidence =
      bbbModule.validateBbbSourceAccessEvidence(unvalidatedEvidence, {
        countyKey: request.county,
        categories: request.bbb.categories,
      });
    if (
      sourceAccessEvidence.runId !== request.runId ||
      sourceAccessEvidence.batchRequestSha256 !== digest
    ) {
      throw new Error(
        "BBB source-access evidence does not match the batch request provenance",
      );
    }
    summary = await bbbModule.writeBlockedBbbCategoryArtifact({
      ...commonOptions,
      sourceAccessEvidence,
    });
  } else {
    summary = await bbbModule.harvestBbbCategory({
      ...commonOptions,
      chromiumExecutablePath:
        process.env.CHROME_EXECUTABLE_PATH ?? "/usr/bin/chromium",
      headless: true,
    resume,
    onCheckpoint: async (event: {
      profileUrl: string;
      checkpoint: unknown;
    }) => {
      await putImmutableJson(
        s3,
        bucket,
        checkpointKey(request, digest, category, event.profileUrl),
        event.checkpoint,
      );
    },
    loadCheckpoint: async (event: { profileUrl: string }) =>
      getVerifiedJsonIfExists(
        s3,
        bucket,
        checkpointKey(request, digest, category, event.profileUrl),
      ),
    });
  }

  await finishStage(
    bucket,
    request,
    digest,
    stage,
    outputDir,
    summary,
    (logicalPath) => logicalPath.startsWith("checkpoints/"),
  );
}

async function loadRequiredHandoffs(
  bucket: string,
  request: BatchRequest,
  digest: string,
): Promise<BatchHandoff[]> {
  const values = await Promise.all(
    requiredStageNames(request).map((stage) =>
      getVerifiedJson(s3, bucket, handoffKey(request, stage)),
    ),
  );
  return validateRequiredHandoffs(values, request, digest);
}

async function materializeHandoff(
  bucket: string,
  handoff: BatchHandoff,
  outputDir: string,
  include: (logicalPath: string) => boolean = () => true,
): Promise<void> {
  for (const artifact of handoff.artifacts) {
    if (!include(artifact.logicalPath)) continue;
    await downloadVerifiedObject(
      s3,
      bucket,
      artifact,
      path.join(outputDir, artifact.logicalPath),
    );
  }
}

async function runReconciliation(
  bucket: string,
  request: BatchRequest,
  digest: string,
): Promise<void> {
  const stage = "reconciliation";
  if (await completedHandoff(bucket, request, digest, stage)) return;

  const workDir = "/work/reconciliation";
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  const handoffs = await loadRequiredHandoffs(bucket, request, digest);
  const byStage = new Map(handoffs.map((handoff) => [handoff.stage, handoff]));
  for (const handoff of handoffs) {
    const include =
      handoff.stage === "sunbiz"
        ? (logicalPath: string) =>
            [
              "enriched/query-table.parquet",
              "enriched/dataset-coverage.json",
            ].includes(logicalPath)
        : (logicalPath: string) =>
            logicalPath === "manifest/summary.json" ||
            logicalPath.startsWith("profiles/") ||
            logicalPath.startsWith("failures/");
    await materializeHandoff(
      bucket,
      handoff,
      path.join(workDir, "stages", handoff.stage),
      include,
    );
  }

  const sunbiz = byStage.get("sunbiz")!;
  const sunbizDir = path.join(workDir, "stages", "sunbiz");
  requireArtifact(sunbiz, "enriched/query-table.parquet");
  requireArtifact(sunbiz, "enriched/dataset-coverage.json");

  const bbbOutputDir = path.join(workDir, "bbb-reconciled");
  const bbbReconciliationModule =
    await runtimeModule<BbbReconciliationModule>(
      "src/enrichment/bbb-reconcile.mjs",
    );
  const profile = await loadEnrichmentProfile(request.county);
  const bbbSummary =
    await bbbReconciliationModule.reconcileBbbHarvests({
      countyKey: profile.countyKey,
      categories: request.bbb.categories,
      harvestDirs: request.bbb.categories.map((category) =>
        path.join(workDir, "stages", `bbb-${category.key}`),
      ),
      inputCoverage: path.join(
        sunbizDir,
        "enriched",
        "dataset-coverage.json",
      ),
      outputCoverage: path.join(bbbOutputDir, "dataset-coverage.json"),
      outputProfiles: path.join(bbbOutputDir, "bbb-profiles.jsonl"),
      outputFailures: path.join(bbbOutputDir, "bbb-failures.jsonl"),
      outputManifest: path.join(
        bbbOutputDir,
        "bbb-reconciliation-manifest.json",
      ),
    });

  const finalDir = path.join(workDir, "final");
  await mkdir(path.join(finalDir, "bbb"), { recursive: true });
  await Promise.all([
    cp(
      path.join(sunbizDir, "enriched", "query-table.parquet"),
      path.join(finalDir, "query-table.parquet"),
    ),
    cp(
      path.join(bbbOutputDir, "dataset-coverage.json"),
      path.join(finalDir, "dataset-coverage.json"),
    ),
    cp(
      path.join(bbbOutputDir, "bbb-profiles.jsonl"),
      path.join(finalDir, "bbb", "profiles.jsonl"),
    ),
    cp(
      path.join(bbbOutputDir, "bbb-reconciliation-manifest.json"),
      path.join(finalDir, "bbb", "manifest.json"),
    ),
    cp(
      path.join(bbbOutputDir, "bbb-failures.jsonl"),
      path.join(finalDir, "bbb", "failures.jsonl"),
    ),
  ]);

  const finalizationModule = await runtimeModule<EnrichmentFinalizationModule>(
    "src/enrichment/enrichment-finalize.mjs",
  );
  const finalSummary = await finalizationModule.finalizeEnrichmentArtifacts({
    inputDir: finalDir,
    profile,
    provenance: {
      requestSha256: digest,
      enrichmentProfileSha256: request.enrichmentProfileSha256,
      gitCommit: request.provenance.gitCommit,
      treeDigest: request.provenance.treeDigest,
      runtimeImageProvenance:
        process.env.RUNTIME_IMAGE_PROVENANCE ?? null,
    },
  });
  await finishStage(
    bucket,
    request,
    digest,
    stage,
    finalDir,
    { bbb: bbbSummary, final: finalSummary },
  );
}

async function main(): Promise<void> {
  const stage = process.argv[2];
  if (!["sunbiz", "bbb", "reconciliation"].includes(stage ?? "")) {
    throw new Error(
      "Usage: worker <sunbiz|bbb|reconciliation>",
    );
  }
  const { bucket, request, digest } = await loadRequest();
  log("stage_started", { runId: request.runId, stage });
  if (stage === "sunbiz") return runSunbiz(bucket, request, digest);
  if (stage === "bbb") return runBbb(bucket, request, digest);
  return runReconciliation(bucket, request, digest);
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      event: "stage_failed",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
});
