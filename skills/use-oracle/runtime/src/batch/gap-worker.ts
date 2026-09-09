import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { S3Client } from "@aws-sdk/client-s3";

import {
  gapRequestDigest,
  parseGapBatchRequest,
  type GapBatchRequest,
} from "./gap-contracts.js";
import { assertGapCostAllowed } from "./gap-cost-plan.js";
import {
  downloadVerifiedObject,
  getVerifiedJson,
  getVerifiedJsonIfExists,
  putImmutableJson,
  putVersionedCheckpointJson,
  uploadDirectoryImmutable,
} from "./s3-integrity.js";

const s3 = new S3Client({});
const runtimeRoot = path.resolve(
  process.env.ORACLE_RUNTIME_ROOT ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../.."),
);

interface ConsolidationModule {
  buildPropertyConsolidation(
    options: Record<string, unknown>,
  ): Promise<Record<string, any>>;
}

interface QueryTableModule {
  enrichQueryTableFile(
    options: Record<string, unknown>,
  ): Promise<Record<string, any>>;
}

interface PlacesModule {
  extractContactFreeOverturePlaces(
    options: Record<string, unknown>,
  ): Promise<Record<string, any>>;
}

interface PublicationModule {
  publishDuvalGapArtifacts(
    options: Record<string, unknown>,
  ): Promise<Record<string, any>>;
}

interface ProfileModule {
  duvalGapProfile: Record<string, any>;
}

interface EnrichmentProfilesModule {
  requireEnrichmentProfile(county: string): {
    queryTable: { schemaFields: Record<string, unknown> };
  };
}

async function runtimeModule<T>(relativePath: string): Promise<T> {
  return (await import(
    pathToFileURL(path.join(runtimeRoot, relativePath)).href
  )) as T;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function emit(event: string, details: Record<string, unknown> = {}): void {
  process.stdout.write(
    `${JSON.stringify({
      event,
      observedAt: new Date().toISOString(),
      ...details,
    })}\n`,
  );
}

async function downloadInputs(
  bucket: string,
  request: GapBatchRequest,
  inputDir: string,
) {
  const paths = {
    queryTable: path.join(inputDir, "query-table.parquet"),
    permitTable: path.join(inputDir, "permit-table.parquet"),
    sunbizHandoff: path.join(inputDir, "sunbiz-handoff.json"),
    ownerOccupiedNal: path.join(inputDir, "owner-occupied-nal.jsonl"),
    hoaMembership:
      request.inputs.hoaMembership === null
        ? null
        : path.join(inputDir, "hoa-membership.jsonl"),
    avmFeed:
      request.inputs.avmFeed === null
        ? null
        : path.join(inputDir, "avm-feed.jsonl"),
    publishApproval:
      request.inputs.publishApproval === null
        ? null
        : path.join(inputDir, "publish-approval.json"),
  };
  await Promise.all(
    Object.entries(paths).map(async ([name, outputPath]) => {
      if (outputPath === null) return;
      const source =
        request.inputs[name as keyof GapBatchRequest["inputs"]];
      if (source === null) return;
      await downloadVerifiedObject(s3, bucket, source, outputPath);
    }),
  );
  return paths;
}

async function materializeSunbizHandoff(
  bucket: string,
  handoffPath: string,
  inputDir: string,
): Promise<{ extractDir: string; linksPath: string }> {
  const handoff = JSON.parse(await readFile(handoffPath, "utf8")) as {
    stage?: string;
    status?: string;
    artifacts?: {
      logicalPath: string;
      key: string;
      bytes: number;
      sha256: string;
    }[];
  };
  if (handoff.stage !== "sunbiz" || handoff.status !== "complete") {
    throw new Error("Sunbiz handoff is not a complete immutable sunbiz stage");
  }
  const selected = (handoff.artifacts ?? []).filter(
    (artifact) =>
      artifact.logicalPath.startsWith("extract/") ||
      artifact.logicalPath === "enriched/sunbiz-property-links.jsonl",
  );
  if (
    !selected.some((artifact) => artifact.logicalPath === "extract/manifest.json") ||
    !selected.some(
      (artifact) =>
        artifact.logicalPath === "enriched/sunbiz-property-links.jsonl",
    )
  ) {
    throw new Error("Sunbiz handoff lacks extract manifest or property links");
  }
  const root = path.join(inputDir, "sunbiz");
  let next = 0;
  const workers = Array.from({ length: 16 }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      const artifact = selected[index];
      if (artifact === undefined) return;
      await downloadVerifiedObject(
        s3,
        bucket,
        artifact,
        path.join(root, artifact.logicalPath),
      );
    }
  });
  await Promise.all(workers);
  return {
    extractDir: path.join(root, "extract"),
    linksPath: path.join(root, "enriched", "sunbiz-property-links.jsonl"),
  };
}

async function main(): Promise<void> {
  const bucket = requiredEnvironment("ARTIFACT_BUCKET");
  const requestKey = requiredEnvironment("REQUEST_KEY");
  const expectedDigest = requiredEnvironment("REQUEST_SHA256");
  const request = parseGapBatchRequest(
    await getVerifiedJson(s3, bucket, requestKey, expectedDigest),
  );
  const digest = gapRequestDigest(request);
  if (digest !== expectedDigest || !requestKey.includes(digest)) {
    throw new Error("Gap request key or digest is not content-addressed");
  }
  if (
    request.provenance.gitCommit !== requiredEnvironment("RUNTIME_GIT_COMMIT") ||
    request.provenance.treeDigest !==
      requiredEnvironment("RUNTIME_TREE_DIGEST")
  ) {
    throw new Error("Gap request provenance does not match the runtime image");
  }
  const cost = assertGapCostAllowed(
    request,
    Number(requiredEnvironment("MAX_COST_CEILING_USD")),
  );
  emit("duval_gap_started", {
    runId: request.runId,
    requestDigest: digest,
    livePublish:
      request.inputs.publishApproval !== null &&
      process.env.GAP_LIVE_PUBLISH === "true",
    estimatedCostUsd: cost.estimatedUsd,
  });

  const workDir = "/work/duval-gap";
  const inputDir = path.join(workDir, "inputs");
  const outputDir = path.join(workDir, "outputs");
  await rm(workDir, { recursive: true, force: true });
  await Promise.all([
    mkdir(inputDir, { recursive: true }),
    mkdir(outputDir, { recursive: true }),
  ]);
  const inputs = await downloadInputs(bucket, request, inputDir);
  emit("duval_gap_inputs_verified", { runId: request.runId });
  const sunbiz = await materializeSunbizHandoff(
    bucket,
    inputs.sunbizHandoff,
    inputDir,
  );
  emit("duval_gap_sunbiz_materialized", { runId: request.runId });

  const [
    consolidationModule,
    queryTableModule,
    placesModule,
    publicationModule,
    profileModule,
    profilesModule,
  ] = await Promise.all([
    runtimeModule<ConsolidationModule>("src/gaps/property-consolidation.mjs"),
    runtimeModule<QueryTableModule>("src/gaps/query-table-enrichment.mjs"),
    runtimeModule<PlacesModule>("src/gaps/overture-places.mjs"),
    runtimeModule<PublicationModule>("src/gaps/filebase-publication.mjs"),
    runtimeModule<ProfileModule>("src/counties/duval/gap-profile.mjs"),
    runtimeModule<EnrichmentProfilesModule>(
      "src/counties/enrichment-profiles.mjs",
    ),
  ]);
  const profile = profileModule.duvalGapProfile;
  const protectedProfileCids = {
    queryTable: profile.protectedPublications.queryTable.frozenCid,
    permitTable: profile.protectedPublications.permitTable.frozenCid,
    coverage: profile.protectedPublications.coverage.frozenCid,
  };
  if (
    JSON.stringify(protectedProfileCids) !==
    JSON.stringify(request.protectedCids)
  ) {
    throw new Error("Gap request protected CIDs do not match runtime profile");
  }
  const propertyOutput = path.join(outputDir, "property");
  const placesOutput = path.join(outputDir, "places");
  const queryOutput = path.join(outputDir, "query-table.parquet");
  const queryManifest = path.join(outputDir, "query-table-manifest.json");
  const publicationCheckpointKey =
    `runs/${request.runId}/checkpoints/duval-gap/publication.json`;
  let lastPublicationCheckpoint: Record<string, unknown> | null = null;

  const consolidation = await consolidationModule.buildPropertyConsolidation({
    county: request.county,
    queryTableParquet: inputs.queryTable,
    permitParquet: inputs.permitTable,
    sunbizExtractDir: sunbiz.extractDir,
    sunbizLinksPath: sunbiz.linksPath,
    ownerOccupiedPath: inputs.ownerOccupiedNal,
    hoaPath: inputs.hoaMembership,
    avmPath: inputs.avmFeed,
    outputDir: propertyOutput,
    frozenAt: request.frozenAt,
    expectedPropertyCount: request.expected.propertyCount,
    expectedPermitCount: request.expected.permitCount,
    onProgress: (details: Record<string, unknown>) =>
      emit("duval_gap_progress", { runId: request.runId, ...details }),
  });
  emit("duval_gap_consolidation_complete", {
    runId: request.runId,
    propertyCount: consolidation.manifest.propertyCount,
  });
  const consolidationExpected = {
    linkedPermitCount: request.expected.linkedPermitCount,
    sunbizSourceCount: request.expected.sunbizSourceCount,
    sunbizLinkCount: request.expected.sunbizLinkCount,
    sunbizLinkedPropertyCount: request.expected.sunbizLinkedPropertyCount,
    ownerOccupiedSourceRows: request.expected.ownerOccupiedSourceCount,
  };
  for (const [key, expected] of Object.entries(consolidationExpected)) {
    const observed = consolidation.manifest.reconciliation[key];
    if (observed !== expected) {
      throw new Error(
        `Consolidation ${key} ${observed} does not match ${expected}`,
      );
    }
  }

  const places = await placesModule.extractContactFreeOverturePlaces({
    county: request.county,
    countyFips: request.countyFips,
    release: request.overture.release,
    boundarySource: request.overture.boundarySource,
    outputDir: placesOutput,
    cacheDir: path.join(workDir, "cache"),
    frozenAt: request.frozenAt,
  });
  emit("duval_gap_places_complete", {
    runId: request.runId,
    rowCount: places.rowCount,
  });
  const query = await queryTableModule.enrichQueryTableFile({
    county: request.county,
    inputParquet: inputs.queryTable,
    outputParquet: queryOutput,
    schemaFields:
      profilesModule.requireEnrichmentProfile(request.county).queryTable
        .schemaFields,
    cidManifestPath: path.join(propertyOutput, "manifest.json"),
    ownerOccupiedPath: inputs.ownerOccupiedNal,
    hoaPath: inputs.hoaMembership,
    avmPath: inputs.avmFeed,
    outputManifest: queryManifest,
    expectedRowCount: request.expected.propertyCount,
    expectedCounts: {
      ownerOccupiedSourceCount: request.expected.ownerOccupiedSourceCount,
      permitPropertyCount: request.expected.permitPropertyCount,
      linkedPermitCount: request.expected.linkedPermitCount,
      sunbizPropertyCount: request.expected.sunbizLinkedPropertyCount,
      bbbPropertyCount: request.expected.bbbPropertyCount,
      bbbWithoutPermitsCount: 0,
      ownerOccupiedTrueCount: request.expected.ownerOccupiedTrueCount,
      ownerOccupiedFalseCount: request.expected.ownerOccupiedFalseCount,
      ownerOccupiedNullCount: request.expected.ownerOccupiedNullCount,
    },
    frozenAt: request.frozenAt,
    onProgress: (details: Record<string, unknown>) =>
      emit("duval_gap_progress", { runId: request.runId, ...details }),
  });
  emit("duval_gap_query_table_complete", {
    runId: request.runId,
    rowCount: query.rowCount,
    cidCount: query.cidCount,
  });
  const publication = await publicationModule.publishDuvalGapArtifacts({
    profile,
    propertyOutputDir: propertyOutput,
    placesOutputDir: placesOutput,
    queryTablePath: queryOutput,
    approvalPath: inputs.publishApproval,
    receiptPath: path.join(outputDir, "publication-receipt.json"),
    dryRun:
      inputs.publishApproval === null ||
      process.env.GAP_LIVE_PUBLISH !== "true",
    checkpointIdentity: {
      requestDigest: digest,
      gitCommit: request.provenance.gitCommit,
      treeDigest: request.provenance.treeDigest,
    },
    checkpointStore: {
      load: () =>
        getVerifiedJsonIfExists(s3, bucket, publicationCheckpointKey),
      save: async (value: unknown) => {
        lastPublicationCheckpoint = await putVersionedCheckpointJson(
          s3,
          bucket,
          publicationCheckpointKey,
          value,
        );
      },
    },
    uploadConcurrency: request.publication.filebaseConcurrency,
    checkpointEvery: request.publication.checkpointEvery,
    onProgress: (details: Record<string, unknown>) =>
      emit("duval_gap_progress", { runId: request.runId, ...details }),
    env: process.env,
  });
  emit("duval_gap_publication_phase_complete", {
    runId: request.runId,
    status:
      publication.status ??
      (publication.dryRun ? "awaiting-exact-byte-approval" : "unknown"),
  });
  const consolidationSummary = {
    propertyCount: consolidation.manifest.propertyCount,
    totalBytes: consolidation.manifest.totalBytes,
    reconciliation: consolidation.manifest.reconciliation,
    indexCid: consolidation.indexCid,
    manifestCid: consolidation.manifestCid,
  };
  const publicationSummary = {
    dryRun: publication.dryRun ?? false,
    status:
      publication.status ??
      (inputs.publishApproval === null
        ? "awaiting-exact-byte-approval"
        : "unknown"),
    artifacts: publication.artifacts,
    destinations: publication.destinations,
    names: publication.names,
    placesDirectoryCid: publication.placesDirectoryCid,
    placesTableUrl: publication.placesTableUrl,
    checkpoint: lastPublicationCheckpoint,
    completedAt: publication.completedAt,
  };
  await writeFile(
    path.join(outputDir, "run-summary.json"),
    `${JSON.stringify(
      {
        requestDigest: digest,
        cost,
        consolidation: consolidationSummary,
        places,
        query,
        publication: publicationSummary,
      },
      null,
      2,
    )}\n`,
  );

  const artifacts = await uploadDirectoryImmutable(
    s3,
    bucket,
    `runs/${request.runId}/artifacts/duval-gap`,
    outputDir,
    {
      exclude: (logicalPath) => logicalPath.startsWith("property/properties/"),
    },
  );
  await putImmutableJson(
    s3,
    bucket,
    `runs/${request.runId}/handoffs/duval-gap-${digest}.json`,
    {
      schemaVersion: "elephant.duval-mcp-gap-handoff.v1",
      runId: request.runId,
      county: request.county,
      requestDigest: digest,
      frozenAt: request.frozenAt,
      status:
        inputs.publishApproval !== null &&
        process.env.GAP_LIVE_PUBLISH === "true"
          ? "published"
          : "awaiting-exact-byte-approval",
      artifacts,
      summary: {
        consolidation: consolidationSummary,
        places,
        query,
        publication: publicationSummary,
      },
    },
  );
  emit("duval_gap_handoff_complete", {
    runId: request.runId,
    requestDigest: digest,
  });
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      event: "duval_gap_worker_failed",
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
});
