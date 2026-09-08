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
const SOURCE_MANIFEST_SCHEMA = "elephant.hoa-membership-source-manifest.v1";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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
    throw new Error(`HOA source manifest requires ${field}`);
  }
  return value.trim();
}

function validateSourceManifest(value, countyKey) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("HOA source manifest must be a JSON object");
  }
  if (value.schemaVersion !== SOURCE_MANIFEST_SCHEMA) {
    throw new Error(`HOA source manifest must use ${SOURCE_MANIFEST_SCHEMA}`);
  }
  if (value.county !== countyKey) {
    throw new Error(
      `HOA source county mismatch: expected ${countyKey}, received ${value.county ?? "missing"}`,
    );
  }
  if (value.authoritative !== true) {
    throw new Error("HOA membership source must be authoritative");
  }
  if (value.publicationPermitted !== true) {
    throw new Error(
      "HOA enrichment requires explicit permission to publish the records",
    );
  }
  if (value.linkMethod !== "parcel_identifier") {
    throw new Error(
      "HOA membership must link by parcel_identifier, never subdivision name or address",
    );
  }
  if (typeof value.authoritativeNegativeCoverage !== "boolean") {
    throw new Error(
      "HOA source manifest requires authoritativeNegativeCoverage",
    );
  }
  if (!Number.isSafeInteger(value.recordCount) || value.recordCount < 0) {
    throw new Error("HOA source manifest requires a non-negative recordCount");
  }
  if (!/^[a-f0-9]{64}$/.test(value.recordsSha256 ?? "")) {
    throw new Error("HOA source manifest requires recordsSha256");
  }
  return {
    ...value,
    authority: nonEmptyString(value.authority, "authority"),
    extractId: nonEmptyString(value.extractId, "extractId"),
    sourceRetrievedAt: nonEmptyString(
      value.sourceRetrievedAt,
      "sourceRetrievedAt",
    ),
    recordsRequestReference: nonEmptyString(
      value.recordsRequestReference,
      "recordsRequestReference",
    ),
    scopeDescription: nonEmptyString(
      value.scopeDescription,
      "scopeDescription",
    ),
  };
}

function validateRecord(value, lineNumber, sourceManifest) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`HOA record ${lineNumber} must be a JSON object`);
  }
  const folio = normalizeFolio(value.parcel_identifier);
  if (folio === null) {
    throw new Error(
      `HOA record ${lineNumber} has an invalid parcel_identifier`,
    );
  }
  if (typeof value.membership !== "boolean") {
    throw new Error(`HOA record ${lineNumber} requires boolean membership`);
  }
  if (
    value.membership === false &&
    sourceManifest.authoritativeNegativeCoverage !== true
  ) {
    throw new Error(
      `HOA record ${lineNumber} asserts false membership without authoritative negative coverage`,
    );
  }
  const effectiveOn = String(value.effective_on ?? "");
  if (!ISO_DATE.test(effectiveOn)) {
    throw new Error(`HOA record ${lineNumber} has an invalid effective_on`);
  }
  return {
    folio,
    membership: value.membership,
    associationId: nonEmptyString(
      value.association_id,
      `record ${lineNumber} association_id`,
    ),
    effectiveOn,
    evidenceReference: nonEmptyString(
      value.evidence_reference,
      `record ${lineNumber} evidence_reference`,
    ),
  };
}

async function loadMembershipRecords(recordsPath, sourceManifest) {
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
      );
      const existing = byFolio.get(record.folio);
      if (existing !== undefined && existing.membership !== record.membership) {
        throw new Error(
          `HOA source contains conflicting membership for folio ${record.folio}`,
        );
      }
      if (existing === undefined || record.effectiveOn > existing.effectiveOn) {
        byFolio.set(record.folio, record);
      }
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

export async function enrichQueryTableWithHoa({
  countyKey,
  schemaFields,
  inputParquet,
  outputParquet,
  inputCoverage,
  outputCoverage,
  recordsPath,
  sourceManifestPath,
  exportedAt = new Date().toISOString(),
  manifestPath = `${outputParquet}.manifest.json`,
}) {
  if (schemaFields?.hoa_flag?.type !== "BOOLEAN") {
    throw new Error("HOA enrichment requires a hoa_flag BOOLEAN column");
  }
  if (path.resolve(inputParquet) === path.resolve(outputParquet)) {
    throw new Error("HOA enrichment requires a distinct output Parquet path");
  }

  const sourceManifest = validateSourceManifest(
    JSON.parse(await readFile(sourceManifestPath, "utf8")),
    countyKey,
  );
  const recordsSha256 = await sha256File(recordsPath);
  if (recordsSha256 !== sourceManifest.recordsSha256) {
    throw new Error(
      "HOA source records digest does not match records request manifest",
    );
  }
  const source = await loadMembershipRecords(recordsPath, sourceManifest);
  if (source.recordCount !== sourceManifest.recordCount) {
    throw new Error(
      `HOA source record count ${source.recordCount} does not match manifest ${sourceManifest.recordCount}`,
    );
  }

  const originalCoverage = JSON.parse(await readFile(inputCoverage, "utf8"));
  if (originalCoverage.county !== countyKey) {
    throw new Error(
      `Coverage county mismatch: expected ${countyKey}, received ${originalCoverage.county ?? "missing"}`,
    );
  }
  const existingHoaCoverage = (originalCoverage.datasets ?? []).find(
    (entry) => entry?.source === "hoa",
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
  let positiveMembershipCount = 0;
  let authoritativeNegativeCount = 0;
  const matchedFolios = new Set();
  try {
    const cursor = reader.getCursor();
    let row = await cursor.next();
    while (row) {
      inputRowCount += 1;
      const folio = normalizeFolio(row.parcel_identifier);
      const record = folio === null ? undefined : source.byFolio.get(folio);
      const hoaFlag = record?.membership ?? null;
      await writer.appendRow(
        toParquetRecord({
          ...row,
          hoa_flag: hoaFlag,
        }),
      );
      outputRowCount += 1;
      if (record !== undefined) {
        linkedPropertyCount += 1;
        matchedFolios.add(record.folio);
        if (record.membership) positiveMembershipCount += 1;
        else authoritativeNegativeCount += 1;
      }
      row = await cursor.next();
    }
  } finally {
    await reader.close();
    await writer.close();
  }
  if (inputRowCount !== outputRowCount) {
    throw new Error(
      `HOA row reconciliation failed: ${inputRowCount} input vs ${outputRowCount} output`,
    );
  }
  if (
    sourceManifest.authoritativeNegativeCoverage === true &&
    (source.byFolio.size !== inputRowCount ||
      matchedFolios.size !== inputRowCount)
  ) {
    throw new Error(
      "HOA authoritative negative coverage must contain exactly one known membership result for every property",
    );
  }

  const validUnlinkedFolioCount = source.byFolio.size - matchedFolios.size;
  const unknownPropertyCount = outputRowCount - linkedPropertyCount;
  const coverage = upsertCoverageDataset(
    { ...originalCoverage, exportedAt },
    {
      county: countyKey,
      source: "hoa",
      ingested_count: source.recordCount,
      expected_count: null,
      first_loaded_at: existingHoaCoverage?.first_loaded_at ?? exportedAt,
      last_loaded_at: exportedAt,
      source_folio_count: source.byFolio.size,
      linked_property_count: linkedPropertyCount,
      positive_membership_count: positiveMembershipCount,
      authoritative_negative_count: authoritativeNegativeCount,
      unknown_property_count: unknownPropertyCount,
      valid_unlinked_count: validUnlinkedFolioCount,
      source_authority: sourceManifest.authority,
      extract_id: sourceManifest.extractId,
      source_retrieved_at: sourceManifest.sourceRetrievedAt,
      records_request_reference: sourceManifest.recordsRequestReference,
      authoritative_negative_coverage:
        sourceManifest.authoritativeNegativeCoverage,
      publication_permitted: true,
      match_method: "exact_normalized_parcel_identifier",
    },
  );
  await writeFile(outputCoverage, `${JSON.stringify(coverage, null, 2)}\n`);

  const [inputStat, outputStat] = await Promise.all([
    stat(inputParquet),
    stat(outputParquet),
  ]);
  const summary = {
    schemaVersion: "elephant.hoa-query-table-enrichment.v1",
    county: countyKey,
    enrichedAt: exportedAt,
    authority: sourceManifest.authority,
    extractId: sourceManifest.extractId,
    inputRowCount,
    outputRowCount,
    sourceRecordCount: source.recordCount,
    sourceFolioCount: source.byFolio.size,
    linkedPropertyCount,
    positiveMembershipCount,
    authoritativeNegativeCount,
    unknownPropertyCount,
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
