import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { S3Client } from "@aws-sdk/client-s3";

import {
  gapRequestDigest,
  parseGapBatchRequest,
  type GapBatchRequest,
} from "./gap-contracts.js";
import {
  downloadVerifiedObject,
  getVerifiedJson,
  putImmutableJson,
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

  const workDir = "/work/duval-gap";
  const inputDir = path.join(workDir, "inputs");
  const outputDir = path.join(workDir, "outputs");
  await rm(workDir, { recursive: true, force: true });
  await Promise.all([
    mkdir(inputDir, { recursive: true }),
    mkdir(outputDir, { recursive: true }),
  ]);
  const inputs = await downloadInputs(bucket, request, inputDir);
  const sunbiz = await materializeSunbizHandoff(
    bucket,
    inputs.sunbizHandoff,
    inputDir,
  );

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
  const propertyOutput = path.join(outputDir, "property");
  const placesOutput = path.join(outputDir, "places");
  const queryOutput = path.join(outputDir, "query-table.parquet");
  const queryManifest = path.join(outputDir, "query-table-manifest.json");

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
  });
  if (
    consolidation.manifest.reconciliation.sunbizLinkedPropertyCount !==
    request.expected.sunbizLinkedPropertyCount
  ) {
    throw new Error("Sunbiz linked-property reconciliation failed");
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
    frozenAt: request.frozenAt,
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
    env: process.env,
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
    completedAt: publication.completedAt,
  };
  await writeFile(
    path.join(outputDir, "run-summary.json"),
    `${JSON.stringify(
      {
        requestDigest: digest,
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
