import { createRequire } from "node:module";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { duvalPermitProfile } from "../src/counties/duval/permit-profile.mjs";
import { duvalEnrichmentProfile } from "../src/counties/duval/enrichment-profile.mjs";
import { writeQueryTableParquet } from "../src/core/query-table.mjs";
import { normalizeJaxEpicsPermit } from "../src/permits/adapters/jaxepics.mjs";
import { exportPermitArtifacts } from "../src/permits/artifacts.mjs";
import { exportJaxPermitBulkArtifacts } from "../src/permits/bulk-export.mjs";
import { harvestPermitProperties } from "../src/permits/harvest.mjs";
import { atomicWriteJson } from "../src/permits/storage.mjs";

const require = createRequire(import.meta.url);
const { ParquetReader } = require("@dsnp/parquetjs");
const temporaryDirectories = [];
const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/permits/duval",
);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
  );
});

describe("resumable permit harvesting", () => {
  it("fails closed for documented source gaps and resumes terminal parcels", async () => {
    const outputDir = await mkdtemp(
      path.join(tmpdir(), "permit-harvest-"),
    );
    temporaryDirectories.push(outputDir);
    const properties = [
      {
        property_id: "a".repeat(32),
        parcel_identifier: "177552-0000",
        address_city: "Jacksonville Beach",
      },
      {
        property_id: "b".repeat(32),
        parcel_identifier: "171190-0000",
        address_city: "Atlantic Beach",
      },
    ];
    const first = await harvestPermitProperties({
      properties,
      profile: duvalPermitProfile,
      outputDir,
      jobId: "bounded-test",
      clock: () => Date.parse("2026-09-06T05:00:00.000Z"),
    });
    expect(first.summary).toMatchObject({
      propertyCount: 2,
      blockedCount: 2,
      permitCount: 0,
    });
    const resumed = await harvestPermitProperties({
      properties,
      profile: duvalPermitProfile,
      outputDir,
      jobId: "bounded-test",
      resume: true,
      clock: () => Date.parse("2026-09-06T05:01:00.000Z"),
    });
    expect(resumed.summary.resumedCount).toBe(2);
  });
});

describe("permit public artifact export", () => {
  it("rewrites property flags and limits the public permit table to 20 columns", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "permit-export-"));
    temporaryDirectories.push(root);
    const harvestDir = path.join(root, "harvest");
    const outputDir = path.join(root, "public");
    const propertyId = "c".repeat(32);
    const inputPropertyParquet = path.join(root, "query-table.parquet");
    const inputCoveragePath = path.join(root, "dataset-coverage.json");
    await writeQueryTableParquet({
      parquetPath: inputPropertyParquet,
      schemaFields: duvalEnrichmentProfile.queryTable.schemaFields,
      rows: [
        {
          property_id: propertyId,
          parcel_identifier: "044280-0505",
          address_city: "Jacksonville",
          has_permits: false,
          permit_count: 0,
        },
      ],
    });
    await writeFile(
      inputCoveragePath,
      `${JSON.stringify({
        county: "duval",
        exportedAt: "2026-09-05T00:00:00.000Z",
        datasets: [
          {
            county: "duval",
            source: "appraisal",
            ingested_count: 1,
            expected_count: 1,
          },
        ],
      })}\n`,
    );
    const payload = JSON.parse(
      await readFile(
        path.join(fixtureRoot, "jaxepics/permit-detail.json"),
        "utf8",
      ),
    );
    const record = normalizeJaxEpicsPermit(payload, {
      requestedParcelIdentifier: "044280-0505",
      requestedPropertyId: propertyId,
    });
    await atomicWriteJson(
      path.join(harvestDir, "extracted/jacksonville/record.json"),
      { records: [record] },
    );
    await atomicWriteJson(
      path.join(harvestDir, "status/jacksonville/record.json"),
      {
        countyKey: "duval",
        jobId: "permit-export-test",
        parcelIdentifier: "044280-0505",
        propertyId,
        jurisdictionKey: "jacksonville",
        status: "done",
        permitCount: 1,
        failureCount: 0,
        attempts: 1,
        completedAt: "2026-09-06T05:00:00.000Z",
      },
    );

    const exported = await exportPermitArtifacts({
      harvestDir,
      inputPropertyParquet,
      inputCoveragePath,
      outputDir,
      profile: duvalPermitProfile,
      propertySchemaFields:
        duvalEnrichmentProfile.queryTable.schemaFields,
      jobId: "permit-export-test",
      exportedAt: "2026-09-06T05:00:00.000Z",
    });
    expect(exported.permitCoverage).toMatchObject({
      linkedPermits: 1,
      validUnlinkedPermits: 0,
      availability: "supported_partial",
    });
    expect(
      exported.datasetCoverage.datasets.find(
        (dataset) => dataset.source === "permits",
      ),
    ).toMatchObject({
      ingested_count: 1,
      linked_property_count: 1,
    });

    const propertyReader = await ParquetReader.openFile(
      exported.paths.propertyPath,
    );
    const propertyRow = await propertyReader.getCursor().next();
    await propertyReader.close();
    expect(propertyRow).toMatchObject({
      has_permits: true,
      permit_count: 1n,
    });

    const permitReader = await ParquetReader.openFile(
      exported.paths.permitPath,
    );
    const permitRow = await permitReader.getCursor().next();
    await permitReader.close();
    expect(Object.keys(permitRow)).toHaveLength(20);
    expect(permitRow).not.toHaveProperty("contractors");
    expect(exported.approval.status).toBe(
      "pending_human_approval",
    );
  });

  it("streams a bulk snapshot and excludes independent municipalities", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "permit-bulk-"));
    temporaryDirectories.push(root);
    const inputPropertyParquet = path.join(root, "input.parquet");
    const inputCoveragePath = path.join(root, "coverage.json");
    const outputDir = path.join(root, "output");
    const jacksonvilleId = "d".repeat(32);
    const beachId = "e".repeat(32);
    await writeQueryTableParquet({
      parquetPath: inputPropertyParquet,
      schemaFields: duvalEnrichmentProfile.queryTable.schemaFields,
      rows: [
        {
          property_id: jacksonvilleId,
          parcel_identifier: "1646340000",
          address_city: "Jacksonville",
        },
        {
          property_id: beachId,
          parcel_identifier: "1775520000",
          address_city: "Jacksonville Beach",
        },
      ],
    });
    await writeFile(
      inputCoveragePath,
      `${JSON.stringify({ county: "duval", datasets: [] })}\n`,
    );
    const fixture = JSON.parse(
      await readFile(
        path.join(
          fixtureRoot,
          "jaxepics-map/permit-page.json",
        ),
        "utf8",
      ),
    );
    const linked = fixture.features[0];
    const unlinked = structuredClone(fixture.features[1]);
    unlinked.attributes.OBJECTID = 2;
    unlinked.attributes.RecordID = 5500;
    unlinked.attributes.RE = "999999 9999";
    unlinked.attributes.FullPermitNumber = "M-00-5500.000";
    const independent = structuredClone(fixture.features[0]);
    independent.attributes.OBJECTID = 3;
    independent.attributes.RecordID = 5501;
    independent.attributes.RE = "177552 0000";
    const malformed = structuredClone(fixture.features[0]);
    malformed.attributes.OBJECTID = 4;
    malformed.attributes.RecordID = 5502;
    malformed.attributes.RE = null;
    const pages = [
      [linked, unlinked],
      [independent, malformed],
    ];
    const adapter = {
      pageSize: 2,
      async getSnapshot() {
        return { maxObjectId: 4, count: 4, where: "OBJECTID <= 4" };
      },
      async fetchPage({ offset }) {
        return {
          features: pages[offset / 2],
          exceededTransferLimit: offset === 0,
        };
      },
    };
    const exported = await exportJaxPermitBulkArtifacts({
      inputPropertyParquet,
      inputCoveragePath,
      outputDir,
      profile: duvalPermitProfile,
      propertySchemaFields:
        duvalEnrichmentProfile.queryTable.schemaFields,
      jobId: "permit-bulk-test",
      exportedAt: "2026-09-06T05:40:00.000Z",
      adapter,
    });
    expect(exported.counters).toMatchObject({
      sourceRows: 4,
      publishedRows: 2,
      linkedRows: 1,
      validUnlinkedRows: 1,
      invalidParcelRows: 1,
      excludedJurisdictionRows: 1,
    });
    expect(exported.permitCoverage).toMatchObject({
      attemptedParcels: 2,
      succeededParcels: 1,
      failedParcels: 1,
      linkedPermits: 1,
      validUnlinkedPermits: 1,
    });
    expect(exported.approval.status).toBe(
      "pending_human_approval",
    );
  });
});
