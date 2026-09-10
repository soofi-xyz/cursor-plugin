import { existsSync } from "node:fs";

import * as cheerio from "cheerio";
import { z } from "zod";

import {
  createStablePermitId,
  normalizedPermitRecordSchema,
} from "../contracts.mjs";
import {
  normalizeBrowardParcelIdentifier,
  normalizeSourcePayload,
} from "../normalization.mjs";
import { PermitSourceError } from "../errors.mjs";

const SELECTORS = Object.freeze({
  parcel: "#ctl00_PlaceHolderMain_generalSearchForm_txtGSParcelNo",
  startDate: "#ctl00_PlaceHolderMain_generalSearchForm_txtGSStartDate",
  endDate: "#ctl00_PlaceHolderMain_generalSearchForm_txtGSEndDate",
  searchType: "#ctl00_PlaceHolderMain_generalSearchForm_ddlGSSearchType",
  streetNumber:
    "#ctl00_PlaceHolderMain_generalSearchForm_txtGSNumber_ChildControl0",
  streetNumberTo:
    "#ctl00_PlaceHolderMain_generalSearchForm_txtGSNumber_ChildControl1",
  streetName: "#ctl00_PlaceHolderMain_generalSearchForm_txtGSStreetName",
  licenseNumber:
    "#ctl00_PlaceHolderMain_generalSearchForm_txtGSLicenseNumber",
  submit: "#ctl00_PlaceHolderMain_btnNewSearch",
});
const NO_RECORDS_PATTERN =
  /no records found|no record was found|search returned no results/i;

const configSchema = z.object({
  sourceSystem: z.string().min(1),
  baseUrl: z.string().url(),
  agencyCode: z.string().min(1),
  module: z.string().min(1).default("Building"),
  contentFrameName: z.string().min(1).nullable().default(null),
  maximumSearchPages: z.number().int().min(1).max(10).default(5),
  maximumDetailRecords: z.number().int().min(1).max(200).default(100),
  detailFingerprintVersion: z.string().min(1).default("accela-v1"),
});

function text(value) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized || null;
}

function dateFromText(value, label) {
  const match = new RegExp(
    `${label}\\s*:?\\s*(\\d{1,2}/\\d{1,2}/\\d{4})`,
    "i",
  ).exec(value);
  if (!match) return null;
  const parsed = new Date(match[1]);
  return Number.isNaN(parsed.valueOf())
    ? null
    : parsed.toISOString().slice(0, 10);
}

function dateFromUs(value) {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(
    String(value ?? "").trim(),
  );
  if (!match) return null;
  const date = new Date(
    Date.UTC(Number(match[3]), Number(match[1]) - 1, Number(match[2])),
  );
  return Number.isNaN(date.valueOf())
    ? null
    : date.toISOString().slice(0, 10);
}

function normalizeParcelIdentifier(value, countyKey) {
  if (countyKey === "broward") {
    return normalizeBrowardParcelIdentifier(value);
  }
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (!/^[A-Z0-9]{5,40}$/.test(normalized)) {
    throw new PermitSourceError(
      `Invalid ${countyKey} parcel identifier`,
      {
        classification: "permanent",
        code: "accela_invalid_parcel_identifier",
      },
    );
  }
  return normalized;
}

function recordNumberFromUrl(url) {
  const parsed = new URL(url);
  const parts = ["capID1", "capID2", "capID3"]
    .map((key) => parsed.searchParams.get(key))
    .filter(Boolean);
  return parts.length === 3 ? parts.join("-") : null;
}

export function parseAccelaSearchPage(
  html,
  { pageUrl, sourcePage = 1 } = {},
) {
  const $ = cheerio.load(html);
  const summary = text(
    $(".ACA_SmLabel")
      .toArray()
      .map((element) => $(element).text())
      .join(" "),
  );
  const reportedTotal = Number(
    /(?:of\s+(\d+)\s+records?\s+found|showing\s+\d+\s*-\s*\d+\s+of\s+(\d+))/i.exec(
      summary ?? "",
    )?.slice(1).find(Boolean) ?? NaN,
  );
  const references = [];
  $('a[href*="/Cap/CapDetail.aspx"]').each((_, element) => {
    const anchor = $(element);
    const href = anchor.attr("href");
    if (!href) return;
    const detailUrl = new URL(href, pageUrl).toString();
    const row = anchor.closest("tr");
    const cells = row
      .find("td")
      .toArray()
      .map((cell) => text($(cell).text()));
    const anchorCellIndex = row.find("td").index(anchor.closest("td"));
    references.push({
      sourceRecordId:
        text(anchor.text()) ?? recordNumberFromUrl(detailUrl) ?? detailUrl,
      recordNumber: text(anchor.text()),
      detailUrl,
      address:
        text(row.find('[id$="_lblAddress"]').text()) ??
        cells[anchorCellIndex + 1] ??
        null,
      description:
        text(row.find('[id$="_lblShortNote"]').text()) ??
        (anchorCellIndex === 1 ? cells[3] : null),
      status:
        text(row.find('[id$="_lblStatus"]').text()) ??
        (anchorCellIndex === 1 ? cells[4] : cells[5]) ??
        null,
      recordType:
        text(row.find('[id$="_lblType"]').text()) ??
        (anchorCellIndex === 1 ? cells[5] : cells[3]) ??
        null,
      updatedDate: text(row.find('[id$="_lblUpdatedTime"]').text()),
      sourcePage,
    });
  });
  return {
    references,
    reportedTotal: Number.isInteger(reportedTotal) ? reportedTotal : null,
    noRecords: NO_RECORDS_PATTERN.test(text($("body").text()) ?? ""),
    hasNext: $('a[href*="__doPostBack"]').toArray().some((element) =>
      /^next\s*>?$/i.test(text($(element).text()) ?? ""),
    ),
  };
}

function detailValue($, labelFragment) {
  const label = $(`[id*="${labelFragment}"]`).first();
  return text(label.closest("div").find("> span").first().text());
}

function stripProfessionalContactDetails(value) {
  return text(
    value
      ?.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "")
      .replace(/(?:home|mobile|work)\s+phone\s*:?\s*/gi, "")
      .replace(/\d{7,}/g, ""),
  );
}

function parseLicensedProfessionals($) {
  const professionals = [];
  $("#tbl_licensedps > tbody > tr > td").each((_, element) => {
    const html = $(element).html();
    const raw = text($(element).text());
    if (!html || !raw) return;
    const parts = html
      .split(/<br\s*\/?>/i)
      .map((part) => text(cheerio.load(`<div>${part}</div>`)("div").text()))
      .filter(Boolean)
      .map(stripProfessionalContactDetails)
      .filter(Boolean);
    const licenseMatch =
      /\b((?:CCC|RC|CGC|CAC|CFC|EC|CBC|CRC)\d{5,12})\b/i.exec(raw);
    const roleLine = parts.find((part) =>
      /\b(?:contractor|architect|engineer)\b/i.test(part),
    );
    const qualifierName = text(parts[0]);
    if (
      !qualifierName ||
      /^(?:view additional licensed professionals?>*|\d+\)?|licensed professional:?)$/i.test(
        qualifierName,
      )
    ) {
      return;
    }
    const businessName =
      text(
        parts.find(
          (part, index) =>
            index > 0 &&
            part !== roleLine &&
            !/\d{3,}/.test(part) &&
            !/\b(?:FL|Florida),?\s*\d{5}\b/i.test(part),
        ),
      ) ?? qualifierName;
    if (!businessName) return;
    professionals.push({
      businessName,
      licenseNumber: licenseMatch?.[1]?.toUpperCase() ?? null,
      qualifierName,
      sourceRole: stripProfessionalContactDetails(
        roleLine?.replace(licenseMatch?.[1] ?? "", ""),
      ),
      phone: null,
      email: null,
    });
  });
  return professionals;
}

function parseWorkflowEvents($) {
  const events = [];
  $("#divProcessingTable > table > tbody > tr").each((_, element) => {
    const row = $(element);
    if (row.attr("id")) return;
    const cells = row.find("> td");
    if (cells.length < 2) return;
    const eventType = text(cells.eq(1).text());
    const detailText = text(row.next("tr").text());
    const match =
      /Marked as\s+(.+?)\s+on\s+(\d{1,2}\/\d{1,2}\/\d{4})\b/i.exec(
        detailText ?? "",
      );
    if (!eventType || !match) return;
    events.push({
      eventType,
      eventStatus: text(match[1]),
      eventDate: dateFromUs(match[2]),
    });
  });
  return events;
}

function parseCompletedInspections($) {
  const inspections = [];
  $(
    "#ctl00_PlaceHolderMain_InspectionList_gvListCompleted .InspectionListRow",
  ).each((_, element) => {
    const cell = $(element).find(".ACA_Width45em").first();
    const spans = cell.find("> span");
    const result = text(spans.eq(0).text());
    const inspectionType = text(spans.eq(1).text());
    if (!inspectionType) return;
    const dateText =
      /\bon\s+(\d{1,2}\/\d{1,2}\/\d{4}|TBD)\b/i.exec(
        text(cell.text()) ?? "",
      )?.[1] ?? null;
    inspections.push({
      inspectionType,
      inspectionDate:
        dateText && !/^TBD$/i.test(dateText)
          ? dateFromUs(dateText)
          : null,
      result,
    });
  });
  return inspections;
}

function workflowDate(events, eventPattern, statusPattern) {
  return (
    events
      .filter(
        (event) =>
          eventPattern.test(event.eventType) &&
          statusPattern.test(event.eventStatus ?? ""),
      )
      .map((event) => event.eventDate)
      .filter(Boolean)
      .sort()
      .at(-1) ?? null
  );
}

export function normalizeAccelaPermitDetail(
  html,
  reference,
  {
    countyKey = "broward",
    countyName = "Broward",
    jurisdiction,
    config,
    requestedParcelIdentifier,
    requestedPropertyId = null,
    acceptedParcelIdentifiers = [],
  },
) {
  const $ = cheerio.load(html);
  const rawText = text($("body").text()) ?? "";
  const header =
    /Record\s+([A-Z0-9][A-Z0-9./_-]+)\s*:\s*(.*?)\s+Record Status:\s*(.*?)(?:Click here|Work Location|Record Details|$)/i.exec(
      rawText,
    );
  const permitNumber =
    text($("#ctl00_PlaceHolderMain_lblPermitNumber").text()) ??
    header?.[1] ??
    reference.recordNumber ??
    reference.sourceRecordId;
  const permitType =
    text($("#ctl00_PlaceHolderMain_lblPermitType").text()) ??
    text(header?.[2]) ??
    reference.recordType;
  const status =
    text($("#ctl00_PlaceHolderMain_lblRecordStatus").text()) ??
    text(header?.[3]) ??
    reference.status;
  const workLocationText = text($("#tbl_worklocation").text()) ?? "";
  const sourceParcel =
    (
      /FOLIO\s*:?\s*(\d{1,20}(?:\.\d{1,10})?)/i.exec(
        workLocationText,
      )?.[1] ??
      /\bParcel Number\s*:?\s*([A-Z0-9.-]{5,40})/i.exec(rawText)?.[1]
    )
      ?.replace(/[^A-Z0-9]/gi, "")
      .toUpperCase() ?? null;
  const normalizedRequestedParcel = requestedParcelIdentifier
    ? normalizeParcelIdentifier(requestedParcelIdentifier, countyKey)
    : null;
  const acceptedParcels = new Set(
    [normalizedRequestedParcel, ...acceptedParcelIdentifiers]
      .filter(Boolean)
      .map((value) => normalizeParcelIdentifier(value, countyKey)),
  );
  if (
    sourceParcel &&
    normalizedRequestedParcel &&
    !acceptedParcels.has(sourceParcel)
  ) {
    throw new PermitSourceError(
      `Accela detail parcel ${sourceParcel} differs from requested parcel`,
      { classification: "permanent", code: "accela_parcel_mismatch" },
    );
  }
  const workAddress =
    text(
      (text($("#tbl_worklocation").text()) ?? "").split(
        /SITE ADDRESS ID:|STRAP:|FOLIO:/i,
      )[0],
    ) ??
    text(/Work Location\s+(.*?)(?:\*|Record Details)/i.exec(rawText)?.[1]) ??
    reference.address;
  const description =
    detailValue($, "label_project") ??
    text(
      /Project Description:\s*(.*?)(?:More Details|Estimated Job Value|Parcel Number|$)/i.exec(
        rawText,
      )?.[1],
    ) ??
    reference.description;
  let contractors = parseLicensedProfessionals($);
  if (contractors.length === 0) {
    const licensedProfessional = text(
      /Licensed Professional:\s*(.*?)(?:Project Description|More Details|$)/i.exec(
        rawText,
      )?.[1],
    );
    const license =
      /\b((?:CCC|RC|CGC|CAC|CFC|EC|CBC|CRC)\d{5,12})\b/i.exec(
        licensedProfessional ?? "",
      )?.[1]?.toUpperCase() ?? null;
    const businessName = text(
      licensedProfessional
        ?.replace(/\bLICENSE\s*:?\s*/i, "")
        .replace(license ?? "", ""),
    );
    contractors = businessName
      ? [
          {
            businessName,
            licenseNumber: license,
            qualifierName: null,
            sourceRole: "licensed professional",
            phone: null,
            email: null,
          },
        ]
      : [];
  }
  const workflowEvents = parseWorkflowEvents($);
  const inspections = parseCompletedInspections($);
  const valueText =
    /(?:Estimated Job Value|Job Value)\s*:?\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i.exec(
      text($("#trASIList").text()) ?? rawText,
    )?.[1] ?? null;
  const estimatedValue = valueText
    ? Number(valueText.replaceAll(",", ""))
    : null;

  return normalizedPermitRecordSchema.parse({
    schemaVersion: "elephant.normalized-permit-record.v1",
    property_improvement_id: createStablePermitId({
      countyKey,
      jurisdictionKey: jurisdiction.key,
      sourceRecordId: permitNumber,
    }),
    property_id: requestedPropertyId,
    parcel_identifier: normalizedRequestedParcel,
    permit_number: permitNumber,
    improvement_type: permitType,
    improvement_status: status,
    improvement_action: null,
    permit_issue_date:
      workflowDate(workflowEvents, /^Issuance$/i, /^Issued$/i) ??
      dateFromText(rawText, "Issued Date"),
    application_received_date: dateFromText(
      text($("#trASIList").text()) ?? "",
      "(?:Application Submitted|Application Acceptance Date)",
    ),
    final_inspection_date:
      workflowDate(workflowEvents, /^Inspection$/i, /complete|pass/i) ??
      dateFromText(rawText, "Final Inspection"),
    permit_close_date:
      workflowDate(workflowEvents, /^Closure$/i, /complete|closed/i) ??
      dateFromText(rawText, "Closed Date"),
    completion_date:
      workflowDate(workflowEvents, /^Closure$/i, /complete|closed/i) ??
      dateFromText(rawText, "Completion Date"),
    expiration_date:
      dateFromUs($("#ctl00_PlaceHolderMain_lblExpirtionDate").text()) ??
      dateFromText(rawText, "Expiration Date"),
    opened_date: dateFromText(rawText, "Opened Date"),
    source_system: config.sourceSystem,
    county_name: countyName,
    project_description: description,
    description,
    estimated_job_value:
      Number.isFinite(estimatedValue) && estimatedValue >= 0
        ? estimatedValue
        : null,
    fee: null,
    countyKey,
    jurisdictionKey: jurisdiction.key,
    sourceRecordId: permitNumber,
    sourceUrl: reference.detailUrl,
    requestedParcelIdentifier: normalizedRequestedParcel,
    requestedPropertyId,
    workAddress,
    isRoofPermit: /roof/i.test(
      `${permitType ?? ""} ${description ?? ""}`,
    ),
    contractors,
    inspections,
    relatedRecords: [],
    sourcePayload: normalizeSourcePayload({
      agencyCode: config.agencyCode,
      module: config.module,
      sourceParcelIdentifier: sourceParcel,
      workflowEvents,
      detailFingerprintVersion: config.detailFingerprintVersion,
    }),
  });
}

export function createAccelaAdapter(jurisdiction, options = {}) {
  const config = configSchema.parse(jurisdiction.adapterConfig);
  let browserPromise;

  async function browser() {
    const executablePath =
      options.chromiumExecutablePath ??
      [
        process.env.CHROME_EXECUTABLE_PATH?.trim(),
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
      ]
        .filter(Boolean)
        .find((candidate) => existsSync(candidate));
    if (!options.browser && !executablePath) {
      throw new PermitSourceError(
        "Accela requires CHROME_EXECUTABLE_PATH or installed Chrome/Chromium",
        {
          classification: "blocked",
          code: "accela_browser_unavailable",
        },
      );
    }
    browserPromise ??= options.browser
      ? Promise.resolve(options.browser)
      : (await import("puppeteer-core")).default.launch({
          executablePath,
          headless: true,
          args: ["--no-sandbox", "--disable-setuid-sandbox"],
        });
    return browserPromise;
  }

  async function context(page) {
    if (!config.contentFrameName) return page;
    await page.waitForFrame(
      (frame) => frame.name() === config.contentFrameName,
      { timeout: options.timeoutMs ?? 60_000 },
    );
    return page.frames().find(
      (frame) => frame.name() === config.contentFrameName,
    );
  }

  async function openSearch() {
    const page = await (await browser()).newPage();
    await page.goto(config.baseUrl, {
      waitUntil: "domcontentloaded",
      timeout: options.timeoutMs ?? 60_000,
    });
    const dom = await context(page);
    if (!dom) {
      await page.close();
      throw new PermitSourceError("Accela content frame is unavailable", {
        classification: "blocked",
        code: "accela_content_frame_unavailable",
      });
    }
    try {
      await dom.waitForSelector(SELECTORS.parcel, {
        timeout: options.timeoutMs ?? 60_000,
      });
    } catch {
      await page.close();
      throw new PermitSourceError(
        "Accela public parcel search form is unavailable",
        {
          classification: "blocked",
          code: "accela_search_contract_changed",
        },
      );
    }
    return { page, dom };
  }

  async function searchRecords(
    {
      fields,
      requestedParcelIdentifier = null,
      requestedPropertyId = null,
    },
  ) {
    const { page, dom } = await openSearch();
    try {
      for (const [selector, value] of Object.entries(fields)) {
        if (!(await dom.$(selector))) continue;
        await dom.$eval(
          selector,
          (element, nextValue) => {
            element.value = nextValue;
            if (element.tagName === "SELECT") return;
            element.dispatchEvent(new Event("input", { bubbles: true }));
            element.dispatchEvent(new Event("change", { bubbles: true }));
          },
          value,
        );
      }
      await Promise.allSettled([
        dom.waitForNavigation({
          waitUntil: "domcontentloaded",
          timeout: options.timeoutMs ?? 60_000,
        }),
        dom.click(SELECTORS.submit),
      ]);

      const references = [];
      let reportedTotal = null;
      for (let sourcePage = 1; ; sourcePage += 1) {
        const pageHtml = await dom.content();
        await options.onRawEvidence?.({
          kind: "search",
          sourcePage,
          url: dom.url(),
          html: pageHtml,
        });
        if (/\/Cap\/CapDetail\.aspx/i.test(dom.url())) {
          const directPage = cheerio.load(pageHtml);
          const directText = text(directPage("body").text());
          const recordNumber =
            text(
              directPage(
                "#ctl00_PlaceHolderMain_lblPermitNumber",
              ).text(),
            ) ??
            /Record\s+([A-Z0-9][A-Z0-9./_-]+)/i.exec(
              directText ?? "",
            )?.[1] ?? recordNumberFromUrl(dom.url());
          if (!recordNumber) {
            throw new PermitSourceError(
              "Accela direct detail redirect has no stable record number",
              {
                classification: "permanent",
                code: "accela_direct_detail_identity_missing",
              },
            );
          }
          references.push({
            sourceRecordId: recordNumber,
            recordNumber,
            detailUrl: dom.url(),
            address: text(
              (
                text(directPage("#tbl_worklocation").text()) ?? ""
              ).split(/SITE ADDRESS ID:|STRAP:|FOLIO:/i)[0],
            ),
            description: null,
            status: text(
              directPage(
                "#ctl00_PlaceHolderMain_lblRecordStatus",
              ).text(),
            ),
            recordType: text(
              directPage("#ctl00_PlaceHolderMain_lblPermitType").text(),
            ),
            sourcePage,
          });
          reportedTotal = 1;
          break;
        }
        const parsed = parseAccelaSearchPage(pageHtml, {
          pageUrl: dom.url(),
          sourcePage,
        });
        references.push(...parsed.references);
        reportedTotal ??= parsed.reportedTotal;
        if (!parsed.hasNext) {
          if (references.length === 0 && !parsed.noRecords) {
            throw new PermitSourceError(
              "Accela returned neither records nor a no-records marker",
              {
                classification: "permanent",
                code: "accela_ambiguous_empty_result",
              },
            );
          }
          break;
        }
        if (sourcePage >= config.maximumSearchPages) {
          throw new PermitSourceError(
            "Accela pagination exceeded the configured page limit",
            {
              classification: "permanent",
              code: "accela_page_limit_exceeded",
            },
          );
        }
        await Promise.allSettled([
          dom.waitForNavigation({
            waitUntil: "domcontentloaded",
            timeout: options.timeoutMs ?? 60_000,
          }),
          dom.evaluate(() => {
            const next = [...document.querySelectorAll("a")].find(
              (anchor) =>
                /^next\s*>?$/i.test(anchor.textContent?.trim() ?? ""),
            );
            next?.click();
          }),
        ]);
      }

      const deduped = [
        ...new Map(
          references.map((reference) => [
            reference.detailUrl,
            reference,
          ]),
        ).values(),
      ];
      if (deduped.length > config.maximumDetailRecords) {
        throw new PermitSourceError(
          `Accela returned ${deduped.length} records; configured limit is ${config.maximumDetailRecords}`,
          {
            classification: "permanent",
            code: "accela_result_limit_exceeded",
          },
        );
      }
      if (reportedTotal !== null && deduped.length !== reportedTotal) {
        throw new PermitSourceError(
          `Accela reported ${reportedTotal} records but ${deduped.length} unique detail links were extracted`,
          {
            classification: "permanent",
            code: "accela_reconciliation_mismatch",
          },
        );
      }
      const result = deduped.map((reference) => ({
        ...reference,
        requestedParcelIdentifier,
        requestedPropertyId,
      }));
      return Object.assign(result, {
        reconciliation: {
          reported: reportedTotal,
          extracted: deduped.length,
        },
      });
    } finally {
      await page.close();
    }
  }

  return {
    key: "accela",
    async probe() {
      const { page } = await openSearch();
      await page.close();
      return {
        status: "ready",
        ok: true,
        agencyCode: config.agencyCode,
      };
    },

    async searchParcel(rawParcelIdentifier, request = {}) {
      const parcelIdentifier = normalizeParcelIdentifier(
        rawParcelIdentifier,
        options.countyKey ?? "broward",
      );
      return searchRecords({
        fields: {
          [SELECTORS.startDate]: "",
          [SELECTORS.endDate]: "",
          [SELECTORS.parcel]: parcelIdentifier,
        },
        requestedParcelIdentifier: parcelIdentifier,
        requestedPropertyId: request.requestedPropertyId ?? null,
      });
    },

    async searchAddress(
      { streetNumber, streetName },
      request = {},
    ) {
      if (!/^\d+[A-Z]?$/.test(String(streetNumber ?? "").trim())) {
        throw new PermitSourceError("Accela street number is invalid", {
          classification: "permanent",
          code: "accela_invalid_street_number",
        });
      }
      if (!/^[A-Z0-9 .'-]{2,80}$/i.test(String(streetName ?? "").trim())) {
        throw new PermitSourceError("Accela street name is invalid", {
          classification: "permanent",
          code: "accela_invalid_street_name",
        });
      }
      return searchRecords({
        fields: {
          [SELECTORS.startDate]: "",
          [SELECTORS.endDate]: "",
          [SELECTORS.streetNumber]: String(streetNumber).trim(),
          [SELECTORS.streetNumberTo]: String(streetNumber).trim(),
          [SELECTORS.streetName]: String(streetName).trim(),
        },
        requestedParcelIdentifier: request.requestedParcelIdentifier
          ? normalizeParcelIdentifier(
              request.requestedParcelIdentifier,
              options.countyKey ?? "broward",
            )
          : null,
        requestedPropertyId: request.requestedPropertyId ?? null,
      });
    },

    async searchLicense(licenseNumber, request = {}) {
      const normalizedLicense = String(licenseNumber ?? "")
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");
      if (!/^[A-Z]{1,5}\d{4,12}$/.test(normalizedLicense)) {
        throw new PermitSourceError("Accela license number is invalid", {
          classification: "permanent",
          code: "accela_invalid_license_number",
        });
      }
      return searchRecords({
        fields: {
          [SELECTORS.searchType]: "2",
          [SELECTORS.startDate]: request.fromDate ?? "",
          [SELECTORS.endDate]: request.throughDate ?? "",
          [SELECTORS.licenseNumber]: normalizedLicense,
        },
      });
    },

    async fetchPermitDetail(reference) {
      const page = await (await browser()).newPage();
      try {
        await page.goto(reference.detailUrl, {
          waitUntil: "domcontentloaded",
          timeout: options.timeoutMs ?? 60_000,
        });
        const pageHtml = await page.content();
        await options.onRawEvidence?.({
          kind: "detail",
          sourceRecordId: reference.sourceRecordId,
          url: page.url(),
          html: pageHtml,
        });
        return normalizeAccelaPermitDetail(
          pageHtml,
          reference,
          {
            countyKey: options.countyKey ?? "broward",
            countyName: options.countyName ?? "Broward",
            jurisdiction,
            config,
            requestedParcelIdentifier:
              reference.requestedParcelIdentifier,
            requestedPropertyId: reference.requestedPropertyId,
            acceptedParcelIdentifiers:
              options.acceptedParcelIdentifiers ?? [],
          },
        );
      } finally {
        await page.close();
      }
    },

    async close() {
      if (!options.browser && browserPromise) {
        await (await browserPromise).close();
      }
    },
  };
}
