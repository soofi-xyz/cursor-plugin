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

function validateConfig(jurisdiction) {
  const config = jurisdiction.adapterConfig;
  const base = new URL(config.baseUrl);
  if (
    base.protocol !== "https:" ||
    base.hostname !== "www6.citizenserve.com" ||
    !base.pathname.endsWith("/Portal") ||
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
    baseUrl: config.baseUrl.replace(/\/+$/, ""),
    jurisdictionTokens: config.jurisdictionTokens.map((token) =>
      token.toLowerCase(),
    ),
  };
}

export function buildCitizenserveSearchUrl(jurisdiction) {
  const config = validateConfig(jurisdiction);
  const query = new URLSearchParams({
    Action: "showSearchPage",
    ctzPagePrefix: "Portal_",
    installationID: String(config.installationId),
    original_contactID: "0",
    original_iid: "0",
  });
  return `${config.baseUrl}/PortalController?${query.toString()}`;
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
    detailUrl.hostname !== "www6.citizenserve.com" ||
    detailUrl.pathname !== "/Portal/PortalController" ||
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
  { jurisdiction, pageNumber },
) {
  const config = validateConfig(jurisdiction);
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    fail(
      "Citizenserve page number must be positive",
      "citizenserve_invalid_page",
    );
  }
  const $ = cheerio.load(html);
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
    const permitNumber = cleanText(anchor.text());
    if (!permitNumber) {
      fail(
        "Citizenserve result row has no permit number",
        "citizenserve_source_identity_mismatch",
      );
    }
    const sourceUrl = parseDetailLink(anchor.attr("href"), config);
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
      sourceRecordId: parsedUrl.searchParams.get("permit_ID"),
      workOrderId: parsedUrl.searchParams.get("workOrder_ID"),
      permitNumber,
      sourceUrl,
      workAddress: cleanText(cells.eq(1).text()),
      improvementType: recordType,
      improvementAction: cleanText(cells.eq(3).text()),
      status: cleanText(cells.eq(4).text()),
      issueDate: parsePortalDate(cells.eq(5).text()),
      description: cleanText(cells.eq(6).text()),
      sourcePayload: {
        permitId: parsedUrl.searchParams.get("permit_ID"),
        workOrderId: parsedUrl.searchParams.get("workOrder_ID"),
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

export function parseCitizenservePermitDetailHtml(
  html,
  { jurisdiction, reference, request, searchUrl },
) {
  validateConfig(jurisdiction);
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

async function submitSearch(page, searchUrl, query, timeoutMs) {
  await page.goto(searchUrl, {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
  });
  await rejectAccessControls(page);
  const fieldsResponse = page.waitForResponse(
    (response) =>
      response.url().includes("getSearchFieldsOnFileType") &&
      response.request().method() === "GET",
    { timeout: timeoutMs },
  );
  await page.select("#filetype", "Permit");
  await fieldsResponse;
  const selector = query.kind === "address" ? "#address" : "#parcelNumber";
  await page.waitForSelector(`${selector}:not([disabled])`, {
    visible: true,
    timeout: timeoutMs,
  });
  await page.type(selector, query.value);
  await Promise.all([
    page.waitForNavigation({
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    }),
    page.click("#submitRow button"),
  ]);
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

export function createCitizenserveAdapter(jurisdiction, options = {}) {
  const config = validateConfig(jurisdiction);
  const timeoutMs = options.timeoutMs ?? 60_000;
  const minimumDelayMs = Math.max(config.minimumDelayMs, 1_500);
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
      const searchUrl = buildCitizenserveSearchUrl(jurisdiction);
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
      const records = [];
      try {
        const page = await browser.newPage();
        await submitSearch(page, searchUrl, query, timeoutMs);
        let prefetchedPage = null;
        if (query.kind === "folio" && request.fallbackAddress) {
          const folioHtml = await page.content();
          if (options.onSearchHtml) {
            await options.onSearchHtml({
              pageNumber: 1,
              searchKind: "folio",
              html: folioHtml,
            });
          }
          const folioPage = parseCitizenserveSearchResultsHtml(
            folioHtml,
            { jurisdiction, pageNumber: 1 },
          );
          if (folioPage.reportedTotal === 0) {
            query = {
              kind: "address",
              value: cleanText(request.fallbackAddress),
            };
            await submitSearch(page, searchUrl, query, timeoutMs);
          } else {
            prefetchedPage = {
              html: folioHtml,
              parsed: folioPage,
            };
          }
        }
        const maximumPages = config.maximumSearchPages ?? 3;
        const maximumDetails = config.maximumDetailRecords ?? 25;
        for (let pageNumber = 1; pageNumber <= maximumPages; pageNumber += 1) {
          const searchHtml =
            pageNumber === 1 && prefetchedPage
              ? prefetchedPage.html
              : await page.content();
          if (options.onSearchHtml && !(pageNumber === 1 && prefetchedPage)) {
            await options.onSearchHtml({
              pageNumber,
              searchKind: query.kind,
              html: searchHtml,
            });
          }
          const parsed =
            pageNumber === 1 && prefetchedPage
              ? prefetchedPage.parsed
              : parseCitizenserveSearchResultsHtml(searchHtml, {
                  jurisdiction,
                  pageNumber,
                });
          for (const reference of parsed.references) {
            if (records.length >= maximumDetails) {
              fail(
                "Citizenserve detail ceiling would truncate source results",
                "citizenserve_detail_limit",
              );
            }
            if (records.length > 0) {
              await new Promise((resolve) =>
                setTimeout(resolve, minimumDelayMs),
              );
            }
            const detailPage = await browser.newPage();
            try {
              const response = await detailPage.goto(reference.sourceUrl, {
                waitUntil: "domcontentloaded",
                timeout: timeoutMs,
              });
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
                  pageNumber,
                  html: detailHtml,
                });
              }
              records.push(
                parseCitizenservePermitDetailHtml(
                  detailHtml,
                  {
                    jurisdiction,
                    reference: {
                      ...reference,
                      searchPage: pageNumber,
                      searchKind: query.kind,
                      searchValue: query.value,
                      folioSearchReportedTotal:
                        query.kind === "address" ? 0 : null,
                    },
                    request: {
                      requestedParcelIdentifier: parcelIdentifier,
                      requestedPropertyId:
                        request.requestedPropertyId ?? null,
                    },
                    searchUrl,
                  },
                ),
              );
            } finally {
              await detailPage.close().catch(() => undefined);
            }
          }
          if (!parsed.nextRange) break;
          if (pageNumber === maximumPages) {
            fail(
              "Citizenserve search-page ceiling would truncate source results",
              "citizenserve_pagination_limit",
            );
          }
          await new Promise((resolve) =>
            setTimeout(resolve, minimumDelayMs),
          );
          await nextPage(page, parsed.nextRange, timeoutMs);
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
