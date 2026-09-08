import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { ParquetSchema, ParquetWriter } from "@dsnp/parquetjs";

import { toParquetRecord } from "../core/query-table.mjs";
import { normalizeSunbizAddress } from "./sunbiz.mjs";

const require = createRequire(import.meta.url);
const { ParquetReader } = require("@dsnp/parquetjs");

function propertyAddressKey(street, zip) {
  const normalizedStreet = normalizeSunbizAddress(street);
  const normalizedZip = String(zip ?? "").replace(/\D+/g, "").slice(0, 5);
  return normalizedStreet && normalizedZip
    ? `${normalizedStreet}|${normalizedZip}`
    : null;
}

async function countPropertyAddresses(parquetPath) {
  const counts = new Map();
  const reader = await ParquetReader.openFile(parquetPath);
  try {
    const cursor = reader.getCursor(["address_street", "address_zip"]);
    let row = await cursor.next();
    while (row) {
      const key = propertyAddressKey(row.address_street, row.address_zip);
      if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1);
      row = await cursor.next();
    }
  } finally {
    await reader.close();
  }
  return counts;
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function loadSunbizBusinessAddresses(extractDir, countyKey) {
  const manifestPath = path.join(extractDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.completeSourceScan !== true) {
    throw new Error("Refusing to enrich from an incomplete Sunbiz source scan");
  }
  if (manifest.county !== countyKey) {
    throw new Error(
      `Sunbiz extract county mismatch: expected ${countyKey}, received ${manifest.county ?? "missing"}`,
    );
  }
  const documentsByAddress = new Map();
  let parsedRecordCount = 0;
  let activePrincipalRecordCount = 0;

  for (const chunk of manifest.chunks ?? []) {
    const chunkPath = path.join(extractDir, chunk.relativePath);
    const body = await readFile(chunkPath, "utf8");
    const digest = createHash("sha256").update(body).digest("hex");
    if (digest !== chunk.sha256) {
      throw new Error(`Sunbiz chunk digest mismatch: ${chunk.relativePath}`);
    }
    for (const line of body.split(/\r?\n/)) {
      if (!line.trim()) continue;
      parsedRecordCount += 1;
      const record = JSON.parse(line);
      const entity = record.entity;
      if (entity?.status !== "ACTIVE") continue;
      const key = propertyAddressKey(
        entity.principalAddress?.line1,
        entity.principalAddress?.zip,
      );
      if (key === null) continue;
      const principalMatched = (record.matchedAddresses ?? []).some(
        (match) => match.role === "principalAddress",
      );
      if (!principalMatched) continue;
      activePrincipalRecordCount += 1;
      const documents = documentsByAddress.get(key) ?? new Set();
      documents.add(entity.documentNumber);
      documentsByAddress.set(key, documents);
    }
  }

  if (parsedRecordCount !== manifest.matchedRecordCount) {
    throw new Error(
      `Sunbiz extract reconciliation failed: ${parsedRecordCount} chunk rows vs ${manifest.matchedRecordCount} manifest rows`,
    );
  }
  return {
    manifest,
    documentsByAddress,
    parsedRecordCount,
    activePrincipalRecordCount,
  };
}

function upsertCoverageDataset(coverage, dataset) {
  const datasets = Array.isArray(coverage.datasets) ? [...coverage.datasets] : [];
  const existingIndex = datasets.findIndex(
    (entry) => entry?.source === dataset.source,
  );
  if (existingIndex >= 0) datasets[existingIndex] = dataset;
  else datasets.push(dataset);
  return { ...coverage, datasets };
}

export async function enrichQueryTableWithSunbiz({
  countyKey,
  schemaFields,
  inputParquet,
  outputParquet,
  inputCoverage,
  outputCoverage,
  sunbizExtractDir,
  linksPath,
  exportedAt = new Date().toISOString(),
  manifestPath = `${outputParquet}.manifest.json`,
}) {
  if (
    typeof countyKey !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(countyKey)
  ) {
    throw new Error("Sunbiz query-table enrichment requires a valid countyKey");
  }
  if (
    !schemaFields ||
    typeof schemaFields !== "object" ||
    schemaFields.has_sunbiz_tenant?.type !== "BOOLEAN"
  ) {
    throw new Error(
      "Sunbiz query-table enrichment requires schemaFields with has_sunbiz_tenant",
    );
  }
  if (path.resolve(inputParquet) === path.resolve(outputParquet)) {
    throw new Error("Sunbiz enrichment requires a distinct output Parquet path");
  }
  const sunbiz = await loadSunbizBusinessAddresses(
    sunbizExtractDir,
    countyKey,
  );
  const propertyAddressCounts = await countPropertyAddresses(inputParquet);
  await mkdir(path.dirname(outputParquet), { recursive: true });
  await mkdir(path.dirname(outputCoverage), { recursive: true });
  await mkdir(path.dirname(linksPath), { recursive: true });

  const reader = await ParquetReader.openFile(inputParquet);
  const writer = await ParquetWriter.openFile(
    new ParquetSchema(structuredClone(schemaFields)),
    outputParquet,
  );
  const linkWriter = createWriteStream(linksPath, { encoding: "utf8" });
  let inputRowCount = 0;
  let outputRowCount = 0;
  let sunbizPropertyMatchCount = 0;
  let sunbizLinkCount = 0;
  const linkedDocuments = new Set();

  try {
    const cursor = reader.getCursor();
    let row = await cursor.next();
    while (row) {
      inputRowCount += 1;
      const key = propertyAddressKey(row.address_street, row.address_zip);
      const documents =
        key === null || propertyAddressCounts.get(key) !== 1
          ? null
          : sunbiz.documentsByAddress.get(key) ?? null;
      const hasSunbizTenant = documents !== null && documents.size > 0;
      await writer.appendRow(
        toParquetRecord({
          ...row,
          has_sunbiz_tenant: hasSunbizTenant,
        }),
      );
      outputRowCount += 1;
      if (hasSunbizTenant) {
        sunbizPropertyMatchCount += 1;
        for (const documentNumber of documents) {
          const link = {
            property_id: row.property_id,
            document_number: documentNumber,
            match_method:
              "unique_property_exact_normalized_principal_address_zip",
            confidence: 0.9,
            source: "SUNBIZ",
          };
          if (!linkWriter.write(`${JSON.stringify(link)}\n`)) {
            await new Promise((resolve) => linkWriter.once("drain", resolve));
          }
          sunbizLinkCount += 1;
          linkedDocuments.add(documentNumber);
        }
      }
      row = await cursor.next();
    }
  } finally {
    await reader.close();
    await writer.close();
    await new Promise((resolve, reject) => {
      linkWriter.once("error", reject);
      linkWriter.end(resolve);
    });
  }
  if (inputRowCount !== outputRowCount) {
    throw new Error(
      `Query-table row reconciliation failed: ${inputRowCount} input vs ${outputRowCount} output`,
    );
  }

  const originalCoverage = JSON.parse(await readFile(inputCoverage, "utf8"));
  if (originalCoverage.county !== countyKey) {
    throw new Error(
      `Coverage county mismatch: expected ${countyKey}, received ${originalCoverage.county ?? "missing"}`,
    );
  }
  const existingSunbiz = (originalCoverage.datasets ?? []).find(
    (dataset) => dataset?.source === "sunbiz",
  );
  const coverage = upsertCoverageDataset(
    { ...originalCoverage, exportedAt },
    {
      county: countyKey,
      source: "sunbiz",
      ingested_count: sunbiz.parsedRecordCount,
      expected_count: null,
      first_loaded_at: existingSunbiz?.first_loaded_at ?? exportedAt,
      last_loaded_at: exportedAt,
      cid: null,
      ipns_label: null,
      linked_property_count: sunbizPropertyMatchCount,
      linked_registration_count: linkedDocuments.size,
      valid_unlinked_count: sunbiz.parsedRecordCount - linkedDocuments.size,
      match_method:
        "unique_property_exact_normalized_principal_address_zip",
    },
  );
  await writeFile(outputCoverage, `${JSON.stringify(coverage, null, 2)}\n`, "utf8");

  const [inputStat, outputStat, linksStat] = await Promise.all([
    stat(inputParquet),
    stat(outputParquet),
    stat(linksPath),
  ]);
  const summary = {
    schemaVersion: "elephant.sunbiz-query-table-enrichment.v1",
    county: countyKey,
    enrichedAt: exportedAt,
    inputParquet,
    outputParquet,
    inputRowCount,
    outputRowCount,
    sunbizSourceRecordCount: sunbiz.parsedRecordCount,
    sunbizActivePrincipalRecordCount: sunbiz.activePrincipalRecordCount,
    sunbizPropertyMatchCount,
    sunbizLinkCount,
    sunbizLinkedRegistrationCount: linkedDocuments.size,
    inputBytes: inputStat.size,
    outputBytes: outputStat.size,
    linksBytes: linksStat.size,
    inputSha256: await sha256File(inputParquet),
    outputSha256: await sha256File(outputParquet),
    linksSha256: await sha256File(linksPath),
  };
  await writeFile(manifestPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return summary;
}
