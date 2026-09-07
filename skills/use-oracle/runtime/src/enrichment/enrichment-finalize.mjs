import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import {
  enrichmentProfileDigest,
  validateEnrichmentProfile,
} from "../counties/enrichment-profile.mjs";

const require = createRequire(import.meta.url);
const { ParquetReader } = require("@dsnp/parquetjs");

async function fileIntegrity(filePath) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  const fileStat = await stat(filePath);
  return { bytes: fileStat.size, sha256: hash.digest("hex") };
}

function requireCoverageDataset(coverage, source) {
  const dataset = coverage.datasets?.find((entry) => entry?.source === source);
  if (!dataset) throw new Error(`Enrichment coverage is missing ${source}`);
  return dataset;
}

function validateProvenance(value, profile) {
  if (value === undefined) {
    return {
      enrichmentProfileSha256: enrichmentProfileDigest(profile),
    };
  }
  if (
    !value ||
    !/^[a-f0-9]{64}$/.test(value.requestSha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(value.enrichmentProfileSha256 ?? "") ||
    !/^[a-f0-9]{40}$/.test(value.gitCommit ?? "") ||
    !/^[a-f0-9]{64}$/.test(value.treeDigest ?? "") ||
    !(
      value.runtimeImageProvenance === null ||
      (typeof value.runtimeImageProvenance === "string" &&
        value.runtimeImageProvenance.length > 0)
    ) ||
    value.enrichmentProfileSha256 !== enrichmentProfileDigest(profile)
  ) {
    throw new Error("Enrichment finalization requires valid immutable provenance");
  }
  return { ...value };
}

export async function finalizeEnrichmentArtifacts({
  inputDir,
  profile,
  provenance,
}) {
  const enrichmentProfile = validateEnrichmentProfile(profile);
  const immutableProvenance = validateProvenance(
    provenance,
    enrichmentProfile,
  );
  const countyKey = enrichmentProfile.countyKey;
  const parquetPath = path.join(inputDir, "query-table.parquet");
  const coveragePath = path.join(inputDir, "dataset-coverage.json");
  const manifestPath = path.join(inputDir, "manifest.json");
  const coverage = JSON.parse(await readFile(coveragePath, "utf8"));
  if (coverage.county !== countyKey) {
    throw new Error(
      `Expected ${countyKey} coverage, received ${coverage.county ?? "missing"}`,
    );
  }
  const appraisal = requireCoverageDataset(coverage, "appraisal");
  const sunbiz = requireCoverageDataset(coverage, "sunbiz");
  const bbb = requireCoverageDataset(coverage, "bbb");
  const permits = coverage.datasets?.find(
    (entry) => entry?.source === "permits",
  );

  const reader = await ParquetReader.openFile(parquetPath);
  const propertyIds = new Set();
  let rowCount = 0;
  let sunbizPropertyCount = 0;
  let bbbContractorPropertyCount = 0;
  let permitPropertyCount = 0;
  try {
    const cursor = reader.getCursor([
      "property_id",
      "has_sunbiz_tenant",
      "has_bbb_contractor",
      "has_permits",
    ]);
    let row = await cursor.next();
    while (row) {
      rowCount += 1;
      if (typeof row.property_id !== "string" || row.property_id.length === 0) {
        throw new Error("Enrichment query table contains a null property_id");
      }
      if (propertyIds.has(row.property_id)) {
        throw new Error(
          `Enrichment query table contains duplicate property_id ${row.property_id}`,
        );
      }
      propertyIds.add(row.property_id);
      if (row.has_sunbiz_tenant === true) sunbizPropertyCount += 1;
      if (row.has_bbb_contractor === true) bbbContractorPropertyCount += 1;
      if (row.has_permits === true) permitPropertyCount += 1;
      row = await cursor.next();
    }
  } finally {
    await reader.close();
  }

  if (rowCount !== appraisal.ingested_count) {
    throw new Error(
      `Appraisal coverage mismatch: ${rowCount} query rows vs ${appraisal.ingested_count}`,
    );
  }
  if (sunbizPropertyCount !== sunbiz.linked_property_count) {
    throw new Error(
      `Sunbiz coverage mismatch: ${sunbizPropertyCount} flagged properties vs ${sunbiz.linked_property_count}`,
    );
  }
  if (bbbContractorPropertyCount !== bbb.linked_property_count) {
    throw new Error(
      `BBB coverage mismatch: ${bbbContractorPropertyCount} flagged properties vs ${bbb.linked_property_count}`,
    );
  }
  if (
    permits?.linked_property_count !== undefined &&
    permitPropertyCount !== permits.linked_property_count
  ) {
    throw new Error(
      `Permit coverage mismatch: ${permitPropertyCount} flagged properties vs ${permits.linked_property_count}`,
    );
  }

  const [queryTableIntegrity, coverageIntegrity] = await Promise.all([
    fileIntegrity(parquetPath),
    fileIntegrity(coveragePath),
  ]);
  const artifacts = {
    schemaVersion: "elephant.enrichment-publication-artifacts.v1",
    county: countyKey,
    provenance: immutableProvenance,
    parquetPath,
    coveragePath,
    manifestPath,
    bucket: enrichmentProfile.publication.bucket,
    queryTableIpnsLabel:
      enrichmentProfile.publication.queryTableIpnsLabel,
    coverageIpnsLabel: enrichmentProfile.publication.coverageIpnsLabel,
    rowCount,
    distinctPropertyIdCount: propertyIds.size,
    expectedCount: appraisal.expected_count,
    sunbizPropertyCount,
    sunbizRegistrationCount: sunbiz.ingested_count,
    bbbContractorPropertyCount,
    bbbProfileCount: bbb.ingested_count,
    permitPropertyCount,
    artifactIntegrity: {
      queryTable: queryTableIntegrity,
      coverage: coverageIntegrity,
    },
  };
  await writeFile(manifestPath, `${JSON.stringify(artifacts, null, 2)}\n`, "utf8");
  return artifacts;
}
