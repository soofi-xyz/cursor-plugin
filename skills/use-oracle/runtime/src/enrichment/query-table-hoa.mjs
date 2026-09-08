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
const ASSOCIATION_SCOPE = "florida_chapter_720_mandatory_hoa";
const ASSOCIATION_TYPE = "chapter_720_hoa";
const ACTIVE_INSTRUMENT_ACTIONS = new Set([
  "annexation",
  "declaration",
  "preservation",
  "revival",
]);
const APPROVED_HOA_SOURCE_PROFILES = new Map();

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

function validIsoDate(value) {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function validateSourceManifest(value, countyKey, approvedSourceProfiles) {
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
  const manifest = {
    ...value,
    sourceProfileId: nonEmptyString(
      value.sourceProfileId,
      "sourceProfileId",
    ),
    associationScope: nonEmptyString(
      value.associationScope,
      "associationScope",
    ),
    asOfDate: nonEmptyString(value.asOfDate, "asOfDate"),
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
  if (manifest.associationScope !== ASSOCIATION_SCOPE) {
    throw new Error(
      `HOA source manifest associationScope must be ${ASSOCIATION_SCOPE}`,
    );
  }
  if (!validIsoDate(manifest.asOfDate)) {
    throw new Error("HOA source manifest requires a valid asOfDate");
  }
  const approvedProfile = approvedSourceProfiles.get(manifest.sourceProfileId);
  if (approvedProfile === undefined) {
    throw new Error(
      `HOA source profile ${manifest.sourceProfileId} is not approved`,
    );
  }
  for (const field of [
    "county",
    "authority",
    "recordsRequestReference",
    "associationScope",
  ]) {
    if (approvedProfile[field] !== manifest[field]) {
      throw new Error(
        `HOA source profile ${manifest.sourceProfileId} does not approve manifest ${field}`,
      );
    }
  }
  if (approvedProfile.publicationPermitted !== true) {
    throw new Error(
      `HOA source profile ${manifest.sourceProfileId} does not permit publication`,
    );
  }
  return manifest;
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
  if (!validIsoDate(effectiveOn)) {
    throw new Error(`HOA record ${lineNumber} has an invalid effective_on`);
  }
  if (effectiveOn > sourceManifest.asOfDate) {
    throw new Error(
      `HOA record ${lineNumber} has future evidence after the source asOfDate`,
    );
  }
  if (value.association_type !== ASSOCIATION_TYPE) {
    throw new Error(
      `HOA record ${lineNumber} association_type must be ${ASSOCIATION_TYPE}`,
    );
  }
  const membershipStatus = nonEmptyString(
    value.membership_status,
    `record ${lineNumber} membership_status`,
  );
  const instrumentAction = nonEmptyString(
    value.instrument_action,
    `record ${lineNumber} instrument_action`,
  );
  if (value.membership === true) {
    if (membershipStatus !== "active") {
      throw new Error(
        `HOA record ${lineNumber} membership_status must be active for a positive membership`,
      );
    }
    if (!ACTIVE_INSTRUMENT_ACTIONS.has(instrumentAction)) {
      throw new Error(
        `HOA record ${lineNumber} has an inactive or unsupported instrument_action`,
      );
    }
  } else if (
    membershipStatus !== "not_member" ||
    instrumentAction !== "custodian_negative"
  ) {
    throw new Error(
      `HOA record ${lineNumber} negative membership must be an explicit custodian_negative`,
    );
  }
  const inactiveOn =
    value.inactive_on === null || value.inactive_on === undefined
      ? null
      : String(value.inactive_on);
  if (inactiveOn !== null) {
    if (!validIsoDate(inactiveOn)) {
      throw new Error(`HOA record ${lineNumber} has an invalid inactive_on`);
    }
    if (inactiveOn <= sourceManifest.asOfDate) {
      throw new Error(
        `HOA record ${lineNumber} is inactive as of the source asOfDate`,
      );
    }
  }
  return {
    folio,
    membership: value.membership,
    associationId: nonEmptyString(
      value.association_id,
      `record ${lineNumber} association_id`,
    ),
    effectiveOn,
    inactiveOn,
    instrumentAction,
    membershipStatus,
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
      const byAssociation = byFolio.get(record.folio) ?? new Map();
      const existing = byAssociation.get(record.associationId);
      if (
        existing !== undefined &&
        existing.effectiveOn === record.effectiveOn &&
        JSON.stringify(existing) !== JSON.stringify(record)
      ) {
        throw new Error(
          `HOA source contains ambiguous tied evidence for folio ${record.folio} association ${record.associationId}`,
        );
      }
      if (
        existing === undefined ||
        record.effectiveOn > existing.effectiveOn
      ) {
        byAssociation.set(record.associationId, record);
      }
      byFolio.set(record.folio, byAssociation);
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
  approvedSourceProfiles = APPROVED_HOA_SOURCE_PROFILES,
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
    approvedSourceProfiles,
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
  let activeAssociationMembershipCount = 0;
  const matchedFolios = new Set();
  try {
    const cursor = reader.getCursor();
    let row = await cursor.next();
    while (row) {
      inputRowCount += 1;
      const folio = normalizeFolio(row.parcel_identifier);
      const memberships =
        folio === null ? undefined : source.byFolio.get(folio);
      const activeMemberships =
        memberships === undefined
          ? []
          : [...memberships.values()].filter(
              (record) => record.membership === true,
            );
      const hoaFlag =
        activeMemberships.length > 0
          ? true
          : memberships !== undefined &&
              sourceManifest.authoritativeNegativeCoverage === true
            ? false
            : null;
      await writer.appendRow(
        toParquetRecord({
          ...row,
          hoa_flag: hoaFlag,
        }),
      );
      outputRowCount += 1;
      if (memberships !== undefined) {
        linkedPropertyCount += 1;
        matchedFolios.add(folio);
        activeAssociationMembershipCount += activeMemberships.length;
        if (hoaFlag === true) positiveMembershipCount += 1;
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
      active_association_membership_count:
        activeAssociationMembershipCount,
      authoritative_negative_count: authoritativeNegativeCount,
      unknown_property_count: unknownPropertyCount,
      valid_unlinked_count: validUnlinkedFolioCount,
      source_authority: sourceManifest.authority,
      extract_id: sourceManifest.extractId,
      source_retrieved_at: sourceManifest.sourceRetrievedAt,
      records_request_reference: sourceManifest.recordsRequestReference,
      source_profile_id: sourceManifest.sourceProfileId,
      association_scope: sourceManifest.associationScope,
      as_of_date: sourceManifest.asOfDate,
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
    activeAssociationMembershipCount,
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
