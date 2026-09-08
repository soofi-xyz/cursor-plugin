import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeQueryTableParquet } from "../src/core/query-table.mjs";
import { duvalEnrichmentProfile } from "../src/counties/duval/enrichment-profile.mjs";
import { enrichmentProfileDigest } from "../src/counties/enrichment-profile.mjs";
import { finalizeEnrichmentArtifacts } from "../src/enrichment/enrichment-finalize.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("enrichment artifact finalization", () => {
  it("proves row, enrichment, and property-linkage invariants before publication", async () => {
    const inputDir = await mkdtemp(
      path.join(tmpdir(), "enrichment-finalize-"),
    );
    temporaryDirectories.push(inputDir);
    await writeQueryTableParquet({
      parquetPath: path.join(inputDir, "query-table.parquet"),
      schemaFields: duvalEnrichmentProfile.queryTable.schemaFields,
      rows: [
        {
          property_id: "property-1",
          has_sunbiz_tenant: true,
          has_bbb_contractor: false,
          has_permits: false,
          hoa_flag: true,
          avm_value: 250_000,
        },
        {
          property_id: "property-2",
          has_sunbiz_tenant: false,
          has_bbb_contractor: true,
          has_permits: true,
        },
      ],
    });
    await writeFile(
      path.join(inputDir, "dataset-coverage.json"),
      JSON.stringify({
        county: "duval",
        exportedAt: "2026-09-04T18:00:00.000Z",
        datasets: [
          {
            county: "duval",
            source: "appraisal",
            ingested_count: 2,
            expected_count: 2,
          },
          {
            county: "duval",
            source: "sunbiz",
            ingested_count: 2,
            expected_count: null,
            linked_property_count: 1,
          },
          {
            county: "duval",
            source: "bbb",
            ingested_count: 2,
            expected_count: null,
            linked_property_count: 1,
            property_linkage_status: "linked_via_permit_contractor",
          },
          {
            county: "duval",
            source: "permits",
            ingested_count: 3,
            expected_count: null,
            linked_property_count: 3,
            properties_with_permits: 1,
          },
          {
            county: "duval",
            source: "avm",
            ingested_count: 1,
            linked_property_count: 1,
          },
          {
            county: "duval",
            source: "hoa",
            ingested_count: 1,
            linked_property_count: 1,
            positive_membership_count: 1,
          },
        ],
      }),
    );

    const artifacts = await finalizeEnrichmentArtifacts({
      inputDir,
      profile: duvalEnrichmentProfile,
      provenance: {
        requestSha256: "a".repeat(64),
        enrichmentProfileSha256:
          enrichmentProfileDigest(duvalEnrichmentProfile),
        gitCommit: "b".repeat(40),
        treeDigest: "c".repeat(64),
        runtimeImageProvenance: "job-definition:test:1",
      },
    });

    expect(artifacts).toMatchObject({
      schemaVersion: "elephant.enrichment-publication-artifacts.v1",
      county: "duval",
      bucket: "elephant-oracle-query-table",
      provenance: {
        enrichmentProfileSha256:
          enrichmentProfileDigest(duvalEnrichmentProfile),
      },
      rowCount: 2,
      expectedCount: 2,
      sunbizPropertyCount: 1,
      bbbContractorPropertyCount: 1,
      permitPropertyCount: 1,
      hoaKnownPropertyCount: 1,
      hoaPositivePropertyCount: 1,
      avmPropertyCount: 1,
    });
    expect(artifacts.artifactIntegrity.queryTable.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(
      JSON.parse(await readFile(path.join(inputDir, "manifest.json"), "utf8")),
    ).toEqual(artifacts);
  });

  it("rejects a BBB contractor flag on a property without permits", async () => {
    const inputDir = await mkdtemp(
      path.join(tmpdir(), "enrichment-finalize-bbb-without-permit-"),
    );
    temporaryDirectories.push(inputDir);
    await writeQueryTableParquet({
      parquetPath: path.join(inputDir, "query-table.parquet"),
      schemaFields: duvalEnrichmentProfile.queryTable.schemaFields,
      rows: [
        {
          property_id: "property-1",
          has_sunbiz_tenant: false,
          has_bbb_contractor: true,
          has_permits: false,
        },
      ],
    });
    await writeFile(
      path.join(inputDir, "dataset-coverage.json"),
      JSON.stringify({
        county: "duval",
        datasets: [
          {
            county: "duval",
            source: "appraisal",
            ingested_count: 1,
            expected_count: 1,
          },
          {
            county: "duval",
            source: "sunbiz",
            ingested_count: 0,
            linked_property_count: 0,
          },
          {
            county: "duval",
            source: "bbb",
            ingested_count: 1,
            linked_property_count: 1,
          },
          {
            county: "duval",
            source: "permits",
            ingested_count: 0,
            properties_with_permits: 0,
          },
        ],
      }),
    );

    await expect(
      finalizeEnrichmentArtifacts({
        inputDir,
        profile: duvalEnrichmentProfile,
        provenance: {
          requestSha256: "a".repeat(64),
          enrichmentProfileSha256:
            enrichmentProfileDigest(duvalEnrichmentProfile),
          gitCommit: "b".repeat(40),
          treeDigest: "c".repeat(64),
          runtimeImageProvenance: "job-definition:test:1",
        },
      }),
    ).rejects.toThrow(/BBB contractor property property-1 is not permit-linked/);
  });
});
