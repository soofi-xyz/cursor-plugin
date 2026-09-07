import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_CATALOG_PATH,
  normalizeCountyKey,
  upsertCounty,
  validateCatalog,
  verifyPublishedCountyArtifacts,
} from "../../scripts/catalog/update-published-county-catalog.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const trackedCatalogPath = resolve(testDir, "../../catalog/published-counties.json");

const baseCatalog = {
  schemaVersion: "1.0",
  generatedAt: "2026-07-24T00:00:00.000Z",
  counties: [
    {
      countyKey: "lee",
      countyName: "Lee",
      stateCode: "FL",
      countyFips: "12071",
      status: "published",
      queryTableUrl: "https://example.com/lee.parquet",
      datasetCoverageUrl: "https://example.com/lee-coverage.json",
      permitQueryTableUrl: null,
      updatedAt: "2026-07-23T00:00:00.000Z",
    },
  ],
};

describe("published county catalog", () => {
  it("resolves the default catalog path to the bundled runtime catalog, not a sibling checkout", () => {
    expect(DEFAULT_CATALOG_PATH).toBe(trackedCatalogPath);
    expect(DEFAULT_CATALOG_PATH).not.toContain("oracle-node");
  });

  it("validates the tracked bundled catalog and contains exactly the thirteen locked counties", async () => {
    const tracked = JSON.parse(await readFile(trackedCatalogPath, "utf8"));

    const result = validateCatalog(tracked);

    expect(result.counties).toHaveLength(13);
    expect(result.counties.map((county) => county.countyKey)).toEqual([
      "broward",
      "chester",
      "duval",
      "hillsborough",
      "lee",
      "miami-dade",
      "montgomery",
      "orange",
      "palm-beach",
      "pinellas",
      "polk",
      "rock-island",
      "seminole",
    ]);
  });

  it("carries the locked Duval entry exactly", async () => {
    const tracked = JSON.parse(await readFile(trackedCatalogPath, "utf8"));
    const duval = validateCatalog(tracked).counties.find(
      (county) => county.countyKey === "duval",
    );

    expect(duval).toEqual({
      countyKey: "duval",
      countyName: "Duval",
      stateCode: "FL",
      countyFips: "12031",
      status: "published",
      queryTableUrl:
        "https://k51qzi5uqu5dle7swd06u9ebrgw375b5vhhhtiiz7un7udfsar0rci53x2w5y4.ipns.dweb.link/",
      datasetCoverageUrl:
        "https://k51qzi5uqu5dgqc52fnea1o42e27dr4os0mrdf5ixonuv8kdztdnxclflazf4w.ipns.dweb.link/",
      permitQueryTableUrl:
        "https://ipfs.filebase.io/ipns/k51qzi5uqu5dll7nwe1o7s1htngeoxrou8k593xieuziw9521444vh3pd7v4y1",
      placesTableUrl: null,
      updatedAt: "2026-09-06T11:46:55.444Z",
    });
  });

  it("carries the locked Seminole entry exactly", async () => {
    const tracked = JSON.parse(await readFile(trackedCatalogPath, "utf8"));
    const seminole = validateCatalog(tracked).counties.find(
      (county) => county.countyKey === "seminole",
    );

    expect(seminole).toBeDefined();
    expect(seminole).toMatchObject({
      countyKey: "seminole",
      countyName: "Seminole",
      stateCode: "FL",
      countyFips: "12117",
      status: "published",
      permitQueryTableUrl: null,
      placesTableUrl: null,
      updatedAt: "2026-09-01T14:16:20.247Z",
    });
    expect(seminole.queryTableUrl).toContain(
      "k51qzi5uqu5di6kqptmkfaoq7yxc7z04spm1n0gbrc26toi2eah1b66cfrqfwp",
    );
    expect(seminole.datasetCoverageUrl).toContain(
      "k51qzi5uqu5dmawnn59hx0z87i36xk60os0vur3m05p8u2ial89cn2oay7o9oz",
    );
  });

  it("normalizes county keys", () => {
    expect(normalizeCountyKey("  Miami Dade  ")).toBe("miami-dade");
    expect(normalizeCountyKey("Palm_Beach")).toBe("palm-beach");
  });

  it("upserts a county and keeps entries sorted", () => {
    const updated = upsertCounty(
      validateCatalog(baseCatalog),
      {
        countyKey: "alameda",
        countyName: "Alameda",
        stateCode: "CA",
        countyFips: "06001",
        status: "published",
        queryTableUrl: "https://example.com/alameda.parquet",
        datasetCoverageUrl: "https://example.com/alameda-coverage.json",
        permitQueryTableUrl: null,
        updatedAt: "2026-07-24T10:00:00.000Z",
      },
      "2026-07-24T10:01:00.000Z",
    );

    expect(updated.generatedAt).toBe("2026-07-24T10:01:00.000Z");
    expect(updated.counties.map((county) => county.countyKey)).toEqual([
      "alameda",
      "lee",
    ]);
  });

  it("rejects a FIPS code already assigned to another county", () => {
    expect(() =>
      upsertCounty(
        validateCatalog(baseCatalog),
        {
          ...baseCatalog.counties[0],
          countyKey: "orange",
        },
        "2026-07-24T10:01:00.000Z",
      ),
    ).toThrow("countyFips '12071' is already assigned to 'lee'");
  });

  it("rejects changing the FIPS identity of an existing county", () => {
    expect(() =>
      upsertCounty(
        validateCatalog(baseCatalog),
        {
          ...baseCatalog.counties[0],
          countyFips: "12095",
        },
        "2026-07-24T10:01:00.000Z",
      ),
    ).toThrow("countyKey 'lee' is already assigned to FIPS '12071'");
  });

  it("rejects duplicate county keys", () => {
    expect(() =>
      validateCatalog({
        ...baseCatalog,
        counties: [...baseCatalog.counties, baseCatalog.counties[0]],
      }),
    ).toThrow("duplicate countyKey 'lee'");
  });

  it("rejects published counties without coverage", () => {
    expect(() =>
      validateCatalog({
        ...baseCatalog,
        counties: [
          {
            ...baseCatalog.counties[0],
            datasetCoverageUrl: null,
          },
        ],
      }),
    ).toThrow("datasetCoverageUrl must be an HTTP(S) URL");
  });

  it("rejects duplicate county FIPS identities", () => {
    expect(() =>
      validateCatalog({
        ...baseCatalog,
        counties: [
          ...baseCatalog.counties,
          {
            ...baseCatalog.counties[0],
            countyKey: "different-key",
          },
        ],
      }),
    ).toThrow("duplicate countyFips '12071'");
  });

  it("reads back artifacts and verifies the coverage county", async () => {
    const requests = [];
    const fetchImpl = async (url, init) => {
      requests.push({ url: String(url), method: init?.method ?? "GET" });
      if (init?.method === "HEAD") {
        return new Response(null, { status: 200 });
      }
      return new Response(JSON.stringify({ county: "Lee", datasets: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await verifyPublishedCountyArtifacts(
      validateCatalog(baseCatalog).counties[0],
      fetchImpl,
    );

    expect(requests).toEqual([
      { url: "https://example.com/lee.parquet", method: "HEAD" },
      { url: "https://example.com/lee-coverage.json", method: "GET" },
    ]);
  });

  it("verifies an optional permit query table", async () => {
    const requests = [];
    const fetchImpl = async (url, init) => {
      requests.push({ url: String(url), method: init?.method ?? "GET" });
      if (init?.method === "HEAD") {
        return new Response(null, { status: 200 });
      }
      return new Response(JSON.stringify({ county: "Lee" }), { status: 200 });
    };
    const county = {
      ...validateCatalog(baseCatalog).counties[0],
      permitQueryTableUrl: "https://example.com/lee-permits.parquet",
    };

    await verifyPublishedCountyArtifacts(county, fetchImpl);

    expect(requests.at(-1)).toEqual({
      url: "https://example.com/lee-permits.parquet",
      method: "HEAD",
    });
  });

  it("rejects coverage for a different county", async () => {
    const fetchImpl = async (_url, init) =>
      init?.method === "HEAD"
        ? new Response(null, { status: 200 })
        : new Response(JSON.stringify({ county: "Orange" }), { status: 200 });

    await expect(
      verifyPublishedCountyArtifacts(
        validateCatalog(baseCatalog).counties[0],
        fetchImpl,
      ),
    ).rejects.toThrow("does not match 'lee'");
  });

  it("rejects non-public query table URLs", () => {
    expect(() =>
      validateCatalog({
        ...baseCatalog,
        counties: [
          {
            ...baseCatalog.counties[0],
            queryTableUrl: "file:///tmp/lee.parquet",
          },
        ],
      }),
    ).toThrow("must use http or https");
  });
});
