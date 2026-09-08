import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { duvalEnrichmentProfile } from "../src/counties/duval/enrichment-profile.mjs";
import { writeQueryTableParquet } from "../src/core/query-table.mjs";
import { enrichQueryTableWithHoa } from "../src/enrichment/query-table-hoa.mjs";

const require = createRequire(import.meta.url);
const { ParquetReader } = require("@dsnp/parquetjs");
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture({
  linkMethod = "parcel_identifier",
  authoritativeNegativeCoverage = false,
  includeUnsupportedNegative = false,
  corruptDigest = false,
} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "duval-hoa-"));
  temporaryDirectories.push(directory);
  const inputParquet = path.join(directory, "input.parquet");
  const inputCoverage = path.join(directory, "input-coverage.json");
  const recordsPath = path.join(directory, "hoa-memberships.jsonl");
  const sourceManifestPath = path.join(directory, "source-manifest.json");
  const outputDir = path.join(directory, "output");

  await writeQueryTableParquet({
    parquetPath: inputParquet,
    schemaFields: duvalEnrichmentProfile.queryTable.schemaFields,
    rows: [
      {
        property_id: "property-1",
        parcel_identifier: "1646340000",
        subdivision: "EXAMPLE SUBDIVISION",
        hoa_flag: null,
      },
      {
        property_id: "property-2",
        parcel_identifier: "0969250000R",
        subdivision: "ANOTHER SUBDIVISION",
        hoa_flag: null,
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

  const records = [
    {
      parcel_identifier: "164634-0000",
      membership: true,
      association_id: "association-1",
      effective_on: "2026-08-01",
      evidence_reference: "duval-clerk:instrument-123",
    },
    {
      parcel_identifier: "9999999999",
      membership: true,
      association_id: "association-unmatched",
      effective_on: "2026-08-01",
      evidence_reference: "duval-clerk:instrument-456",
    },
  ];
  if (includeUnsupportedNegative) {
    records.push({
      parcel_identifier: "0969250000",
      membership: false,
      association_id: "association-2",
      effective_on: "2026-08-01",
      evidence_reference: "custodian-export:negative-2",
    });
  }
  const body = records
    .map((row) => JSON.stringify(row))
    .join("\n")
    .concat("\n");
  await writeFile(recordsPath, body);
  await writeFile(
    sourceManifestPath,
    `${JSON.stringify({
      schemaVersion: "elephant.hoa-membership-source-manifest.v1",
      county: "duval",
      authority: "Duval official records custodian",
      extractId: "duval-hoa-2026-08",
      sourceRetrievedAt: "2026-09-08T16:00:00.000Z",
      recordsRequestReference: "public-records-request:test",
      scopeDescription: "Effective parcel-level HOA membership records",
      authoritative: true,
      publicationPermitted: true,
      linkMethod,
      authoritativeNegativeCoverage,
      recordCount: records.length,
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

describe("authoritative HOA membership enrichment", () => {
  it("sets only parcel-linked authoritative positives and leaves unknowns null", async () => {
    const input = await fixture();
    const result = await enrichQueryTableWithHoa({
      countyKey: "duval",
      schemaFields: duvalEnrichmentProfile.queryTable.schemaFields,
      inputParquet: input.inputParquet,
      inputCoverage: input.inputCoverage,
      recordsPath: input.recordsPath,
      sourceManifestPath: input.sourceManifestPath,
      outputParquet: path.join(input.outputDir, "query-table.parquet"),
      outputCoverage: path.join(input.outputDir, "dataset-coverage.json"),
      manifestPath: path.join(input.outputDir, "hoa-enrichment-manifest.json"),
      exportedAt: "2026-09-08T17:00:00.000Z",
    });

    expect(result).toMatchObject({
      inputRowCount: 2,
      outputRowCount: 2,
      sourceRecordCount: 2,
      linkedPropertyCount: 1,
      positiveMembershipCount: 1,
      authoritativeNegativeCount: 0,
      validUnlinkedFolioCount: 1,
      unknownPropertyCount: 1,
    });

    const reader = await ParquetReader.openFile(
      path.join(input.outputDir, "query-table.parquet"),
    );
    try {
      const cursor = reader.getCursor([
        "property_id",
        "subdivision",
        "hoa_flag",
      ]);
      expect(await cursor.next()).toMatchObject({
        property_id: "property-1",
        subdivision: "EXAMPLE SUBDIVISION",
        hoa_flag: true,
      });
      expect(await cursor.next()).toMatchObject({
        property_id: "property-2",
        subdivision: "ANOTHER SUBDIVISION",
        hoa_flag: null,
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
    expect(coverage.datasets.find((row) => row.source === "hoa")).toMatchObject(
      {
        ingested_count: 2,
        linked_property_count: 1,
        positive_membership_count: 1,
        authoritative_negative_count: 0,
        unknown_property_count: 1,
        match_method: "exact_normalized_parcel_identifier",
      },
    );
  });

  it("rejects subdivision-name matching", async () => {
    const input = await fixture({ linkMethod: "subdivision_name" });
    await expect(
      enrichQueryTableWithHoa({
        countyKey: "duval",
        schemaFields: duvalEnrichmentProfile.queryTable.schemaFields,
        inputParquet: input.inputParquet,
        inputCoverage: input.inputCoverage,
        recordsPath: input.recordsPath,
        sourceManifestPath: input.sourceManifestPath,
        outputParquet: path.join(input.outputDir, "query-table.parquet"),
        outputCoverage: path.join(input.outputDir, "dataset-coverage.json"),
      }),
    ).rejects.toThrow(/parcel_identifier/i);
  });

  it("rejects false membership without authoritative negative coverage", async () => {
    const input = await fixture({ includeUnsupportedNegative: true });
    await expect(
      enrichQueryTableWithHoa({
        countyKey: "duval",
        schemaFields: duvalEnrichmentProfile.queryTable.schemaFields,
        inputParquet: input.inputParquet,
        inputCoverage: input.inputCoverage,
        recordsPath: input.recordsPath,
        sourceManifestPath: input.sourceManifestPath,
        outputParquet: path.join(input.outputDir, "query-table.parquet"),
        outputCoverage: path.join(input.outputDir, "dataset-coverage.json"),
      }),
    ).rejects.toThrow(/negative coverage/i);
  });

  it("rejects claimed negative coverage without the complete property denominator", async () => {
    const input = await fixture({ authoritativeNegativeCoverage: true });
    await expect(
      enrichQueryTableWithHoa({
        countyKey: "duval",
        schemaFields: duvalEnrichmentProfile.queryTable.schemaFields,
        inputParquet: input.inputParquet,
        inputCoverage: input.inputCoverage,
        recordsPath: input.recordsPath,
        sourceManifestPath: input.sourceManifestPath,
        outputParquet: path.join(input.outputDir, "query-table.parquet"),
        outputCoverage: path.join(input.outputDir, "dataset-coverage.json"),
      }),
    ).rejects.toThrow(/every property/i);
  });

  it("rejects source bytes that do not match the records request manifest", async () => {
    const input = await fixture({ corruptDigest: true });
    await expect(
      enrichQueryTableWithHoa({
        countyKey: "duval",
        schemaFields: duvalEnrichmentProfile.queryTable.schemaFields,
        inputParquet: input.inputParquet,
        inputCoverage: input.inputCoverage,
        recordsPath: input.recordsPath,
        sourceManifestPath: input.sourceManifestPath,
        outputParquet: path.join(input.outputDir, "query-table.parquet"),
        outputCoverage: path.join(input.outputDir, "dataset-coverage.json"),
      }),
    ).rejects.toThrow(/digest/i);
  });
});
