import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { duvalEnrichmentProfile } from "../src/counties/duval/enrichment-profile.mjs";
import { writeQueryTableParquet } from "../src/core/query-table.mjs";
import { enrichQueryTableWithAvm } from "../src/enrichment/query-table-avm.mjs";

const require = createRequire(import.meta.url);
const { ParquetReader } = require("@dsnp/parquetjs");
const temporaryDirectories = [];
const approvedSourceProfiles = new Map([
  [
    "test-provider-v1",
    {
      county: "duval",
      countyFips: "12031",
      provider: "licensed-test-provider",
      licenseReviewReference: "contract-review:test",
      publicationPermitted: true,
    },
  ],
]);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture({
  publicationPermitted = true,
  corruptDigest = false,
  firstRecordOverrides = {},
  secondRecordOverrides = {},
} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "duval-avm-"));
  temporaryDirectories.push(directory);
  const inputParquet = path.join(directory, "input.parquet");
  const inputCoverage = path.join(directory, "input-coverage.json");
  const recordsPath = path.join(directory, "avm-records.jsonl");
  const sourceManifestPath = path.join(directory, "source-manifest.json");
  const outputDir = path.join(directory, "output");

  await writeQueryTableParquet({
    parquetPath: inputParquet,
    schemaFields: duvalEnrichmentProfile.queryTable.schemaFields,
    rows: [
      {
        property_id: "property-1",
        parcel_identifier: "1646340000",
        market_value: 210_000,
        avm_value: null,
      },
      {
        property_id: "property-2",
        parcel_identifier: "0969250000R",
        market_value: 195_000,
        avm_value: null,
      },
    ],
  });
  await writeFile(
    inputCoverage,
    `${JSON.stringify({
      county: "duval",
      datasets: [
        {
          county: "duval",
          source: "appraisal",
          ingested_count: 2,
          expected_count: 2,
        },
      ],
    })}\n`,
  );

  const body = [
    {
      parcel_identifier: "164634-0000",
      vendor_apn: "164634-0000",
      county_fips: "12031",
      current_avm_value: 225_000,
      valuation_date: "2026-07-01",
      valuation_method_type: "licensed-vendor-avm",
      confidence_score: 82,
      valuation_high: 240_000,
      valuation_low: 210_000,
      vendor_property_id: "vendor-1",
      ...firstRecordOverrides,
    },
    {
      parcel_identifier: "1646340000",
      vendor_apn: "1646340000",
      county_fips: "12031",
      current_avm_value: 231_000,
      valuation_date: "2026-08-15",
      valuation_method_type: "licensed-vendor-avm",
      confidence_score: 85,
      valuation_high: 245_000,
      valuation_low: 218_000,
      vendor_property_id: "vendor-1",
      ...secondRecordOverrides,
    },
    {
      parcel_identifier: "9999999999",
      vendor_apn: "9999999999",
      county_fips: "12031",
      current_avm_value: 180_000,
      valuation_date: "2026-08-15",
      valuation_method_type: "licensed-vendor-avm",
      confidence_score: 78,
      valuation_high: 195_000,
      valuation_low: 168_000,
      vendor_property_id: "vendor-unmatched",
    },
  ]
    .map((row) => JSON.stringify(row))
    .join("\n")
    .concat("\n");
  await writeFile(recordsPath, body);
  await writeFile(
    sourceManifestPath,
    `${JSON.stringify({
      schemaVersion: "elephant.avm-source-manifest.v1",
      county: "duval",
      countyFips: "12031",
      sourceProfileId: "test-provider-v1",
      provider: "licensed-test-provider",
      extractId: "duval-2026-08-15",
      sourceRetrievedAt: "2026-09-08T16:00:00.000Z",
      licenseReviewReference: "contract-review:test",
      publicationPermitted,
      recordCount: 3,
      recordsSha256: corruptDigest
        ? "0".repeat(64)
        : createHash("sha256").update(body).digest("hex"),
    })}\n`,
  );

  return {
    inputParquet,
    inputCoverage,
    recordsPath,
    sourceManifestPath,
    outputDir,
  };
}

describe("licensed AVM enrichment", () => {
  it("selects the latest approved vendor value by Duval folio", async () => {
    const input = await fixture();
    const result = await enrichQueryTableWithAvm({
      countyKey: "duval",
      schemaFields: duvalEnrichmentProfile.queryTable.schemaFields,
      inputParquet: input.inputParquet,
      inputCoverage: input.inputCoverage,
      recordsPath: input.recordsPath,
      sourceManifestPath: input.sourceManifestPath,
      approvedSourceProfiles,
      outputParquet: path.join(input.outputDir, "query-table.parquet"),
      outputCoverage: path.join(input.outputDir, "dataset-coverage.json"),
      manifestPath: path.join(input.outputDir, "avm-enrichment-manifest.json"),
      exportedAt: "2026-09-08T17:00:00.000Z",
    });

    expect(result).toMatchObject({
      inputRowCount: 2,
      outputRowCount: 2,
      sourceRecordCount: 3,
      sourceFolioCount: 2,
      linkedPropertyCount: 1,
      validUnlinkedFolioCount: 1,
      provider: "licensed-test-provider",
    });

    const reader = await ParquetReader.openFile(
      path.join(input.outputDir, "query-table.parquet"),
    );
    try {
      const cursor = reader.getCursor([
        "property_id",
        "market_value",
        "avm_value",
      ]);
      expect(await cursor.next()).toMatchObject({
        property_id: "property-1",
        market_value: 210_000,
        avm_value: 231_000,
      });
      expect(await cursor.next()).toMatchObject({
        property_id: "property-2",
        market_value: 195_000,
        avm_value: null,
      });
    } finally {
      await reader.close();
    }

    const coverage = JSON.parse(
      await readFile(
        path.join(input.outputDir, "dataset-coverage.json"),
        "utf8",
      ),
    );
    expect(coverage.datasets.find((row) => row.source === "avm")).toMatchObject(
      {
        ingested_count: 3,
        linked_property_count: 1,
        valid_unlinked_count: 1,
        provider: "licensed-test-provider",
        publication_permitted: true,
      },
    );
  });

  it("rejects a feed without explicit publication rights", async () => {
    const input = await fixture({ publicationPermitted: false });
    await expect(
      enrichQueryTableWithAvm({
        countyKey: "duval",
        schemaFields: duvalEnrichmentProfile.queryTable.schemaFields,
        inputParquet: input.inputParquet,
        inputCoverage: input.inputCoverage,
        recordsPath: input.recordsPath,
        sourceManifestPath: input.sourceManifestPath,
        approvedSourceProfiles,
        outputParquet: path.join(input.outputDir, "query-table.parquet"),
        outputCoverage: path.join(input.outputDir, "dataset-coverage.json"),
      }),
    ).rejects.toThrow(/publication rights/i);
  });

  it("rejects source bytes that do not match the reviewed manifest", async () => {
    const input = await fixture({ corruptDigest: true });
    await expect(
      enrichQueryTableWithAvm({
        countyKey: "duval",
        schemaFields: duvalEnrichmentProfile.queryTable.schemaFields,
        inputParquet: input.inputParquet,
        inputCoverage: input.inputCoverage,
        recordsPath: input.recordsPath,
        sourceManifestPath: input.sourceManifestPath,
        approvedSourceProfiles,
        outputParquet: path.join(input.outputDir, "query-table.parquet"),
        outputCoverage: path.join(input.outputDir, "dataset-coverage.json"),
      }),
    ).rejects.toThrow(/digest/i);
  });

  it("rejects a source profile that has not been reviewed in code", async () => {
    const input = await fixture();
    await expect(
      enrichQueryTableWithAvm({
        countyKey: "duval",
        schemaFields: duvalEnrichmentProfile.queryTable.schemaFields,
        inputParquet: input.inputParquet,
        inputCoverage: input.inputCoverage,
        recordsPath: input.recordsPath,
        sourceManifestPath: input.sourceManifestPath,
        outputParquet: path.join(input.outputDir, "query-table.parquet"),
        outputCoverage: path.join(input.outputDir, "dataset-coverage.json"),
      }),
    ).rejects.toThrow(/not approved/i);
  });

  it("rejects a vendor APN or FIPS that does not exactly match Duval", async () => {
    const input = await fixture({
      firstRecordOverrides: { county_fips: "12086" },
    });
    await expect(
      enrichQueryTableWithAvm({
        countyKey: "duval",
        schemaFields: duvalEnrichmentProfile.queryTable.schemaFields,
        inputParquet: input.inputParquet,
        inputCoverage: input.inputCoverage,
        recordsPath: input.recordsPath,
        sourceManifestPath: input.sourceManifestPath,
        approvedSourceProfiles,
        outputParquet: path.join(input.outputDir, "query-table.parquet"),
        outputCoverage: path.join(input.outputDir, "dataset-coverage.json"),
      }),
    ).rejects.toThrow(/county_fips/i);
  });

  it("requires confidence and valuation bounds for every AVM", async () => {
    const input = await fixture({
      firstRecordOverrides: { confidence_score: null },
    });
    await expect(
      enrichQueryTableWithAvm({
        countyKey: "duval",
        schemaFields: duvalEnrichmentProfile.queryTable.schemaFields,
        inputParquet: input.inputParquet,
        inputCoverage: input.inputCoverage,
        recordsPath: input.recordsPath,
        sourceManifestPath: input.sourceManifestPath,
        approvedSourceProfiles,
        outputParquet: path.join(input.outputDir, "query-table.parquet"),
        outputCoverage: path.join(input.outputDir, "dataset-coverage.json"),
      }),
    ).rejects.toThrow(/confidence_score/i);
  });

  it("rejects APN disagreement and tax-roll valuation substitution", async () => {
    for (const [overrides, expectedError] of [
      [{ vendor_apn: "0969250000" }, /vendor_apn/i],
      [{ valuation_method_type: "appraisal_market_value" }, /non-AVM/i],
    ]) {
      const input = await fixture({ firstRecordOverrides: overrides });
      await expect(
        enrichQueryTableWithAvm({
          countyKey: "duval",
          schemaFields: duvalEnrichmentProfile.queryTable.schemaFields,
          inputParquet: input.inputParquet,
          inputCoverage: input.inputCoverage,
          recordsPath: input.recordsPath,
          sourceManifestPath: input.sourceManifestPath,
          approvedSourceProfiles,
          outputParquet: path.join(input.outputDir, "query-table.parquet"),
          outputCoverage: path.join(input.outputDir, "dataset-coverage.json"),
        }),
      ).rejects.toThrow(expectedError);
    }
  });

  it("rejects ambiguous valuations tied on date", async () => {
    const input = await fixture({
      secondRecordOverrides: { valuation_date: "2026-07-01" },
    });
    await expect(
      enrichQueryTableWithAvm({
        countyKey: "duval",
        schemaFields: duvalEnrichmentProfile.queryTable.schemaFields,
        inputParquet: input.inputParquet,
        inputCoverage: input.inputCoverage,
        recordsPath: input.recordsPath,
        sourceManifestPath: input.sourceManifestPath,
        approvedSourceProfiles,
        outputParquet: path.join(input.outputDir, "query-table.parquet"),
        outputCoverage: path.join(input.outputDir, "dataset-coverage.json"),
      }),
    ).rejects.toThrow(/ambiguous tied/i);
  });
});
