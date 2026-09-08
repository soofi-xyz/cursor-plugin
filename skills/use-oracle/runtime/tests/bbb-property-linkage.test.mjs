import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ParquetReader } from "@dsnp/parquetjs";
import { afterEach, describe, expect, it } from "vitest";

import { writeQueryTableParquet } from "../src/core/query-table.mjs";
import { duvalEnrichmentProfile } from "../src/counties/duval/enrichment-profile.mjs";
import {
  duvalBbbPermitSourceAdapter,
  jaroWinkler,
  linkBbbContractorsToProperties,
  normalizeBusinessName,
  normalizeLicense,
  normalizePhone,
} from "../src/enrichment/query-table-bbb.mjs";

const temporaryDirectories = [];
const testPermitSourceAdapter = {
  ...duvalBbbPermitSourceAdapter,
  key: "synthetic-duval-permits",
  validateFeature(feature) {
    return {
      property_improvement_id: `permit-${feature.attributes.RecordID}`,
    };
  },
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function readParquetRows(filePath) {
  const reader = await ParquetReader.openFile(filePath);
  const rows = [];
  try {
    const cursor = reader.getCursor();
    let row = await cursor.next();
    while (row) {
      rows.push(row);
      row = await cursor.next();
    }
  } finally {
    await reader.close();
  }
  return rows;
}

function bbbProfile({
  providerBusinessId,
  providerProfileId,
  name,
  phone = null,
  license = null,
}) {
  return {
    recordKind: "bbb_business_profile",
    providerBusinessId,
    providerProfileId,
    profileUrl: `https://www.bbb.org/profile/${providerProfileId}`,
    name,
    legalName: name,
    phone,
    alternateNames: [],
    licenses: license
      ? [{ rawText: `BBB records show a license number of ${license} for this business` }]
      : [],
  };
}

describe("BBB permit-contractor property linkage", () => {
  it("normalizes identity evidence and computes stable similarity", () => {
    expect(normalizeBusinessName("Apex Roofing, LLC")).toBe("APEX ROOFING");
    expect(
      normalizeBusinessName("Apex Roofing Services, LLC", { loose: true }),
    ).toBe("APEX");
    expect(normalizePhone("+1 (904) 555-0100")).toBe("9045550100");
    expect(normalizeLicense("ccc-1330549")).toBe("CCC1330549");
    expect(jaroWinkler("APEX ROOFING", "APEX ROOFING")).toBe(1);
    expect(jaroWinkler("APEX", "OMEGA")).toBeLessThan(0.9);
  });

  it("links only license, phone, and unique exact-name matches to properties", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bbb-linkage-"));
    temporaryDirectories.push(directory);
    const inputParquet = path.join(directory, "input.parquet");
    const outputParquet = path.join(directory, "output.parquet");
    const inputCoverage = path.join(directory, "input-coverage.json");
    const outputCoverage = path.join(directory, "output-coverage.json");
    const bbbProfilesPath = path.join(directory, "bbb-profiles.jsonl");
    const bbbReconciliationManifestPath = path.join(
      directory,
      "bbb-reconciliation.json",
    );
    const permitSourcePath = path.join(directory, "permits.jsonl.gz");
    const permitArtifactManifestPath = path.join(
      directory,
      "permit-artifact-manifest.json",
    );
    const linksPath = path.join(directory, "links.jsonl");
    const candidatesPath = path.join(directory, "candidates.jsonl");
    const manifestPath = path.join(directory, "manifest.json");

    await writeQueryTableParquet({
      parquetPath: inputParquet,
      schemaFields: duvalEnrichmentProfile.queryTable.schemaFields,
      rows: [
        {
          property_id: "property-1",
          parcel_identifier: "123456-0000",
          has_bbb_contractor: false,
          has_permits: true,
        },
        {
          property_id: "property-2",
          parcel_identifier: "123456-0001",
          has_bbb_contractor: false,
          has_permits: true,
        },
        {
          property_id: "property-3",
          parcel_identifier: "123456-0002",
          has_bbb_contractor: false,
          has_permits: true,
        },
        {
          property_id: "property-4",
          parcel_identifier: "123456-0003",
          has_bbb_contractor: false,
          has_permits: false,
        },
      ],
    });
    await writeFile(
      inputCoverage,
      `${JSON.stringify({
        county: "duval",
        exportedAt: "2026-09-08T10:00:00.000Z",
        datasets: [
          { county: "duval", source: "appraisal", ingested_count: 4 },
          {
            county: "duval",
            source: "bbb",
            ingested_count: 5,
            linked_property_count: 0,
            valid_unlinked_count: 5,
            property_linkage_status: "not_linked",
          },
          {
            county: "duval",
            source: "permits",
            ingested_count: 6,
            expected_count: 7,
            linked_property_count: 6,
            valid_unlinked_permit_count: 0,
            excluded_source_record_count: 1,
          },
        ],
      })}\n`,
    );
    const profiles = [
      bbbProfile({
        providerBusinessId: "bbb-apex",
        providerProfileId: "0403:1",
        name: "Apex Roofing, LLC",
        phone: "(904) 555-0100",
        license: "CCC1111111",
      }),
      bbbProfile({
        providerBusinessId: "bbb-apex",
        providerProfileId: "0403:1:2",
        name: "Apex Roofing, LLC",
        phone: "(904) 555-0100",
        license: "CCC1111111",
      }),
      bbbProfile({
        providerBusinessId: "bbb-alpha",
        providerProfileId: "0403:2",
        name: "Alpha Services, LLC",
      }),
      bbbProfile({
        providerBusinessId: "bbb-twin-1",
        providerProfileId: "0403:3",
        name: "Twin Roofing, LLC",
      }),
      bbbProfile({
        providerBusinessId: "bbb-twin-2",
        providerProfileId: "0403:4",
        name: "Twin Roofing, Inc.",
      }),
    ];
    const bbbBody = `${profiles
      .map((profile) => JSON.stringify(profile))
      .join("\n")}\n`;
    await writeFile(bbbProfilesPath, bbbBody);
    await writeFile(
      bbbReconciliationManifestPath,
      JSON.stringify({
        schemaVersion: "elephant.bbb-reconciliation.v1",
        county: "duval",
        sourceAccessStatus: "accessible",
        sourceAccessComplete: true,
        categories: [{ categoryKey: "roofing-contractors" }],
        uniqueProfileCount: profiles.length,
        profilesBytes: Buffer.byteLength(bbbBody),
        profilesSha256: createHash("sha256").update(bbbBody).digest("hex"),
      }),
    );
    const features = [
      {
        attributes: {
          RecordID: 1,
          RE: "123456 0000",
          CompanyID: 10,
          CompanyName: "Apex Roofing Inc.",
          FullPermitNumber: "R-1",
        },
      },
      {
        attributes: {
          RecordID: 2,
          RE: "123456 0000",
          CompanyID: 10,
          CompanyName: "Apex Roofing Inc.",
          FullPermitNumber: "R-2",
        },
      },
      {
        attributes: {
          RecordID: 3,
          RE: "123456 0001",
          CompanyID: 11,
          CompanyName: "Different Display Name",
          LicenseNumber: "CCC1111111",
          FullPermitNumber: "R-3",
        },
      },
      {
        attributes: {
          RecordID: 4,
          RE: "123456 0001",
          CompanyID: 14,
          CompanyName: "Another Display Name",
          CompanyPhone: "(904) 555-0100",
          FullPermitNumber: "R-4",
        },
      },
      {
        attributes: {
          RecordID: 5,
          RE: "123456 0002",
          CompanyID: 12,
          CompanyName: "Alpha Service",
          FullPermitNumber: "R-5",
        },
      },
      {
        attributes: {
          RecordID: 6,
          RE: "123456 0002",
          CompanyID: 13,
          CompanyName: "Twin Roofing Company",
          FullPermitNumber: "R-6",
        },
      },
      {
        attributes: {
          RecordID: 7,
          RE: "123456 0003",
          CompanyID: 10,
          CompanyName: "Apex Roofing Inc.",
          FullPermitNumber: "R-7",
        },
      },
    ];
    const permitBody = gzipSync(`${JSON.stringify({ offset: 0, features })}\n`);
    await writeFile(permitSourcePath, permitBody);
    await writeFile(
      permitArtifactManifestPath,
      JSON.stringify({
        schemaVersion: "elephant.permit-artifact-manifest.v1",
        countyKey: "duval",
        artifacts: [
          {
            path: "private/jaxepics-bid-map.jsonl.gz",
            bytes: permitBody.length,
            sha256: createHash("sha256").update(permitBody).digest("hex"),
            rowCount: features.length,
            privacy: "private",
          },
        ],
      }),
    );

    const { summary, coverage } = await linkBbbContractorsToProperties({
      countyKey: "duval",
      permitSourceAdapter: testPermitSourceAdapter,
      expectedCategoryKeys: ["roofing-contractors"],
      schemaFields: duvalEnrichmentProfile.queryTable.schemaFields,
      inputParquet,
      outputParquet,
      inputCoverage,
      outputCoverage,
      bbbProfilesPath,
      bbbReconciliationManifestPath,
      permitSourcePath,
      permitArtifactManifestPath,
      linksPath,
      candidatesPath,
      manifestPath,
      exportedAt: "2026-09-08T12:00:00.000Z",
    });

    expect(summary).toMatchObject({
      inputPropertyCount: 4,
      outputPropertyCount: 4,
      permitFeatureCount: 7,
      publishedPermitCount: 6,
      propertyLinkedPermitCount: 6,
      excludedPermitCount: 1,
      permitsOnIneligibleProperty: 1,
      bbbProfileCount: 5,
      bbbBusinessCount: 4,
      linkedBbbBusinessCount: 1,
      linkedBbbProfileCount: 2,
      linkedPermitCount: 4,
      linkedPropertyCount: 2,
      acceptedContractorMatchCount: 3,
      reviewCandidateCount: 2,
      sourceVerification: {
        permitSourceAdapter: "synthetic-duval-permits",
        bbbReconciliationManifestVerified: true,
        permitArtifactManifestVerified: true,
        expectedPermitFeatureCount: 7,
      },
    });
    expect(
      coverage.datasets.find((dataset) => dataset.source === "bbb"),
    ).toMatchObject({
      linked_property_count: 2,
      linked_permit_count: 4,
      matched_permit_count: 4,
      linked_business_count: 1,
      total_business_count: 4,
      provider_business_count: 4,
      linked_provider_business_count: 1,
      valid_unlinked_provider_business_count: 3,
      linked_profile_count: 2,
      valid_unlinked_count: 3,
      property_linkage_status: "linked_via_permit_contractor",
      linkage_complete_within_scope: true,
      review_candidate_count: 2,
      ambiguous_candidate_count: 1,
      contractor_evidence_privacy: "private",
      linkage_temporal_basis:
        "current_bbb_snapshot_to_historical_permit_contractor_identity",
      asserts_bbb_status_at_permit_time: false,
    });
    const rows = await readParquetRows(outputParquet);
    expect(
      Object.fromEntries(
        rows.map((row) => [row.property_id, row.has_bbb_contractor]),
      ),
    ).toEqual({
      "property-1": true,
      "property-2": true,
      "property-3": false,
      "property-4": false,
    });
    expect(
      (await readFile(linksPath, "utf8")).trim().split("\n"),
    ).toHaveLength(4);
    const candidates = (await readFile(candidatesPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(candidates.map((candidate) => candidate.status).sort()).toEqual([
      "ambiguous",
      "review",
    ]);
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toEqual(summary);
  });
});
