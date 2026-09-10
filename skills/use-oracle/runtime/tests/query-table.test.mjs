import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  toNumber,
  toInteger,
  toText,
  parseUnnormalizedAddress,
  toParquetRecord,
  buildCoverageSnapshot,
  writeQueryTableParquet,
  readTransformedZipJsonFiles,
} from "../src/core/query-table.mjs";
import {
  propertyIdForStrap,
  ownerNameFromRecord,
  mapTransformedFilesToQueryTableRow,
  QUERY_TABLE_SCHEMA_FIELDS,
  QUERY_TABLE_BUCKET,
  QUERY_TABLE_IPNS_LABEL,
  COVERAGE_IPNS_LABEL,
} from "../src/counties/pinellas/query-table.mjs";
import { pinellasAdapter } from "../src/counties/pinellas/adapter.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ParquetReader } = require("@dsnp/parquetjs");

const RUNTIME_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = path.join(RUNTIME_ROOT, "fixtures", "pinellas-replay");
const STRAP = "162805389030000430";

describe("core query-table coercion helpers", () => {
  it("coerces numbers, integers, and text defensively", () => {
    expect(toNumber("1,234")).toBeNull();
    expect(toNumber("1450")).toBe(1450);
    expect(toNumber(42)).toBe(42);
    expect(toNumber(Number.NaN)).toBeNull();
    expect(toNumber(null)).toBeNull();
    expect(toInteger("1985.7")).toBe(1985);
    expect(toInteger(undefined)).toBeNull();
    expect(toText("  hi  ")).toBe("hi");
    expect(toText("   ")).toBeNull();
    expect(toText(42)).toBeNull();
  });

  it("parses a single-line address into street/city/zip", () => {
    expect(parseUnnormalizedAddress("3400 RUGBY CT, PALM HARBOR FL 34684")).toEqual({
      street: "3400 RUGBY CT",
      city: "PALM HARBOR",
      postalCode: "34684",
    });
    expect(parseUnnormalizedAddress(null)).toEqual({ street: null, city: null, postalCode: null });
    expect(parseUnnormalizedAddress("")).toEqual({ street: null, city: null, postalCode: null });
  });

  it("drops null/undefined keys for sparse Parquet rows", () => {
    expect(toParquetRecord({ a: 1, b: null, c: undefined, d: "x" })).toEqual({ a: 1, d: "x" });
  });

  it("builds a one-dataset coverage snapshot", () => {
    const snapshot = buildCoverageSnapshot({
      county: "pinellas",
      source: "appraisal",
      ingestedCount: 1,
      expectedCount: 1,
      exportedAt: "2026-01-01T00:00:00.000Z",
      ipnsLabel: COVERAGE_IPNS_LABEL,
    });
    expect(snapshot.datasets).toHaveLength(1);
    expect(snapshot.datasets[0]).toMatchObject({
      county: "pinellas",
      source: "appraisal",
      ingested_count: 1,
      expected_count: 1,
      cid: null,
      ipns_label: COVERAGE_IPNS_LABEL,
    });
  });
});

describe("Pinellas query-table row mapping (Gate B fixture)", () => {
  it("derives a stable UUID-shaped property id from a STRAP", () => {
    const id = propertyIdForStrap(STRAP);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(propertyIdForStrap(STRAP)).toBe(id);
  });

  it("reads an owner display name from person-shaped and company-shaped records", () => {
    expect(ownerNameFromRecord({ name: "Acme LLC" })).toBe("Acme LLC");
    expect(ownerNameFromRecord({ first_name: "John", middle_name: "Q", last_name: "Smith" })).toBe("John Q Smith");
    expect(ownerNameFromRecord({})).toBeNull();
  });

  it("exposes the Pinellas Filebase destination constants", () => {
    expect(QUERY_TABLE_BUCKET).toBe("elephant-oracle-query-table-pinellas");
    expect(QUERY_TABLE_IPNS_LABEL).toBe("oracle-query-table-pinellas");
    expect(COVERAGE_IPNS_LABEL).toBe("oracle-dataset-coverage-pinellas");
    expect(Object.keys(QUERY_TABLE_SCHEMA_FIELDS)).toContain("property_id");
  });

  it("maps the transformed Gate B fixture zip into the expected query-table row", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "pinellas-query-table-"));
    try {
      const { parseCsvRecords } = await import("../src/core/csv.mjs");
      const seedRows = parseCsvRecords(await readFile(path.join(FIXTURE_DIR, "seed.csv"), "utf8"));
      expect(seedRows).toHaveLength(1);
      const outputDir = path.join(tempDir, "ingest");
      const manifest = await pinellasAdapter.captureAndTransform({
        seedRows,
        htmlDir: path.join(FIXTURE_DIR, "html"),
        outputDir,
        liveFetch: false,
        asOfDate: "2026-09-09",
      });
      expect(manifest.results).toEqual([
        { parcelId: STRAP, transformSuccess: true, propertyUsageType: "Residential", error: null },
      ]);

      const files = readTransformedZipJsonFiles(path.join(outputDir, STRAP, "transformed.zip"));
      const row = mapTransformedFilesToQueryTableRow({ strap: STRAP, files, seedRow: seedRows[0] });
      const expectedRow = JSON.parse(await readFile(path.join(FIXTURE_DIR, "expected-row.json"), "utf8"));
      expect(row).toEqual(expectedRow);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("writeQueryTableParquet", () => {
  it("writes exactly one row with optional nulls preserved as absent columns", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "pinellas-parquet-"));
    try {
      const parquetPath = path.join(tempDir, "query-table.parquet");
      const row = JSON.parse(await readFile(path.join(FIXTURE_DIR, "expected-row.json"), "utf8"));
      const written = await writeQueryTableParquet({
        parquetPath,
        schemaFields: QUERY_TABLE_SCHEMA_FIELDS,
        rows: [row],
      });
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
        // `@dsnp/parquetjs` materializes every optional schema field on
        // read, reporting an absent value as `null` rather than omitting
        // the key.
        expect(rows[0].land_value).toBeNull();
      } finally {
        await reader.close();
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
