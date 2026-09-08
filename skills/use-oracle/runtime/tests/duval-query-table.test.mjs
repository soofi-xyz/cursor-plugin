import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { readTransformedZipJsonFiles, writeQueryTableParquet } from "../src/core/query-table.mjs";
import { parseCsvRecords } from "../src/core/csv.mjs";
import {
  duvalPropertyId,
  pickLatestTax,
  pickLatestSale,
  formatOwnerName,
  mapTransformedFilesToQueryTableRow,
  COUNTY_KEY,
  COUNTY_NAME,
} from "../src/counties/duval/query-table.mjs";
import { duvalEnrichmentProfile } from "../src/counties/duval/enrichment-profile.mjs";
import { duvalAdapter } from "../src/counties/duval/adapter.mjs";

const require = createRequire(import.meta.url);
const { ParquetReader } = require("@dsnp/parquetjs");

const RUNTIME_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = path.join(RUNTIME_ROOT, "fixtures", "duval-replay");
const PARCEL_ID = "0969250000";
const RE_NUMBER = "0969250000R";
const QUERY_TABLE_SCHEMA_FIELDS =
  duvalEnrichmentProfile.queryTable.schemaFields;

describe("Duval query-table row mapping (Gate B fixture)", () => {
  it("derives a stable id from a canonical DOR parcel id", () => {
    const id = duvalPropertyId(RE_NUMBER);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(duvalPropertyId(RE_NUMBER)).toBe(id);
    expect(duvalPropertyId("0000000001R")).not.toBe(id);
  });

  it("picks the highest-tax_year record and the latest-dated sale", () => {
    const taxes = [{ tax_year: 2023 }, { tax_year: 2025 }, { tax_year: 2024 }];
    expect(pickLatestTax(taxes)).toEqual({ tax_year: 2025 });
    expect(pickLatestTax([])).toBeNull();

    const sales = [
      { ownership_transfer_date: "2019-01-01" },
      { ownership_transfer_date: "2021-06-15" },
      { ownership_transfer_date: "2020-05-01" },
    ];
    expect(pickLatestSale(sales)).toEqual({ ownership_transfer_date: "2021-06-15" });
    expect(pickLatestSale([])).toBeNull();
  });

  it("reads an owner display name from person-shaped and company-shaped records", () => {
    expect(formatOwnerName({ name: "Acme LLC" })).toBe("Acme LLC");
    expect(formatOwnerName({ first_name: "John", middle_name: "A", last_name: "Doe" })).toBe("John A Doe");
    expect(formatOwnerName({})).toBeNull();
    expect(formatOwnerName(null)).toBeNull();
  });

  it("exposes the Duval Filebase destination constants", () => {
    expect(duvalEnrichmentProfile.publication.bucket).toBe(
      "elephant-oracle-query-table",
    );
    expect(duvalEnrichmentProfile.publication.queryTableIpnsLabel).toBe(
      "oracle-query-table-duval",
    );
    expect(duvalEnrichmentProfile.publication.coverageIpnsLabel).toBe(
      "oracle-dataset-coverage-duval",
    );
    expect(COUNTY_KEY).toBe("duval");
    expect(COUNTY_NAME).toBe("Duval");
    expect(Object.keys(QUERY_TABLE_SCHEMA_FIELDS)).toContain("property_id");
    expect(Object.keys(QUERY_TABLE_SCHEMA_FIELDS)).toContain("has_pa_corp_tenant");
  });

  it("maps the transformed Gate B fixture zip into the expected query-table row", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "duval-query-table-"));
    try {
      const seedRows = parseCsvRecords(await readFile(path.join(FIXTURE_DIR, "seed.csv"), "utf8"));
      expect(seedRows).toHaveLength(1);
      const outputDir = path.join(tempDir, "ingest");
      const manifest = await duvalAdapter.captureAndTransform({
        seedRows,
        htmlDir: path.join(FIXTURE_DIR, "html"),
        outputDir,
        liveFetch: false,
      });
      expect(manifest.results).toEqual([
        {
          parcelId: PARCEL_ID,
          transformSuccess: true,
          classification: "success",
          propertyUsageType: "Residential",
          error: null,
        },
      ]);

      const files = readTransformedZipJsonFiles(path.join(outputDir, PARCEL_ID, "transformed.zip"));
      const row = mapTransformedFilesToQueryTableRow({
        parcelId: seedRows[0].source_identifier,
        files,
        seedRow: seedRows[0],
      });
      const expectedRow = JSON.parse(await readFile(path.join(FIXTURE_DIR, "expected-row.json"), "utf8"));
      expect(row).toEqual(expectedRow);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("writeQueryTableParquet", () => {
  it("writes exactly one row with optional nulls preserved as absent columns", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "duval-parquet-"));
    try {
      const parquetPath = path.join(tempDir, "query-table.parquet");
      const row = JSON.parse(await readFile(path.join(FIXTURE_DIR, "expected-row.json"), "utf8"));
      const written = await writeQueryTableParquet({ parquetPath, schemaFields: QUERY_TABLE_SCHEMA_FIELDS, rows: [row] });
      expect(written).toBe(1);

      const reader = await ParquetReader.openFile(parquetPath);
      try {
        const cursor = reader.getCursor();
        const rows = [];
        let record = await cursor.next();
        while (record) {
          rows.push(record);
          record = await cursor.next();
        }
        expect(rows).toHaveLength(1);
        expect(rows[0].property_id).toBe(row.property_id);
        expect(rows[0].owner_name).toBe(row.owner_name);
        expect(rows[0].avm_value).toBeNull();
      } finally {
        await reader.close();
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("query-table uniqueness (Global Constraint)", () => {
  it("rejects publication artifacts that would contain duplicate request_identifier values", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "duval-dup-request-id-"));
    try {
      const seedRows = parseCsvRecords(await readFile(path.join(FIXTURE_DIR, "seed.csv"), "utf8"));
      const duplicateRow = { ...seedRows[0], parcel_id: "0969250001" };
      const outputDir = path.join(tempDir, "ingest");
      await duvalAdapter.captureAndTransform({
        seedRows: [seedRows[0]],
        htmlDir: path.join(FIXTURE_DIR, "html"),
        outputDir,
        liveFetch: false,
      });
      // Duplicate the successful parcel's output under a second parcel_id
      // directory so buildPublicationArtifacts sees two rows sharing the
      // same underlying source_identifier (RE Number).
      const { cp } = await import("node:fs/promises");
      await cp(path.join(outputDir, PARCEL_ID), path.join(outputDir, duplicateRow.parcel_id), { recursive: true });

      await expect(
        duvalAdapter.buildPublicationArtifacts({
          outputDir,
          seedRows: [seedRows[0], duplicateRow],
          publishDir: path.join(tempDir, "publish"),
        }),
      ).rejects.toThrow(/duplicate request_identifier/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
