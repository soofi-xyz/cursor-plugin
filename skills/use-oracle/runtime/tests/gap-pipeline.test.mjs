import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { duvalGapProfile } from "../src/counties/duval/gap-profile.mjs";
import { duvalEnrichmentProfile } from "../src/counties/duval/enrichment-profile.mjs";
import { writeQueryTableParquet } from "../src/core/query-table.mjs";
import {
  assertProtectedNames,
  publishDuvalGapArtifacts,
  validateGapApproval,
} from "../src/gaps/filebase-publication.mjs";
import { buildPropertyConsolidation } from "../src/gaps/property-consolidation.mjs";
import { enrichQueryTableFile } from "../src/gaps/query-table-enrichment.mjs";

const require = createRequire(import.meta.url);
const { ParquetReader } = require("@dsnp/parquetjs");
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "duval-gap-pipeline-"));
  temporaryDirectories.push(root);
  const input = path.join(root, "input");
  await mkdir(input, { recursive: true });
  const queryTable = path.join(input, "query.parquet");
  const permitTable = path.join(input, "permit.parquet");
  const propertyId = "146108fcb20391c44b2d9583462eb3a4";
  await writeQueryTableParquet({
    parquetPath: queryTable,
    schemaFields: duvalEnrichmentProfile.queryTable.schemaFields,
    rows: [
      {
        property_id: propertyId,
        property_cid: null,
        request_identifier: "1646340000R",
        parcel_identifier: "164634-0000",
        source_system: "duval_appraiser",
        county_name: "Duval",
        state_code: "FL",
        address_street: "100 MAIN ST",
        address_city: "JACKSONVILLE",
        address_zip: "32202",
        market_value: 250_000,
        owner_name: "EXAMPLE OWNER",
        owner_count: 1,
        has_permits: true,
        permit_count: 1,
        has_sunbiz_tenant: true,
        has_bbb_contractor: false,
        has_pa_corp_tenant: false,
      },
    ],
  });
  await writeQueryTableParquet({
    parquetPath: permitTable,
    schemaFields: {
      property_improvement_id: { type: "UTF8", optional: true },
      property_id: { type: "UTF8", optional: true },
      parcel_identifier: { type: "UTF8", optional: true },
      permit_number: { type: "UTF8", optional: true },
      improvement_type: { type: "UTF8", optional: true },
      improvement_status: { type: "UTF8", optional: true },
      improvement_action: { type: "UTF8", optional: true },
      permit_issue_date: { type: "UTF8", optional: true },
      application_received_date: { type: "UTF8", optional: true },
      final_inspection_date: { type: "UTF8", optional: true },
      permit_close_date: { type: "UTF8", optional: true },
      completion_date: { type: "UTF8", optional: true },
      expiration_date: { type: "UTF8", optional: true },
      opened_date: { type: "UTF8", optional: true },
      source_system: { type: "UTF8", optional: true },
      county_name: { type: "UTF8", optional: true },
      project_description: { type: "UTF8", optional: true },
      description: { type: "UTF8", optional: true },
      estimated_job_value: { type: "DOUBLE", optional: true },
      fee: { type: "DOUBLE", optional: true },
    },
    rows: [
      {
        property_improvement_id: "permit-1",
        property_id: propertyId,
        parcel_identifier: "164634-0000",
        permit_number: "B-123",
        permit_issue_date: "2026-01-02",
        source_system: "duval_jaxepics_bid_map",
      },
    ],
  });
  const sunbiz = path.join(input, "sunbiz");
  await mkdir(path.join(sunbiz, "chunks"), { recursive: true });
  const chunkPath = path.join(sunbiz, "chunks", "part-0001.jsonl");
  const linksPath = path.join(input, "links.jsonl");
  const ownerPath = path.join(input, "owner.jsonl");
  await writeFile(
    linksPath,
    `${JSON.stringify({
      property_id: propertyId,
      document_number: "L12345",
      match_method: "unique_property_exact_normalized_principal_address_zip",
    })}\n`,
  );
  await writeFile(
    ownerPath,
    `${JSON.stringify({
      parcel_identifier: "164634-0000",
      AV_HMSTD: "25000",
    })}\n`,
  );
  return {
    root,
    input,
    queryTable,
    permitTable,
    propertyId,
    sunbiz,
    chunkPath,
    linksPath,
    ownerPath,
  };
}

async function writeSunbiz(fixture, entityName) {
  const body = `${JSON.stringify({
    entity: {
      documentNumber: "L12345",
      entityName,
      status: "ACTIVE",
      principalAddress: { line1: "100 MAIN ST", zip: "32202" },
      parties: [{ name: "REGISTERED AGENT", role: "RA" }],
    },
    matchedAddresses: [{ role: "principalAddress" }],
  })}\n`;
  await writeFile(fixture.chunkPath, body);
  await writeFile(
    path.join(fixture.sunbiz, "manifest.json"),
    `${JSON.stringify({
      county: "duval",
      completeSourceScan: true,
      matchedRecordCount: 1,
      chunks: [
        {
          relativePath: "chunks/part-0001.jsonl",
          sha256: createHash("sha256").update(body).digest("hex"),
        },
      ],
    })}\n`,
  );
}

async function readSingleParquet(parquetPath) {
  const reader = await ParquetReader.openFile(parquetPath);
  try {
    return await reader.getCursor().next();
  } finally {
    await reader.close();
  }
}

describe("Duval gap consolidation and CID fill", () => {
  it("rejects protected permit and coverage IPNS changes", () => {
    const protectedNames = [
      {
        label: "oracle-query-table-duval",
        network_key:
          duvalGapProfile.protectedPublications.queryTable.networkKey,
        cid: duvalGapProfile.protectedPublications.queryTable.frozenCid,
      },
      {
        label: "oracle-permit-table-duval",
        network_key:
          duvalGapProfile.protectedPublications.permitTable.networkKey,
        cid: duvalGapProfile.protectedPublications.permitTable.frozenCid,
      },
      {
        label: "oracle-dataset-coverage-duval",
        network_key:
          duvalGapProfile.protectedPublications.coverage.networkKey,
        cid: duvalGapProfile.protectedPublications.coverage.frozenCid,
      },
    ];
    expect(() =>
      assertProtectedNames(protectedNames, duvalGapProfile),
    ).not.toThrow();
    expect(() =>
      assertProtectedNames(
        protectedNames.map((entry) =>
          entry.label === "oracle-permit-table-duval"
            ? { ...entry, cid: "QmChangedPermit" }
            : entry,
        ),
        duvalGapProfile,
      ),
    ).toThrow(/Protected permitTable IPNS identity changed/);
  });

  it("attaches permit/Sunbiz data, leaves BBB empty, and changes CID with content", async () => {
    const data = await fixture();
    await writeSunbiz(data, "EXAMPLE LLC");
    const firstOutput = path.join(data.root, "first");
    const first = await buildPropertyConsolidation({
      county: "duval",
      queryTableParquet: data.queryTable,
      permitParquet: data.permitTable,
      sunbizExtractDir: data.sunbiz,
      sunbizLinksPath: data.linksPath,
      ownerOccupiedPath: data.ownerPath,
      outputDir: firstOutput,
      frozenAt: "2026-09-08T04:45:00Z",
      expectedPropertyCount: 1,
      expectedPermitCount: 1,
      shardSize: 1,
    });
    const document = JSON.parse(
      await readFile(
        path.join(firstOutput, `properties/${data.propertyId}.json`),
        "utf8",
      ),
    );
    expect(document.permits).toHaveLength(1);
    expect(document.sunbizTenants[0].entityName).toBe("EXAMPLE LLC");
    expect(document.sunbizTenants[0].linkage.matchMethod).toBe(
      "unique_property_exact_normalized_principal_address_zip",
    );
    expect(document.sunbizTenants[0]).not.toHaveProperty("principalAddress");
    expect(document.sunbizTenants[0]).not.toHaveProperty("parties");
    expect(document.sunbizTenants[0]).not.toHaveProperty("officers");
    expect(document.sunbizTenants[0]).not.toHaveProperty("registeredAgent");
    expect(document.property.ownerOccupied).toBe(true);
    expect(document.bbbProfiles).toEqual([]);
    expect(first.manifest.reconciliation.sunbizLinkedPropertyCount).toBe(1);

    await writeSunbiz(data, "RENAMED LLC");
    const second = await buildPropertyConsolidation({
      county: "duval",
      queryTableParquet: data.queryTable,
      permitParquet: data.permitTable,
      sunbizExtractDir: data.sunbiz,
      sunbizLinksPath: data.linksPath,
      ownerOccupiedPath: data.ownerPath,
      outputDir: path.join(data.root, "second"),
      frozenAt: "2026-09-08T04:45:00Z",
      expectedPropertyCount: 1,
      expectedPermitCount: 1,
      shardSize: 1,
    });
    expect(second.manifest.entries[0].cid).not.toBe(
      first.manifest.entries[0].cid,
    );
  });

  it("fills every CID, emits source blockers, and produces a guarded dry run", async () => {
    const data = await fixture();
    await writeSunbiz(data, "EXAMPLE LLC");
    const propertyOutput = path.join(data.root, "property");
    await buildPropertyConsolidation({
      county: "duval",
      queryTableParquet: data.queryTable,
      permitParquet: data.permitTable,
      sunbizExtractDir: data.sunbiz,
      sunbizLinksPath: data.linksPath,
      ownerOccupiedPath: data.ownerPath,
      outputDir: propertyOutput,
      frozenAt: "2026-09-08T04:45:00Z",
      expectedPropertyCount: 1,
      expectedPermitCount: 1,
      shardSize: 1,
    });
    const queryOutput = path.join(data.root, "query-output.parquet");
    const queryManifest = path.join(data.root, "query-manifest.json");
    const manifest = await enrichQueryTableFile({
      county: "duval",
      inputParquet: data.queryTable,
      outputParquet: queryOutput,
      schemaFields: duvalEnrichmentProfile.queryTable.schemaFields,
      cidManifestPath: path.join(propertyOutput, "manifest.json"),
      ownerOccupiedPath: data.ownerPath,
      outputManifest: queryManifest,
      expectedRowCount: 1,
      expectedCounts: {
        ownerOccupiedSourceCount: 1,
        permitPropertyCount: 1,
        linkedPermitCount: 1,
        sunbizPropertyCount: 1,
        bbbPropertyCount: 0,
        bbbWithoutPermitsCount: 0,
        ownerOccupiedTrueCount: 1,
        ownerOccupiedFalseCount: 0,
        ownerOccupiedNullCount: 0,
      },
      frozenAt: "2026-09-08T04:45:00Z",
    });
    const row = await readSingleParquet(queryOutput);
    expect(row.property_cid).toMatch(/^Qm/);
    expect(row.owner_occupied).toBe(true);
    expect(row.market_value).toBe(250_000);
    expect(row.has_permits).toBe(true);
    expect(Number(row.permit_count)).toBe(1);
    expect(row.has_sunbiz_tenant).toBe(true);
    expect(row.has_bbb_contractor).toBe(false);
    expect(row.hoa_flag).toBeNull();
    expect(row.avm_value).toBeNull();
    expect(manifest.preservedColumnCount).toBeGreaterThan(20);
    expect(manifest.blockers.map((blocker) => blocker.field)).toEqual([
      "hoa_flag",
      "avm_value",
    ]);

    const placesOutput = path.join(data.root, "places");
    await mkdir(placesOutput, { recursive: true });
    await writeFile(
      path.join(placesOutput, "places-table.parquet"),
      await readFile(data.permitTable),
    );
    await writeFile(
      path.join(placesOutput, "index.json"),
      `${JSON.stringify({
        county: "duval",
        artifact: "places-table",
        rowCount: 1,
        overtureRelease: "2026-08-19.0",
        published: true,
      })}\n`,
    );
    await writeFile(
      path.join(placesOutput, "NOTICE.txt"),
      "Contact-free Duval Overture places\n",
    );
    const plan = await publishDuvalGapArtifacts({
      profile: duvalGapProfile,
      propertyOutputDir: propertyOutput,
      placesOutputDir: placesOutput,
      queryTablePath: queryOutput,
      receiptPath: path.join(data.root, "receipt.json"),
      dryRun: true,
    });
    const persistedPlan = JSON.parse(
      await readFile(
        path.join(data.root, "publication-plan.json"),
        "utf8",
      ),
    );
    expect(plan.dryRun).toBe(true);
    expect(persistedPlan).toEqual(plan);
    expect(plan.destinations.propertyDocumentsIpnsLabel).toBe(
      "oracle-open-data-duval",
    );
    expect(plan.artifacts.placesIndex.cid).toMatch(/^Qm/);
    expect(plan.artifacts.placesNotice.cid).toMatch(/^Qm/);
    expect(plan.forbiddenOperations).toContain("BBB submission");
    expect(plan.privacyPolicy.bbbProfilesPublished).toBe(false);
    expect(plan.privacyPolicy.sunbizExcludedFields).toContain("officers");
    expect(plan.createsDedicatedLabels).toEqual([
      "oracle-open-data-duval",
      "oracle-open-data-duval-places",
    ]);
    const approval = {
      schemaVersion: "elephant.duval-mcp-gap-publish-approval.v1",
      action: "publish-duval-mcp-gap-artifacts",
      county: "duval",
      protectedCids: {
        queryTable:
          duvalGapProfile.protectedPublications.queryTable.frozenCid,
        permitTable:
          duvalGapProfile.protectedPublications.permitTable.frozenCid,
        coverage: duvalGapProfile.protectedPublications.coverage.frozenCid,
      },
      artifacts: plan.artifacts,
      destinations: plan.destinations,
      publicationBounds: plan.publicationBounds,
      privacyPolicy: plan.privacyPolicy,
      createsDedicatedLabels: plan.createsDedicatedLabels,
      humanPiiApproval: true,
      approved: true,
      approvedBy: "test approver",
      approvedAt: "2026-09-09T12:00:00Z",
    };
    expect(
      validateGapApproval(approval, plan, duvalGapProfile).approved,
    ).toBe(true);
    expect(() =>
      validateGapApproval(
        {
          ...approval,
          privacyPolicy: {
            ...approval.privacyPolicy,
            placesPhonesPublished: true,
          },
        },
        plan,
        duvalGapProfile,
      ),
    ).toThrow();
  });
});
