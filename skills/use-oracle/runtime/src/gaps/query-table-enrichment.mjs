import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import readline from "node:readline";

import { ParquetSchema, ParquetWriter } from "@dsnp/parquetjs";
import { DuckDBInstance } from "@duckdb/node-api";

import { toParquetRecord } from "../core/query-table.mjs";
import {
  assertNoPlaceholderEnrichment,
  buildDurableBlocker,
  deriveHoaFlag,
  normalizeFolio,
  ownerOccupiedFromHomestead,
  selectLatestApprovedAvm,
} from "./source-qualification.mjs";

const require = createRequire(import.meta.url);
const { ParquetReader } = require("@dsnp/parquetjs");

async function readJsonLines(filePath) {
  const records = [];
  if (filePath === null) return records;
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim().length > 0) records.push(JSON.parse(line));
  }
  return records;
}

function mapByFolio(records, callback) {
  const result = new Map();
  for (const record of records) {
    const folio = normalizeFolio(
      record.parcel_identifier ?? record.folio ?? record.re_number,
    );
    if (folio === null) continue;
    callback(result, folio, record);
  }
  return result;
}

export async function loadGapOverlays({
  cidManifestPath,
  ownerOccupiedPath,
  hoaPath = null,
  avmPath = null,
}) {
  const cidManifest = JSON.parse(await readFile(cidManifestPath, "utf8"));
  const cidByPropertyId = new Map();
  const cidByFolio = new Map();
  for (const entry of cidManifest.entries ?? []) {
    if (typeof entry.cid !== "string" || entry.cid.length === 0) {
      throw new Error("CID manifest contains a property without a CID");
    }
    if (cidByPropertyId.has(entry.propertyId)) {
      throw new Error(`Duplicate CID propertyId ${entry.propertyId}`);
    }
    const folio = normalizeFolio(entry.parcelIdentifier);
    if (folio === null) {
      throw new Error(`CID manifest contains invalid folio ${entry.parcelIdentifier}`);
    }
    if (cidByFolio.has(folio)) throw new Error(`Duplicate CID folio ${folio}`);
    cidByPropertyId.set(entry.propertyId, entry.cid);
    cidByFolio.set(folio, entry.cid);
  }

  const ownerOccupiedByFolio = mapByFolio(
    await readJsonLines(ownerOccupiedPath),
    (map, folio, record) => {
      if (map.has(folio)) throw new Error(`Duplicate DOR NAL folio ${folio}`);
      map.set(folio, ownerOccupiedFromHomestead(record.AV_HMSTD));
    },
  );
  const hoaByFolio = mapByFolio(
    await readJsonLines(hoaPath),
    (map, folio, record) => {
      if (map.has(folio)) throw new Error(`Duplicate HOA folio ${folio}`);
      map.set(folio, deriveHoaFlag(record));
    },
  );
  const avmRowsByFolio = mapByFolio(
    await readJsonLines(avmPath),
    (map, folio, record) => {
      const values = map.get(folio) ?? [];
      values.push(record);
      map.set(folio, values);
    },
  );
  const avmByFolio = new Map(
    [...avmRowsByFolio].map(([folio, rows]) => [
      folio,
      selectLatestApprovedAvm(rows),
    ]),
  );
  return {
    cidByPropertyId,
    cidByFolio,
    ownerOccupiedByFolio,
    hoaByFolio,
    avmByFolio,
  };
}

export function enrichQueryTableRow(row, overlays) {
  const folio = normalizeFolio(row.parcel_identifier);
  if (folio === null) {
    throw new Error(`Query table contains invalid folio ${row.parcel_identifier}`);
  }
  const cid =
    overlays.cidByPropertyId.get(String(row.property_id)) ??
    overlays.cidByFolio.get(folio);
  if (!cid) throw new Error(`Missing property CID for ${folio}`);

  const avm = overlays.avmByFolio.get(folio) ?? null;
  const hoaFlag = overlays.hoaByFolio.has(folio)
    ? overlays.hoaByFolio.get(folio)
    : null;
  const enriched = {
    ...row,
    property_cid: cid,
    owner_occupied: overlays.ownerOccupiedByFolio.has(folio)
      ? overlays.ownerOccupiedByFolio.get(folio)
      : null,
    hoa_flag: hoaFlag,
    avm_value:
      avm === null ? null : Number(avm.current_avm_value),
  };
  assertNoPlaceholderEnrichment({
    ...enriched,
    hoa_provenance:
      hoaFlag === null ? undefined : { linkMethod: "parcel_identifier" },
    avm_value_source:
      avm === null ? undefined : "approved_avm_feed",
  });
  return enriched;
}

function incrementSplit(split, value) {
  const key = value === null || value === undefined ? "null" : String(value);
  split[key] = (split[key] ?? 0) + 1;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

async function assertPreservedColumns({
  inputParquet,
  outputParquet,
  schemaFields,
}) {
  const changedFields = new Set([
    "property_cid",
    "owner_occupied",
    "hoa_flag",
    "avm_value",
  ]);
  const preserved = Object.keys(schemaFields).filter(
    (field) => !changedFields.has(field),
  );
  const comparisons = preserved.map(
    (field) =>
      `input.${sqlIdentifier(field)} IS DISTINCT FROM output.${sqlIdentifier(field)}`,
  );
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    const result = await connection.runAndReadAll(
      `SELECT count(*) AS mismatch_count
       FROM read_parquet(${sqlString(inputParquet)}) AS input
       FULL OUTER JOIN read_parquet(${sqlString(outputParquet)}) AS output
         ON input.property_id = output.property_id
       WHERE input.property_id IS NULL
          OR output.property_id IS NULL
          OR ${comparisons.join("\n          OR ")}`,
    );
    const mismatchCount = Number(
      result.getRowObjectsJson()[0]?.mismatch_count ?? 0,
    );
    if (mismatchCount !== 0) {
      throw new Error(
        `Gap query-table changed ${mismatchCount} rows outside approved overlays`,
      );
    }
    return preserved.length;
  } finally {
    connection.closeSync();
  }
}

export async function enrichQueryTableFile({
  county,
  inputParquet,
  outputParquet,
  schemaFields,
  cidManifestPath,
  ownerOccupiedPath,
  hoaPath = null,
  avmPath = null,
  outputManifest,
  expectedRowCount = null,
  expectedCounts = null,
  frozenAt,
  onProgress = async () => {},
}) {
  if (path.resolve(inputParquet) === path.resolve(outputParquet)) {
    throw new Error("Gap enrichment requires a distinct output Parquet");
  }
  const overlays = await loadGapOverlays({
    cidManifestPath,
    ownerOccupiedPath,
    hoaPath,
    avmPath,
  });
  await mkdir(path.dirname(outputParquet), { recursive: true });
  const reader = await ParquetReader.openFile(inputParquet);
  const writer = await ParquetWriter.openFile(
    new ParquetSchema(structuredClone(schemaFields)),
    outputParquet,
  );
  const seenProperties = new Set();
  const seenFolios = new Set();
  const ownerOccupiedSplit = {};
  const hoaSplit = {};
  let inputCidCount = 0;
  let inputOwnerOccupiedCount = 0;
  let permitPropertyCount = 0;
  let linkedPermitCount = 0;
  let sunbizPropertyCount = 0;
  let bbbPropertyCount = 0;
  let bbbWithoutPermitsCount = 0;
  let rowCount = 0;
  let avmCount = 0;
  try {
    const cursor = reader.getCursor();
    let row = await cursor.next();
    while (row) {
      const propertyId = String(row.property_id);
      const folio = normalizeFolio(row.parcel_identifier);
      if (seenProperties.has(propertyId)) {
        throw new Error(`Duplicate query-table property_id ${propertyId}`);
      }
      if (folio === null || seenFolios.has(folio)) {
        throw new Error(`Duplicate or invalid query-table folio ${folio}`);
      }
      seenProperties.add(propertyId);
      seenFolios.add(folio);
      if (row.property_cid !== null && row.property_cid !== undefined) {
        inputCidCount += 1;
      }
      if (row.owner_occupied !== null && row.owner_occupied !== undefined) {
        inputOwnerOccupiedCount += 1;
      }
      const enriched = enrichQueryTableRow(row, overlays);
      if (!/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(enriched.property_cid)) {
        throw new Error(`Invalid property CID for ${folio}`);
      }
      await writer.appendRow(toParquetRecord(enriched));
      rowCount += 1;
      if (enriched.has_permits === true) permitPropertyCount += 1;
      linkedPermitCount += Number(enriched.permit_count ?? 0);
      if (enriched.has_sunbiz_tenant === true) sunbizPropertyCount += 1;
      if (enriched.has_bbb_contractor === true) {
        bbbPropertyCount += 1;
        if (enriched.has_permits !== true) bbbWithoutPermitsCount += 1;
      }
      if (enriched.avm_value !== null) avmCount += 1;
      incrementSplit(ownerOccupiedSplit, enriched.owner_occupied);
      incrementSplit(hoaSplit, enriched.hoa_flag);
      if (rowCount % 50_000 === 0) {
        await onProgress({
          stage: "query-table",
          completedRows: rowCount,
          expectedRows: expectedRowCount,
        });
      }
      row = await cursor.next();
    }
  } finally {
    await reader.close();
    await writer.close();
  }
  if (expectedRowCount !== null && rowCount !== expectedRowCount) {
    throw new Error(
      `Gap query-table row count ${rowCount} does not match ${expectedRowCount}`,
    );
  }
  if (overlays.cidByFolio.size !== rowCount) {
    throw new Error(
      `CID count ${overlays.cidByFolio.size} does not match query rows ${rowCount}`,
    );
  }
  if (inputCidCount !== 0 || inputOwnerOccupiedCount !== 0) {
    throw new Error(
      "Gap input is not the frozen empty-CID/empty-owner-occupied snapshot",
    );
  }
  if (expectedCounts !== null) {
    const observed = {
      ownerOccupiedSourceCount: overlays.ownerOccupiedByFolio.size,
      permitPropertyCount,
      linkedPermitCount,
      sunbizPropertyCount,
      bbbPropertyCount,
      bbbWithoutPermitsCount,
      ownerOccupiedTrueCount: ownerOccupiedSplit.true ?? 0,
      ownerOccupiedFalseCount: ownerOccupiedSplit.false ?? 0,
      ownerOccupiedNullCount: ownerOccupiedSplit.null ?? 0,
    };
    for (const [key, expected] of Object.entries(expectedCounts)) {
      if (observed[key] !== expected) {
        throw new Error(
          `Gap query-table ${key} ${observed[key]} does not match ${expected}`,
        );
      }
    }
  }
  const preservedColumnCount = await assertPreservedColumns({
    inputParquet,
    outputParquet,
    schemaFields,
  });

  const outputBody = await readFile(outputParquet);
  const blockers = [];
  if (hoaPath === null) {
    blockers.push(
      buildDurableBlocker({
        county,
        field: "hoa_flag",
        owner: "Oracle Data Partnerships",
        attemptedSources: [
          "Florida DBPR condominium records",
          "FloridaCommerce Official List of Special Districts",
        ],
        missingRequirement:
          "complete authoritative parcel-membership source and publication rights",
        evidence: [
          "DBPR identifies projects and managers but not complete parcel membership",
          "CDD identity does not establish HOA membership",
        ],
        nextAction:
          "request Jacksonville GIS or Clerk parcel-linked association records",
        observedAt: frozenAt,
      }),
    );
  }
  if (avmPath === null) {
    blockers.push(
      buildDurableBlocker({
        county,
        field: "avm_value",
        owner: "Oracle Data Partnerships",
        attemptedSources: ["Oracle product and vendor registry"],
        missingRequirement:
          "named AVM vendor, credential, folio-keyed feed, and permitted-use contract",
        evidence: [
          "no AVM ingest skill or approved vendor is registered in the runtime",
        ],
        nextAction:
          "select an AVM provider and implement the approved reusable loader",
        observedAt: frozenAt,
      }),
    );
  }
  const manifest = {
    schemaVersion: "elephant.duval-gap-query-table.v1",
    county,
    frozenAt,
    rowCount,
    cidCount: overlays.cidByFolio.size,
    ownerOccupiedSourceRows: overlays.ownerOccupiedByFolio.size,
    ownerOccupiedSplit,
    inputCidCount,
    inputOwnerOccupiedCount,
    permitPropertyCount,
    linkedPermitCount,
    sunbizPropertyCount,
    bbbPropertyCount,
    bbbWithoutPermitsCount,
    preservedColumnCount,
    hoaSourceRows: overlays.hoaByFolio.size,
    hoaSplit,
    avmSourceFolios: overlays.avmByFolio.size,
    avmCount,
    blockers,
    outputBytes: outputBody.byteLength,
    outputSha256: createHash("sha256").update(outputBody).digest("hex"),
  };
  await mkdir(path.dirname(outputManifest), { recursive: true });
  await writeFile(outputManifest, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
