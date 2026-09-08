import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import readline from "node:readline";

import { ParquetSchema, ParquetWriter } from "@dsnp/parquetjs";

import { toParquetRecord } from "../core/query-table.mjs";

const require = createRequire(import.meta.url);
const { ParquetReader } = require("@dsnp/parquetjs");
const SOURCE_MANIFEST_SCHEMA = "elephant.avm-source-manifest.v1";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const APPROVED_AVM_SOURCE_PROFILES = new Map();

function normalizeFolio(value) {
  const compact = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/R$/, "");
  return /^\d{10}$/.test(compact) ? compact : null;
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

function nonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`AVM source manifest requires ${field}`);
  }
  return value.trim();
}

function validateSourceManifest(value, countyKey, approvedSourceProfiles) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("AVM source manifest must be a JSON object");
  }
  if (value.schemaVersion !== SOURCE_MANIFEST_SCHEMA) {
    throw new Error(`AVM source manifest must use ${SOURCE_MANIFEST_SCHEMA}`);
  }
  if (value.county !== countyKey) {
    throw new Error(
      `AVM source county mismatch: expected ${countyKey}, received ${value.county ?? "missing"}`,
    );
  }
  if (value.publicationPermitted !== true) {
    throw new Error(
      "AVM enrichment requires explicit licensed publication rights",
    );
  }
  if (!Number.isSafeInteger(value.recordCount) || value.recordCount < 0) {
    throw new Error("AVM source manifest requires a non-negative recordCount");
  }
  if (!/^[a-f0-9]{64}$/.test(value.recordsSha256 ?? "")) {
    throw new Error("AVM source manifest requires recordsSha256");
  }
  const manifest = {
    ...value,
    countyFips: nonEmptyString(value.countyFips, "countyFips"),
    sourceProfileId: nonEmptyString(
      value.sourceProfileId,
      "sourceProfileId",
    ),
    provider: nonEmptyString(value.provider, "provider"),
    extractId: nonEmptyString(value.extractId, "extractId"),
    sourceRetrievedAt: nonEmptyString(
      value.sourceRetrievedAt,
      "sourceRetrievedAt",
    ),
    licenseReviewReference: nonEmptyString(
      value.licenseReviewReference,
      "licenseReviewReference",
    ),
  };
  const approvedProfile = approvedSourceProfiles.get(manifest.sourceProfileId);
  if (approvedProfile === undefined) {
    throw new Error(
      `AVM source profile ${manifest.sourceProfileId} is not approved`,
    );
  }
  for (const field of [
    "county",
    "countyFips",
    "provider",
    "licenseReviewReference",
  ]) {
    if (approvedProfile[field] !== manifest[field]) {
      throw new Error(
        `AVM source profile ${manifest.sourceProfileId} does not approve manifest ${field}`,
      );
    }
  }
  if (approvedProfile.publicationPermitted !== true) {
    throw new Error(
      `AVM source profile ${manifest.sourceProfileId} does not permit publication`,
    );
  }
  return manifest;
}

function validateRecord(value, lineNumber, sourceManifest, exportedAt) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`AVM record ${lineNumber} must be a JSON object`);
  }
  const folio = normalizeFolio(value.parcel_identifier);
  if (folio === null) {
    throw new Error(
      `AVM record ${lineNumber} has an invalid parcel_identifier`,
    );
  }
  const vendorApn = normalizeFolio(value.vendor_apn);
  if (vendorApn === null || vendorApn !== folio) {
    throw new Error(
      `AVM record ${lineNumber} vendor_apn does not exactly match parcel_identifier`,
    );
  }
  if (value.county_fips !== sourceManifest.countyFips) {
    throw new Error(
      `AVM record ${lineNumber} county_fips does not match the approved source profile`,
    );
  }
  const avmValue = Number(value.current_avm_value);
  if (!Number.isFinite(avmValue) || avmValue <= 0) {
    throw new Error(
      `AVM record ${lineNumber} has an invalid current_avm_value`,
    );
  }
  const valuationDate = String(value.valuation_date ?? "");
  if (!ISO_DATE.test(valuationDate)) {
    throw new Error(`AVM record ${lineNumber} has an invalid valuation_date`);
  }
  const valuationTimestamp = Date.parse(`${valuationDate}T00:00:00.000Z`);
  if (
    !Number.isFinite(valuationTimestamp) ||
    valuationTimestamp > Date.parse(exportedAt)
  ) {
    throw new Error(
      `AVM record ${lineNumber} has a future or invalid valuation_date`,
    );
  }
  const valuationMethodType = nonEmptyString(
    value.valuation_method_type,
    `record ${lineNumber} valuation_method_type`,
  );
  if (/apprais|assess|tax.?roll/i.test(valuationMethodType)) {
    throw new Error(
      `AVM record ${lineNumber} uses a non-AVM valuation_method_type`,
    );
  }
  const vendorPropertyId = nonEmptyString(
    value.vendor_property_id,
    `record ${lineNumber} vendor_property_id`,
  );
  const optionalNumber = (field, { minimum = null, maximum = null } = {}) => {
    const raw = value[field];
    if (raw === null || raw === undefined || raw === "") return null;
    const parsed = Number(raw);
    if (
      !Number.isFinite(parsed) ||
      (minimum !== null && parsed < minimum) ||
      (maximum !== null && parsed > maximum)
    ) {
      throw new Error(`AVM record ${lineNumber} has an invalid ${field}`);
    }
    return parsed;
  };
  const requiredNumber = (field, options) => {
    const parsed = optionalNumber(field, options);
    if (parsed === null) {
      throw new Error(`AVM record ${lineNumber} requires ${field}`);
    }
    return parsed;
  };
  const lowValue = requiredNumber("valuation_low", { minimum: 0 });
  const highValue = requiredNumber("valuation_high", { minimum: 0 });
  if (lowValue !== null && lowValue > avmValue) {
    throw new Error(`AVM record ${lineNumber} valuation_low exceeds its AVM`);
  }
  if (highValue !== null && highValue < avmValue) {
    throw new Error(`AVM record ${lineNumber} valuation_high is below its AVM`);
  }
  return {
    folio,
    currentAvmValue: avmValue,
    valuationDate,
    valuationMethodType,
    confidenceScore: requiredNumber("confidence_score", {
      minimum: 0,
      maximum: 100,
    }),
    lowValue,
    highValue,
    vendorPropertyId,
  };
}

function newerRecord(left, right) {
  if (left.vendorPropertyId !== right.vendorPropertyId) {
    throw new Error(
      `AVM source maps folio ${left.folio} to multiple vendor property IDs`,
    );
  }
  if (left.valuationDate !== right.valuationDate) {
    return left.valuationDate > right.valuationDate ? left : right;
  }
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(
      `AVM source contains ambiguous tied valuations for folio ${left.folio}`,
    );
  }
  return left;
}

async function loadAvmRecords(recordsPath, sourceManifest, exportedAt) {
  const byFolio = new Map();
  let recordCount = 0;
  const lines = readline.createInterface({
    input: createReadStream(recordsPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of lines) {
      if (line.trim().length === 0) continue;
      recordCount += 1;
      const record = validateRecord(
        JSON.parse(line),
        recordCount,
        sourceManifest,
        exportedAt,
      );
      const existing = byFolio.get(record.folio);
      byFolio.set(
        record.folio,
        existing === undefined ? record : newerRecord(existing, record),
      );
    }
  } finally {
    lines.close();
  }
  return { byFolio, recordCount };
}

function upsertCoverageDataset(coverage, dataset) {
  const datasets = Array.isArray(coverage.datasets)
    ? [...coverage.datasets]
    : [];
  const index = datasets.findIndex((entry) => entry?.source === dataset.source);
  if (index >= 0) datasets[index] = dataset;
  else datasets.push(dataset);
  return { ...coverage, datasets };
}

export async function enrichQueryTableWithAvm({
  countyKey,
  schemaFields,
  inputParquet,
  outputParquet,
  inputCoverage,
  outputCoverage,
  recordsPath,
  sourceManifestPath,
  approvedSourceProfiles = APPROVED_AVM_SOURCE_PROFILES,
  exportedAt = new Date().toISOString(),
  manifestPath = `${outputParquet}.manifest.json`,
}) {
  if (schemaFields?.avm_value?.type !== "DOUBLE") {
    throw new Error("AVM enrichment requires an avm_value DOUBLE column");
  }
  if (path.resolve(inputParquet) === path.resolve(outputParquet)) {
    throw new Error("AVM enrichment requires a distinct output Parquet path");
  }

  const sourceManifest = validateSourceManifest(
    JSON.parse(await readFile(sourceManifestPath, "utf8")),
    countyKey,
    approvedSourceProfiles,
  );
  const recordsSha256 = await sha256File(recordsPath);
  if (recordsSha256 !== sourceManifest.recordsSha256) {
    throw new Error(
      "AVM source records digest does not match reviewed manifest",
    );
  }
  const source = await loadAvmRecords(
    recordsPath,
    sourceManifest,
    exportedAt,
  );
  if (source.recordCount !== sourceManifest.recordCount) {
    throw new Error(
      `AVM source record count ${source.recordCount} does not match manifest ${sourceManifest.recordCount}`,
    );
  }

  const originalCoverage = JSON.parse(await readFile(inputCoverage, "utf8"));
  if (originalCoverage.county !== countyKey) {
    throw new Error(
      `Coverage county mismatch: expected ${countyKey}, received ${originalCoverage.county ?? "missing"}`,
    );
  }
  const existingAvmCoverage = (originalCoverage.datasets ?? []).find(
    (entry) => entry?.source === "avm",
  );

  await Promise.all([
    mkdir(path.dirname(outputParquet), { recursive: true }),
    mkdir(path.dirname(outputCoverage), { recursive: true }),
    mkdir(path.dirname(manifestPath), { recursive: true }),
  ]);
  const reader = await ParquetReader.openFile(inputParquet);
  const writer = await ParquetWriter.openFile(
    new ParquetSchema(structuredClone(schemaFields)),
    outputParquet,
  );
  let inputRowCount = 0;
  let outputRowCount = 0;
  let linkedPropertyCount = 0;
  const matchedFolios = new Set();
  try {
    const cursor = reader.getCursor();
    let row = await cursor.next();
    while (row) {
      inputRowCount += 1;
      const folio = normalizeFolio(row.parcel_identifier);
      const record = folio === null ? undefined : source.byFolio.get(folio);
      await writer.appendRow(
        toParquetRecord({
          ...row,
          avm_value: record?.currentAvmValue ?? null,
        }),
      );
      outputRowCount += 1;
      if (record !== undefined) {
        linkedPropertyCount += 1;
        matchedFolios.add(record.folio);
      }
      row = await cursor.next();
    }
  } finally {
    await reader.close();
    await writer.close();
  }
  if (inputRowCount !== outputRowCount) {
    throw new Error(
      `AVM row reconciliation failed: ${inputRowCount} input vs ${outputRowCount} output`,
    );
  }

  const validUnlinkedFolioCount = source.byFolio.size - matchedFolios.size;
  const coverage = upsertCoverageDataset(
    { ...originalCoverage, exportedAt },
    {
      county: countyKey,
      source: "avm",
      ingested_count: source.recordCount,
      expected_count: null,
      first_loaded_at: existingAvmCoverage?.first_loaded_at ?? exportedAt,
      last_loaded_at: exportedAt,
      linked_property_count: linkedPropertyCount,
      source_folio_count: source.byFolio.size,
      valid_unlinked_count: validUnlinkedFolioCount,
      provider: sourceManifest.provider,
      extract_id: sourceManifest.extractId,
      source_retrieved_at: sourceManifest.sourceRetrievedAt,
      publication_permitted: true,
      license_review_reference: sourceManifest.licenseReviewReference,
      source_profile_id: sourceManifest.sourceProfileId,
      county_fips: sourceManifest.countyFips,
      match_method: "exact_normalized_parcel_identifier",
    },
  );
  await writeFile(outputCoverage, `${JSON.stringify(coverage, null, 2)}\n`);

  const [inputStat, outputStat] = await Promise.all([
    stat(inputParquet),
    stat(outputParquet),
  ]);
  const summary = {
    schemaVersion: "elephant.avm-query-table-enrichment.v1",
    county: countyKey,
    enrichedAt: exportedAt,
    provider: sourceManifest.provider,
    extractId: sourceManifest.extractId,
    sourceProfileId: sourceManifest.sourceProfileId,
    countyFips: sourceManifest.countyFips,
    inputRowCount,
    outputRowCount,
    sourceRecordCount: source.recordCount,
    sourceFolioCount: source.byFolio.size,
    linkedPropertyCount,
    validUnlinkedFolioCount,
    inputBytes: inputStat.size,
    outputBytes: outputStat.size,
    inputSha256: await sha256File(inputParquet),
    outputSha256: await sha256File(outputParquet),
    recordsSha256,
  };
  await writeFile(manifestPath, `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}
