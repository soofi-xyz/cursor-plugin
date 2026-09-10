import { existsSync } from "node:fs";

import * as cheerio from "cheerio";
import puppeteer from "puppeteer-core";

import {
  createStablePermitId,
  normalizedPermitRecordSchema,
} from "../contracts.mjs";
import { PermitSourceError } from "../errors.mjs";
import { isRoofPermit, parsePortalDate } from "../normalization.mjs";

const RESULT_HEADERS = Object.freeze([
  "Permit#",
  "Address",
  "Permit Type",
  "Sub Type",
  "Status",
  "Issue Date",
  "Work Description",
]);
const CITIZENSERVE_HOST_PATTERN = /^www\d+\.citizenserve\.com$/u;
const SEARCH_PATH = "/Portal/PortalController";

function cleanText(value) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

function fail(message, code) {
  throw new PermitSourceError(message, {
    classification: "permanent",
    code,
  });
}

function normalizeBaseUrl(value) {
  const base = new URL(value);
  if (
    base.protocol !== "https:" ||
    !CITIZENSERVE_HOST_PATTERN.test(base.hostname) ||
    base.port ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname.replace(/\/+$/u, "") !== "/Portal"
  ) {
    fail(
      "Citizenserve source URL is not an allow-listed public portal host",
      "citizenserve_invalid_configuration",
    );
  }
  return `${base.origin}/Portal`;
}

function validateConfig(jurisdiction) {
  const config = jurisdiction.adapterConfig;
  const baseUrls = [
    config.baseUrl,
    ...(config.fallbackBaseUrls ?? []),
  ].map(normalizeBaseUrl);
  const listingOnlyBaseUrls = (config.listingOnlyBaseUrls ?? []).map(
    normalizeBaseUrl,
  );
  if (
    new Set(baseUrls).size !== baseUrls.length ||
    listingOnlyBaseUrls.some((baseUrl) => !baseUrls.includes(baseUrl)) ||
    !Number.isInteger(config.installationId) ||
    !Array.isArray(config.jurisdictionTokens) ||
    config.jurisdictionTokens.length === 0
  ) {
    fail(
      "Citizenserve jurisdiction configuration is invalid",
      "citizenserve_invalid_configuration",
    );
  }
  return {
    ...config,
    baseUrl: baseUrls[0],
    baseUrls,
    fallbackBaseUrls: baseUrls.slice(1),
    listingOnlyBaseUrls,
    jurisdictionTokens: config.jurisdictionTokens.map((token) =>
      token.toLowerCase(),
    ),
  };
}

function requireConfiguredBaseUrl(config, candidate) {
  const baseUrl = normalizeBaseUrl(candidate);
  if (!config.baseUrls.includes(baseUrl)) {
    fail(
      "Citizenserve source host is not configured for this jurisdiction",
      "citizenserve_source_identity_mismatch",
    );
  }
  return baseUrl;
}

export function buildCitizenserveSearchUrl(
  jurisdiction,
  sourceBaseUrl = null,
) {
  const config = validateConfig(jurisdiction);
  const baseUrl = requireConfiguredBaseUrl(
    config,
    sourceBaseUrl ?? config.baseUrl,
  );
  const query = new URLSearchParams({
    Action: "showSearchPage",
    ctzPagePrefix: "Portal_",
    installationID: String(config.installationId),
    original_contactID: "0",
    original_iid: "0",
  });
  return `${baseUrl}/PortalController?${query.toString()}`;
}

export function buildCitizenserveSearchUrls(jurisdiction) {
  const config = validateConfig(jurisdiction);
  return config.baseUrls.map((baseUrl) =>
    buildCitizenserveSearchUrl(jurisdiction, baseUrl),
  );
}

export function validateCitizenserveSearchPageHtml(html, { jurisdiction }) {
  const config = validateConfig(jurisdiction);
  const $ = cheerio.load(html);
  const installationIds = $("input#installationID")
    .map((_, element) => cleanText($(element).attr("value")))
    .get();
  const fileTypes = $("select#filetype option")
    .map((_, element) => cleanText($(element).attr("value")))
    .get();
  if (
    installationIds.length !== 1 ||
    installationIds[0] !== String(config.installationId) ||
    cleanText($("main h1.page-heading").first().text()) !== "Search" ||
    $("form#frm_PortalSearch").attr("action") !== "PortalController" ||
    !fileTypes.includes("Permit")
  ) {
    fail(
      "Citizenserve search page does not match the configured installation",
      "citizenserve_source_identity_mismatch",
    );
  }
  return {
    installationId: config.installationId,
  };
}

function isHostAvailabilityError(error) {
  return (
    (error instanceof PermitSourceError &&
      error.code === "citizenserve_host_unavailable") ||
    error?.name === "TimeoutError" ||
    /net::ERR_(?:CONNECTION|TIMED_OUT|NAME_NOT_RESOLVED)/u.test(
      error instanceof Error ? error.message : String(error),
    )
  );
}

export async function resolveCitizenserveSource(jurisdiction, probe) {
  const config = validateConfig(jurisdiction);
  for (const [index, baseUrl] of config.baseUrls.entries()) {
    try {
      return await probe({
        baseUrl,
        searchUrl: buildCitizenserveSearchUrl(jurisdiction, baseUrl),
        listingOnly: config.listingOnlyBaseUrls.includes(baseUrl),
      });
    } catch (error) {
      if (
        index === config.baseUrls.length - 1 ||
        !isHostAvailabilityError(error)
      ) {
        throw error;
      }
    }
  }
  fail(
    "Citizenserve has no configured source host",
    "citizenserve_invalid_configuration",
  );
}

function parseDetailLink(href, config) {
  const match =
    typeof href === "string"
      ? /^javascript:openURLLink\('([^']+)'\);?$/u.exec(href)
      : null;
  if (!match) {
    fail(
      "Citizenserve permit row has an invalid detail link",
      "citizenserve_detail_link_changed",
    );
  }
  const detailUrl = new URL(match[1], `${config.baseUrl}/`);
  if (
    detailUrl.protocol !== "https:" ||
    detailUrl.origin !== new URL(config.baseUrl).origin ||
    detailUrl.pathname !== SEARCH_PATH ||
    detailUrl.searchParams.get("Action") !== "viewPortalCase" ||
    detailUrl.searchParams.get("type") !== "Permit" ||
    detailUrl.searchParams.get("installationID") !==
      String(config.installationId) ||
    !detailUrl.searchParams.get("permit_ID") ||
    !detailUrl.searchParams.get("workOrder_ID")
  ) {
    fail(
      "Citizenserve detail link left the configured public source",
      "citizenserve_source_identity_mismatch",
    );
  }
  return detailUrl.toString();
}

export function parseCitizenserveSearchResultsHtml(
  html,
  {
    jurisdiction,
    pageNumber,
    sourceBaseUrl = null,
    searchUrl = null,
    expectedPermitNumber = null,
  },
) {
  const validatedConfig = validateConfig(jurisdiction);
  const activeBaseUrl = requireConfiguredBaseUrl(
    validatedConfig,
    sourceBaseUrl ?? validatedConfig.baseUrl,
  );
  const config = {
    ...validatedConfig,
    baseUrl: activeBaseUrl,
  };
  const activeSearchUrl =
    searchUrl ??
    buildCitizenserveSearchUrl(jurisdiction, activeBaseUrl);
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    fail(
      "Citizenserve page number must be positive",
      "citizenserve_invalid_page",
    );
  }
  const $ = cheerio.load(html);
  const pageInstallationId = cleanText(
    $("input#installationID").first().attr("value"),
  );
  if (
    pageInstallationId !== null &&
    pageInstallationId !== String(config.installationId)
  ) {
    fail(
      "Citizenserve result page changed installation identity",
      "citizenserve_source_identity_mismatch",
    );
  }
  const heading = cleanText($("main h1.page-heading").first().text());
  if (heading !== "Permitting Search Results") {
    fail(
      "Unexpected Citizenserve search-result heading",
      "citizenserve_search_shape_changed",
    );
  }
  const resultText = cleanText($("#resultContent").text()) ?? "";
  const range =
    /(\d+)\s+to\s+(\d+)\s+of\s+(\d+)\s+records?\s+found/iu.exec(
      resultText,
    );
  const explicitEmpty = /\bNo records found\b/iu.test(resultText);
  if (!range && !explicitEmpty) {
    fail(
      "Citizenserve result count is missing",
      "citizenserve_search_shape_changed",
    );
  }
  const rangeStart = range ? Number(range[1]) : 0;
  const rangeEnd = range ? Number(range[2]) : 0;
  const reportedTotal = range ? Number(range[3]) : 0;
  if (
    range &&
    (rangeStart < 1 ||
      rangeEnd < rangeStart ||
      reportedTotal < rangeEnd)
  ) {
    fail(
      "Citizenserve result range is invalid",
      "citizenserve_pagination_changed",
    );
  }
  const headers = $("#resultContent table thead th")
    .map((_, element) => cleanText($(element).text()) ?? "")
    .get();
  if (
    reportedTotal > 0 &&
    (headers.length !== RESULT_HEADERS.length ||
      headers.some((header, index) => header !== RESULT_HEADERS[index]))
  ) {
    fail(
      "Citizenserve permit result columns changed",
      "citizenserve_search_shape_changed",
    );
  }
  const references = [];
  let excludedJurisdictionCount = 0;
  $("#resultContent table tbody tr").each((_, row) => {
    if (reportedTotal === 0) return;
    const cells = $(row).find("td");
    if (cells.length !== RESULT_HEADERS.length) {
      fail(
        "Citizenserve permit result row has unexpected columns",
        "citizenserve_search_shape_changed",
      );
    }
    const anchor = cells.eq(0).find("a").first();
    const permitNumber =
      cleanText(anchor.text()) ?? cleanText(cells.eq(0).text());
    if (!permitNumber) {
      fail(
        "Citizenserve result row has no permit number",
        "citizenserve_source_identity_mismatch",
      );
    }
    if (
      expectedPermitNumber !== null &&
      permitNumber !== expectedPermitNumber
    ) {
      fail(
        "Citizenserve exact-permit search returned a different permit",
        "citizenserve_exact_permit_mismatch",
      );
    }
    const hasPublicDetail = anchor.length > 0;
    if (
      !hasPublicDetail &&
      !config.listingOnlyBaseUrls.includes(activeBaseUrl)
    ) {
      fail(
        "Citizenserve permit row has no configured public detail link",
        "citizenserve_detail_link_changed",
      );
    }
    const sourceUrl = hasPublicDetail
      ? parseDetailLink(anchor.attr("href"), config)
      : activeSearchUrl;
    const parsedUrl = new URL(sourceUrl);
    const recordType = cleanText(cells.eq(2).text());
    if (
      !recordType ||
      !config.jurisdictionTokens.some((token) =>
        recordType.toLowerCase().includes(token),
      )
    ) {
      excludedJurisdictionCount += 1;
      return;
    }
    references.push({
      sourceRecordId:
        parsedUrl.searchParams.get("permit_ID") ?? permitNumber,
      workOrderId: parsedUrl.searchParams.get("workOrder_ID"),
      permitNumber,
      sourceUrl,
      hasPublicDetail,
      workAddress: cleanText(cells.eq(1).text()),
      improvementType: recordType,
      improvementAction: cleanText(cells.eq(3).text()),
      status: cleanText(cells.eq(4).text()),
      issueDate: parsePortalDate(cells.eq(5).text()),
      description: cleanText(cells.eq(6).text()),
      sourcePayload: {
        permitId: parsedUrl.searchParams.get("permit_ID"),
        workOrderId: parsedUrl.searchParams.get("workOrder_ID"),
        listingOnly: !hasPublicDetail,
      },
    });
  });
  if (
    reportedTotal > 0 &&
    references.length + excludedJurisdictionCount !==
      rangeEnd - rangeStart + 1
  ) {
    fail(
      "Citizenserve parsed row count differs from source range",
      "citizenserve_search_shape_changed",
    );
  }
  const nextHref = $("#resultContent a")
    .toArray()
    .map((element) => $(element).attr("href") ?? "")
    .find((href) => href.includes("displayResultNPagging"));
  const nextMatch =
    nextHref === undefined
      ? null
      : /displayResultNPagging\('(\d+)','(\d+)'\)/u.exec(nextHref);
  const nextRange = nextMatch
    ? { start: Number(nextMatch[1]), end: Number(nextMatch[2]) }
    : null;
  if (
    nextHref !== undefined &&
    (!nextRange ||
      nextRange.start !== rangeEnd ||
      nextRange.end <= nextRange.start ||
      nextRange.end > reportedTotal)
  ) {
    fail(
      "Citizenserve next-page range is unexpected",
      "citizenserve_pagination_changed",
    );
  }
  return {
    pageNumber,
    rangeStart,
    rangeEnd,
    reportedTotal,
    references,
    excludedJurisdictionCount,
    nextRange,
  };
}

function readDetailRow($, label) {
  let value = null;
  $("#permit .row").each((_, row) => {
    if (value !== null) return;
    const columns = $(row).children("div");
    if (
      columns.length >= 2 &&
      cleanText(columns.eq(0).text()) === label
    ) {
      value = cleanText(columns.eq(1).text());
    }
  });
  return value;
}

function readSummaryField($, label) {
  const summary = $("main .configspace > .row font.color-11").first();
  const bold = summary
    .find("b")
    .toArray()
    .find((element) => cleanText($(element).text()) === label);
  if (!bold) return null;
  const fragments = [];
  let sibling = bold.nextSibling;
  while (sibling) {
    if (
      sibling.type === "tag" &&
      "name" in sibling &&
      sibling.name.toLowerCase() === "br"
    ) {
      break;
    }
    fragments.push($(sibling).text());
    sibling = sibling.nextSibling;
  }
  return cleanText(fragments.join(" "));
}

function labeledFields($, root) {
  const fields = new Map();
  $(root)
    .find("tr, .row")
    .each((_, row) => {
      const cells = $(row).children("th, td, div");
      if (cells.length < 2) return;
      const label = cleanText(cells.eq(0).text())
        ?.replace(/:$/u, "")
        .toLowerCase();
      const value = cleanText(cells.eq(1).text());
      if (label && value && !fields.has(label)) fields.set(label, value);
    });
  $(root)
    .find("label, b, strong")
    .each((_, labelElement) => {
      const label = cleanText($(labelElement).text())
        ?.replace(/:$/u, "")
        .toLowerCase();
      if (!label || fields.has(label)) return;
      const value =
        cleanText($(labelElement).next().text()) ??
        cleanText($(labelElement).parent().children().eq(1).text());
      if (value && value !== cleanText($(labelElement).text())) {
        fields.set(label, value);
      }
    });
  return fields;
}

export function parseCitizenserveContractors($) {
  const contractors = [];
  const selector =
    "[data-contact-role*='contractor' i], #contractor, #contractors, .contractor, .contractors, [id*='contractor' i], [class*='contractor' i]";
  const candidates = $(selector).toArray();
  for (const root of candidates) {
    if ($(root).find(selector).length > 0) continue;
    const fields = labeledFields($, root);
    const sourceRole =
      cleanText($(root).attr("data-contact-role")) ??
      fields.get("role") ??
      fields.get("contact type") ??
      "Contractor";
    if (!/contractor/iu.test(sourceRole) && !/contractor/iu.test($(root).text())) {
      continue;
    }
    const businessName =
      fields.get("business name") ??
      fields.get("company") ??
      fields.get("contractor") ??
      fields.get("contractor name") ??
      fields.get("license holder");
    if (!businessName) continue;
    contractors.push({
      businessName,
      licenseNumber:
        fields.get("license #") ??
        fields.get("license number") ??
        fields.get("license no.") ??
        null,
      qualifierName:
        fields.get("qualifier") ??
        fields.get("qualifier name") ??
        null,
      sourceRole,
      phone: fields.get("phone") ?? null,
      email: fields.get("email") ?? null,
    });
  }
  return [
    ...new Map(
      contractors.map((contractor) => [
        JSON.stringify([
          contractor.businessName,
          contractor.licenseNumber,
          contractor.qualifierName,
          contractor.sourceRole,
        ]),
        contractor,
      ]),
    ).values(),
  ];
}

function sourceHostProvenance(jurisdiction, sourceUrl) {
  const config = validateConfig(jurisdiction);
  const parsed = new URL(sourceUrl);
  const sourceBaseUrl = requireConfiguredBaseUrl(
    config,
    `${parsed.origin}/Portal`,
  );
  return {
    sourceHost: parsed.hostname,
    sourceHostRole:
      sourceBaseUrl === config.baseUrl
        ? "configured-primary"
        : "operator-approved-fallback",
    configuredPrimaryHost: new URL(config.baseUrl).hostname,
    installationId: config.installationId,
  };
}

export function normalizeCitizenservePermitListing({
  jurisdiction,
  reference,
  request,
  searchUrl,
}) {
  if (reference.hasPublicDetail !== false) {
    fail(
      "Citizenserve listing normalization requires an explicit listing-only record",
      "citizenserve_detail_shape_changed",
    );
  }
  const sourceRecordId = reference.sourceRecordId;
  const description = reference.description;
  return normalizedPermitRecordSchema.parse({
    schemaVersion: "elephant.normalized-permit-record.v1",
    property_improvement_id: createStablePermitId({
      countyKey: "broward",
      jurisdictionKey: jurisdiction.key,
      sourceRecordId,
    }),
    property_id: request.requestedPropertyId,
    parcel_identifier: request.requestedParcelIdentifier,
    permit_number: reference.permitNumber,
    improvement_type: reference.improvementType,
    improvement_status: reference.status,
    improvement_action: reference.improvementAction,
    permit_issue_date: reference.issueDate,
    application_received_date: null,
    final_inspection_date: null,
    permit_close_date: null,
    completion_date: null,
    expiration_date: null,
    opened_date: null,
    source_system: jurisdiction.adapterConfig.sourceSystem,
    county_name: "Broward",
    project_description: description,
    description,
    estimated_job_value: null,
    fee: null,
    countyKey: "broward",
    jurisdictionKey: jurisdiction.key,
    sourceRecordId,
    sourceUrl: reference.sourceUrl,
    requestedParcelIdentifier: request.requestedParcelIdentifier,
    requestedPropertyId: request.requestedPropertyId,
    workAddress: reference.workAddress,
    isRoofPermit: isRoofPermit(
      reference.improvementType,
      reference.improvementAction,
      description,
    ),
    contractors: [],
    inspections: [],
    relatedRecords: [],
    sourcePayload: {
      permitId: null,
      workOrderId: null,
      projectNumber: null,
      searchUrl,
      searchPage: reference.searchPage,
      searchedParcelIdentifier: request.requestedParcelIdentifier,
      contractorDisclosure: "public_detail_not_exposed",
      detailAvailability: "not_exposed",
      sourceSearchKind: reference.searchKind,
      sourceSearchValue: reference.searchValue,
      folioSearchReportedTotal:
        reference.folioSearchReportedTotal ?? null,
      folioSearchPermitNumbers:
        reference.folioSearchPermitNumbers ?? [],
      ...sourceHostProvenance(jurisdiction, reference.sourceUrl),
    },
  });
}

export function parseCitizenservePermitDetailHtml(
  html,
  { jurisdiction, reference, request, searchUrl },
) {
  const config = validateConfig(jurisdiction);
  const referenceUrl = new URL(reference.sourceUrl);
  requireConfiguredBaseUrl(config, `${referenceUrl.origin}/Portal`);
  if (
    referenceUrl.searchParams.get("installationID") !==
    String(config.installationId)
  ) {
    fail(
      "Citizenserve detail reference changed installation identity",
      "citizenserve_source_identity_mismatch",
    );
  }
  const $ = cheerio.load(html);
  if (cleanText($("main h1.page-heading").first().text()) !== "View Permit") {
    fail(
      "Unexpected Citizenserve permit detail page",
      "citizenserve_detail_shape_changed",
    );
  }
  const permitNumber = readDetailRow($, "Permit #:");
  if (!permitNumber || permitNumber !== reference.permitNumber) {
    fail(
      "Citizenserve detail permit differs from search result",
      "citizenserve_source_identity_mismatch",
    );
  }
  const improvementType = readDetailRow($, "Permit Type:");
  const improvementAction = readDetailRow($, "Sub Type:");
  const issueDate = parsePortalDate(readDetailRow($, "Issue Date:"));
  const status = readSummaryField($, "Status:");
  for (const [name, listed, detailed] of [
    ["type", reference.improvementType, improvementType],
    ["subtype", reference.improvementAction, improvementAction],
    ["status", reference.status, status],
    ["issue date", reference.issueDate, issueDate],
  ]) {
    if (listed && detailed && listed !== detailed) {
      fail(
        `Citizenserve detail ${name} differs from search result`,
        "citizenserve_list_detail_mismatch",
      );
    }
  }
  const sourceRecordId = reference.sourceRecordId;
  const description =
    readSummaryField($, "Description:") ?? reference.description;
  const contractors = parseCitizenserveContractors($);
  return normalizedPermitRecordSchema.parse({
    schemaVersion: "elephant.normalized-permit-record.v1",
    property_improvement_id: createStablePermitId({
      countyKey: "broward",
      jurisdictionKey: jurisdiction.key,
      sourceRecordId,
    }),
    property_id: request.requestedPropertyId,
    parcel_identifier: request.requestedParcelIdentifier,
    permit_number: permitNumber,
    improvement_type: improvementType ?? reference.improvementType,
    improvement_status: status ?? reference.status,
    improvement_action:
      improvementAction ?? reference.improvementAction,
    permit_issue_date: issueDate ?? reference.issueDate,
    application_received_date: null,
    final_inspection_date: null,
    permit_close_date: null,
    completion_date: null,
    expiration_date: parsePortalDate(
      readDetailRow($, "Expiration Date:"),
    ),
    opened_date: null,
    source_system: jurisdiction.adapterConfig.sourceSystem,
    county_name: "Broward",
    project_description: description,
    description,
    estimated_job_value: null,
    fee: null,
    countyKey: "broward",
    jurisdictionKey: jurisdiction.key,
    sourceRecordId,
    sourceUrl: reference.sourceUrl,
    requestedParcelIdentifier: request.requestedParcelIdentifier,
    requestedPropertyId: request.requestedPropertyId,
    workAddress:
      readSummaryField($, "Address:") ?? reference.workAddress,
    isRoofPermit: isRoofPermit(
      improvementType,
      improvementAction,
      description,
    ),
    contractors,
    inspections: [],
    relatedRecords: [],
    sourcePayload: {
      permitId: reference.sourceRecordId,
      workOrderId: reference.workOrderId,
      projectNumber: readSummaryField($, "Project #:"),
      searchUrl,
      searchPage: reference.searchPage,
      searchedParcelIdentifier: request.requestedParcelIdentifier,
      contractorDisclosure:
        contractors.length > 0 ? "source_reported" : "not_exposed",
      sourceSearchKind: reference.searchKind ?? "folio",
      sourceSearchValue:
        reference.searchValue ?? request.requestedParcelIdentifier,
      folioSearchReportedTotal:
        reference.folioSearchReportedTotal ?? null,
      folioSearchPermitNumbers:
        reference.folioSearchPermitNumbers ?? [],
      detailAvailability: "public-detail",
      ...sourceHostProvenance(jurisdiction, reference.sourceUrl),
    },
  });
}

function executablePath() {
  const candidates = [
    process.env.CHROME_EXECUTABLE_PATH?.trim(),
    [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ],
  ].flat().filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    fail(
      "Citizenserve requires CHROME_EXECUTABLE_PATH or an installed Chrome/Chromium executable",
      "citizenserve_browser_unavailable",
    );
  }
  return found;
}

async function rejectAccessControls(page) {
  const state = await page.evaluate(() => ({
    password: [...document.querySelectorAll("input[type='password']")].some(
      (element) => element.offsetParent !== null,
    ),
    visibleRecaptcha: [
      ...document.querySelectorAll("iframe[src*='recaptcha']"),
    ].some(
      (element) =>
        element.offsetParent !== null &&
        /challenge/iu.test(element.title || ""),
    ),
  }));
  if (state.password) {
    fail(
      "Citizenserve requires login; credentials will not be used",
      "citizenserve_login_required",
    );
  }
  if (state.visibleRecaptcha) {
    fail(
      "Citizenserve presented a challenge; bypass will not be attempted",
      "citizenserve_captcha_presented",
    );
  }
}

function assertPageLocation(pageUrl, sourceBaseUrl) {
  const actual = new URL(pageUrl);
  const expected = new URL(sourceBaseUrl);
  if (
    actual.protocol !== "https:" ||
    actual.origin !== expected.origin ||
    actual.pathname !== SEARCH_PATH
  ) {
    fail(
      "Citizenserve navigation left the selected configured host",
      "citizenserve_source_identity_mismatch",
    );
  }
}

async function configurePinnedHost(page, sourceBaseUrl, enabled) {
  if (!enabled) return;
  const source = new URL(sourceBaseUrl);
  const redirectEndpoint = `${source.origin}/Portal/PortalAjaxController`;
  const selectedHost = source.hostname.split(".")[0];
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (
      request.url() === redirectEndpoint &&
      request.method() === "POST" &&
      new URLSearchParams(request.postData() ?? "").get("Action") ===
        "getReDirectPortalURL"
    ) {
      void request.respond({
        status: 200,
        contentType: "text/plain",
        body: selectedHost,
      });
      return;
    }
    void request.continue();
  });
}

async function openSearchPage(
  page,
  { jurisdiction, sourceBaseUrl, searchUrl, timeoutMs },
) {
  let response;
  try {
    response = await page.goto(searchUrl, {
      waitUntil: "load",
      timeout: timeoutMs,
    });
  } catch (error) {
    if (isHostAvailabilityError(error)) {
      throw new PermitSourceError(
        "Citizenserve configured host is unavailable",
        {
          classification: "transient",
          code: "citizenserve_host_unavailable",
          cause: error,
        },
      );
    }
    throw error;
  }
  if (
    !response ||
    response.status() === 408 ||
    response.status() === 429 ||
    response.status() >= 500
  ) {
    throw new PermitSourceError(
      "Citizenserve configured host is unavailable",
      {
        classification: "transient",
        code: "citizenserve_host_unavailable",
        status: response?.status() ?? null,
      },
    );
  }
  if (response.status() !== 200) {
    fail(
      `Citizenserve search returned HTTP ${response.status()}`,
      "citizenserve_search_unavailable",
    );
  }
  assertPageLocation(page.url(), sourceBaseUrl);
  await rejectAccessControls(page);
  validateCitizenserveSearchPageHtml(await page.content(), {
    jurisdiction,
  });
}

async function submitSearch(
  page,
  { jurisdiction, sourceBaseUrl, query, timeoutMs },
) {
  const config = validateConfig(jurisdiction);
  const fieldsResponse = page.waitForResponse(
    (response) =>
      response.url().includes("getSearchFieldsOnFileType") &&
      response.request().method() === "GET",
    { timeout: timeoutMs },
  );
  await page.select("#filetype", "Permit");
  await fieldsResponse;
  const selector = {
    address: "#address",
    folio: "#parcelNumber",
    "permit-number": "#PermitNumber",
  }[query.kind];
  await page.waitForSelector(`${selector}:not([disabled])`, {
    visible: true,
    timeout: timeoutMs,
  });
  const permitType = await page.evaluate((tokens) => {
    const options = [
      ...document.querySelectorAll("#PermitType option"),
    ].map((option) => ({
      value: option.value,
      text: (option.textContent ?? "").replace(/\s+/g, " ").trim(),
    }));
    return (
      options.find((option) =>
        tokens.some((token) => option.text.toLowerCase().includes(token)),
      ) ?? null
    );
  }, config.jurisdictionTokens);
  if (!permitType?.value) {
    fail(
      "Citizenserve permit form does not identify the configured jurisdiction",
      "citizenserve_source_identity_mismatch",
    );
  }
  await page.$eval(
    "#PermitType",
    (element, value) => {
      element.value = value;
    },
    permitType.value,
  );
  await page.type(selector, query.value);
  await page.waitForSelector("#submitRow button", {
    visible: true,
    timeout: timeoutMs,
  });
  await page.evaluate(
    ({ fieldSelector, fieldValue, permitTypeValue }) => {
      window
        .jQuery("#frm_PortalSearch")
        .one("submit.citizenserveAdapter", () => {
          window.jQuery("#PermitType").val(permitTypeValue);
          window.jQuery("#PermitSubType").val("");
          window.jQuery("#PermitStatus").val("");
          window.jQuery("#to").val("");
          window.jQuery(fieldSelector).val(fieldValue);
        });
    },
    {
      fieldSelector: selector,
      fieldValue: query.value,
      permitTypeValue: permitType.value,
    },
  );
  await Promise.all([
    page.waitForNavigation({
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    }),
    page.click("#submitRow button"),
  ]);
  assertPageLocation(page.url(), sourceBaseUrl);
  await rejectAccessControls(page);
}

async function nextPage(page, range, timeoutMs) {
  const navigation = page.waitForNavigation({
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
  });
  const clicked = await page.evaluate(({ start, end }) => {
    const expected =
      `displayResultNPagging('${String(start)}','${String(end)}')`;
    const link = [...document.querySelectorAll("#resultContent a")].find(
      (candidate) => candidate.getAttribute("href")?.includes(expected),
    );
    if (!(link instanceof HTMLAnchorElement)) return false;
    link.click();
    return true;
  }, range);
  if (!clicked) {
    await navigation.catch(() => undefined);
    fail(
      "Citizenserve next-page link disappeared",
      "citizenserve_pagination_changed",
    );
  }
  await navigation;
}

function normalizedAddressForComparison(value) {
  return String(value ?? "")
    .split(",")[0]
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9 ]/gu, " ")
    .toUpperCase()
    .replace(
      /\b(COURT|STREET|ROAD|DRIVE|AVENUE|BOULEVARD|LANE|TRAIL|PLACE|CIRCLE)\b/gu,
      (word) =>
        ({
          COURT: "CT",
          STREET: "ST",
          ROAD: "RD",
          DRIVE: "DR",
          AVENUE: "AVE",
          BOULEVARD: "BLVD",
          LANE: "LN",
          TRAIL: "TRL",
          PLACE: "PL",
          CIRCLE: "CIR",
        })[word],
    )
    .replace(/\s+/gu, " ")
    .trim();
}

function assertExpectedAddress(reference, expectedAddress) {
  if (
    expectedAddress &&
    normalizedAddressForComparison(reference.workAddress) !==
      normalizedAddressForComparison(expectedAddress)
  ) {
    fail(
      "Citizenserve permit address differs from the requested property",
      "citizenserve_property_identity_mismatch",
    );
  }
}

export function createCitizenserveAdapter(jurisdiction, options = {}) {
  const config = validateConfig(jurisdiction);
  const timeoutMs = options.timeoutMs ?? 60_000;
  const minimumDelayMs = Math.max(config.minimumDelayMs, 1_500);
  const wait = () =>
    new Promise((resolve) => setTimeout(resolve, minimumDelayMs));
  return Object.freeze({
    key: "citizenserve",
    async probe() {
      return {
        status: "configured",
        sourceUrl: buildCitizenserveSearchUrl(jurisdiction),
      };
    },
    async searchParcel(parcelIdentifier, request = {}) {
      if (!/^[A-Z0-9]{12}$/u.test(parcelIdentifier)) {
        fail(
          "Citizenserve parcel identifier must be 12 undashed characters",
          "invalid_parcel_identifier",
        );
      }
      const browser = await puppeteer.launch({
        headless: true,
        executablePath: executablePath(),
      });
      const records = [];
      try {
        const selected = await resolveCitizenserveSource(
          jurisdiction,
          async ({ baseUrl, searchUrl, listingOnly }) => {
            const page = await browser.newPage();
            try {
              await configurePinnedHost(
                page,
                baseUrl,
                config.pinConfiguredHost === true,
              );
              await openSearchPage(page, {
                jurisdiction,
                sourceBaseUrl: baseUrl,
                searchUrl,
                timeoutMs,
              });
              return { baseUrl, searchUrl, listingOnly, page };
            } catch (error) {
              await page.close().catch(() => undefined);
              throw error;
            }
          },
        );
        const { baseUrl: sourceBaseUrl, searchUrl, page } = selected;
        const maximumPages = config.maximumSearchPages ?? 3;
        const maximumDetails = config.maximumDetailRecords ?? 25;
        let firstQuery = true;
        const collectQuery = async (query) => {
          if (!firstQuery) {
            await wait();
            await openSearchPage(page, {
              jurisdiction,
              sourceBaseUrl,
              searchUrl,
              timeoutMs,
            });
          }
          firstQuery = false;
          await submitSearch(page, {
            jurisdiction,
            sourceBaseUrl,
            query,
            timeoutMs,
          });
          const references = [];
          let reportedTotal = 0;
          for (
            let pageNumber = 1;
            pageNumber <= maximumPages;
            pageNumber += 1
          ) {
            const searchHtml = await page.content();
            if (options.onSearchHtml) {
              await options.onSearchHtml({
                pageNumber,
                searchKind: query.kind,
                searchValue: query.value,
                sourceBaseUrl,
                html: searchHtml,
              });
            }
            const parsed = parseCitizenserveSearchResultsHtml(searchHtml, {
              jurisdiction,
              pageNumber,
              sourceBaseUrl,
              searchUrl,
              expectedPermitNumber:
                query.kind === "permit-number" ? query.value : null,
            });
            reportedTotal = parsed.reportedTotal;
            references.push(
              ...parsed.references.map((reference) => ({
                ...reference,
                searchPage: pageNumber,
                searchKind: query.kind,
                searchValue: query.value,
              })),
            );
            if (!parsed.nextRange) break;
            if (pageNumber === maximumPages) {
              fail(
                "Citizenserve search-page ceiling would truncate source results",
                "citizenserve_pagination_limit",
              );
            }
            await wait();
            await nextPage(page, parsed.nextRange, timeoutMs);
          }
          return { references, reportedTotal };
        };
        const exactPermitNumbers = [
          ...new Set(
            (request.exactPermitNumbers ?? [])
              .map(cleanText)
              .filter(Boolean),
          ),
        ];
        if (
          exactPermitNumbers.some(
            (permitNumber) => !/^[A-Z0-9-]+$/u.test(permitNumber),
          )
        ) {
          fail(
            "Citizenserve exact permit numbers are invalid",
            "citizenserve_invalid_permit_number",
          );
        }
        let selectedReferences = [];
        let folioSearchReportedTotal = null;
        let folioSearchPermitNumbers = [];
        if (exactPermitNumbers.length > 0) {
          const folioResult = await collectQuery({
            kind: "folio",
            value: parcelIdentifier,
          });
          folioSearchReportedTotal = folioResult.reportedTotal;
          folioSearchPermitNumbers = folioResult.references.map(
            (reference) => reference.permitNumber,
          );
          const folioPermitSet = new Set(folioSearchPermitNumbers);
          for (const permitNumber of exactPermitNumbers) {
            const exactResult = await collectQuery({
              kind: "permit-number",
              value: permitNumber,
            });
            if (
              exactResult.reportedTotal > 1 ||
              exactResult.references.length > 1
            ) {
              fail(
                "Citizenserve exact-permit search was not exact",
                "citizenserve_exact_permit_mismatch",
              );
            }
            for (const reference of exactResult.references) {
              if (!folioPermitSet.has(reference.permitNumber)) {
                fail(
                  "Citizenserve exact permit is not associated with the requested folio",
                  "citizenserve_property_identity_mismatch",
                );
              }
              assertExpectedAddress(
                reference,
                request.expectedAddress,
              );
              selectedReferences.push(reference);
            }
          }
        } else {
          let query = request.searchAddress
            ? {
                kind: "address",
                value: cleanText(request.searchAddress),
              }
            : { kind: "folio", value: parcelIdentifier };
          if (!query.value) {
            fail(
              "Citizenserve address search value is empty",
              "invalid_property_address",
            );
          }
          let result = await collectQuery(query);
          if (
            query.kind === "folio" &&
            result.reportedTotal === 0 &&
            request.fallbackAddress
          ) {
            query = {
              kind: "address",
              value: cleanText(request.fallbackAddress),
            };
            result = await collectQuery(query);
          }
          selectedReferences = result.references;
          if (query.kind === "folio") {
            folioSearchReportedTotal = result.reportedTotal;
            folioSearchPermitNumbers = result.references.map(
              (reference) => reference.permitNumber,
            );
          }
        }
        for (const reference of selectedReferences) {
          if (records.length >= maximumDetails) {
            fail(
              "Citizenserve detail ceiling would truncate source results",
              "citizenserve_detail_limit",
            );
          }
          const enrichedReference = {
            ...reference,
            folioSearchReportedTotal,
            folioSearchPermitNumbers,
          };
          const normalizedRequest = {
            requestedParcelIdentifier: parcelIdentifier,
            requestedPropertyId: request.requestedPropertyId ?? null,
          };
          if (!reference.hasPublicDetail) {
            records.push(
              normalizeCitizenservePermitListing({
                jurisdiction,
                reference: enrichedReference,
                request: normalizedRequest,
                searchUrl,
              }),
            );
            continue;
          }
          if (records.length > 0) await wait();
          const detailPage = await browser.newPage();
          try {
            await configurePinnedHost(
              detailPage,
              sourceBaseUrl,
              config.pinConfiguredHost === true,
            );
            const response = await detailPage.goto(reference.sourceUrl, {
              waitUntil: "domcontentloaded",
              timeout: timeoutMs,
            });
            assertPageLocation(detailPage.url(), sourceBaseUrl);
            if (!response || response.status() !== 200) {
              fail(
                "Citizenserve detail did not return HTTP 200",
                "citizenserve_detail_unavailable",
              );
            }
            await rejectAccessControls(detailPage);
            const detailHtml = await detailPage.content();
            if (options.onDetailHtml) {
              await options.onDetailHtml({
                reference,
                pageNumber: reference.searchPage,
                html: detailHtml,
              });
            }
            records.push(
              parseCitizenservePermitDetailHtml(detailHtml, {
                jurisdiction,
                reference: enrichedReference,
                request: normalizedRequest,
                searchUrl,
              }),
            );
          } finally {
            await detailPage.close().catch(() => undefined);
          }
        }
      } finally {
        await browser.close().catch(() => undefined);
      }
      return records.map((record) => ({
        sourceRecordId: record.sourceRecordId,
        permitNumber: record.permit_number,
        sourceUrl: record.sourceUrl,
        normalizedRecord: record,
      }));
    },
    async fetchPermitDetail(reference) {
      return normalizedPermitRecordSchema.parse(
        reference.normalizedRecord,
      );
    },
  });
}
