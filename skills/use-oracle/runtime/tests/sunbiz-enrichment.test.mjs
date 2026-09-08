import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  filterSunbizDirectory,
  findZipMatchedAddresses,
  parseCorporateDataRecord,
  transformSunbizExtract,
} from "../src/enrichment/sunbiz.mjs";
import { enrichQueryTableWithSunbiz } from "../src/enrichment/query-table-sunbiz.mjs";
import { validateSunbizArchiveEntries } from "../src/enrichment/sunbiz-archive.mjs";
import { writeQueryTableParquet } from "../src/core/query-table.mjs";
import { duvalEnrichmentProfile } from "../src/counties/duval/enrichment-profile.mjs";

const require = createRequire(import.meta.url);
const { ParquetReader } = require("@dsnp/parquetjs");
const DUVAL_SUNBIZ_ZIP_PREFIXES =
  duvalEnrichmentProfile.sunbiz.zipPrefixes;
const QUERY_TABLE_SCHEMA_FIELDS =
  duvalEnrichmentProfile.queryTable.schemaFields;

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function fixedWidthRecord({
  documentNumber,
  entityName = "EXAMPLE COMPANY LLC",
  principalZip = "",
  mailingZip = "",
  agentZip = "",
  officerZip = "",
}) {
  const chars = Array(1_450).fill(" ");
  const write = (start, length, value) => {
    const text = String(value).slice(0, length).padEnd(length, " ");
    chars.splice(start - 1, length, ...text);
  };
  write(1, 12, documentNumber);
  write(13, 192, entityName);
  write(205, 1, "A");
  write(206, 15, "FLAL");
  write(221, 42, "100 MAIN STREET");
  write(305, 28, "JACKSONVILLE");
  write(333, 2, "FL");
  write(335, 10, principalZip);
  write(347, 42, "200 MAIL ROAD");
  write(431, 28, "JACKSONVILLE");
  write(459, 2, "FL");
  write(461, 10, mailingZip);
  write(545, 42, "REGISTERED AGENT NAME");
  write(588, 42, "300 AGENT AVENUE");
  write(630, 28, "JACKSONVILLE");
  write(658, 2, "FL");
  write(660, 9, agentZip);
  write(669, 4, "MGR");
  write(674, 42, "OFFICER NAME");
  write(716, 42, "400 OFFICER DRIVE");
  write(758, 28, "JACKSONVILLE");
  write(786, 2, "FL");
  write(788, 9, officerZip);
  return chars.join("");
}

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

describe("Sunbiz Duval enrichment", () => {
  it("rejects unsafe, unexpected, and oversized archive entries before extraction", () => {
    expect(
      validateSunbizArchiveEntries([
        { name: "cordata0.txt", bytes: 10 },
        { name: "cordata1.txt", bytes: 20 },
      ]),
    ).toEqual({
      fileNames: ["cordata0.txt", "cordata1.txt"],
      expandedBytes: 30,
    });
    expect(() =>
      validateSunbizArchiveEntries([{ name: "../cordata0.txt", bytes: 10 }]),
    ).toThrow(/Unsafe/);
    expect(() =>
      validateSunbizArchiveEntries([{ name: "readme.html", bytes: 10 }]),
    ).toThrow(/Unexpected/);
    expect(() =>
      validateSunbizArchiveEntries(
        [{ name: "cordata0.txt", bytes: 11 }],
        { maxExpandedBytes: 10 },
      ),
    ).toThrow(/expands beyond/);
  });

  it("uses the reviewed Duval ZIP boundary without admitting other 320xx ZIPs", () => {
    expect(DUVAL_SUNBIZ_ZIP_PREFIXES).toEqual(["322", "32099"]);

    const included = parseCorporateDataRecord(
      fixedWidthRecord({
        documentNumber: "L00000000001",
        principalZip: "32099",
      }),
    );
    const excluded = parseCorporateDataRecord(
      fixedWidthRecord({
        documentNumber: "L00000000002",
        principalZip: "32081",
      }),
    );

    expect(findZipMatchedAddresses(included, DUVAL_SUNBIZ_ZIP_PREFIXES)).toHaveLength(1);
    expect(findZipMatchedAddresses(excluded, DUVAL_SUNBIZ_ZIP_PREFIXES)).toHaveLength(0);
  });

  it("parses and reports every address-bearing role", () => {
    const record = parseCorporateDataRecord(
      fixedWidthRecord({
        documentNumber: "L00000000003",
        principalZip: "32202",
        mailingZip: "32203-1234",
        agentZip: "32204",
        officerZip: "32205",
      }),
    );

    expect(record).toMatchObject({
      documentNumber: "L00000000003",
      entityName: "EXAMPLE COMPANY LLC",
      status: "ACTIVE",
    });
    expect(
      findZipMatchedAddresses(record, DUVAL_SUNBIZ_ZIP_PREFIXES).map(
        (match) => match.role,
      ),
    ).toEqual([
      "principalAddress",
      "mailingAddress",
      "registeredAgentAddress",
      "officerAddress",
    ]);
  });

  it("streams expanded cordata files into reconciled, checksummed chunks", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "sunbiz-duval-"));
    temporaryDirectories.push(directory);
    const sourceDir = path.join(directory, "source");
    const outputDir = path.join(directory, "output");
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(sourceDir, { recursive: true }),
    );
    await writeFile(
      path.join(sourceDir, "cordata0.txt"),
      [
        fixedWidthRecord({
          documentNumber: "L00000000004",
          principalZip: "32202",
        }),
        fixedWidthRecord({
          documentNumber: "L00000000005",
          principalZip: "33101",
        }),
        fixedWidthRecord({
          documentNumber: "L00000000006",
          agentZip: "32099",
        }),
      ].join("\n"),
    );

    const manifest = await filterSunbizDirectory({
      countyKey: duvalEnrichmentProfile.countyKey,
      sourceDir,
      outputDir,
      zipPrefixes: DUVAL_SUNBIZ_ZIP_PREFIXES,
      chunkRecordLimit: 1,
      maxRecords: null,
      jobId: "sunbiz-duval-2026q2",
      quarter: "2026Q2",
    });

    expect(manifest).toMatchObject({
      county: "duval",
      quarter: "2026Q2",
      sourceRecordsRead: 3,
      matchedRecordCount: 2,
      invalidRecordCount: 0,
      completeSourceScan: true,
    });
    expect(manifest.chunks).toHaveLength(2);
    expect(manifest.chunks.every((chunk) => /^[a-f0-9]{64}$/.test(chunk.sha256))).toBe(
      true,
    );
    const rows = (
      await Promise.all(
        manifest.chunks.map((chunk) =>
          readFile(path.join(outputDir, chunk.relativePath), "utf8"),
        ),
      )
    )
      .join("")
      .trim()
      .split("\n")
      .map(JSON.parse);
    expect(rows.map((row) => row.entity.documentNumber)).toEqual([
      "L00000000004",
      "L00000000006",
    ]);

    const transformedDir = path.join(directory, "transformed");
    const summary = await transformSunbizExtract({
      inputDir: outputDir,
      outputDir: transformedDir,
      partRecordLimit: 1,
    });
    expect(summary.counters).toMatchObject({
      sourceRecordCount: 2,
      transformedRecordCount: 2,
      invalidRecordCount: 0,
      companyCount: 2,
      businessRegistrationCount: 2,
    });
    expect(summary.complete).toBe(true);
    expect(summary.outputParts.every((part) => /^[a-f0-9]{64}$/.test(part.sha256))).toBe(
      true,
    );

    const inputParquet = path.join(directory, "query-table.parquet");
    const outputParquet = path.join(directory, "query-table-enriched.parquet");
    const inputCoverage = path.join(directory, "coverage.json");
    const outputCoverage = path.join(directory, "coverage-enriched.json");
    const linksPath = path.join(directory, "sunbiz-property-links.jsonl");
    await writeQueryTableParquet({
      parquetPath: inputParquet,
      schemaFields: QUERY_TABLE_SCHEMA_FIELDS,
      rows: [
        {
          property_id: "property-1",
          address_street: "100 MAIN ST",
          address_zip: "32202",
          has_sunbiz_tenant: false,
        },
        {
          property_id: "property-2",
          address_street: "200 OTHER RD",
          address_zip: "32202",
          has_sunbiz_tenant: false,
        },
      ],
    });
    await writeFile(
      inputCoverage,
      JSON.stringify({
        county: "duval",
        exportedAt: "2026-09-04T00:00:00.000Z",
        datasets: [
          {
            county: "duval",
            source: "appraisal",
            ingested_count: 2,
            expected_count: 2,
          },
        ],
      }),
    );

    const enrichment = await enrichQueryTableWithSunbiz({
      countyKey: duvalEnrichmentProfile.countyKey,
      schemaFields: duvalEnrichmentProfile.queryTable.schemaFields,
      inputParquet,
      outputParquet,
      inputCoverage,
      outputCoverage,
      sunbizExtractDir: outputDir,
      linksPath,
      exportedAt: "2026-09-04T12:00:00.000Z",
    });
    expect(enrichment).toMatchObject({
      inputRowCount: 2,
      outputRowCount: 2,
      sunbizSourceRecordCount: 2,
      sunbizPropertyMatchCount: 1,
      sunbizLinkCount: 1,
    });
    const enrichedRows = await readParquetRows(outputParquet);
    expect(enrichedRows.map((row) => row.has_sunbiz_tenant)).toEqual([
      true,
      false,
    ]);
    const enrichedCoverage = JSON.parse(await readFile(outputCoverage, "utf8"));
    expect(enrichedCoverage.datasets.find((dataset) => dataset.source === "sunbiz")).toMatchObject({
      ingested_count: 2,
      expected_count: null,
      linked_property_count: 1,
      valid_unlinked_count: 1,
    });
  });
});
