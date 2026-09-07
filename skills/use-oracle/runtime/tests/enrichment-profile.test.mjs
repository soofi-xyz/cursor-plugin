import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createEnrichmentProfileRegistry,
  validateEnrichmentProfile,
} from "../src/counties/enrichment-profile.mjs";
import {
  enrichmentProfileRegistry,
  requireEnrichmentProfile,
} from "../src/counties/enrichment-profiles.mjs";
import { duvalEnrichmentProfile } from "../src/counties/duval/enrichment-profile.mjs";
import { buildBbbRequestContract } from "../src/enrichment/bbb.mjs";
import { filterSunbizDirectory } from "../src/enrichment/sunbiz.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function syntheticProfile() {
  return {
    countyKey: "test-county",
    countyName: "Test County",
    stateCode: "FL",
    sunbiz: { zipPrefixes: ["330"] },
    bbb: {
      categories: [
        {
          key: "general-contractors",
          url: "https://www.bbb.org/us/fl/testville/category/general-contractors",
          reviewedPath: "/us/fl/testville/category/general-contractors",
        },
      ],
    },
    queryTable: {
      schemaFields: {
        property_id: { type: "UTF8" },
        address_street: { type: "UTF8", optional: true },
        address_zip: { type: "UTF8", optional: true },
        has_permits: { type: "BOOLEAN", optional: true },
        has_sunbiz_tenant: { type: "BOOLEAN", optional: true },
        has_bbb_contractor: { type: "BOOLEAN", optional: true },
      },
    },
    publication: {
      bucket: "test-query-table",
      queryTableIpnsLabel: "test-query-table-name",
      coverageIpnsLabel: "test-coverage-name",
    },
  };
}

function fixedWidthRecord(documentNumber, zip) {
  const chars = Array(1_450).fill(" ");
  const write = (start, length, value) => {
    chars.splice(
      start - 1,
      length,
      ...String(value).slice(0, length).padEnd(length, " "),
    );
  };
  write(1, 12, documentNumber);
  write(13, 192, "SYNTHETIC COMPANY LLC");
  write(205, 1, "A");
  write(221, 42, "1 TEST STREET");
  write(305, 28, "TESTVILLE");
  write(333, 2, "FL");
  write(335, 10, zip);
  return chars.join("");
}

describe("county enrichment profiles", () => {
  it("keeps the production registry limited to reviewed counties", () => {
    expect(enrichmentProfileRegistry.countyKeys).toEqual(["duval"]);
    expect(requireEnrichmentProfile("duval")).toEqual(duvalEnrichmentProfile);
    expect(() => requireEnrichmentProfile("test-county")).toThrow(
      /Unknown enrichment --county/,
    );
  });

  it("owns Duval geography, discovery, schema, and publication configuration", () => {
    expect(duvalEnrichmentProfile).toMatchObject({
      countyKey: "duval",
      countyName: "Duval",
      stateCode: "FL",
      sunbiz: { zipPrefixes: ["322", "32099"] },
      publication: {
        bucket: "elephant-oracle-query-table",
        queryTableIpnsLabel: "oracle-query-table-duval",
        coverageIpnsLabel: "oracle-dataset-coverage-duval",
      },
    });
    expect(
      duvalEnrichmentProfile.bbb.categories.map(({ key, url }) => ({ key, url })),
    ).toEqual([
      {
        key: "roofing-contractors",
        url: "https://www.bbb.org/us/fl/jacksonville/category/roofing-contractors",
      },
      {
        key: "solar-energy-system-contractors",
        url: "https://www.bbb.org/us/fl/jacksonville/category/solar-energy-system-contractors",
      },
      {
        key: "heating-and-air-conditioning",
        url: "https://www.bbb.org/us/fl/jacksonville/category/heating-and-air-conditioning",
      },
    ]);
    expect(duvalEnrichmentProfile.queryTable.schemaFields).toHaveProperty(
      "has_pa_corp_tenant",
    );
  });

  it("rejects malformed geography, category evidence paths, and query schemas", () => {
    const invalidZip = syntheticProfile();
    invalidZip.sunbiz.zipPrefixes = ["33x"];
    expect(() => validateEnrichmentProfile(invalidZip)).toThrow();

    const mismatchedPath = syntheticProfile();
    mismatchedPath.bbb.categories[0].reviewedPath =
      "/us/fl/elsewhere/category/general-contractors";
    expect(() => validateEnrichmentProfile(mismatchedPath)).toThrow(
      /exact reviewed/,
    );

    const missingFlag = syntheticProfile();
    delete missingFlag.queryTable.schemaFields.has_sunbiz_tenant;
    expect(() => validateEnrichmentProfile(missingFlag)).toThrow(
      /has_sunbiz_tenant/,
    );
  });

  it("injects a synthetic county into an isolated registry and generic engines", async () => {
    const profile = validateEnrichmentProfile(syntheticProfile());
    const registry = createEnrichmentProfileRegistry([
      duvalEnrichmentProfile,
      profile,
    ]);
    expect(registry.countyKeys).toEqual(["duval", "test-county"]);
    expect(registry.require("test-county")).toEqual(profile);

    const category = profile.bbb.categories[0];
    const request = buildBbbRequestContract({
      countyKey: profile.countyKey,
      reviewedCategory: category,
      categoryKey: category.key,
      categoryUrl: category.url,
      jobId: "test-county-bbb",
      maxPages: 1,
      maxProfiles: 1,
      maxRequests: 2,
      maxDurationMs: 1_000,
      partRecordLimit: 1,
      pageDelayMs: 0,
      profileDelayMs: 0,
      navigationTimeoutMs: 1_000,
      challengeAttempts: 1,
      challengeCheckIntervalMs: 0,
      challengeChecksPerAttempt: 1,
      includeHtml: false,
      profileSubpages: [],
    });
    expect(request).toMatchObject({
      county: "test-county",
      categoryKey: "general-contractors",
      categoryUrl: category.url,
    });

    const root = await mkdtemp(path.join(tmpdir(), "enrichment-profile-"));
    temporaryDirectories.push(root);
    const sourceDir = path.join(root, "source");
    const outputDir = path.join(root, "output");
    await mkdir(sourceDir);
    await writeFile(
      path.join(sourceDir, "cordata0.txt"),
      fixedWidthRecord("L00000000999", "33010"),
    );
    const manifest = await filterSunbizDirectory({
      countyKey: profile.countyKey,
      sourceDir,
      outputDir,
      zipPrefixes: profile.sunbiz.zipPrefixes,
      chunkRecordLimit: 1,
      jobId: "test-county-sunbiz",
      quarter: "2026Q3",
    });
    expect(manifest).toMatchObject({
      county: "test-county",
      zipPrefixes: ["330"],
      matchedRecordCount: 1,
    });
    expect(
      JSON.parse(await readFile(path.join(outputDir, "manifest.json"), "utf8")),
    ).toEqual(manifest);
  });
});
