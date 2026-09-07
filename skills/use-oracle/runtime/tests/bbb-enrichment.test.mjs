import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildBlockedBbbCategorySummary,
  harvestBbbCategoryInExistingPage,
  isProfileUrl,
  parseBbbProfileUrlIdentity,
  parseCategoryCounts,
  validateBbbSourceAccessEvidence,
  writeBlockedBbbCategoryArtifact,
} from "../src/enrichment/bbb.mjs";
import { duvalEnrichmentProfile } from "../src/counties/duval/enrichment-profile.mjs";

const temporaryDirectories = [];
const COUNTY_KEY = duvalEnrichmentProfile.countyKey;
const BBB_CATEGORIES = duvalEnrichmentProfile.bbb.categories;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Duval BBB enrichment", () => {
  const blockedEvidence = {
    schemaVersion: "elephant.bbb-source-access-evidence.v1",
    source: "bbb-public-browser",
    runId: "duval-r2-test",
    batchRequestSha256: "a".repeat(64),
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

  it("locks the three reviewed Jacksonville category seeds", () => {
    expect(BBB_CATEGORIES.map(({ key, url }) => ({ key, url }))).toEqual([
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
  });

  it("parses BBB profile identities and advertised category counts", () => {
    expect(
      parseBbbProfileUrlIdentity(
        "https://www.bbb.org/us/fl/jacksonville/profile/roofing-contractors/example-roofing-0403-123456/addressId/99",
      ),
    ).toEqual({
      providerBbbId: "0403",
      providerBusinessId: "123456",
      addressId: "99",
      slug: "example-roofing",
    });
    expect(
      parseCategoryCounts({
        text: "Showing: 41 results for Roofing Contractors",
        links: [
          {
            text: "Page 3",
            href: "https://www.bbb.org/us/fl/jacksonville/category/roofing-contractors?page=3",
          },
        ],
      }),
    ).toEqual({ totalResults: 41, pageCount: 3 });
  });

  it("accepts only HTTPS profiles on the exact BBB domain boundary", () => {
    expect(
      isProfileUrl(
        "https://www.bbb.org/us/fl/testville/profile/example/example-0403-1",
      ),
    ).toBe(true);
    expect(
      isProfileUrl(
        "https://business.bbb.org/us/fl/testville/profile/example/example-0403-1",
      ),
    ).toBe(true);
    expect(
      isProfileUrl(
        "https://evilbbb.org/us/fl/testville/profile/example/example-0403-1",
      ),
    ).toBe(false);
    expect(
      isProfileUrl(
        "http://www.bbb.org/us/fl/testville/profile/example/example-0403-1",
      ),
    ).toBe(false);
  });

  it("runs a bounded probe into checksummed profile parts and a reconciled manifest", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "bbb-duval-"));
    temporaryDirectories.push(outputDir);
    const categoryUrl = BBB_CATEGORIES[0].url;
    const profileUrl =
      "https://www.bbb.org/us/fl/jacksonville/profile/roofing-contractors/example-roofing-0403-123456";
    let currentUrl = categoryUrl;
    let profileNavigationCount = 0;
    const page = {
      goto: async (url) => {
        currentUrl = url;
        if (url === profileUrl) profileNavigationCount += 1;
        return { status: () => 200 };
      },
      title: async () => "Accessible BBB page",
      evaluate: async (_callback, ...args) => {
        if (args.length === 0) return "";
        if (currentUrl === categoryUrl) {
          return {
            url: categoryUrl,
            title: "Roofing Contractors near Jacksonville, FL",
            text: "Showing: 1 result for Roofing Contractors",
            headings: [],
            links: [{ text: "Example Roofing LLC", href: profileUrl }],
            jsonLd: [],
            html: null,
          };
        }
        return {
          url: profileUrl,
          title: "Example Roofing LLC | BBB Business Profile",
          text: "BUSINESS PROFILE\nRoofing Contractors\nExample Roofing LLC\nBBB Accredited Business\nA+\nRated by BBB",
          headings: ["Example Roofing LLC"],
          links: [{ text: "Visit Website", href: "https://example.invalid/" }],
          jsonLd: [
            JSON.stringify({
              "@context": "https://schema.org",
              "@type": "LocalBusiness",
              name: "Example Roofing LLC",
              telephone: "(904) 555-0100",
              address: {
                "@type": "PostalAddress",
                streetAddress: "100 Main St",
                addressLocality: "Jacksonville",
                addressRegion: "FL",
                postalCode: "32202",
              },
            }),
          ],
          html: null,
        };
      },
    };

    const remoteCheckpoints = new Map();
    const options = {
      countyKey: COUNTY_KEY,
      reviewedCategory: BBB_CATEGORIES[0],
      jobId: "bbb-duval-roofing-probe",
      categoryKey: "roofing-contractors",
      categoryUrl,
      outputDir,
      maxPages: 2,
      maxProfiles: 1,
      partRecordLimit: 1,
      pageDelayMs: 0,
      profileDelayMs: 0,
      navigationTimeoutMs: 1_000,
      challengeAttempts: 1,
      challengeCheckIntervalMs: 0,
      challengeChecksPerAttempt: 1,
      maxRequests: 5,
      maxDurationMs: 30_000,
      includeHtml: true,
      profileSubpages: [],
      onCheckpoint: async (event) => {
        remoteCheckpoints.set(event.profileUrl, event.checkpoint);
      },
    };
    const summary = await harvestBbbCategoryInExistingPage(options, page);

    expect(summary).toMatchObject({
      categoryPagesVisited: 1,
      advertisedResults: 1,
      profileUrlsDiscovered: 1,
      profilesHarvested: 1,
      profilesFailedPermanent: 0,
      completeWithinBounds: true,
    });
    expect(summary.profileParts).toHaveLength(1);
    expect(summary.profileParts[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    const profile = JSON.parse(
      (
        await readFile(
          path.join(outputDir, summary.profileParts[0].relativePath),
          "utf8",
        )
      ).trim(),
    );
    expect(profile).toMatchObject({
      providerProfileId: "0403:123456",
      name: "Example Roofing LLC",
      phone: "(904) 555-0100",
      accredited: true,
      bbbRating: "A+",
      address: { postalCode: "32202" },
    });
    expect(remoteCheckpoints.get(profileUrl)).toMatchObject({
      requestSha256: summary.requestSha256,
      status: "harvested",
    });

    await rm(path.join(outputDir, "checkpoints"), {
      recursive: true,
      force: true,
    });
    await rm(path.join(outputDir, "manifest", "request.json"), {
      force: true,
    });
    const resumed = await harvestBbbCategoryInExistingPage(
      {
        ...options,
        resume: true,
        loadCheckpoint: async (event) =>
          remoteCheckpoints.get(event.profileUrl) ?? null,
      },
      page,
    );
    expect(resumed.resumed).toBe(true);
    expect(profileNavigationCount).toBe(1);
  });

  it("stops immediately on a blocked response instead of retrying aggressively", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "bbb-duval-blocked-"));
    temporaryDirectories.push(outputDir);
    let navigationCount = 0;
    const page = {
      goto: async () => {
        navigationCount += 1;
        return { status: () => 403 };
      },
      title: async () => "Access denied",
      evaluate: async () => "Forbidden",
    };

    await expect(
      harvestBbbCategoryInExistingPage(
        {
          countyKey: COUNTY_KEY,
          reviewedCategory: BBB_CATEGORIES[0],
          jobId: "bbb-duval-blocked-probe",
          categoryKey: "roofing-contractors",
          categoryUrl: BBB_CATEGORIES[0].url,
          outputDir,
          maxPages: 1,
          maxProfiles: 1,
          partRecordLimit: 1,
          pageDelayMs: 0,
          profileDelayMs: 0,
          navigationTimeoutMs: 1_000,
          challengeAttempts: 5,
          challengeCheckIntervalMs: 0,
          challengeChecksPerAttempt: 1,
          maxRequests: 10,
          maxDurationMs: 30_000,
          includeHtml: false,
          profileSubpages: [],
        },
        page,
      ),
    ).rejects.toThrow(/\[blocked\]/);
    expect(navigationCount).toBe(1);
  });

  it("writes zero-profile blocked artifacts without claiming completeness", async () => {
    const outputDir = await mkdtemp(
      path.join(tmpdir(), "bbb-duval-blocked-artifact-"),
    );
    temporaryDirectories.push(outputDir);
    const options = {
      countyKey: COUNTY_KEY,
      reviewedCategory: BBB_CATEGORIES[0],
      reviewedCategories: BBB_CATEGORIES,
      jobId: "duval-r2-test-roofing-contractors",
      categoryKey: "roofing-contractors",
      categoryUrl: BBB_CATEGORIES[0].url,
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
      sourceAccessEvidence: blockedEvidence,
      artifactCreatedAt: "2026-09-05T19:00:00.000Z",
    };
    const summary = await writeBlockedBbbCategoryArtifact(options);
    expect(summary).toMatchObject({
      categoryKey: "roofing-contractors",
      advertisedResults: null,
      profilesSelected: 0,
      profilesHarvested: 0,
      profilesFailedPermanent: 0,
      requestCount: 0,
      profileParts: [],
      completeWithinBounds: false,
      sourceAccessStatus: "blocked",
      sourceAccessEvidence: blockedEvidence,
    });
    const stored = JSON.parse(
      await readFile(path.join(outputDir, "manifest", "summary.json"), "utf8"),
    );
    expect(stored.requestSha256).toMatch(/^[a-f0-9]{64}$/);

    const notAttempted = buildBlockedBbbCategorySummary({
      ...options,
      reviewedCategory: BBB_CATEGORIES[1],
      categoryKey: "solar-energy-system-contractors",
      categoryUrl: BBB_CATEGORIES[1].url,
    });
    expect(notAttempted.sourceAccessStatus).toBe(
      "not_attempted_after_source_block",
    );
  });

  it("strictly rejects weak or mismatched source-access evidence", () => {
    expect(() =>
      validateBbbSourceAccessEvidence({
        ...blockedEvidence,
        httpStatus: 429,
      }, {
        countyKey: COUNTY_KEY,
        categories: BBB_CATEGORIES,
      }),
    ).toThrow();
    expect(() =>
      validateBbbSourceAccessEvidence({
        ...blockedEvidence,
        observedUrl: "https://evil.example/category/roofing-contractors?page=2",
      }, {
        countyKey: COUNTY_KEY,
        categories: BBB_CATEGORIES,
      }),
    ).toThrow(/reviewed BBB category URL/);
    expect(() =>
      validateBbbSourceAccessEvidence({
        ...blockedEvidence,
        observedUrl:
          "https://www.bbb.org/us/fl/jacksonville/category/roofing-contractors?page=0",
      }, {
        countyKey: COUNTY_KEY,
        categories: BBB_CATEGORIES,
      }),
    ).toThrow(/optional positive page/);
    expect(() =>
      validateBbbSourceAccessEvidence({
        ...blockedEvidence,
        observedUrl:
          "https://www.bbb.org/us/fl/jacksonville/category/roofing-contractors?page=2&sort=rating",
      }, {
        countyKey: COUNTY_KEY,
        categories: BBB_CATEGORIES,
      }),
    ).toThrow(/optional positive page/);
    expect(() =>
      validateBbbSourceAccessEvidence({
        ...blockedEvidence,
        unreviewedNote: "trust me",
      }, {
        countyKey: COUNTY_KEY,
        categories: BBB_CATEGORIES,
      }),
    ).toThrow();
  });
});
