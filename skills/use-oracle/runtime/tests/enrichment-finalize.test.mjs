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
        },
        {
          property_id: "property-2",
          has_sunbiz_tenant: false,
          has_bbb_contractor: false,
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
            linked_property_count: 0,
            property_linkage_status: "not_linked",
          },
          {
            county: "duval",
            source: "permits",
            ingested_count: 3,
            expected_count: null,
            linked_property_count: 1,
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
      bbbContractorPropertyCount: 0,
      permitPropertyCount: 1,
    });
    expect(artifacts.artifactIntegrity.queryTable.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(
      JSON.parse(await readFile(path.join(inputDir, "manifest.json"), "utf8")),
    ).toEqual(artifacts);
  });
});
