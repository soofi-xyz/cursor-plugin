import { createGzip } from "node:zlib";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";

import {
  ParquetReader,
  ParquetSchema,
  ParquetWriter,
} from "@dsnp/parquetjs";

import { toParquetRecord } from "../core/query-table.mjs";
import { permitProfileDigest } from "../counties/permit-profile.mjs";
import {
  permitArtifactManifestSchema,
  permitCoverageSchema,
  permitTableSchemaFields,
  toPermitTableRow,
} from "./contracts.mjs";
import {
  createJaxPermitMapAdapter,
  normalizeJaxPermitMapFeature,
} from "./adapters/jaxepics-map.mjs";
import {
  normalizeDuvalParcelIdentifier,
  routePermitJurisdiction,
} from "./normalization.mjs";
import { atomicWriteJson, fileIntegrity } from "./storage.mjs";

async function writeJsonLine(stream, value) {
  if (!stream.write(`${JSON.stringify(value)}\n`)) {
    await once(stream, "drain");
  }
}

async function closeCompressedStream(gzip, output) {
  gzip.end();
  await once(output, "close");
}

function updateDateRange(range, record) {
  const dates = [
    record.permit_issue_date,
    record.application_received_date,
    record.opened_date,
    record.completion_date,
  ].filter(Boolean);
  for (const date of dates) {
    if (!range.first || date < range.first) range.first = date;
    if (!range.last || date > range.last) range.last = date;
  }
}

async function buildPropertyIndex({ inputParquet, profile }) {
  const reader = await ParquetReader.openFile(inputParquet);
  const byParcel = new Map();
  const propertyIds = new Set();
  const jurisdictionCounts = new Map();
  let rowCount = 0;
  try {
    const cursor = reader.getCursor([
      "property_id",
      "parcel_identifier",
      "address_city",
    ]);
    let row = await cursor.next();
    while (row) {
      rowCount += 1;
      const propertyId = String(row.property_id ?? "");
      if (!/^[a-f0-9]{32}$/.test(propertyId)) {
        throw new Error(
          `Property query table row ${rowCount} has an invalid property_id`,
        );
      }
      if (propertyIds.has(propertyId)) {
        throw new Error(`Duplicate property_id ${propertyId}`);
      }
      propertyIds.add(propertyId);
      const parcelIdentifier = normalizeDuvalParcelIdentifier(
        row.parcel_identifier,
      );
      const jurisdiction = routePermitJurisdiction(
        profile,
        row.address_city,
      );
      if (!jurisdiction) {
        throw new Error(
          `Property ${propertyId} could not be routed to a permit jurisdiction`,
        );
      }
      const existing = byParcel.get(parcelIdentifier);
      if (existing && existing.propertyId !== propertyId) {
        throw new Error(
          `Parcel ${parcelIdentifier} maps to multiple property IDs`,
        );
      }
      byParcel.set(parcelIdentifier, {
        propertyId,
        jurisdictionKey: jurisdiction.key,
      });
      jurisdictionCounts.set(
        jurisdiction.key,
        (jurisdictionCounts.get(jurisdiction.key) ?? 0) + 1,
      );
      row = await cursor.next();
    }
  } finally {
    await reader.close();
  }
  return { byParcel, jurisdictionCounts, rowCount };
}

async function rewritePropertyTable({
  inputParquet,
  outputParquet,
  schemaFields,
  permitCounts,
}) {
  const temporaryPath = `${outputParquet}.tmp-${process.pid}`;
  const reader = await ParquetReader.openFile(inputParquet);
  const writer = await ParquetWriter.openFile(
    new ParquetSchema(structuredClone(schemaFields)),
    temporaryPath,
  );
  let rowCount = 0;
  try {
    const cursor = reader.getCursor();
    let row = await cursor.next();
    while (row) {
      const propertyId = String(row.property_id);
      const count = permitCounts.get(propertyId) ?? 0;
      await writer.appendRow(
        toParquetRecord({
          ...row,
          has_permits: count > 0,
          permit_count: count,
        }),
      );
      rowCount += 1;
      row = await cursor.next();
    }
  } finally {
    await Promise.all([reader.close(), writer.close()]);
  }
  await rename(temporaryPath, outputParquet);
  return rowCount;
}

function buildCoverage({
  profile,
  propertyIndex,
  permitCount,
  validUnlinkedPermits,
  dateRange,
  exportedAt,
}) {
  const jurisdictions = profile.jurisdictions.map((jurisdiction) => {
    const propertyCount =
      propertyIndex.jurisdictionCounts.get(jurisdiction.key) ?? 0;
    const supported = jurisdiction.status === "supported";
    return {
      jurisdictionKey: jurisdiction.key,
      sourceStatus: jurisdiction.status,
      attemptedParcels: propertyCount,
      succeededParcels: supported ? propertyCount : 0,
      failedParcels: supported ? 0 : propertyCount,
      permitCount: supported ? permitCount : 0,
      firstPermitDate: supported ? dateRange.first : null,
      lastPermitDate: supported ? dateRange.last : null,
      gapReason: supported
        ? null
        : (jurisdiction.recordsRequest?.systemScope ??
          "No accepted public historical source"),
    };
  });
  return permitCoverageSchema.parse({
    schemaVersion: "elephant.permit-coverage.v1",
    countyKey: profile.countyKey,
    exportedAt,
    availability:
      profile.jurisdictions.every(
        (jurisdiction) => jurisdiction.status === "supported",
      )
        ? "supported_full"
        : "supported_partial",
    attemptedParcels: propertyIndex.rowCount,
    succeededParcels: jurisdictions.reduce(
      (sum, item) => sum + item.succeededParcels,
      0,
    ),
    failedParcels: jurisdictions.reduce(
      (sum, item) => sum + item.failedParcels,
      0,
    ),
    validUnlinkedPermits,
    linkedPermits: permitCount - validUnlinkedPermits,
    jurisdictions,
  });
}

function mergeDatasetCoverage({
  input,
  permitCoverage,
  sourceCount,
  publishedCount,
  excludedCount,
  exportedAt,
  profile,
}) {
  return {
    ...input,
    exportedAt,
    datasets: [
      ...(input.datasets ?? []).filter(
        (dataset) => dataset.source !== "permits",
      ),
      {
        county: profile.countyKey,
        source: "permits",
        ingested_count: publishedCount,
        expected_count: sourceCount,
        first_loaded_at: permitCoverage.jurisdictions.find(
          (item) => item.jurisdictionKey === "jacksonville",
        )?.firstPermitDate,
        last_loaded_at: permitCoverage.jurisdictions.find(
          (item) => item.jurisdictionKey === "jacksonville",
        )?.lastPermitDate,
        cid: null,
        ipns_label: profile.publication.permitTableIpnsLabel,
        linked_property_count: permitCoverage.linkedPermits,
        valid_unlinked_permit_count:
          permitCoverage.validUnlinkedPermits,
        excluded_source_record_count: excludedCount,
        attempted_parcel_count: permitCoverage.attemptedParcels,
        succeeded_parcel_count: permitCoverage.succeededParcels,
        failed_parcel_count: permitCoverage.failedParcels,
      },
    ],
  };
}

async function artifactEntry({
  filePath,
  relativePath,
  rowCount,
  privacy,
}) {
  const integrity = await fileIntegrity(filePath);
  return {
    path: relativePath,
    ...integrity,
    rowCount,
    privacy,
  };
}

export async function exportJaxPermitBulkArtifacts({
  inputPropertyParquet,
  inputCoveragePath,
  outputDir,
  profile,
  propertySchemaFields,
  jobId,
  exportedAt = new Date().toISOString(),
  adapter = null,
  maxPages = null,
  progress = () => {},
}) {
  const jacksonville = profile.jurisdictions.find(
    (jurisdiction) => jurisdiction.key === "jacksonville",
  );
  if (!jacksonville || jacksonville.status !== "supported") {
    throw new Error("Jacksonville is not an accepted permit source");
  }
  await mkdir(path.join(outputDir, "private"), { recursive: true });
  const paths = {
    permit: path.join(outputDir, "permit-table.parquet"),
    property: path.join(outputDir, "query-table.parquet"),
    datasetCoverage: path.join(outputDir, "dataset-coverage.json"),
    permitCoverage: path.join(outputDir, "permit-coverage.json"),
    raw: path.join(outputDir, "private", "jaxepics-bid-map.jsonl.gz"),
    exclusions: path.join(
      outputDir,
      "private",
      "permit-exclusions.jsonl.gz",
    ),
    summary: path.join(
      outputDir,
      "private",
      "permit-harvest-summary.json",
    ),
    approval: path.join(outputDir, "permit-publication-approval.json"),
    manifest: path.join(outputDir, "permit-artifact-manifest.json"),
  };
  const propertyIndex = await buildPropertyIndex({
    inputParquet: inputPropertyParquet,
    profile,
  });
  const bulkAdapter =
    adapter ?? createJaxPermitMapAdapter(jacksonville);
  const snapshot = await bulkAdapter.getSnapshot();
  const permitWriter = await ParquetWriter.openFile(
    new ParquetSchema(structuredClone(permitTableSchemaFields)),
    paths.permit,
  );
  const rawOutput = createWriteStream(paths.raw);
  const rawGzip = createGzip({ level: 9 });
  rawGzip.pipe(rawOutput);
  const exclusionsOutput = createWriteStream(paths.exclusions);
  const exclusionsGzip = createGzip({ level: 9 });
  exclusionsGzip.pipe(exclusionsOutput);
  const seenPermits = new Set();
  const permitCounts = new Map();
  const dateRange = { first: null, last: null };
  const counters = {
    pages: 0,
    sourceRows: 0,
    publishedRows: 0,
    linkedRows: 0,
    validUnlinkedRows: 0,
    invalidParcelRows: 0,
    excludedJurisdictionRows: 0,
    malformedRows: 0,
    duplicateRows: 0,
  };
  let offset = 0;
  let fullSnapshot = true;
  try {
    while (offset < snapshot.count) {
      if (maxPages !== null && counters.pages >= maxPages) {
        fullSnapshot = false;
        break;
      }
      const page = await bulkAdapter.fetchPage({
        where: snapshot.where,
        offset,
        pageSize: bulkAdapter.pageSize,
      });
      if (page.features.length === 0) {
        throw new Error(
          `BID permit layer ended at ${offset} of ${snapshot.count} rows`,
        );
      }
      await writeJsonLine(rawGzip, {
        offset,
        features: page.features,
      });
      for (const feature of page.features) {
        counters.sourceRows += 1;
        let parcelIdentifier;
        try {
          parcelIdentifier = normalizeDuvalParcelIdentifier(
            feature?.attributes?.RE,
          );
        } catch (error) {
          counters.invalidParcelRows += 1;
          await writeJsonLine(exclusionsGzip, {
            reason: "invalid_parcel_identifier",
            objectId: feature?.attributes?.OBJECTID ?? null,
            recordId: feature?.attributes?.RecordID ?? null,
            parcel: feature?.attributes?.RE ?? null,
            message: error.message,
          });
          continue;
        }
        const property = propertyIndex.byParcel.get(parcelIdentifier);
        if (property?.jurisdictionKey !== undefined &&
            property.jurisdictionKey !== "jacksonville") {
          counters.excludedJurisdictionRows += 1;
          await writeJsonLine(exclusionsGzip, {
            reason: "independent_municipality",
            objectId: feature?.attributes?.OBJECTID ?? null,
            recordId: feature?.attributes?.RecordID ?? null,
            parcel: parcelIdentifier,
            jurisdictionKey: property.jurisdictionKey,
          });
          continue;
        }
        try {
          const record = normalizeJaxPermitMapFeature(feature, {
            requestedParcelIdentifier: parcelIdentifier,
            requestedPropertyId: property?.propertyId ?? null,
          });
          if (seenPermits.has(record.property_improvement_id)) {
            counters.duplicateRows += 1;
            continue;
          }
          seenPermits.add(record.property_improvement_id);
          await permitWriter.appendRow(
            toParquetRecord(toPermitTableRow(record)),
          );
          counters.publishedRows += 1;
          if (property) {
            counters.linkedRows += 1;
            permitCounts.set(
              property.propertyId,
              (permitCounts.get(property.propertyId) ?? 0) + 1,
            );
          } else {
            counters.validUnlinkedRows += 1;
          }
          updateDateRange(dateRange, record);
        } catch (error) {
          counters.malformedRows += 1;
          await writeJsonLine(exclusionsGzip, {
            reason: "malformed_permit_record",
            objectId: feature?.attributes?.OBJECTID ?? null,
            recordId: feature?.attributes?.RecordID ?? null,
            parcel: parcelIdentifier,
            message: error.message,
          });
        }
      }
      offset += page.features.length;
      counters.pages += 1;
      progress({
        ...counters,
        expectedSourceRows: snapshot.count,
        offset,
      });
      if (!page.exceededTransferLimit && offset < snapshot.count) {
        throw new Error(
          `BID permit layer stopped before snapshot count at ${offset}`,
        );
      }
    }
  } finally {
    await Promise.all([
      permitWriter.close(),
      closeCompressedStream(rawGzip, rawOutput),
      closeCompressedStream(exclusionsGzip, exclusionsOutput),
    ]);
  }
  if (fullSnapshot && counters.sourceRows !== snapshot.count) {
    throw new Error(
      `BID permit snapshot expected ${snapshot.count} rows, received ${counters.sourceRows}`,
    );
  }

  const propertyRows = await rewritePropertyTable({
    inputParquet: inputPropertyParquet,
    outputParquet: paths.property,
    schemaFields: propertySchemaFields,
    permitCounts,
  });
  if (propertyRows !== propertyIndex.rowCount) {
    throw new Error(
      `Property rewrite expected ${propertyIndex.rowCount} rows, wrote ${propertyRows}`,
    );
  }
  const permitCoverage = buildCoverage({
    profile,
    propertyIndex,
    permitCount: counters.publishedRows,
    validUnlinkedPermits: counters.validUnlinkedRows,
    dateRange,
    exportedAt,
  });
  const inputCoverage = JSON.parse(
    await readFile(inputCoveragePath, "utf8"),
  );
  const datasetCoverage = mergeDatasetCoverage({
    input: inputCoverage,
    permitCoverage,
    sourceCount: snapshot.count,
    publishedCount: counters.publishedRows,
    excludedCount:
      counters.invalidParcelRows +
      counters.excludedJurisdictionRows +
      counters.malformedRows +
      counters.duplicateRows,
    exportedAt,
    profile,
  });
  await Promise.all([
    atomicWriteJson(paths.permitCoverage, permitCoverage),
    atomicWriteJson(paths.datasetCoverage, datasetCoverage),
    atomicWriteJson(paths.summary, {
      schemaVersion: "elephant.permit-bulk-harvest-summary.v1",
      countyKey: profile.countyKey,
      jobId,
      exportedAt,
      fullSnapshot,
      snapshot,
      propertyRows,
      propertiesWithPermits: permitCounts.size,
      counters,
    }),
  ]);
  const publicArtifacts = await Promise.all([
    artifactEntry({
      filePath: paths.permit,
      relativePath: "permit-table.parquet",
      rowCount: counters.publishedRows,
      privacy: "public",
    }),
    artifactEntry({
      filePath: paths.property,
      relativePath: "query-table.parquet",
      rowCount: propertyRows,
      privacy: "public",
    }),
    artifactEntry({
      filePath: paths.datasetCoverage,
      relativePath: "dataset-coverage.json",
      rowCount: null,
      privacy: "public",
    }),
    artifactEntry({
      filePath: paths.permitCoverage,
      relativePath: "permit-coverage.json",
      rowCount: null,
      privacy: "public",
    }),
  ]);
  const approval = {
    schemaVersion: "elephant.permit-publication-approval.v1",
    countyKey: profile.countyKey,
    jobId,
    generatedAt: exportedAt,
    status: "pending_human_approval",
    destination: {
      bucket: profile.publication.bucket,
      permitTableIpnsLabel: profile.publication.permitTableIpnsLabel,
      propertyQueryTableIpnsLabel:
        profile.publication.propertyQueryTableIpnsLabel,
      coverageIpnsLabel: profile.publication.coverageIpnsLabel,
    },
    artifacts: publicArtifacts,
  };
  await atomicWriteJson(paths.approval, approval);
  const privateArtifacts = await Promise.all([
    artifactEntry({
      filePath: paths.raw,
      relativePath: "private/jaxepics-bid-map.jsonl.gz",
      rowCount: counters.sourceRows,
      privacy: "private",
    }),
    artifactEntry({
      filePath: paths.exclusions,
      relativePath: "private/permit-exclusions.jsonl.gz",
      rowCount:
        counters.invalidParcelRows +
        counters.excludedJurisdictionRows +
        counters.malformedRows,
      privacy: "private",
    }),
    artifactEntry({
      filePath: paths.summary,
      relativePath: "private/permit-harvest-summary.json",
      rowCount: null,
      privacy: "private",
    }),
    artifactEntry({
      filePath: paths.approval,
      relativePath: "permit-publication-approval.json",
      rowCount: null,
      privacy: "public",
    }),
  ]);
  const manifest = permitArtifactManifestSchema.parse({
    schemaVersion: "elephant.permit-artifact-manifest.v1",
    countyKey: profile.countyKey,
    jobId,
    profileSha256: permitProfileDigest(profile),
    generatedAt: exportedAt,
    artifacts: [...publicArtifacts, ...privateArtifacts],
  });
  await atomicWriteJson(paths.manifest, manifest);
  return {
    snapshot,
    counters,
    propertyRows,
    propertiesWithPermits: permitCounts.size,
    permitCoverage,
    datasetCoverage,
    approval,
    manifest,
    paths,
  };
}
