import { createRequire } from "node:module";
import { mkdir, readFile, readdir, rename } from "node:fs/promises";
import path from "node:path";

import { writeQueryTableParquet } from "../core/query-table.mjs";
import { permitProfileDigest } from "../counties/permit-profile.mjs";
import {
  normalizedPermitRecordSchema,
  parcelPermitStatusSchema,
  permitArtifactManifestSchema,
  permitCoverageSchema,
  permitTableSchemaFields,
  toPermitTableRow,
} from "./contracts.mjs";
import {
  atomicWriteJson,
  fileIntegrity,
  readJson,
} from "./storage.mjs";

const require = createRequire(import.meta.url);
const { ParquetReader } = require("@dsnp/parquetjs");

async function readParquetRows(parquetPath) {
  const reader = await ParquetReader.openFile(parquetPath);
  const rows = [];
  try {
    const cursor = reader.getCursor();
    let row = await cursor.next();
    while (row) {
      rows.push(row);
      row = await cursor.next();
    }
  } finally {
    await reader.close();
  }
  return rows;
}

async function jsonFiles(directory) {
  try {
    return (await readdir(directory))
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => path.join(directory, name));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function reconcilePermitHarvest({ harvestDir, profile }) {
  const records = [];
  const statuses = [];
  for (const jurisdiction of profile.jurisdictions) {
    for (const filePath of await jsonFiles(
      path.join(harvestDir, "extracted", jurisdiction.key),
    )) {
      const artifact = await readJson(filePath);
      records.push(
        ...(artifact.records ?? []).map((record) =>
          normalizedPermitRecordSchema.parse(record),
        ),
      );
    }
    for (const filePath of await jsonFiles(
      path.join(harvestDir, "status", jurisdiction.key),
    )) {
      statuses.push(parcelPermitStatusSchema.parse(await readJson(filePath)));
    }
  }
  const uniqueRecords = new Map();
  for (const record of records) {
    const existing = uniqueRecords.get(record.property_improvement_id);
    if (
      existing &&
      (existing.property_id !== record.property_id ||
        existing.parcel_identifier !== record.parcel_identifier)
    ) {
      throw new Error(
        `Permit ${record.property_improvement_id} has conflicting property links`,
      );
    }
    uniqueRecords.set(record.property_improvement_id, record);
  }
  return {
    records: [...uniqueRecords.values()].sort((left, right) =>
      left.property_improvement_id.localeCompare(
        right.property_improvement_id,
      ),
    ),
    statuses: statuses.sort((left, right) =>
      left.parcelIdentifier.localeCompare(right.parcelIdentifier),
    ),
  };
}

function buildPermitCoverage({ records, statuses, profile, exportedAt }) {
  const jurisdictions = profile.jurisdictions.map((jurisdiction) => {
    const jurisdictionStatuses = statuses.filter(
      (status) => status.jurisdictionKey === jurisdiction.key,
    );
    const jurisdictionRecords = records.filter(
      (record) => record.jurisdictionKey === jurisdiction.key,
    );
    const dates = jurisdictionRecords
      .flatMap((record) => [
        record.permit_issue_date,
        record.application_received_date,
        record.opened_date,
      ])
      .filter(Boolean)
      .sort();
    return {
      jurisdictionKey: jurisdiction.key,
      sourceStatus: jurisdiction.status,
      attemptedParcels: jurisdictionStatuses.length,
      succeededParcels: jurisdictionStatuses.filter(
        (status) => status.status === "done",
      ).length,
      failedParcels: jurisdictionStatuses.filter(
        (status) => status.status !== "done",
      ).length,
      permitCount: jurisdictionRecords.length,
      firstPermitDate: dates[0] ?? null,
      lastPermitDate: dates.at(-1) ?? null,
      gapReason:
        jurisdiction.status === "supported"
          ? null
          : jurisdiction.recordsRequest?.systemScope ??
            `Source status: ${jurisdiction.status}`,
    };
  });
  const linkedPermits = records.filter(
    (record) => record.property_id !== null,
  ).length;
  const hasSupportedSource = profile.jurisdictions.some(
    (jurisdiction) => jurisdiction.status === "supported",
  );
  const allSupported = profile.jurisdictions.every(
    (jurisdiction) => jurisdiction.status === "supported",
  );
  return permitCoverageSchema.parse({
    schemaVersion: "elephant.permit-coverage.v1",
    countyKey: profile.countyKey,
    exportedAt,
    availability: !hasSupportedSource
      ? "unsupported"
      : allSupported
        ? "supported_full"
        : "supported_partial",
    attemptedParcels: statuses.length,
    succeededParcels: statuses.filter(
      (status) => status.status === "done",
    ).length,
    failedParcels: statuses.filter(
      (status) => status.status !== "done",
    ).length,
    validUnlinkedPermits: records.length - linkedPermits,
    linkedPermits,
    jurisdictions,
  });
}

function rewritePropertyRows(propertyRows, records) {
  const propertyIds = new Set();
  const parcelByProperty = new Map();
  for (const row of propertyRows) {
    if (!row.property_id || propertyIds.has(row.property_id)) {
      throw new Error(
        `Property table has null or duplicate property_id ${row.property_id ?? "null"}`,
      );
    }
    propertyIds.add(row.property_id);
    parcelByProperty.set(row.property_id, row.parcel_identifier ?? null);
  }
  const counts = new Map();
  for (const record of records) {
    if (!record.property_id || !propertyIds.has(record.property_id)) {
      throw new Error(
        `Permit ${record.property_improvement_id} is not linked to an exported property`,
      );
    }
    if (
      parcelByProperty.get(record.property_id) !==
      record.parcel_identifier
    ) {
      throw new Error(
        `Permit ${record.property_improvement_id} parcel link does not match its property row`,
      );
    }
    counts.set(record.property_id, (counts.get(record.property_id) ?? 0) + 1);
  }
  return propertyRows.map((row) => {
    const permitCount = counts.get(row.property_id) ?? 0;
    return {
      ...row,
      has_permits: permitCount > 0,
      permit_count: permitCount,
    };
  });
}

function mergeDatasetCoverage(baseCoverage, permitCoverage, profile) {
  if (baseCoverage.county !== profile.countyKey) {
    throw new Error(
      `Expected ${profile.countyKey} coverage, received ${baseCoverage.county ?? "missing"}`,
    );
  }
  const linkedPropertyIds = new Set();
  const permitDataset = {
    county: profile.countyKey,
    source: "permits",
    ingested_count: permitCoverage.linkedPermits,
    expected_count: null,
    linked_property_count: linkedPropertyIds.size,
    attempted_count: permitCoverage.attemptedParcels,
    succeeded_count: permitCoverage.succeededParcels,
    failed_count: permitCoverage.failedParcels,
    availability: permitCoverage.availability,
    first_loaded_at: permitCoverage.exportedAt,
    last_loaded_at: permitCoverage.exportedAt,
    cid: null,
    ipns_label: profile.publication.permitTableIpnsLabel,
    jurisdictions: permitCoverage.jurisdictions,
  };
  return {
    ...baseCoverage,
    exportedAt: permitCoverage.exportedAt,
    datasets: [
      ...(baseCoverage.datasets ?? []).filter(
        (dataset) => dataset.source !== "permits",
      ),
      permitDataset,
    ],
  };
}

export async function exportPermitArtifacts({
  harvestDir,
  inputPropertyParquet,
  inputCoveragePath,
  outputDir,
  profile,
  propertySchemaFields,
  jobId,
  exportedAt = new Date().toISOString(),
  allowEmpty = false,
}) {
  const { records, statuses } = await reconcilePermitHarvest({
    harvestDir,
    profile,
  });
  if (records.length === 0 && !allowEmpty) {
    throw new Error(
      "Refusing to export an empty permit table without explicit allowEmpty approval",
    );
  }
  const propertyRows = await readParquetRows(inputPropertyParquet);
  const rewrittenProperties = rewritePropertyRows(propertyRows, records);
  const permitCoverage = buildPermitCoverage({
    records,
    statuses,
    profile,
    exportedAt,
  });
  const baseCoverage = JSON.parse(
    await readFile(inputCoveragePath, "utf8"),
  );
  const datasetCoverage = mergeDatasetCoverage(
    baseCoverage,
    permitCoverage,
    profile,
  );
  datasetCoverage.datasets = datasetCoverage.datasets.map((dataset) =>
    dataset.source === "permits"
      ? {
          ...dataset,
          linked_property_count: new Set(
            records.map((record) => record.property_id).filter(Boolean),
          ).size,
        }
      : dataset,
  );

  await mkdir(outputDir, { recursive: true });
  const permitPath = path.join(outputDir, "permit-query-table.parquet");
  const propertyPath = path.join(outputDir, "query-table.parquet");
  const coveragePath = path.join(outputDir, "dataset-coverage.json");
  const permitCoveragePath = path.join(
    outputDir,
    "permit-coverage.json",
  );
  const permitTemporaryPath = `${permitPath}.tmp`;
  const propertyTemporaryPath = `${propertyPath}.tmp`;
  await writeQueryTableParquet({
    parquetPath: permitTemporaryPath,
    schemaFields: permitTableSchemaFields,
    rows: records.map(toPermitTableRow),
  });
  await writeQueryTableParquet({
    parquetPath: propertyTemporaryPath,
    schemaFields: propertySchemaFields,
    rows: rewrittenProperties,
  });
  await Promise.all([
    rename(permitTemporaryPath, permitPath),
    rename(propertyTemporaryPath, propertyPath),
    atomicWriteJson(coveragePath, datasetCoverage),
    atomicWriteJson(permitCoveragePath, permitCoverage),
  ]);

  const publicArtifacts = await Promise.all(
    [
      [permitPath, records.length],
      [propertyPath, rewrittenProperties.length],
      [coveragePath, null],
      [permitCoveragePath, null],
    ].map(async ([filePath, rowCount]) => ({
      path: filePath,
      ...(await fileIntegrity(filePath)),
      rowCount,
      privacy: "public",
    })),
  );
  const harvestSummaryPath = path.join(
    harvestDir,
    "harvest-summary.json",
  );
  const privateArtifacts = [];
  try {
    privateArtifacts.push({
      path: harvestSummaryPath,
      ...(await fileIntegrity(harvestSummaryPath)),
      rowCount: null,
      privacy: "private",
    });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const manifest = permitArtifactManifestSchema.parse({
    schemaVersion: "elephant.permit-artifact-manifest.v1",
    countyKey: profile.countyKey,
    jobId,
    profileSha256: permitProfileDigest(profile),
    generatedAt: exportedAt,
    artifacts: [...publicArtifacts, ...privateArtifacts],
  });
  const manifestPath = path.join(
    outputDir,
    "permit-artifact-manifest.json",
  );
  await atomicWriteJson(manifestPath, manifest);
  const approval = {
    schemaVersion: "elephant.permit-publication-approval.v1",
    countyKey: profile.countyKey,
    jobId,
    status: "pending_human_approval",
    generatedAt: exportedAt,
    artifacts: publicArtifacts.map((artifact) => ({
      path: artifact.path,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
    })),
  };
  await atomicWriteJson(
    path.join(outputDir, "permit-publication-approval.json"),
    approval,
  );
  return {
    records,
    statuses,
    rewrittenProperties,
    permitCoverage,
    datasetCoverage,
    manifest,
    approval,
    paths: {
      permitPath,
      propertyPath,
      coveragePath,
      permitCoveragePath,
      manifestPath,
    },
  };
}
