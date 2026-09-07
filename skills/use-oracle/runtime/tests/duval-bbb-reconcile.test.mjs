import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeBlockedBbbCategoryArtifact } from "../src/enrichment/bbb.mjs";
import { reconcileBbbHarvests } from "../src/enrichment/bbb-reconcile.mjs";
import { duvalEnrichmentProfile } from "../src/counties/duval/enrichment-profile.mjs";

const temporaryDirectories = [];
const BBB_CATEGORIES = duvalEnrichmentProfile.bbb.categories;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function writeHarvest(directory, category, profile) {
  const relativePath = "profiles/profiles-part-0001.jsonl";
  const body = `${JSON.stringify(profile)}\n`;
  await mkdir(path.join(directory, "profiles"), { recursive: true });
  await mkdir(path.join(directory, "manifest"), { recursive: true });
  await writeFile(path.join(directory, relativePath), body);
  await writeFile(
    path.join(directory, "manifest", "summary.json"),
    JSON.stringify({
      schemaVersion: "elephant.bbb-category-harvest.v1",
      jobId: `bbb-duval-${category.key}`,
      county: "duval",
      categoryKey: category.key,
      categoryUrl: category.url,
      profilesSelected: 1,
      profilesHarvested: 1,
      profilesFailedPermanent: 0,
      completeWithinBounds: true,
      advertisedResultsAreCompletenessDenominator: false,
      failurePart: null,
      profileParts: [
        {
          relativePath,
          recordCount: 1,
          bytes: Buffer.byteLength(body),
          sha256: createHash("sha256").update(body).digest("hex"),
        },
      ],
    }),
  );
}

async function writePermanentFailureHarvest(directory, category, failure) {
  const relativePath = "failures/failed-profiles.jsonl";
  const body = `${JSON.stringify(failure)}\n`;
  await mkdir(path.join(directory, "failures"), { recursive: true });
  await mkdir(path.join(directory, "manifest"), { recursive: true });
  await writeFile(path.join(directory, relativePath), body);
  await writeFile(
    path.join(directory, "manifest", "summary.json"),
    JSON.stringify({
      schemaVersion: "elephant.bbb-category-harvest.v1",
      jobId: `bbb-duval-${category.key}`,
      county: "duval",
      categoryKey: category.key,
      categoryUrl: category.url,
      profilesSelected: 1,
      profilesHarvested: 0,
      profilesFailedPermanent: 1,
      completeWithinBounds: true,
      advertisedResultsAreCompletenessDenominator: false,
      profileParts: [],
      failurePart: {
        relativePath,
        recordCount: 1,
        bytes: Buffer.byteLength(body),
        sha256: createHash("sha256").update(body).digest("hex"),
      },
    }),
  );
}

describe("Duval BBB harvest reconciliation", () => {
  it("deduplicates profiles across all three categories and reports them as valid-unlinked until permits exist", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "duval-bbb-reconcile-"));
    temporaryDirectories.push(root);
    const harvestDirs = [];
    for (const [index, category] of BBB_CATEGORIES.entries()) {
      const directory = path.join(root, category.key);
      harvestDirs.push(directory);
      await writeHarvest(directory, category, {
        recordKind: "bbb_business_profile",
        providerProfileId: index < 2 ? "0403:shared" : "0403:unique",
        profileUrl:
          index < 2
            ? "https://www.bbb.org/us/fl/jacksonville/profile/example/shared-0403-1"
            : "https://www.bbb.org/us/fl/jacksonville/profile/example/unique-0403-2",
        name: index < 2 ? "Shared Contractor" : "Unique Contractor",
      });
    }
    const inputCoverage = path.join(root, "coverage-input.json");
    const outputCoverage = path.join(root, "coverage-output.json");
    const outputProfiles = path.join(root, "bbb-profiles.jsonl");
    const outputManifest = path.join(root, "bbb-manifest.json");
    await writeFile(
      inputCoverage,
      JSON.stringify({
        county: "duval",
        datasets: [
          {
            county: "duval",
            source: "appraisal",
            ingested_count: 2,
            expected_count: 2,
          },
        ],
      }),
    );

    const summary = await reconcileBbbHarvests({
      countyKey: duvalEnrichmentProfile.countyKey,
      categories: BBB_CATEGORIES,
      harvestDirs,
      inputCoverage,
      outputCoverage,
      outputProfiles,
      outputManifest,
      reconciledAt: "2026-09-04T18:00:00.000Z",
    });

    expect(summary).toMatchObject({
      categoryCount: 3,
      rawProfileCount: 3,
      uniqueProfileCount: 2,
      duplicateProfileCount: 1,
      linkedPropertyCount: 0,
    });
    const profiles = (await readFile(outputProfiles, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    expect(profiles).toHaveLength(2);
    const coverage = JSON.parse(await readFile(outputCoverage, "utf8"));
    expect(coverage.datasets.find((dataset) => dataset.source === "bbb")).toMatchObject({
      ingested_count: 2,
      expected_count: null,
      linked_property_count: 0,
      valid_unlinked_count: 2,
      property_linkage_status: "not_linked",
    });
  });

  it("retains explicit incomplete 403 coverage for a zero-profile blocked source", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "duval-bbb-blocked-"));
    temporaryDirectories.push(root);
    const evidence = {
      schemaVersion: "elephant.bbb-source-access-evidence.v1",
      source: "bbb-public-browser",
      runId: "duval-r2-test",
      batchRequestSha256: "b".repeat(64),
      observedBatchJobId: "11111111-2222-4333-8444-555555555555",
      observedAt: "2026-09-05T18:00:00.000Z",
      observedCategoryKey: "roofing-contractors",
      observedUrl:
        "https://www.bbb.org/us/fl/jacksonville/category/roofing-contractors?page=2",
      httpStatus: 403,
      classification: "blocked",
      failureReason: "blocked",
      operatorDirective: "stop_no_further_bbb_requests",
    };
    const harvestDirs = [];
    for (const category of BBB_CATEGORIES) {
      const outputDir = path.join(root, category.key);
      harvestDirs.push(outputDir);
      await writeBlockedBbbCategoryArtifact({
        countyKey: duvalEnrichmentProfile.countyKey,
        reviewedCategory: category,
        reviewedCategories: BBB_CATEGORIES,
        jobId: `duval-r2-test-${category.key}`,
        categoryKey: category.key,
        categoryUrl: category.url,
        outputDir,
        maxPages: 2,
        maxProfiles: 25,
        maxRequests: 100,
        maxDurationMs: 30 * 60 * 1_000,
        partRecordLimit: 25,
        pageDelayMs: 2_000,
        profileDelayMs: 1_500,
        navigationTimeoutMs: 90_000,
        challengeAttempts: 1,
        challengeCheckIntervalMs: 3_000,
        challengeChecksPerAttempt: 1,
        includeHtml: true,
        profileSubpages: [],
        sourceAccessEvidence: evidence,
        artifactCreatedAt: "2026-09-05T19:00:00.000Z",
      });
    }
    const inputCoverage = path.join(root, "coverage-input.json");
    const outputCoverage = path.join(root, "coverage-output.json");
    const outputProfiles = path.join(root, "bbb-profiles.jsonl");
    const outputManifest = path.join(root, "bbb-manifest.json");
    await writeFile(
      inputCoverage,
      JSON.stringify({ county: "duval", datasets: [] }),
    );

    const result = await reconcileBbbHarvests({
      countyKey: duvalEnrichmentProfile.countyKey,
      categories: BBB_CATEGORIES,
      harvestDirs,
      inputCoverage,
      outputCoverage,
      outputProfiles,
      outputManifest,
      reconciledAt: "2026-09-05T20:00:00.000Z",
    });
    expect(result).toMatchObject({
      uniqueProfileCount: 0,
      linkedPropertyCount: 0,
      propertyLinkageStatus: "not_linked",
      sourceAccessStatus: "blocked",
      sourceAccessComplete: false,
      sourceAccessEvidence: evidence,
    });
    expect(await readFile(outputProfiles, "utf8")).toBe("");
    const coverage = JSON.parse(await readFile(outputCoverage, "utf8"));
    expect(
      coverage.datasets.find((dataset) => dataset.source === "bbb"),
    ).toMatchObject({
      expected_count: null,
      ingested_count: 0,
      linked_property_count: 0,
      valid_unlinked_count: 0,
      property_linkage_status: "not_linked",
      source_access_status: "blocked",
      source_access_complete: false,
      incomplete_reason: "http_403_source_block",
      source_access_evidence: evidence,
      scope: {
        type: "bounded_category_harvest",
        advertised_results_are_denominator: false,
        access_complete: false,
        blocked_category_keys: ["roofing-contractors"],
        not_attempted_category_keys: [
          "solar-energy-system-contractors",
          "heating-and-air-conditioning",
        ],
      },
    });
  });

  it("retains completed profiles beside one observed block and exact not-attempted coverage", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "duval-bbb-mixed-blocked-"));
    temporaryDirectories.push(root);
    const evidence = {
      schemaVersion: "elephant.bbb-source-access-evidence.v1",
      source: "bbb-public-browser",
      runId: "duval-r3-test",
      batchRequestSha256: "c".repeat(64),
      observedBatchJobId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      observedAt: "2026-09-05T18:00:00.000Z",
      observedCategoryKey: BBB_CATEGORIES[1].key,
      observedUrl: `${BBB_CATEGORIES[1].url}?page=2`,
      httpStatus: 403,
      classification: "blocked",
      failureReason: "blocked",
      operatorDirective: "stop_no_further_bbb_requests",
    };
    const harvestDirs = BBB_CATEGORIES.map((category) =>
      path.join(root, category.key),
    );
    await writeHarvest(harvestDirs[0], BBB_CATEGORIES[0], {
      recordKind: "bbb_business_profile",
      providerProfileId: "0403:retained",
      profileUrl:
        "https://www.bbb.org/us/fl/jacksonville/profile/example/retained-0403-3",
      name: "Retained Contractor",
    });
    for (let index = 1; index < BBB_CATEGORIES.length; index += 1) {
      const category = BBB_CATEGORIES[index];
      await writeBlockedBbbCategoryArtifact({
        countyKey: duvalEnrichmentProfile.countyKey,
        reviewedCategory: category,
        reviewedCategories: BBB_CATEGORIES,
        jobId: `duval-r3-test-${category.key}`,
        categoryKey: category.key,
        categoryUrl: category.url,
        outputDir: harvestDirs[index],
        maxPages: 2,
        maxProfiles: 25,
        maxRequests: 100,
        maxDurationMs: 30 * 60 * 1_000,
        partRecordLimit: 25,
        pageDelayMs: 2_000,
        profileDelayMs: 1_500,
        navigationTimeoutMs: 90_000,
        challengeAttempts: 1,
        challengeCheckIntervalMs: 3_000,
        challengeChecksPerAttempt: 1,
        includeHtml: true,
        profileSubpages: [],
        sourceAccessEvidence: evidence,
        artifactCreatedAt: "2026-09-05T19:00:00.000Z",
      });
    }
    const inputCoverage = path.join(root, "coverage-input.json");
    const outputCoverage = path.join(root, "coverage-output.json");
    const outputProfiles = path.join(root, "bbb-profiles.jsonl");
    await writeFile(
      inputCoverage,
      JSON.stringify({ county: "duval", datasets: [] }),
    );

    const result = await reconcileBbbHarvests({
      countyKey: duvalEnrichmentProfile.countyKey,
      categories: BBB_CATEGORIES,
      harvestDirs,
      inputCoverage,
      outputCoverage,
      outputProfiles,
      outputManifest: path.join(root, "bbb-manifest.json"),
      reconciledAt: "2026-09-05T20:00:00.000Z",
    });

    expect(result).toMatchObject({
      uniqueProfileCount: 1,
      sourceAccessStatus: "blocked",
      sourceAccessComplete: false,
      blockedCategoryKeys: [BBB_CATEGORIES[1].key],
      notAttemptedCategoryKeys: [BBB_CATEGORIES[2].key],
    });
    expect(await readFile(outputProfiles, "utf8")).toContain(
      "Retained Contractor",
    );
    const coverage = JSON.parse(await readFile(outputCoverage, "utf8"));
    expect(
      coverage.datasets.find((dataset) => dataset.source === "bbb").scope,
    ).toMatchObject({
      access_complete: false,
      blocked_category_keys: [BBB_CATEGORIES[1].key],
      not_attempted_category_keys: [BBB_CATEGORIES[2].key],
    });
  });

  it("verifies and retains permanent profile failures", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "duval-bbb-failures-"));
    temporaryDirectories.push(root);
    const harvestDirs = [];
    const failure = {
      recordKind: "bbb_profile_failure",
      schemaVersion: "elephant.bbb-category-harvest.v1",
      profileUrl:
        "https://www.bbb.org/us/fl/jacksonville/profile/example/missing-0403-4",
      status: 404,
      classification: "PERMANENT",
    };
    for (const [index, category] of BBB_CATEGORIES.entries()) {
      const directory = path.join(root, category.key);
      harvestDirs.push(directory);
      if (index === 0) {
        await writePermanentFailureHarvest(directory, category, failure);
      } else {
        await writeHarvest(directory, category, {
          recordKind: "bbb_business_profile",
          providerProfileId: `0403:complete-${index}`,
          profileUrl:
            `https://www.bbb.org/us/fl/jacksonville/profile/example/complete-${index}-0403-${index}`,
          name: `Complete Contractor ${index}`,
        });
      }
    }
    const inputCoverage = path.join(root, "coverage-input.json");
    const outputFailures = path.join(root, "bbb-failures.jsonl");
    await writeFile(
      inputCoverage,
      JSON.stringify({ county: "duval", datasets: [] }),
    );

    const result = await reconcileBbbHarvests({
      countyKey: duvalEnrichmentProfile.countyKey,
      categories: BBB_CATEGORIES,
      harvestDirs,
      inputCoverage,
      outputCoverage: path.join(root, "coverage-output.json"),
      outputProfiles: path.join(root, "bbb-profiles.jsonl"),
      outputFailures,
      outputManifest: path.join(root, "bbb-manifest.json"),
      reconciledAt: "2026-09-05T20:00:00.000Z",
    });

    expect(result).toMatchObject({
      permanentFailureCount: 1,
      failuresBytes: expect.any(Number),
      failuresSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.parse((await readFile(outputFailures, "utf8")).trim())).toEqual(
      failure,
    );
  });

  it("requires a null failure part when the permanent-failure count is zero", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "duval-bbb-failure-null-"));
    temporaryDirectories.push(root);
    const harvestDirs = [];
    for (const category of BBB_CATEGORIES) {
      const directory = path.join(root, category.key);
      harvestDirs.push(directory);
      await writeHarvest(directory, category, {
        recordKind: "bbb_business_profile",
        providerProfileId: `0403:${category.key}`,
        profileUrl:
          `https://www.bbb.org/us/fl/jacksonville/profile/example/${category.key}-0403-5`,
      });
    }
    const invalidSummaryPath = path.join(
      harvestDirs[0],
      "manifest",
      "summary.json",
    );
    const invalidSummary = JSON.parse(
      await readFile(invalidSummaryPath, "utf8"),
    );
    delete invalidSummary.failurePart;
    await writeFile(invalidSummaryPath, JSON.stringify(invalidSummary));
    const inputCoverage = path.join(root, "coverage-input.json");
    await writeFile(
      inputCoverage,
      JSON.stringify({ county: "duval", datasets: [] }),
    );

    await expect(
      reconcileBbbHarvests({
        countyKey: duvalEnrichmentProfile.countyKey,
        categories: BBB_CATEGORIES,
        harvestDirs,
        inputCoverage,
        outputCoverage: path.join(root, "coverage-output.json"),
        outputProfiles: path.join(root, "bbb-profiles.jsonl"),
        outputManifest: path.join(root, "bbb-manifest.json"),
      }),
    ).rejects.toThrow(/Incomplete or unreconciled/);
  });
});
