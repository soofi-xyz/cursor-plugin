import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  mcpEnvMapsFromCatalog,
  stringifyMcpEnvMaps,
} from "../../scripts/catalog/print-mcp-env-maps.mjs";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolve(testDir, "../..");
const trackedCatalogPath = resolve(runtimeRoot, "catalog/published-counties.json");

describe("print-mcp-env-maps", () => {
  it("omits null URLs and keeps only populated fields", () => {
    const maps = mcpEnvMapsFromCatalog({
      counties: [
        {
          countyKey: "lee",
          queryTableUrl: "https://example.com/lee.parquet",
          permitQueryTableUrl: null,
          datasetCoverageUrl: "https://example.com/lee-coverage.json",
        },
        {
          countyKey: "montgomery",
          queryTableUrl: "https://example.com/montgomery.parquet",
          permitQueryTableUrl: "https://example.com/montgomery-permits.parquet",
          datasetCoverageUrl: "",
        },
      ],
    });

    expect(maps.PROPERTY_QUERY_TABLE_MAP).toEqual({
      lee: "https://example.com/lee.parquet",
      montgomery: "https://example.com/montgomery.parquet",
    });
    expect(maps.PERMIT_QUERY_TABLE_MAP).toEqual({
      montgomery: "https://example.com/montgomery-permits.parquet",
    });
    expect(maps.DATASET_COVERAGE_MAP).toEqual({
      lee: "https://example.com/lee-coverage.json",
    });
  });

  it("stringifies maps as JSON-inside-JSON for MCP env", () => {
    const encoded = stringifyMcpEnvMaps({
      PROPERTY_QUERY_TABLE_MAP: { lee: "https://example.com/lee.parquet" },
      PERMIT_QUERY_TABLE_MAP: {},
      DATASET_COVERAGE_MAP: { lee: "https://example.com/lee-coverage.json" },
    });

    expect(JSON.parse(encoded.PROPERTY_QUERY_TABLE_MAP)).toEqual({
      lee: "https://example.com/lee.parquet",
    });
    expect(JSON.parse(encoded.PERMIT_QUERY_TABLE_MAP)).toEqual({});
    expect(JSON.parse(encoded.DATASET_COVERAGE_MAP)).toEqual({
      lee: "https://example.com/lee-coverage.json",
    });
  });

  it("throws on duplicate countyKey for a populated field", () => {
    expect(() =>
      mcpEnvMapsFromCatalog({
        counties: [
          {
            countyKey: "lee",
            queryTableUrl: "https://example.com/lee-a.parquet",
          },
          {
            countyKey: "lee",
            queryTableUrl: "https://example.com/lee-b.parquet",
          },
        ],
      }),
    ).toThrow(/Duplicate countyKey "lee"/);
  });

  it("matches the tracked bundled catalog keys (13 counties, no santa-clara)", async () => {
    const catalog = JSON.parse(await readFile(trackedCatalogPath, "utf8"));
    const maps = mcpEnvMapsFromCatalog(catalog);
    const countyKeys = catalog.counties.map((county) => county.countyKey);

    expect(countyKeys).toHaveLength(13);
    expect(Object.keys(maps.PROPERTY_QUERY_TABLE_MAP)).toEqual(countyKeys);
    expect(Object.keys(maps.DATASET_COVERAGE_MAP)).toEqual(countyKeys);
    expect(maps.PERMIT_QUERY_TABLE_MAP).toEqual({
      broward: catalog.counties.find((c) => c.countyKey === "broward")
        .permitQueryTableUrl,
      duval: catalog.counties.find((c) => c.countyKey === "duval")
        .permitQueryTableUrl,
      montgomery: catalog.counties.find((c) => c.countyKey === "montgomery")
        .permitQueryTableUrl,
      "rock-island": catalog.counties.find((c) => c.countyKey === "rock-island")
        .permitQueryTableUrl,
    });
    expect(Object.keys(maps.PERMIT_QUERY_TABLE_MAP)).not.toContain("santa-clara");
    expect(maps.PERMIT_QUERY_TABLE_MAP.duval).toBe(
      catalog.counties.find((c) => c.countyKey === "duval")
        .permitQueryTableUrl,
    );
    expect(maps.PROPERTY_QUERY_TABLE_MAP.duval).toBe(
      catalog.counties.find((c) => c.countyKey === "duval").queryTableUrl,
    );
    expect(maps.DATASET_COVERAGE_MAP.duval).toBe(
      catalog.counties.find((c) => c.countyKey === "duval").datasetCoverageUrl,
    );
    expect(maps.PROPERTY_QUERY_TABLE_MAP.polk).toMatch(/^https:/);
  });

  it("CLI prints stringified maps for the tracked bundled catalog", async () => {
    const catalog = JSON.parse(await readFile(trackedCatalogPath, "utf8"));
    const { stdout } = await execFileAsync(
      process.execPath,
      [resolve(runtimeRoot, "scripts/catalog/print-mcp-env-maps.mjs")],
      { cwd: runtimeRoot, encoding: "utf8" },
    );

    expect(JSON.parse(stdout)).toEqual(
      stringifyMcpEnvMaps(mcpEnvMapsFromCatalog(catalog)),
    );
  });

  it("CLI output is identical regardless of the invoking working directory", async () => {
    const { stdout: fromRuntimeRoot } = await execFileAsync(
      process.execPath,
      [resolve(runtimeRoot, "scripts/catalog/print-mcp-env-maps.mjs")],
      { cwd: runtimeRoot, encoding: "utf8" },
    );
    const { stdout: fromRepoRoot } = await execFileAsync(
      process.execPath,
      [resolve(runtimeRoot, "scripts/catalog/print-mcp-env-maps.mjs")],
      { cwd: resolve(runtimeRoot, "../../../.."), encoding: "utf8" },
    );

    expect(fromRepoRoot).toBe(fromRuntimeRoot);
  });
});
