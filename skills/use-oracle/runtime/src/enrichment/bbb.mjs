import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

const SCHEMA_VERSION = "elephant.bbb-category-harvest.v1";
const SOURCE_ACCESS_EVIDENCE_SCHEMA_VERSION =
  "elephant.bbb-source-access-evidence.v1";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

function requireCountyKey(countyKey) {
  if (
    typeof countyKey !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(countyKey)
  ) {
    throw new Error("BBB enrichment requires a valid countyKey");
  }
  return countyKey;
}

function validateReviewedCategory(category) {
  if (
    !category ||
    typeof category.key !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(category.key) ||
    typeof category.url !== "string" ||
    typeof category.reviewedPath !== "string"
  ) {
    throw new Error("BBB enrichment requires a reviewed category definition");
  }
  const url = new URL(category.url);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "www.bbb.org" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== category.reviewedPath ||
    !url.pathname.includes("/category/")
  ) {
    throw new Error(
      `BBB category must match its exact reviewed path: ${category.key}`,
    );
  }
  return category;
}

function requireCategoryOptions(options) {
  const countyKey = requireCountyKey(options.countyKey);
  const category = validateReviewedCategory(options.reviewedCategory);
  if (
    options.categoryKey !== category.key ||
    options.categoryUrl !== category.url
  ) {
    throw new Error(
      `BBB category does not match the reviewed scope for ${countyKey}: ${options.categoryKey}`,
    );
  }
  return { countyKey, category };
}

function reviewedCategoryMap(categories) {
  if (!Array.isArray(categories) || categories.length === 0) {
    throw new Error("BBB enrichment requires reviewed categories");
  }
  const byKey = new Map();
  for (const value of categories) {
    const category = validateReviewedCategory(value);
    if (byKey.has(category.key)) {
      throw new Error(`Duplicate reviewed BBB category: ${category.key}`);
    }
    byKey.set(category.key, category);
  }
  return byKey;
}

export function validateReviewedBbbCategories(categories) {
  return [...reviewedCategoryMap(categories).values()];
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function canonicalUrl(value) {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

function canonicalProfileBaseUrl(value) {
  const url = new URL(canonicalUrl(value));
  const segments = url.pathname.split("/").filter(Boolean);
  const subpages = new Set([
    "complaints",
    "customer-reviews",
    "details",
    "email-this-business",
    "leave-a-review",
    "more-info",
  ]);
  const subpageIndex = segments.findIndex(
    (segment, index) => index > 0 && subpages.has(segment),
  );
  if (subpageIndex >= 0) {
    url.pathname = `/${segments.slice(0, subpageIndex).join("/")}`;
  }
  return url.toString().replace(/\/$/, "");
}

function isBbbHostname(hostname) {
  return hostname === "bbb.org" || hostname.endsWith(".bbb.org");
}

export function isProfileUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      isBbbHostname(url.hostname) &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname.includes("/profile/")
    );
  } catch {
    return false;
  }
}

export function parseBbbProfileUrlIdentity(profileUrl) {
  const segments = new URL(profileUrl).pathname.split("/").filter(Boolean);
  const addressIndex = segments.indexOf("addressId");
  const addressId =
    addressIndex >= 0 ? (segments[addressIndex + 1] ?? null) : null;
  const profileSegment =
    addressIndex >= 0
      ? (segments[addressIndex - 1] ?? null)
      : (segments.at(-1) ?? null);
  const match =
    /^(?<slug>.+)-(?<providerBbbId>\d{4})-(?<providerBusinessId>\d+)$/.exec(
      profileSegment ?? "",
    );
  return {
    providerBbbId: match?.groups?.providerBbbId ?? null,
    providerBusinessId: match?.groups?.providerBusinessId ?? null,
    addressId,
    slug: match?.groups?.slug ?? profileSegment,
  };
}

export function parseCategoryCounts(snapshot) {
  const totalMatch = /Showing:\s*([\d,]+)\s+results?/i.exec(snapshot.text);
  const totalResults =
    totalMatch === null ? null : Number(totalMatch[1].replace(/,/g, ""));
  const pageNumbers = (snapshot.links ?? []).flatMap((link) => {
    const textMatch = /^Page\s+(\d+)$/i.exec(link.text);
    let queryPage = null;
    try {
      const value = Number(new URL(link.href).searchParams.get("page"));
      if (Number.isInteger(value) && value > 0) queryPage = value;
    } catch {
      queryPage = null;
    }
    return [textMatch ? Number(textMatch[1]) : null, queryPage].filter(
      (value) => value !== null,
    );
  });
  return {
    totalResults,
    pageCount: pageNumbers.length > 0 ? Math.max(...pageNumbers) : null,
  };
}

function flattenJsonLd(rawValues) {
  const values = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    values.push(value);
    if (Array.isArray(value["@graph"])) value["@graph"].forEach(visit);
  };
  for (const raw of rawValues ?? []) {
    try {
      visit(JSON.parse(raw));
    } catch {
      // Raw JSON-LD remains in the evidence snapshot.
    }
  }
  return values;
}

function typeMatches(value, expected) {
  return typeof value === "string"
    ? value === expected
    : Array.isArray(value) && value.includes(expected);
}

function readLabel(text, label) {
  const match = new RegExp(
    `${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*([^\\n]+)`,
    "i",
  ).exec(text);
  return match?.[1]?.trim() ?? null;
}

function firstExternalWebsite(links) {
  for (const link of links ?? []) {
    try {
      const url = new URL(link.href);
      if (
        ["http:", "https:"].includes(url.protocol) &&
        !isBbbHostname(url.hostname) &&
        !/facebook|instagram|linkedin|twitter|x\.com/i.test(url.hostname)
      ) {
        return link.href;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function parseAccreditation(text) {
  if (/Not BBB Accredited|is not BBB Accredited/i.test(text)) return false;
  if (/BBB Accredited Business|is BBB Accredited/i.test(text)) return true;
  return null;
}

function parseRating(text) {
  return (
    /\n\s*([A-F][+-]?|NR)\s*\n\s*Rated by BBB/i.exec(text)?.[1] ??
    /BBB Rating\s*\n\s*([A-F][+-]?|NR)/i.exec(text)?.[1] ??
    null
  );
}

function integerMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return Number(match[1].replace(/,/g, ""));
  }
  return null;
}

export function buildBbbBusinessProfileRecord({
  profileUrl,
  listing,
  mainPage,
  subpages,
  retrievedAt,
}) {
  const identity = parseBbbProfileUrlIdentity(profileUrl);
  const jsonLd = flattenJsonLd(mainPage.jsonLd);
  const localBusiness =
    jsonLd.find((value) => typeMatches(value["@type"], "LocalBusiness")) ?? {};
  const complaintsPage =
    subpages.find((subpage) => subpage.kind === "complaints")?.page ?? null;
  const reviewsPage =
    subpages.find((subpage) => subpage.kind === "customer-reviews")?.page ?? null;
  return {
    recordKind: "bbb_business_profile",
    schemaVersion: SCHEMA_VERSION,
    source: "bbb-public-browser",
    sourceRetrievedAt: retrievedAt,
    profileUrl,
    providerProfileId:
      identity.providerBbbId && identity.providerBusinessId
        ? [identity.providerBbbId, identity.providerBusinessId, identity.addressId]
            .filter(Boolean)
            .join(":")
        : createHash("sha256").update(profileUrl).digest("hex").slice(0, 24),
    providerBusinessId: identity.providerBusinessId,
    providerBbbId: identity.providerBbbId,
    profileSlug: identity.slug,
    name: localBusiness.name ?? listing?.linkText ?? mainPage.headings?.[0] ?? null,
    legalName: localBusiness.legalName ?? null,
    description: localBusiness.description ?? null,
    phone:
      localBusiness.telephone ??
      mainPage.links?.find((link) => link.href.startsWith("tel:"))?.text ??
      null,
    websiteUrl: firstExternalWebsite(mainPage.links),
    address:
      localBusiness.address &&
      typeof localBusiness.address === "object" &&
      !Array.isArray(localBusiness.address)
        ? localBusiness.address
        : null,
    accredited: parseAccreditation(mainPage.text),
    accreditedSince: readLabel(mainPage.text, "BBB Accredited Since"),
    bbbRating: parseRating(mainPage.text),
    bbbFileOpenedDate: readLabel(mainPage.text, "BBB File Opened"),
    businessStarted: readLabel(mainPage.text, "Business Started"),
    businessIncorporated: readLabel(mainPage.text, "Business Incorporated"),
    entityType: readLabel(mainPage.text, "Type of Entity"),
    reviewsComplaintsSummary: {
      reviewsTotal: reviewsPage
        ? integerMatch(reviewsPage.text, [
            /This business has\s+(\d+)\s+reviews?/i,
            /(\d+)\s+Customer Reviews?/i,
          ])
        : null,
      complaintsTotal: complaintsPage
        ? integerMatch(complaintsPage.text, [
            /This business has\s+(\d+)\s+complaints?/i,
            /(\d+)\s+complaints? in (?:the )?last 3 years/i,
          ])
        : null,
    },
    bbbHarvest: {
      listing,
      mainPage,
      subpages,
      rawJsonLdObjects: jsonLd,
    },
  };
}

async function snapshotPage(page, includeHtml) {
  return page.evaluate((shouldIncludeHtml) => {
    const links = [...document.querySelectorAll("a[href]")].map((anchor) => ({
      text: anchor.textContent?.trim().replace(/\s+/g, " ") ?? "",
      href: anchor.href,
    }));
    const headings = [...document.querySelectorAll("h1,h2,h3,h4")]
      .map((heading) => heading.textContent?.trim().replace(/\s+/g, " ") ?? "")
      .filter(Boolean);
    const jsonLd = [
      ...document.querySelectorAll('script[type="application/ld+json"]'),
    ]
      .map((script) => script.textContent ?? "")
      .filter(Boolean);
    return {
      url: location.href,
      title: document.title,
      text: document.body?.innerText ?? "",
      headings,
      links,
      jsonLd,
      html: shouldIncludeHtml ? document.documentElement.outerHTML : null,
    };
  }, includeHtml);
}

function isChallenge(title, text) {
  return (
    /Just a moment/i.test(title) ||
    /Just a moment\.\.\./i.test(text) ||
    /OOPS! WE'LL BE RIGHT BACK/i.test(text) ||
    /Error \| Better Business Bureau/i.test(title)
  );
}

async function gotoAccessiblePage(page, url, options, budget) {
  let result = {
    ok: false,
    status: null,
    title: "",
    text: "",
    finalUrl: url,
    failureReason: "network",
  };
  for (let attempt = 0; attempt < options.challengeAttempts; attempt += 1) {
    if (Date.now() - budget.startedAtMs >= budget.maxDurationMs) {
      throw new Error(
        `BBB harvest exceeded its ${budget.maxDurationMs}ms duration bound`,
      );
    }
    if (budget.requestCount >= budget.maxRequests) {
      throw new Error(
        `BBB harvest exceeded its ${budget.maxRequests}-request bound`,
      );
    }
    budget.requestCount += 1;
    const response = await page
      .goto(url, {
        waitUntil: "domcontentloaded",
        timeout: options.navigationTimeoutMs,
      })
      .catch(() => null);
    for (
      let check = 0;
      check < options.challengeChecksPerAttempt;
      check += 1
    ) {
      await sleep(options.challengeCheckIntervalMs);
      const title = await page.title();
      const text = await page.evaluate(
        () => document.body?.innerText?.slice(0, 500) ?? "",
      );
      const finalUrl =
        typeof page.url === "function" ? page.url() : url;
      let finalHostValid = false;
      try {
        const parsedFinalUrl = new URL(finalUrl);
        finalHostValid =
          parsedFinalUrl.protocol === "https:" &&
          isBbbHostname(parsedFinalUrl.hostname);
      } catch {
        finalHostValid = false;
      }
      const status = response?.status() ?? null;
      const statusValid =
        status !== null && status >= 200 && status < 400;
      const failureReason =
        status === 403
          ? "blocked"
          : status === 429
            ? "rate_limited"
            : status === 404 || status === 410
              ? "permanent_not_found"
              : status !== null && status >= 500
                ? "server_error"
                : isChallenge(title, text)
                  ? "challenge"
                  : !finalHostValid
                    ? "redirected_off_bbb"
                    : status === null
                      ? "network"
                      : "http_error";
      result = {
        ok: statusValid && finalHostValid && !isChallenge(title, text),
        status,
        title,
        text,
        finalUrl,
        failureReason,
      };
      if (result.ok) return result;
      if (
        ["blocked", "rate_limited", "permanent_not_found", "redirected_off_bbb"].includes(
          result.failureReason,
        )
      ) {
        return result;
      }
    }
  }
  return result;
}

function categoryPageUrl(categoryUrl, pageNumber) {
  const url = new URL(categoryUrl);
  if (pageNumber <= 1) url.searchParams.delete("page");
  else url.searchParams.set("page", String(pageNumber));
  return url.toString();
}

function listingsFromSnapshot(snapshot, categoryUrl, pageNumber) {
  const seen = new Set();
  const listings = [];
  for (const link of snapshot.links ?? []) {
    if (!isProfileUrl(link.href)) continue;
    const profileUrl = canonicalProfileBaseUrl(link.href);
    if (seen.has(profileUrl)) continue;
    seen.add(profileUrl);
    listings.push({
      profileUrl,
      linkText: link.text,
      categoryUrl,
      pageNumber,
      ordinalOnPage: listings.length + 1,
    });
  }
  return listings;
}

function discoverSubpages(snapshot, selectedKinds) {
  const targets = [];
  for (const kind of selectedKinds) {
    const link = snapshot.links?.find((candidate) =>
      candidate.href.includes(`/${kind}`),
    );
    if (link) targets.push({ kind, url: canonicalUrl(link.href) });
  }
  return targets;
}

async function writeJsonl(outputDir, relativePath, records) {
  const body = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  const filePath = path.join(outputDir, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, body, "utf8");
  return {
    relativePath,
    recordCount: records.length,
    bytes: Buffer.byteLength(body),
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function buildBbbRequestContract(options) {
  const { countyKey, category } = requireCategoryOptions(options);
  const request = {
    schemaVersion: "elephant.bbb-harvest-request.v1",
    jobId: options.jobId,
    county: countyKey,
    categoryKey: category.key,
    categoryUrl: category.url,
    maxPages: options.maxPages,
    maxProfiles: options.maxProfiles,
    maxRequests: options.maxRequests,
    maxDurationMs: options.maxDurationMs,
    partRecordLimit: options.partRecordLimit,
    pageDelayMs: options.pageDelayMs,
    profileDelayMs: options.profileDelayMs,
    navigationTimeoutMs: options.navigationTimeoutMs,
    challengeAttempts: options.challengeAttempts,
    challengeCheckIntervalMs: options.challengeCheckIntervalMs,
    challengeChecksPerAttempt: options.challengeChecksPerAttempt,
    includeHtml: options.includeHtml,
    profileSubpages: options.profileSubpages,
  };
  return {
    ...request,
    requestSha256: createHash("sha256")
      .update(JSON.stringify(request))
      .digest("hex"),
  };
}

export function createBbbSourceAccessEvidenceSchema({
  countyKey,
  categories,
}) {
  requireCountyKey(countyKey);
  const categoriesByKey = reviewedCategoryMap(categories);
  return z
    .object({
      schemaVersion: z.literal(SOURCE_ACCESS_EVIDENCE_SCHEMA_VERSION),
      source: z.literal("bbb-public-browser"),
      runId: z
        .string()
        .min(8)
        .max(100)
        .regex(/^[a-z0-9][a-z0-9-]*$/),
      batchRequestSha256: z.string().regex(/^[a-f0-9]{64}$/),
      observedBatchJobId: z.string().uuid(),
      observedAt: z.string().datetime({ offset: true }),
      observedCategoryKey: z
        .string()
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      observedUrl: z.string().url(),
      httpStatus: z.literal(403),
      classification: z.literal("blocked"),
      failureReason: z.literal("blocked"),
      operatorDirective: z.literal("stop_no_further_bbb_requests"),
    })
    .strict()
    .superRefine((evidence, context) => {
      const category = categoriesByKey.get(evidence.observedCategoryKey);
      if (!category) {
        context.addIssue({
          code: "custom",
          path: ["observedCategoryKey"],
          message: `Observed category is outside the reviewed BBB scope for ${countyKey}`,
        });
        return;
      }
      const observedUrl = new URL(evidence.observedUrl);
      const pageValues = observedUrl.searchParams.getAll("page");
      const hasOnlyPageParameter = [...observedUrl.searchParams.keys()].every(
        (key) => key === "page",
      );
      const validPage =
        pageValues.length === 0 ||
        (pageValues.length === 1 &&
          /^[1-9]\d*$/.test(pageValues[0]) &&
          Number.isSafeInteger(Number(pageValues[0])));
      if (
        observedUrl.protocol !== "https:" ||
        observedUrl.hostname !== "www.bbb.org" ||
        observedUrl.port !== "" ||
        observedUrl.username !== "" ||
        observedUrl.password !== "" ||
        observedUrl.hash !== "" ||
        observedUrl.pathname !== category.reviewedPath ||
        !hasOnlyPageParameter ||
        !validPage
      ) {
        context.addIssue({
          code: "custom",
          path: ["observedUrl"],
          message:
            "Observed URL must be the reviewed BBB category URL with only an optional positive page parameter",
        });
      }
    });
}

export function validateBbbSourceAccessEvidence(value, config) {
  return createBbbSourceAccessEvidenceSchema(config).parse(value);
}

export function buildBlockedBbbCategorySummary(options) {
  const { countyKey, category } = requireCategoryOptions(options);
  const evidence = validateBbbSourceAccessEvidence(
    options.sourceAccessEvidence,
    {
      countyKey,
      categories: options.reviewedCategories,
    },
  );
  const sourceAccessStatus =
    category.key === evidence.observedCategoryKey
      ? "blocked"
      : "not_attempted_after_source_block";
  const request = buildBbbRequestContract(options);
  const artifactCreatedAt = options.artifactCreatedAt;
  if (
    typeof artifactCreatedAt !== "string" ||
    !Number.isFinite(Date.parse(artifactCreatedAt))
  ) {
    throw new Error("Blocked BBB summary requires artifactCreatedAt");
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    jobId: options.jobId,
    county: countyKey,
    source: "bbb-public-browser",
    categoryKey: category.key,
    categoryUrl: category.url,
    startedAt: artifactCreatedAt,
    finishedAt: artifactCreatedAt,
    advertisedResults: null,
    discoveredPageCount: null,
    categoryPagesVisited: 0,
    profileUrlsDiscovered: 0,
    profilesSelected: 0,
    profilesHarvested: 0,
    profilesFailedPermanent: 0,
    requestCount: 0,
    maxRequests: options.maxRequests,
    maxDurationMs: options.maxDurationMs,
    bounds: {
      maxPages: options.maxPages,
      maxProfiles: options.maxProfiles,
      maxRequests: options.maxRequests,
      maxDurationMs: options.maxDurationMs,
      profileSubpages: options.profileSubpages,
    },
    requestSha256: request.requestSha256,
    resumed: false,
    advertisedResultsAreCompletenessDenominator: false,
    completeWithinBounds: false,
    sourceAccessStatus,
    sourceAccessEvidence: evidence,
    categoryPagePart: null,
    profileParts: [],
    failurePart: null,
  };
}

export async function writeBlockedBbbCategoryArtifact(options) {
  await mkdir(options.outputDir, { recursive: true });
  if ((await readdir(options.outputDir)).length > 0) {
    throw new Error(`BBB output directory is not empty: ${options.outputDir}`);
  }
  const request = buildBbbRequestContract(options);
  const summary = buildBlockedBbbCategorySummary({
    ...options,
    artifactCreatedAt: options.artifactCreatedAt ?? new Date().toISOString(),
  });
  await mkdir(path.join(options.outputDir, "manifest"), { recursive: true });
  await Promise.all([
    writeFile(
      path.join(options.outputDir, "manifest", "request.json"),
      `${JSON.stringify(request, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      path.join(options.outputDir, "manifest", "summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
      "utf8",
    ),
  ]);
  return summary;
}

function profileCheckpointName(profileUrl) {
  return `${createHash("sha256").update(profileUrl).digest("hex")}.json`;
}

export async function harvestBbbCategoryInExistingPage(options, page) {
  const { countyKey, category: reviewedCategory } =
    requireCategoryOptions(options);
  await mkdir(options.outputDir, { recursive: true });
  const existing = await readdir(options.outputDir);
  if (existing.length > 0 && options.resume !== true) {
    throw new Error(`BBB output directory is not empty: ${options.outputDir}`);
  }
  const request = buildBbbRequestContract(options);
  const requestPath = path.join(options.outputDir, "manifest", "request.json");
  const existingRequest = await readJsonIfExists(requestPath);
  if (
    options.resume === true &&
    existingRequest !== null &&
    existingRequest?.requestSha256 !== request.requestSha256
  ) {
    throw new Error("BBB resume request does not match the original request digest");
  }
  await mkdir(path.dirname(requestPath), { recursive: true });
  await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");
  const startedAt = new Date().toISOString();
  const budget = {
    startedAtMs: Date.now(),
    requestCount: 0,
    maxRequests: options.maxRequests ?? Number.MAX_SAFE_INTEGER,
    maxDurationMs: options.maxDurationMs ?? Number.MAX_SAFE_INTEGER,
  };
  const categoryPages = [];
  const listings = new Map();
  let advertisedResults = null;
  let discoveredPageCount = null;
  const pageLimit = options.maxPages ?? 1;

  for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
    const url = categoryPageUrl(reviewedCategory.url, pageNumber);
    const navigation = await gotoAccessiblePage(page, url, options, budget);
    if (!navigation.ok) {
      throw new Error(
        `BBB category-page failure [${navigation.failureReason}] (${navigation.status ?? "no status"}): ${url}`,
      );
    }
    const snapshot = await snapshotPage(page, options.includeHtml);
    const counts = parseCategoryCounts(snapshot);
    advertisedResults ??= counts.totalResults;
    discoveredPageCount ??= counts.pageCount ?? 1;
    const pageListings = listingsFromSnapshot(
      snapshot,
      reviewedCategory.url,
      pageNumber,
    );
    categoryPages.push({
      recordKind: "bbb_category_page",
      schemaVersion: SCHEMA_VERSION,
      categoryKey: reviewedCategory.key,
      categoryUrl: reviewedCategory.url,
      pageNumber,
      totalResults: counts.totalResults,
      pageCount: counts.pageCount,
      profileListings: pageListings,
      rawPage: snapshot,
    });
    for (const listing of pageListings) {
      if (!listings.has(listing.profileUrl)) {
        listings.set(listing.profileUrl, listing);
      }
    }
    if (pageNumber >= discoveredPageCount) break;
    await sleep(options.pageDelayMs);
  }

  const categoryPagePart = await writeJsonl(
    options.outputDir,
    "category-pages/category-pages.jsonl",
    categoryPages,
  );
  const selected = [...listings.values()].slice(
    0,
    options.maxProfiles ?? undefined,
  );
  const profileParts = [];
  const permanentFailures = [];
  let pendingProfiles = [];
  const flushProfiles = async (force = false) => {
    if (
      pendingProfiles.length === 0 ||
      (!force && pendingProfiles.length < options.partRecordLimit)
    ) {
      return;
    }
    profileParts.push(
      await writeJsonl(
        options.outputDir,
        `profiles/profiles-part-${String(profileParts.length + 1).padStart(4, "0")}.jsonl`,
        pendingProfiles,
      ),
    );
    pendingProfiles = [];
  };

  for (const listing of selected) {
    const checkpointPath = path.join(
      options.outputDir,
      "checkpoints",
      "profiles",
      profileCheckpointName(listing.profileUrl),
    );
    const checkpointRelativePath = path
      .relative(options.outputDir, checkpointPath)
      .replaceAll(path.sep, "/");
    let checkpoint =
      options.resume === true ? await readJsonIfExists(checkpointPath) : null;
    if (
      checkpoint === null &&
      options.resume === true &&
      typeof options.loadCheckpoint === "function"
    ) {
      checkpoint = await options.loadCheckpoint({
        profileUrl: listing.profileUrl,
        relativePath: checkpointRelativePath,
        requestSha256: request.requestSha256,
      });
      if (checkpoint !== null) {
        await mkdir(path.dirname(checkpointPath), { recursive: true });
        await writeFile(
          checkpointPath,
          `${JSON.stringify(checkpoint, null, 2)}\n`,
          "utf8",
        );
      }
    }
    if (
      checkpoint !== null &&
      checkpoint.requestSha256 !== request.requestSha256
    ) {
      throw new Error(
        `BBB checkpoint request digest mismatch: ${checkpointRelativePath}`,
      );
    }
    if (checkpoint?.status === "harvested") {
      pendingProfiles.push(checkpoint.record);
      await flushProfiles();
      continue;
    }
    if (checkpoint?.status === "permanent_failure") {
      permanentFailures.push(checkpoint.failure);
      continue;
    }
    await sleep(options.profileDelayMs);
    const navigation = await gotoAccessiblePage(
      page,
      listing.profileUrl,
      options,
      budget,
    );
    if (!navigation.ok) {
      if ([404, 410].includes(navigation.status)) {
        const failure = {
          recordKind: "bbb_profile_failure",
          schemaVersion: SCHEMA_VERSION,
          profileUrl: listing.profileUrl,
          status: navigation.status,
          classification: "PERMANENT",
        };
        permanentFailures.push(failure);
        const checkpointValue = {
          requestSha256: request.requestSha256,
          status: "permanent_failure",
          failure,
        };
        await mkdir(path.dirname(checkpointPath), { recursive: true });
        await writeFile(
          checkpointPath,
          `${JSON.stringify(checkpointValue, null, 2)}\n`,
          "utf8",
        );
        if (typeof options.onCheckpoint === "function") {
          await options.onCheckpoint({
            profileUrl: listing.profileUrl,
            relativePath: checkpointRelativePath,
            requestSha256: request.requestSha256,
            checkpoint: checkpointValue,
          });
        }
        continue;
      }
      throw new Error(
        `BBB profile failure [${navigation.failureReason}] (${navigation.status ?? "no status"}): ${listing.profileUrl}`,
      );
    }
    const mainPage = await snapshotPage(page, options.includeHtml);
    const subpages = [];
    for (const target of discoverSubpages(mainPage, options.profileSubpages)) {
      await sleep(options.profileDelayMs);
      const subpageNavigation = await gotoAccessiblePage(
        page,
        target.url,
        options,
        budget,
      );
      if (!subpageNavigation.ok) {
        if ([404, 410].includes(subpageNavigation.status)) continue;
        throw new Error(
          `BBB profile-subpage failure [${subpageNavigation.failureReason}] (${subpageNavigation.status ?? "no status"}): ${target.url}`,
        );
      }
      subpages.push({
        kind: target.kind,
        url: target.url,
        status: subpageNavigation.status,
        ok: true,
        page: await snapshotPage(page, options.includeHtml),
        error: null,
      });
    }
    const record = buildBbbBusinessProfileRecord({
      profileUrl: listing.profileUrl,
      listing,
      mainPage,
      subpages,
      retrievedAt: new Date().toISOString(),
    });
    const checkpointValue = {
      requestSha256: request.requestSha256,
      status: "harvested",
      record,
    };
    await mkdir(path.dirname(checkpointPath), { recursive: true });
    await writeFile(
      checkpointPath,
      `${JSON.stringify(checkpointValue, null, 2)}\n`,
      "utf8",
    );
    if (typeof options.onCheckpoint === "function") {
      await options.onCheckpoint({
        profileUrl: listing.profileUrl,
        relativePath: checkpointRelativePath,
        requestSha256: request.requestSha256,
        checkpoint: checkpointValue,
      });
    }
    pendingProfiles.push(record);
    await flushProfiles();
  }
  await flushProfiles(true);
  let failurePart = null;
  if (permanentFailures.length > 0) {
    failurePart = await writeJsonl(
      options.outputDir,
      "failures/failed-profiles.jsonl",
      permanentFailures,
    );
  }

  const profilesHarvested = profileParts.reduce(
    (total, part) => total + part.recordCount,
    0,
  );
  const summary = {
    schemaVersion: SCHEMA_VERSION,
    jobId: options.jobId,
    county: countyKey,
    source: "bbb-public-browser",
    categoryKey: reviewedCategory.key,
    categoryUrl: reviewedCategory.url,
    startedAt,
    finishedAt: new Date().toISOString(),
    advertisedResults,
    discoveredPageCount,
    categoryPagesVisited: categoryPages.length,
    profileUrlsDiscovered: listings.size,
    profilesSelected: selected.length,
    profilesHarvested,
    profilesFailedPermanent: permanentFailures.length,
    requestCount: budget.requestCount,
    maxRequests: budget.maxRequests,
    maxDurationMs: budget.maxDurationMs,
    bounds: {
      maxPages: options.maxPages,
      maxProfiles: options.maxProfiles,
      maxRequests: budget.maxRequests,
      maxDurationMs: budget.maxDurationMs,
      profileSubpages: options.profileSubpages,
    },
    requestSha256: request.requestSha256,
    resumed: options.resume === true,
    advertisedResultsAreCompletenessDenominator: false,
    completeWithinBounds:
      profilesHarvested + permanentFailures.length === selected.length,
    categoryPagePart,
    profileParts,
    failurePart,
  };
  await mkdir(path.join(options.outputDir, "manifest"), { recursive: true });
  await writeFile(
    path.join(options.outputDir, "manifest", "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );
  return summary;
}

async function configurePage(browser, navigationTimeoutMs) {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(navigationTimeoutMs);
  page.setDefaultTimeout(navigationTimeoutMs);
  await page.setCacheEnabled(false);
  await page.setViewport({ width: 1365, height: 900 });
  await page.setUserAgent(USER_AGENT);
  return page;
}

export async function harvestBbbCategory(options) {
  const executablePath = options.chromiumExecutablePath;
  if (typeof executablePath !== "string" || executablePath.length === 0) {
    throw new Error("BBB harvest requires an explicit Chromium executable path");
  }
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.launch({
    executablePath,
    headless: options.headless,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1365,900",
    ],
    defaultViewport: { width: 1365, height: 900 },
  });
  try {
    const page = await configurePage(browser, options.navigationTimeoutMs);
    return await harvestBbbCategoryInExistingPage(options, page);
  } finally {
    await browser.close();
  }
}
