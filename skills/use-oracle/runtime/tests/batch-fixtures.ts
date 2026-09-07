import {
  enrichmentProfileDigest,
  parseBatchRequest,
  type BatchRequest,
  type BbbCategory,
  type RegisteredEnrichmentProfile,
} from "../src/batch/contracts.js";

function categories(count: number): BbbCategory[] {
  return Array.from({ length: count }, (_, index) => {
    const key = `synthetic-trade-${index + 1}`;
    const reviewedPath = `/us/fl/testville/category/${key}`;
    return {
      key,
      url: `https://www.bbb.org${reviewedPath}`,
      reviewedPath,
    };
  });
}

export function syntheticProfile(
  countyKey = "synthetic-county",
  categoryCount = 2,
): RegisteredEnrichmentProfile {
  return {
    countyKey,
    countyName: "Synthetic County",
    stateCode: "FL",
    sunbiz: { zipPrefixes: ["330"] },
    bbb: { categories: categories(categoryCount) },
    queryTable: {
      schemaFields: {
        property_id: { type: "UTF8" },
        address_street: { type: "UTF8", optional: true },
        address_zip: { type: "UTF8", optional: true },
        has_permits: { type: "BOOLEAN", optional: true },
        has_sunbiz_tenant: { type: "BOOLEAN", optional: true },
        has_bbb_contractor: { type: "BOOLEAN", optional: true },
      },
    },
    publication: {
      bucket: "synthetic-query-table",
      queryTableIpnsLabel: "synthetic-query-table-name",
      coverageIpnsLabel: "synthetic-coverage-name",
    },
  };
}

export function syntheticRequest(options: {
  countyKey?: string;
  categoryCount?: number;
  bbbDependencyPolicy?: "serial" | "parallel";
  recoveryBbbDependencyPolicy?: "serial" | "parallel";
  costCeilingUsd?: number;
} = {}): BatchRequest {
  const profile = syntheticProfile(
    options.countyKey,
    options.categoryCount,
  );
  const queryTableSha256 = "a".repeat(64);
  const coverageSha256 = "b".repeat(64);
  const archiveSha256 = "c".repeat(64);
  return parseBatchRequest({
    schemaVersion: "elephant.county-enrichment-batch-request.v1",
    runId: `${profile.countyKey}-2026q3-source-digest`,
    county: profile.countyKey,
    pipelineKey: "sunbiz-bbb-reconcile",
    quarter: "2026Q3",
    enrichmentProfileSha256: enrichmentProfileDigest(profile),
    inputs: {
      queryTable: {
        key: `inputs/query-table/${profile.countyKey}/${queryTableSha256}/query-table.parquet`,
        sha256: queryTableSha256,
        bytes: 1_024,
      },
      coverage: {
        key: `inputs/query-table/${profile.countyKey}/${coverageSha256}/dataset-coverage.json`,
        sha256: coverageSha256,
        bytes: 256,
      },
    },
    sunbiz: {
      archive: {
        key: `inputs/sunbiz/2026Q3/${archiveSha256}/cordata.zip`,
        sha256: archiveSha256,
        bytes: 1_000_000,
      },
      zipPrefixes: profile.sunbiz.zipPrefixes,
      bounds: {
        maxArchiveBytes: 3 * 1024 ** 3,
        maxExpandedBytes: 25 * 1024 ** 3,
        maxSourceRecords: null,
        chunkRecordLimit: 5_000,
        partRecordLimit: 5_000,
        maxDurationMinutes: 240,
      },
    },
    bbb: {
      categories: profile.bbb.categories,
      bounds: {
        maxPages: 2,
        maxProfiles: 5,
        maxRequests: 100,
        maxDurationMinutes: 30,
        partRecordLimit: 5,
        pageDelayMs: 2_000,
        profileDelayMs: 1_500,
        navigationTimeoutMs: 90_000,
        challengeAttempts: 3,
        challengeCheckIntervalMs: 3_000,
        challengeChecksPerAttempt: 6,
        includeHtml: true,
        profileSubpages: [],
      },
    },
    execution: {
      bbbDependencyPolicy: options.bbbDependencyPolicy ?? "serial",
      recoveryBbbDependencyPolicy:
        options.recoveryBbbDependencyPolicy ?? "parallel",
    },
    costCeilingUsd: options.costCeilingUsd ?? 5,
    provenance: {
      gitCommit: "d".repeat(40),
      treeDigest: "e".repeat(64),
    },
  });
}
