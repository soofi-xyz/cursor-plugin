import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { DuckDBInstance } from "@duckdb/node-api";

import { contentReceipt } from "./canonical-json.mjs";
import {
  deriveHoaFlag,
  normalizeFolio,
  ownerOccupiedFromHomestead,
  selectLatestApprovedAvm,
} from "./source-qualification.mjs";

async function readJsonLines(filePath) {
  const rows = [];
  if (filePath === null) return rows;
  for await (const row of streamJsonLines(filePath)) rows.push(row);
  return rows;
}

async function* streamJsonLines(filePath) {
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.trim().length > 0) yield JSON.parse(line);
    }
  } finally {
    lines.close();
  }
}

async function loadDerivedValues({
  ownerOccupiedPath,
  hoaPath,
  avmPath,
}) {
  const ownerOccupied = new Map();
  for (const row of await readJsonLines(ownerOccupiedPath)) {
    const folio = normalizeFolio(
      row.parcel_identifier ?? row.folio ?? row.re_number,
    );
    if (folio === null) continue;
    if (ownerOccupied.has(folio)) throw new Error(`Duplicate DOR folio ${folio}`);
    ownerOccupied.set(folio, ownerOccupiedFromHomestead(row.AV_HMSTD));
  }

  const hoa = new Map();
  for (const row of await readJsonLines(hoaPath)) {
    const folio = normalizeFolio(
      row.parcel_identifier ?? row.folio ?? row.re_number,
    );
    if (folio === null) continue;
    if (hoa.has(folio)) throw new Error(`Duplicate HOA folio ${folio}`);
    hoa.set(folio, deriveHoaFlag(row));
  }

  const avmCandidates = new Map();
  for (const row of await readJsonLines(avmPath)) {
    const folio = normalizeFolio(
      row.parcel_identifier ?? row.folio ?? row.re_number,
    );
    if (folio === null) continue;
    const candidates = avmCandidates.get(folio) ?? [];
    candidates.push(row);
    avmCandidates.set(folio, candidates);
  }
  const avm = new Map(
    [...avmCandidates].map(([folio, rows]) => [
      folio,
      selectLatestApprovedAvm(rows),
    ]),
  );
  return { ownerOccupied, hoa, avm };
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function materializePropertyPermitRows({
  queryTableParquet,
  permitParquet,
  outputPath,
  temporaryDirectory,
}) {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    await mkdir(temporaryDirectory, { recursive: true });
    await connection.run(
      `SET memory_limit = '2GB';
       SET threads = 4;
       SET preserve_insertion_order = false;
       SET temp_directory = ${sqlString(temporaryDirectory)};`,
    );
    const countReader = await connection.runAndReadAll(
      `SELECT count(*) AS input_count,
              count(property_id) AS linked_count
       FROM read_parquet(${sqlString(permitParquet)})`,
    );
    const counts = countReader.getRowObjectsJson()[0] ?? {};
    const propertyRowsPath = `${outputPath}.properties`;
    const permitRowsPath = `${outputPath}.permits`;
    await connection.run(`
      COPY (
        SELECT
          property_id,
          parcel_identifier,
          address_street,
          address_city,
          state_code,
          address_zip,
          latitude,
          longitude,
          property_type,
          property_usage_type,
          built_year,
          livable_floor_area,
          total_area,
          subdivision,
          lot_size_acre,
          lot_area_sqft,
          owner_name,
          owners_text,
          owner_count,
          assessed_value,
          market_value,
          land_value,
          last_sale_date,
          last_sale_price,
          exterior_wall_material,
          roof_covering_material
        FROM read_parquet(${sqlString(queryTableParquet)})
        ORDER BY property_id
      ) TO ${sqlString(propertyRowsPath)} (FORMAT JSON, ARRAY false);
      COPY (
        SELECT
          property_id,
          property_improvement_id,
          parcel_identifier,
          permit_number,
          improvement_type,
          improvement_status,
          improvement_action,
          permit_issue_date,
          application_received_date,
          final_inspection_date,
          permit_close_date,
          completion_date,
          expiration_date,
          opened_date,
          source_system,
          county_name,
          project_description,
          description,
          estimated_job_value,
          fee
        FROM read_parquet(${sqlString(permitParquet)})
        WHERE property_id IS NOT NULL
        ORDER BY property_id, permit_number, permit_issue_date, property_improvement_id
      ) TO ${sqlString(permitRowsPath)} (FORMAT JSON, ARRAY false);
    `);
    return {
      inputCount: Number(counts.input_count ?? 0),
      linkedCount: Number(counts.linked_count ?? 0),
      propertyRowsPath,
      permitRowsPath,
    };
  } finally {
    connection.closeSync();
  }
}

async function* propertyPermitRows({ propertyRowsPath, permitRowsPath }) {
  const permitIterator = streamJsonLines(permitRowsPath)[Symbol.asyncIterator]();
  let permitResult = await permitIterator.next();
  for await (const property of streamJsonLines(propertyRowsPath)) {
    const propertyId = String(property.property_id);
    while (
      !permitResult.done &&
      String(permitResult.value.property_id) < propertyId
    ) {
      permitResult = await permitIterator.next();
    }
    const permits = [];
    while (
      !permitResult.done &&
      String(permitResult.value.property_id) === propertyId
    ) {
      const { property_id: _propertyId, ...permit } = permitResult.value;
      permits.push(permit);
      permitResult = await permitIterator.next();
    }
    yield { ...property, permits };
  }
}

async function loadSunbizDocuments(extractDir) {
  const manifest = JSON.parse(
    await readFile(path.join(extractDir, "manifest.json"), "utf8"),
  );
  if (manifest.completeSourceScan !== true) {
    throw new Error("Consolidation requires a complete Sunbiz source scan");
  }
  const documents = new Map();
  let rows = 0;
  for (const chunk of manifest.chunks ?? []) {
    const body = await readFile(path.join(extractDir, chunk.relativePath), "utf8");
    const digest = createHash("sha256").update(body).digest("hex");
    if (digest !== chunk.sha256) {
      throw new Error(`Sunbiz chunk digest mismatch ${chunk.relativePath}`);
    }
    for (const line of body.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      const record = JSON.parse(line);
      const documentNumber = record.entity?.documentNumber;
      if (typeof documentNumber !== "string" || documentNumber.length === 0) {
        throw new Error("Sunbiz record is missing entity.documentNumber");
      }
      documents.set(documentNumber, record.entity);
      rows += 1;
    }
  }
  if (rows !== manifest.matchedRecordCount) {
    throw new Error(
      `Sunbiz rows ${rows} do not match manifest ${manifest.matchedRecordCount}`,
    );
  }
  return documents;
}

async function loadSunbizLinks(linksPath, documents) {
  const byPropertyId = new Map();
  for (const link of await readJsonLines(linksPath)) {
    const document = documents.get(link.document_number);
    if (document === undefined) {
      throw new Error(
        `Sunbiz link references missing document ${link.document_number}`,
      );
    }
    const values = byPropertyId.get(link.property_id) ?? new Map();
    values.set(link.document_number, document);
    byPropertyId.set(link.property_id, values);
  }
  return new Map(
    [...byPropertyId].map(([propertyId, values]) => [
      propertyId,
      [...values.entries()]
        .sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        )
        .map(([, value]) => value),
    ]),
  );
}

function propertyDocument({
  row,
  folio,
  permits,
  sunbizTenants,
  ownerOccupied,
  hoaFlag,
  avm,
  frozenAt,
}) {
  return {
    parcelId: folio,
    county: "duval",
    jurisdictionKey: "duval",
    sourceSystem: "duval_appraiser",
    address: {
      street: row.address_street ?? null,
      city: row.address_city ?? null,
      state: row.state_code ?? "FL",
      postalCode: row.address_zip ?? null,
      latitude: row.latitude ?? null,
      longitude: row.longitude ?? null,
    },
    property: {
      propertyId: row.property_id,
      propertyType: row.property_type ?? null,
      propertyUsageType: row.property_usage_type ?? null,
      builtYear: row.built_year ?? null,
      livableFloorArea: row.livable_floor_area ?? null,
      totalArea: row.total_area ?? null,
      subdivision: row.subdivision ?? null,
      ownerOccupied,
      hoaFlag,
    },
    parcel: {
      parcelIdentifier: folio,
      lotSizeAcre: row.lot_size_acre ?? null,
      lotAreaSqft: row.lot_area_sqft ?? null,
    },
    ownerships:
      row.owner_name === null || row.owner_name === undefined
        ? []
        : [
            {
              ownerName: row.owner_name,
              ownersText: row.owners_text ?? row.owner_name,
              ownerCount: Number(row.owner_count ?? 1),
              ownerOccupied,
            },
          ],
    taxes: [
      {
        assessedValue: row.assessed_value ?? null,
        marketValue: row.market_value ?? null,
        landValue: row.land_value ?? null,
      },
    ],
    sales:
      row.last_sale_date === null || row.last_sale_date === undefined
        ? []
        : [
            {
              transferDate: row.last_sale_date,
              purchasePrice: row.last_sale_price ?? null,
            },
          ],
    structures: [
      {
        exteriorWallMaterial: row.exterior_wall_material ?? null,
        roofCoveringMaterial: row.roof_covering_material ?? null,
      },
    ],
    valuations:
      avm === null
        ? []
        : [
            {
              currentAvmValue: Number(avm.current_avm_value),
              valuationDate: avm.valuation_date,
              valuationMethodType: avm.valuation_method_type,
              confidenceScore: avm.confidence_score ?? null,
              highValue: avm.high_value ?? null,
              lowValue: avm.low_value ?? null,
              vendorPropertyId: avm.vendor_property_id ?? null,
            },
          ],
    permits,
    sunbizTenants,
    bbbProfiles: [],
    collectedAt: frozenAt,
  };
}

export async function buildPropertyConsolidation({
  county,
  queryTableParquet,
  permitParquet,
  sunbizExtractDir,
  sunbizLinksPath,
  ownerOccupiedPath,
  hoaPath = null,
  avmPath = null,
  outputDir,
  frozenAt,
  expectedPropertyCount = null,
  expectedPermitCount = null,
  shardSize = 5_000,
}) {
  if (county !== "duval") {
    throw new Error("The current gap profile is locked to county=duval");
  }
  const derived = await loadDerivedValues({
    ownerOccupiedPath,
    hoaPath,
    avmPath,
  });
  const joinedRowsPath = path.join(outputDir, ".work", "property-permits.jsonl");
  const permits = await materializePropertyPermitRows({
    queryTableParquet,
    permitParquet,
    outputPath: joinedRowsPath,
    temporaryDirectory: path.join(outputDir, ".work", "duckdb"),
  });
  if (
    expectedPermitCount !== null &&
    permits.inputCount !== expectedPermitCount
  ) {
    throw new Error(
      `Permit input count ${permits.inputCount} does not match ${expectedPermitCount}`,
    );
  }
  const sunbizDocuments = await loadSunbizDocuments(sunbizExtractDir);
  const sunbizByPropertyId = await loadSunbizLinks(
    sunbizLinksPath,
    sunbizDocuments,
  );
  const propertiesDir = path.join(outputDir, "properties");
  const shardsDir = path.join(outputDir, "shards");
  await Promise.all([
    mkdir(propertiesDir, { recursive: true }),
    mkdir(shardsDir, { recursive: true }),
  ]);

  const entries = [];
  const seenFolios = new Set();
  let totalBytes = 0;
  try {
    for await (const row of propertyPermitRows(permits)) {
      const folio = normalizeFolio(row.parcel_identifier);
      if (folio === null || seenFolios.has(folio)) {
        throw new Error(`Duplicate or invalid property folio ${folio}`);
      }
      seenFolios.add(folio);
      const avm = derived.avm.get(folio) ?? null;
      const document = propertyDocument({
        row,
        folio,
        permits: row.permits ?? [],
        sunbizTenants: sunbizByPropertyId.get(row.property_id) ?? [],
        ownerOccupied: derived.ownerOccupied.has(folio)
          ? derived.ownerOccupied.get(folio)
          : null,
        hoaFlag: derived.hoa.has(folio) ? derived.hoa.get(folio) : null,
        avm,
        frozenAt,
      });
      const receipt = await contentReceipt(document);
      const relativePath = `properties/${row.property_id}.json`;
      await writeFile(path.join(outputDir, relativePath), receipt.body);
      entries.push({
        propertyId: String(row.property_id),
        parcelIdentifier: folio,
        filePath: relativePath,
        fileSizeBytes: receipt.bytes,
        sha256: receipt.sha256,
        cid: receipt.cid,
      });
      totalBytes += receipt.bytes;
    }
  } finally {
    await rm(path.join(outputDir, ".work"), { recursive: true, force: true });
  }
  if (
    expectedPropertyCount !== null &&
    entries.length !== expectedPropertyCount
  ) {
    throw new Error(
      `Property count ${entries.length} does not match ${expectedPropertyCount}`,
    );
  }
  entries.sort((left, right) =>
    left.parcelIdentifier < right.parcelIdentifier
      ? -1
      : left.parcelIdentifier > right.parcelIdentifier
        ? 1
        : 0,
  );
  const completedAt = frozenAt;
  const shardRefs = [];
  for (let offset = 0; offset < entries.length; offset += shardSize) {
    const shardIndex = Math.floor(offset / shardSize);
    const slice = entries.slice(offset, offset + shardSize);
    const shard = {
      schemaVersion: "1",
      shardIndex,
      fromParcel: slice[0].parcelIdentifier,
      toParcel: slice.at(-1).parcelIdentifier,
      count: slice.length,
      entries: slice.map(
        ({ propertyId, parcelIdentifier, cid, fileSizeBytes }) => ({
          propertyId,
          parcelIdentifier,
          cid,
          fileSizeBytes,
        }),
      ),
    };
    const receipt = await contentReceipt(shard);
    await writeFile(
      path.join(shardsDir, `shard-${String(shardIndex).padStart(4, "0")}.json`),
      receipt.body,
    );
    shardRefs.push({
      shardIndex,
      fromParcel: shard.fromParcel,
      toParcel: shard.toParcel,
      count: shard.count,
      shardCid: receipt.cid,
    });
  }
  const manifest = {
    schemaVersion: "1",
    county,
    exportedAt: frozenAt,
    completedAt,
    propertyCount: entries.length,
    totalBytes,
    entries,
    reconciliation: {
      permitInputCount: permits.inputCount,
      linkedPermitCount: permits.linkedCount,
      sunbizSourceCount: sunbizDocuments.size,
      sunbizLinkedPropertyCount: sunbizByPropertyId.size,
      ownerOccupiedSourceRows: derived.ownerOccupied.size,
      hoaSourceRows: derived.hoa.size,
      avmSourceFolios: derived.avm.size,
      bbbProfileCount: 0,
    },
  };
  const index = {
    schemaVersion: "1",
    county,
    exportedAt: frozenAt,
    completedAt,
    propertyCount: entries.length,
    shardSize,
    totalBytes,
    shards: shardRefs,
  };
  const [manifestReceipt, indexReceipt] = await Promise.all([
    contentReceipt(manifest),
    contentReceipt(index),
  ]);
  await Promise.all([
    writeFile(path.join(outputDir, "manifest.json"), manifestReceipt.body),
    writeFile(path.join(outputDir, "index.json"), indexReceipt.body),
  ]);
  return {
    manifest,
    index,
    manifestCid: manifestReceipt.cid,
    indexCid: indexReceipt.cid,
  };
}
