import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_MCP_JSON_PATH,
  MANAGED_ENV_KEYS,
  PUBLISHED_COUNTY_CATALOG_URL,
  buildManagedEnvEntries,
  mergeEnv,
  syncMcpJson,
} from "../../scripts/catalog/sync-mcp-json.mjs";
import {
  assertOverlayDisjointFromCatalog,
  buildMergedMcpEnvMaps,
  mergeMcpEnvMaps,
} from "../../scripts/catalog/merge-mcp-env-maps.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolve(testDir, "../..");
const catalogPath = resolve(runtimeRoot, "catalog/published-counties.json");
const overlayPath = resolve(runtimeRoot, "catalog/mcp-overlays.json");
const repoRootMcpJsonPath = resolve(runtimeRoot, "../../../mcp.json");

/** @type {string} */
let tmpDir;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "sync-mcp-json-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("sync-mcp-json path resolution", () => {
  it("resolves the default mcp.json path to the repo-root mcp.json, not a sibling checkout", () => {
    expect(DEFAULT_MCP_JSON_PATH).toBe(repoRootMcpJsonPath);
    expect(DEFAULT_MCP_JSON_PATH.endsWith("/mcp.json")).toBe(true);
    expect(DEFAULT_MCP_JSON_PATH).not.toContain("skills/mcp.json");
    expect(DEFAULT_MCP_JSON_PATH).not.toContain("use-oracle/mcp.json");
  });

  it("PUBLISHED_COUNTY_CATALOG_URL is the exact locked raw GitHub URL", () => {
    expect(PUBLISHED_COUNTY_CATALOG_URL).toBe(
      "https://raw.githubusercontent.com/soofi-xyz/soofi-xyz-team-kit/main/skills/use-oracle/runtime/catalog/published-counties.json",
    );
  });
});

describe("mergeEnv", () => {
  it("places managed keys first and preserves every other key and its order untouched", () => {
    const existingEnv = {
      ORACLE_OPEN_DATA_IPNS_MAP: '{"lee":"abc"}',
      ORACLE_OPEN_DATA_DEFAULT_COUNTY: "lee",
      ORACLE_GEO_INDEX_IPNS: "geo-ipns",
      // Stale values for the managed keys that must be fully replaced, not merged.
      PROPERTY_QUERY_TABLE_MAP: '{"stale":"true"}',
    };
    const managed = buildManagedEnvEntries({
      PROPERTY_QUERY_TABLE_MAP: { lee: "https://example.com/lee.parquet" },
      PERMIT_QUERY_TABLE_MAP: {},
      DATASET_COVERAGE_MAP: { lee: "https://example.com/lee-coverage.json" },
    });

    const merged = mergeEnv(existingEnv, managed);

    expect(Object.keys(merged)).toEqual([
      "PROPERTY_QUERY_TABLE_MAP",
      "PERMIT_QUERY_TABLE_MAP",
      "DATASET_COVERAGE_MAP",
      "PUBLISHED_COUNTY_CATALOG_URL",
      "ORACLE_OPEN_DATA_IPNS_MAP",
      "ORACLE_OPEN_DATA_DEFAULT_COUNTY",
      "ORACLE_GEO_INDEX_IPNS",
    ]);
    expect(merged.PROPERTY_QUERY_TABLE_MAP).toBe(
      '{"lee":"https://example.com/lee.parquet"}',
    );
    expect(merged.ORACLE_OPEN_DATA_IPNS_MAP).toBe('{"lee":"abc"}');
    expect(merged.ORACLE_OPEN_DATA_DEFAULT_COUNTY).toBe("lee");
    expect(merged.ORACLE_GEO_INDEX_IPNS).toBe("geo-ipns");
    expect(merged.PUBLISHED_COUNTY_CATALOG_URL).toBe(PUBLISHED_COUNTY_CATALOG_URL);
  });

  it("preserves an unrelated custom env key not covered by any naming convention", () => {
    const merged = mergeEnv(
      { OPENAI_API_KEY: "sk-example" },
      buildManagedEnvEntries({
        PROPERTY_QUERY_TABLE_MAP: {},
        PERMIT_QUERY_TABLE_MAP: {},
        DATASET_COVERAGE_MAP: {},
      }),
    );

    expect(merged.OPENAI_API_KEY).toBe("sk-example");
  });
});

describe("syncMcpJson against a synthetic mcp.json fixture", () => {
  it("rewrites only the managed env keys and preserves the launcher and unmanaged env", async () => {
    const fixturePath = join(tmpDir, "mcp.json");
    const fixture = {
      $schema: "https://cursor.com/schemas/mcp.json",
      mcpServers: {
        elephant: {
          command: "bash",
          args: ["-c", "exec npx -y --package=github:elephant-xyz/elephant-mcp#main mcp"],
          env: {
            PROPERTY_QUERY_TABLE_MAP: '{"stale-county":"https://stale.example/x"}',
            PERMIT_QUERY_TABLE_MAP: "{}",
            DATASET_COVERAGE_MAP: "{}",
            PERMIT_QUERY_TABLE_CID_FALLBACK_MAP_ADDITIONS:
              '{"duval":"QmImmutablePermitCid"}',
            DATASET_COVERAGE_CID_FALLBACK_MAP_ADDITIONS:
              '{"duval":"QmImmutableCoverageCid"}',
            ORACLE_OPEN_DATA_IPNS_MAP: '{"lee":"abc"}',
            ORACLE_OPEN_DATA_DEFAULT_COUNTY: "lee",
            ORACLE_GEO_INDEX_IPNS: "geo-ipns-value",
          },
        },
      },
    };
    await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");

    const { maps } = await syncMcpJson({
      mcpJsonPath: fixturePath,
      catalogPath,
      overlayPath,
    });

    expect(Object.keys(maps.PROPERTY_QUERY_TABLE_MAP)).toHaveLength(14);
    expect(Object.keys(maps.PERMIT_QUERY_TABLE_MAP)).toHaveLength(5);
    expect(Object.keys(maps.DATASET_COVERAGE_MAP)).toHaveLength(13);

    const written = JSON.parse(await readFile(fixturePath, "utf8"));
    const env = written.mcpServers.elephant.env;

    expect(JSON.parse(env.PROPERTY_QUERY_TABLE_MAP)).not.toHaveProperty("stale-county");
    expect(Object.keys(JSON.parse(env.PROPERTY_QUERY_TABLE_MAP))).toHaveLength(14);
    expect(Object.keys(JSON.parse(env.PERMIT_QUERY_TABLE_MAP))).toHaveLength(5);
    expect(Object.keys(JSON.parse(env.DATASET_COVERAGE_MAP))).toHaveLength(13);
    expect(env.PUBLISHED_COUNTY_CATALOG_URL).toBe(PUBLISHED_COUNTY_CATALOG_URL);

    // Preserved untouched.
    expect(env.PERMIT_QUERY_TABLE_CID_FALLBACK_MAP_ADDITIONS).toBe(
      '{"duval":"QmImmutablePermitCid"}',
    );
    expect(env.DATASET_COVERAGE_CID_FALLBACK_MAP_ADDITIONS).toBe(
      '{"duval":"QmImmutableCoverageCid"}',
    );
    expect(env.ORACLE_OPEN_DATA_IPNS_MAP).toBe('{"lee":"abc"}');
    expect(env.ORACLE_OPEN_DATA_DEFAULT_COUNTY).toBe("lee");
    expect(env.ORACLE_GEO_INDEX_IPNS).toBe("geo-ipns-value");
    expect(written.mcpServers.elephant.command).toBe("bash");
    expect(written.mcpServers.elephant.args).toEqual([
      "-c",
      "exec npx -y --package=github:elephant-xyz/elephant-mcp#main mcp",
    ]);
    expect(written.$schema).toBe("https://cursor.com/schemas/mcp.json");

    // Managed keys come first, in the canonical order, ahead of preserved keys.
    expect(Object.keys(env).slice(0, MANAGED_ENV_KEYS.length)).toEqual(MANAGED_ENV_KEYS);
  });

  it("running sync twice in a row on the same file leaves no further diff (idempotent)", async () => {
    const fixturePath = join(tmpDir, "mcp.json");
    const fixture = {
      $schema: "https://cursor.com/schemas/mcp.json",
      mcpServers: {
        elephant: {
          command: "bash",
          args: ["-c", "exec npx -y --package=github:elephant-xyz/elephant-mcp#main mcp"],
          env: {
            ORACLE_OPEN_DATA_IPNS_MAP: '{"lee":"abc"}',
            ORACLE_GEO_INDEX_IPNS: "geo-ipns-value",
          },
        },
      },
    };
    await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");

    await syncMcpJson({ mcpJsonPath: fixturePath, catalogPath, overlayPath });
    const afterFirstRun = await readFile(fixturePath, "utf8");

    await syncMcpJson({ mcpJsonPath: fixturePath, catalogPath, overlayPath });
    const afterSecondRun = await readFile(fixturePath, "utf8");

    expect(afterSecondRun).toBe(afterFirstRun);
  });

  it("throws a clear error when mcpServers.elephant is missing", async () => {
    const fixturePath = join(tmpDir, "mcp.json");
    await writeFile(
      fixturePath,
      `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`,
      "utf8",
    );

    await expect(
      syncMcpJson({ mcpJsonPath: fixturePath, catalogPath, overlayPath }),
    ).rejects.toThrow(/missing mcpServers\.elephant/);
  });

  it("throws a clear error when the mcp.json path does not exist", async () => {
    await expect(
      syncMcpJson({
        mcpJsonPath: join(tmpDir, "does-not-exist.json"),
        catalogPath,
        overlayPath,
      }),
    ).rejects.toThrow(/not found/);
  });
});

describe("merge-mcp-env-maps", () => {
  it("merges catalog and overlay maps with overlay counties appended", () => {
    const merged = mergeMcpEnvMaps(
      {
        PROPERTY_QUERY_TABLE_MAP: { lee: "https://example.com/lee.parquet" },
        PERMIT_QUERY_TABLE_MAP: {},
        DATASET_COVERAGE_MAP: { lee: "https://example.com/lee-coverage.json" },
      },
      {
        PROPERTY_QUERY_TABLE_MAP: {
          "santa-clara": "https://example.com/santa-clara.parquet",
        },
        PERMIT_QUERY_TABLE_MAP: {
          "santa-clara": "https://example.com/santa-clara-permits.parquet",
        },
        DATASET_COVERAGE_MAP: {},
      },
    );

    expect(merged.PROPERTY_QUERY_TABLE_MAP).toEqual({
      lee: "https://example.com/lee.parquet",
      "santa-clara": "https://example.com/santa-clara.parquet",
    });
    expect(merged.PERMIT_QUERY_TABLE_MAP).toEqual({
      "santa-clara": "https://example.com/santa-clara-permits.parquet",
    });
    expect(merged.DATASET_COVERAGE_MAP).toEqual({
      lee: "https://example.com/lee-coverage.json",
    });
  });

  it("rejects a countyKey present in both the catalog and overlay maps for the same field", () => {
    expect(() =>
      mergeMcpEnvMaps(
        { PROPERTY_QUERY_TABLE_MAP: { lee: "https://example.com/lee.parquet" } },
        { PROPERTY_QUERY_TABLE_MAP: { lee: "https://example.com/lee-2.parquet" } },
      ),
    ).toThrow(/countyKey 'lee' appears in both the catalog and the overlay/);
  });

  it("assertOverlayDisjointFromCatalog rejects an overlay county already in the catalog", () => {
    expect(() =>
      assertOverlayDisjointFromCatalog(
        { counties: [{ countyKey: "lee" }] },
        { counties: [{ countyKey: "lee" }] },
      ),
    ).toThrow(/overlay countyKey 'lee' is already in the published catalog/);
  });

  it("assertOverlayDisjointFromCatalog accepts a disjoint overlay", () => {
    expect(() =>
      assertOverlayDisjointFromCatalog(
        { counties: [{ countyKey: "santa-clara" }] },
        { counties: [{ countyKey: "lee" }] },
      ),
    ).not.toThrow();
  });

  it("buildMergedMcpEnvMaps against the tracked catalog + overlay matches the locked key counts", async () => {
    const maps = await buildMergedMcpEnvMaps({ catalogPath, overlayPath });

    expect(Object.keys(maps.PROPERTY_QUERY_TABLE_MAP)).toHaveLength(14);
    expect(Object.keys(maps.PERMIT_QUERY_TABLE_MAP)).toHaveLength(5);
    expect(Object.keys(maps.DATASET_COVERAGE_MAP)).toHaveLength(13);
    expect(Object.keys(maps.PERMIT_QUERY_TABLE_MAP).sort()).toEqual([
      "broward",
      "duval",
      "montgomery",
      "rock-island",
      "santa-clara",
    ]);
    expect(maps.PROPERTY_QUERY_TABLE_MAP.duval).toBeDefined();
    expect(maps.DATASET_COVERAGE_MAP.duval).toBeDefined();
    expect(maps.PERMIT_QUERY_TABLE_MAP.duval).toBeDefined();
  });
});

describe("syncMcpJson against a copy of the real repo-root mcp.json", () => {
  it("produces the locked 14/5/13 key counts and preserves the real launcher untouched", async () => {
    const fixturePath = join(tmpDir, "mcp.json");
    const original = await readFile(repoRootMcpJsonPath, "utf8");
    await writeFile(fixturePath, original, "utf8");
    const originalParsed = JSON.parse(original);

    const { maps } = await syncMcpJson({
      mcpJsonPath: fixturePath,
      catalogPath,
      overlayPath,
    });

    expect(Object.keys(maps.PROPERTY_QUERY_TABLE_MAP)).toHaveLength(14);
    expect(Object.keys(maps.PERMIT_QUERY_TABLE_MAP)).toHaveLength(5);
    expect(Object.keys(maps.DATASET_COVERAGE_MAP)).toHaveLength(13);
    expect(maps.PROPERTY_QUERY_TABLE_MAP["santa-clara"]).toBeDefined();
    expect(maps.PERMIT_QUERY_TABLE_MAP["santa-clara"]).toBeDefined();
    expect(maps.DATASET_COVERAGE_MAP).not.toHaveProperty("santa-clara");
    expect(maps.PROPERTY_QUERY_TABLE_MAP.duval).toBeDefined();
    expect(maps.DATASET_COVERAGE_MAP.duval).toBeDefined();
    expect(maps.PERMIT_QUERY_TABLE_MAP.duval).toBeDefined();

    const written = JSON.parse(await readFile(fixturePath, "utf8"));
    expect(written.mcpServers.elephant.command).toBe(
      originalParsed.mcpServers.elephant.command,
    );
    expect(written.mcpServers.elephant.args).toEqual(
      originalParsed.mcpServers.elephant.args,
    );
    expect(written.mcpServers.elephant.env.ORACLE_OPEN_DATA_IPNS_MAP).toBe(
      originalParsed.mcpServers.elephant.env.ORACLE_OPEN_DATA_IPNS_MAP,
    );
    expect(written.mcpServers.elephant.env.ORACLE_OPEN_DATA_DEFAULT_COUNTY).toBe(
      originalParsed.mcpServers.elephant.env.ORACLE_OPEN_DATA_DEFAULT_COUNTY,
    );
    expect(written.mcpServers.elephant.env.ORACLE_GEO_INDEX_IPNS).toBe(
      originalParsed.mcpServers.elephant.env.ORACLE_GEO_INDEX_IPNS,
    );
    expect(
      written.mcpServers.elephant.env
        .PERMIT_QUERY_TABLE_CID_FALLBACK_MAP_ADDITIONS,
    ).toBe(
      originalParsed.mcpServers.elephant.env
        .PERMIT_QUERY_TABLE_CID_FALLBACK_MAP_ADDITIONS,
    );
    expect(
      written.mcpServers.elephant.env
        .DATASET_COVERAGE_CID_FALLBACK_MAP_ADDITIONS,
    ).toBe(
      originalParsed.mcpServers.elephant.env
        .DATASET_COVERAGE_CID_FALLBACK_MAP_ADDITIONS,
    );
    expect(
      JSON.parse(
        written.mcpServers.elephant.env
          .DATASET_COVERAGE_CID_FALLBACK_MAP_ADDITIONS,
      ).duval,
    ).toBe("QmQRiMu8ecW3Gk2eymebRfWFVBy73i3Fg8R3GAoMveAMHm");
  });
});
