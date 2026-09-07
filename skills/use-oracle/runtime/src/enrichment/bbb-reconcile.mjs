import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  validateBbbSourceAccessEvidence,
  validateReviewedBbbCategories,
} from "./bbb.mjs";

export const BBB_PROPERTY_LINKAGE_STATUS = "not_linked";

function upsertCoverageDataset(coverage, dataset) {
  const datasets = Array.isArray(coverage.datasets) ? [...coverage.datasets] : [];
  const index = datasets.findIndex((entry) => entry?.source === dataset.source);
  if (index >= 0) datasets[index] = dataset;
  else datasets.push(dataset);
  return { ...coverage, datasets };
}

function profileIdentity(profile) {
  if (
    typeof profile.providerProfileId === "string" &&
    profile.providerProfileId.length > 0
  ) {
    return `id:${profile.providerProfileId}`;
  }
  if (typeof profile.profileUrl === "string" && profile.profileUrl.length > 0) {
    return `url:${profile.profileUrl}`;
  }
  throw new Error("BBB profile has neither providerProfileId nor profileUrl");
}

function validateBlockedSourceSummary(summary, countyKey, categories) {
  const evidence = validateBbbSourceAccessEvidence(
    summary.sourceAccessEvidence,
    { countyKey, categories },
  );
  const expectedStatus =
    summary.categoryKey === evidence.observedCategoryKey
      ? "blocked"
      : "not_attempted_after_source_block";
  const zeroFields = [
    "categoryPagesVisited",
    "profileUrlsDiscovered",
    "profilesSelected",
    "profilesHarvested",
    "profilesFailedPermanent",
    "requestCount",
  ];
  if (
    summary.completeWithinBounds !== false ||
    summary.advertisedResultsAreCompletenessDenominator !== false ||
    summary.advertisedResults !== null ||
    summary.discoveredPageCount !== null ||
    summary.sourceAccessStatus !== expectedStatus ||
    !zeroFields.every((field) => summary[field] === 0) ||
    !Array.isArray(summary.profileParts) ||
    summary.profileParts.length !== 0 ||
    summary.categoryPagePart !== null ||
    summary.failurePart !== null ||
    !/^[a-f0-9]{64}$/.test(summary.requestSha256 ?? "")
  ) {
    throw new Error(
      `Invalid blocked-source BBB outcome: ${summary.categoryKey}`,
    );
  }
  return evidence;
}

function summaryOutcome(summary, countyKey, categories) {
  if (
    ["blocked", "not_attempted_after_source_block"].includes(
      summary.sourceAccessStatus,
    )
  ) {
    return {
      kind: "blocked",
      evidence: validateBlockedSourceSummary(summary, countyKey, categories),
    };
  }
  if (
    summary.completeWithinBounds !== true ||
    summary.advertisedResultsAreCompletenessDenominator !== false ||
    !Number.isSafeInteger(summary.profilesFailedPermanent) ||
    summary.profilesFailedPermanent < 0 ||
    summary.profilesSelected !==
      summary.profilesHarvested + summary.profilesFailedPermanent ||
    (summary.profilesFailedPermanent === 0
      ? summary.failurePart !== null
      : !summary.failurePart)
  ) {
    throw new Error(`Incomplete or unreconciled BBB harvest: ${summary.categoryKey}`);
  }
  return { kind: "complete", evidence: null };
}

async function readVerifiedPart(harvestDir, part, expectedPrefix, label) {
  if (
    !part ||
    typeof part.relativePath !== "string" ||
    !part.relativePath.startsWith(`${expectedPrefix}/`) ||
    part.relativePath.split("/").includes("..") ||
    !Number.isSafeInteger(part.recordCount) ||
    part.recordCount < 1 ||
    !Number.isSafeInteger(part.bytes) ||
    part.bytes < 1 ||
    !/^[a-f0-9]{64}$/.test(part.sha256 ?? "")
  ) {
    throw new Error(`Invalid BBB ${label} part receipt`);
  }
  const partPath = path.join(harvestDir, part.relativePath);
  const body = await readFile(partPath, "utf8");
  const digest = createHash("sha256").update(body).digest("hex");
  if (digest !== part.sha256 || Buffer.byteLength(body) !== part.bytes) {
    throw new Error(`BBB ${label} part integrity failure: ${part.relativePath}`);
  }
  const lines = body.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length !== part.recordCount) {
    throw new Error(`BBB ${label} part count mismatch: ${part.relativePath}`);
  }
  return lines.map((line) => JSON.parse(line));
}

export async function reconcileBbbHarvests({
  countyKey,
  categories,
  harvestDirs,
  inputCoverage,
  outputCoverage,
  outputProfiles,
  outputFailures,
  outputManifest,
  reconciledAt = new Date().toISOString(),
}) {
  if (
    typeof countyKey !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(countyKey)
  ) {
    throw new Error("BBB reconciliation requires a valid countyKey");
  }
  const reviewedCategories = validateReviewedBbbCategories(categories);
  const categoriesByKey = new Map(
    reviewedCategories.map((category) => [category.key, category]),
  );
  const expectedKeys = reviewedCategories.map((category) => category.key);
  if (harvestDirs.length !== expectedKeys.length) {
    throw new Error(
      `BBB reconciliation requires ${expectedKeys.length} harvest directories for ${countyKey}`,
    );
  }

  const summaries = [];
  const outcomes = [];
  const profilesByIdentity = new Map();
  const permanentFailures = [];
  let rawProfileCount = 0;
  for (const harvestDir of harvestDirs) {
    const summary = JSON.parse(
      await readFile(path.join(harvestDir, "manifest", "summary.json"), "utf8"),
    );
    if (
      summary.schemaVersion !== "elephant.bbb-category-harvest.v1" ||
      summary.county !== countyKey ||
      !categoriesByKey.has(summary.categoryKey)
    ) {
      throw new Error(`Invalid BBB summary in ${harvestDir}`);
    }
    const category = categoriesByKey.get(summary.categoryKey);
    if (summary.categoryUrl !== category.url) {
      throw new Error(`Unexpected BBB category URL: ${summary.categoryKey}`);
    }
    outcomes.push(summaryOutcome(summary, countyKey, reviewedCategories));
    summaries.push(summary);

    let summaryProfileCount = 0;
    for (const part of summary.profileParts ?? []) {
      const profiles = await readVerifiedPart(
        harvestDir,
        part,
        "profiles",
        "profile",
      );
      summaryProfileCount += profiles.length;
      for (const profile of profiles) {
        if (profile.recordKind !== "bbb_business_profile") {
          throw new Error(`Unexpected BBB record kind in ${part.relativePath}`);
        }
        rawProfileCount += 1;
        const identity = profileIdentity(profile);
        if (!profilesByIdentity.has(identity)) {
          profilesByIdentity.set(identity, profile);
        }
      }
    }
    if (summaryProfileCount !== summary.profilesHarvested) {
      throw new Error(
        `BBB summary count mismatch for ${summary.categoryKey}: ${summaryProfileCount} vs ${summary.profilesHarvested}`,
      );
    }
    if (summary.profilesFailedPermanent > 0) {
      const failures = await readVerifiedPart(
        harvestDir,
        summary.failurePart,
        "failures",
        "failure",
      );
      if (failures.length !== summary.profilesFailedPermanent) {
        throw new Error(
          `BBB failure summary count mismatch for ${summary.categoryKey}: ${failures.length} vs ${summary.profilesFailedPermanent}`,
        );
      }
      for (const failure of failures) {
        if (
          failure.recordKind !== "bbb_profile_failure" ||
          failure.classification !== "PERMANENT"
        ) {
          throw new Error(
            `Unexpected BBB permanent-failure record in ${summary.failurePart.relativePath}`,
          );
        }
        permanentFailures.push(failure);
      }
    }
  }
  const actualKeys = summaries.map((summary) => summary.categoryKey).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify([...expectedKeys].sort())) {
    throw new Error("BBB harvest summaries do not cover each reviewed category exactly once");
  }
  const blockedOutcomes = outcomes.filter((outcome) => outcome.kind === "blocked");
  let sourceAccessEvidence = null;
  if (blockedOutcomes.length > 0) {
    const evidenceBodies = new Set(
      blockedOutcomes.map((outcome) => JSON.stringify(outcome.evidence)),
    );
    if (evidenceBodies.size !== 1) {
      throw new Error(
        "Blocked-source BBB outcomes must share identical 403 evidence",
      );
    }
    sourceAccessEvidence = blockedOutcomes[0].evidence;
    const observedBlocked = summaries.filter(
      (summary) => summary.sourceAccessStatus === "blocked",
    );
    if (
      observedBlocked.length !== 1 ||
      observedBlocked[0].categoryKey !== sourceAccessEvidence.observedCategoryKey
    ) {
      throw new Error(
        "Blocked-source BBB recovery requires exactly one directly observed category",
      );
    }
  }

  const uniqueProfiles = [...profilesByIdentity.values()];
  const profileBody =
    uniqueProfiles.map((profile) => JSON.stringify(profile)).join("\n") +
    (uniqueProfiles.length > 0 ? "\n" : "");
  await mkdir(path.dirname(outputProfiles), { recursive: true });
  await writeFile(outputProfiles, profileBody, "utf8");
  const failureBody =
    permanentFailures.map((failure) => JSON.stringify(failure)).join("\n") +
    (permanentFailures.length > 0 ? "\n" : "");
  const reconciledFailuresPath =
    outputFailures ??
    path.join(path.dirname(outputProfiles), "bbb-failures.jsonl");
  await mkdir(path.dirname(reconciledFailuresPath), { recursive: true });
  await writeFile(reconciledFailuresPath, failureBody, "utf8");

  const originalCoverage = JSON.parse(await readFile(inputCoverage, "utf8"));
  if (originalCoverage.county !== countyKey) {
    throw new Error(
      `Coverage county mismatch: expected ${countyKey}, received ${originalCoverage.county ?? "missing"}`,
    );
  }
  const existingBbb = (originalCoverage.datasets ?? []).find(
    (dataset) => dataset?.source === "bbb",
  );
  const coverage = upsertCoverageDataset(
    { ...originalCoverage, exportedAt: reconciledAt },
    {
      county: countyKey,
      source: "bbb",
      ingested_count: uniqueProfiles.length,
      expected_count: null,
      first_loaded_at: existingBbb?.first_loaded_at ?? reconciledAt,
      last_loaded_at: reconciledAt,
      cid: null,
      ipns_label: null,
      linked_property_count: 0,
      valid_unlinked_count: uniqueProfiles.length,
      property_linkage_status: BBB_PROPERTY_LINKAGE_STATUS,
      ...(sourceAccessEvidence === null
        ? {}
        : {
            source_access_status: "blocked",
            source_access_complete: false,
            source_access_evidence: sourceAccessEvidence,
            incomplete_reason: "http_403_source_block",
          }),
      scope: {
        type: "bounded_category_harvest",
        category_keys: expectedKeys,
        advertised_results_are_denominator: false,
        ...(sourceAccessEvidence === null
          ? {}
          : {
              access_complete: false,
              blocked_category_keys: summaries
                .filter((value) => value.sourceAccessStatus === "blocked")
                .map((value) => value.categoryKey),
              not_attempted_category_keys: summaries
                .filter(
                  (value) =>
                    value.sourceAccessStatus ===
                    "not_attempted_after_source_block",
                )
                .map((value) => value.categoryKey),
            }),
      },
    },
  );
  await mkdir(path.dirname(outputCoverage), { recursive: true });
  await writeFile(outputCoverage, `${JSON.stringify(coverage, null, 2)}\n`, "utf8");

  const [profileStat, failureStat] = await Promise.all([
    stat(outputProfiles),
    stat(reconciledFailuresPath),
  ]);
  const summary = {
    schemaVersion: "elephant.bbb-reconciliation.v1",
    county: countyKey,
    reconciledAt,
    categoryCount: summaries.length,
    categories: summaries.map((value) => ({
      categoryKey: value.categoryKey,
      profilesSelected: value.profilesSelected,
      profilesHarvested: value.profilesHarvested,
      profilesFailedPermanent: value.profilesFailedPermanent,
      advertisedResults: value.advertisedResults ?? null,
      requestSha256: value.requestSha256 ?? null,
      sourceAccessStatus: value.sourceAccessStatus ?? "accessible",
      sourceAccessEvidence: value.sourceAccessEvidence ?? null,
    })),
    rawProfileCount,
    uniqueProfileCount: uniqueProfiles.length,
    duplicateProfileCount: rawProfileCount - uniqueProfiles.length,
    linkedPropertyCount: 0,
    propertyLinkageStatus: BBB_PROPERTY_LINKAGE_STATUS,
    sourceAccessStatus:
      sourceAccessEvidence === null ? "accessible" : "blocked",
    sourceAccessComplete: sourceAccessEvidence === null,
    sourceAccessEvidence,
    blockedCategoryKeys: summaries
      .filter((value) => value.sourceAccessStatus === "blocked")
      .map((value) => value.categoryKey),
    notAttemptedCategoryKeys: summaries
      .filter(
        (value) =>
          value.sourceAccessStatus ===
          "not_attempted_after_source_block",
      )
      .map((value) => value.categoryKey),
    profilesBytes: profileStat.size,
    profilesSha256: createHash("sha256").update(profileBody).digest("hex"),
    permanentFailureCount: permanentFailures.length,
    failuresBytes: failureStat.size,
    failuresSha256: createHash("sha256").update(failureBody).digest("hex"),
  };
  await mkdir(path.dirname(outputManifest), { recursive: true });
  await writeFile(outputManifest, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return summary;
}
