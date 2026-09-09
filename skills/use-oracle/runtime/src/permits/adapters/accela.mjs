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
    /of\s+(\d+)\s+records?\s+found/i.exec(summary ?? "")?.[1] ?? NaN,
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
    references.push({
      sourceRecordId:
        text(anchor.text()) ?? recordNumberFromUrl(detailUrl) ?? detailUrl,
      recordNumber: text(anchor.text()),
      detailUrl,
      address: cells[2] ?? null,
      description: cells[3] ?? null,
      status: cells[4] ?? null,
      recordType: cells[5] ?? null,
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
  },
) {
  const $ = cheerio.load(html);
  const rawText = text($("body").text()) ?? "";
  const header =
    /Record\s+([A-Z0-9][A-Z0-9./_-]+)\s*:\s*(.*?)\s+Record Status:\s*(.*?)(?:Click here|Work Location|Record Details|$)/i.exec(
      rawText,
    );
  const permitNumber =
    header?.[1] ?? reference.recordNumber ?? reference.sourceRecordId;
  const permitType = text(header?.[2]) ?? reference.recordType;
  const status = text(header?.[3]) ?? reference.status;
  const sourceParcel =
    /Parcel Number\s+([A-Z0-9-]{10,20})/i.exec(rawText)?.[1]
      ?.replace(/[-\s]/g, "")
      .toUpperCase() ?? null;
  if (sourceParcel && sourceParcel !== requestedParcelIdentifier) {
    throw new PermitSourceError(
      `Accela detail parcel ${sourceParcel} differs from requested parcel`,
      { classification: "permanent", code: "accela_parcel_mismatch" },
    );
  }
  const workAddress =
    text(/Work Location\s+(.*?)(?:\*|Record Details)/i.exec(rawText)?.[1]) ??
    reference.address;
  const description =
    text(
      /Project Description:\s*(.*?)(?:More Details|Estimated Job Value|Parcel Number|$)/i.exec(
        rawText,
      )?.[1],
    ) ?? reference.description;
  const licensedProfessional = text(
    /Licensed Professional:\s*(.*?)(?:Project Description|More Details|$)/i.exec(
      rawText,
    )?.[1],
  );
  const license = text(
    /\b(?:License|License Number|State License)\s*:?\s*([A-Z0-9-]{4,30})/i.exec(
      licensedProfessional ?? "",
    )?.[1],
  );
  const contractorBusinessName = licensedProfessional
    ? text(
        licensedProfessional.replace(
          /\b(?:License|License Number|State License)\s*:?\s*[A-Z0-9-]{4,30}\b/i,
          "",
        ),
      )
    : null;
  const valueText =
    /Estimated Job Value\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i.exec(
      rawText,
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
    parcel_identifier: requestedParcelIdentifier,
    permit_number: permitNumber,
    improvement_type: permitType,
    improvement_status: status,
    improvement_action: null,
    permit_issue_date: dateFromText(rawText, "Issued Date"),
    application_received_date: dateFromText(
      rawText,
      "Application Submitted",
    ),
    final_inspection_date: dateFromText(rawText, "Final Inspection"),
    permit_close_date: dateFromText(rawText, "Closed Date"),
    completion_date: dateFromText(rawText, "Completion Date"),
    expiration_date: dateFromText(rawText, "Expiration Date"),
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
    requestedParcelIdentifier,
    requestedPropertyId,
    workAddress,
    isRoofPermit: /roof/i.test(
      `${permitType ?? ""} ${description ?? ""}`,
    ),
    contractors: contractorBusinessName
      ? [
          {
            businessName: contractorBusinessName,
            licenseNumber: license,
            qualifierName: null,
            sourceRole: "licensed professional",
            phone: null,
            email: null,
          },
        ]
      : [],
    inspections: [],
    relatedRecords: [],
    sourcePayload: normalizeSourcePayload({
      agencyCode: config.agencyCode,
      module: config.module,
      sourceParcelIdentifier: sourceParcel,
      applicant: text(
        /Applicant:\s*(.*?)(?:Licensed Professional|Project Description|$)/i.exec(
          rawText,
        )?.[1],
      ),
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
      const parcelIdentifier =
        normalizeBrowardParcelIdentifier(rawParcelIdentifier);
      const { page, dom } = await openSearch();
      try {
        for (const selector of [SELECTORS.startDate, SELECTORS.endDate]) {
          if (await dom.$(selector)) {
            await dom.$eval(selector, (element) => {
              element.value = "";
              element.dispatchEvent(new Event("change", { bubbles: true }));
            });
          }
        }
        await dom.type(SELECTORS.parcel, parcelIdentifier);
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
          if (/\/Cap\/CapDetail\.aspx/i.test(dom.url())) {
            const directText = text(cheerio.load(pageHtml)("body").text());
            const recordNumber =
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
              address: null,
              description: null,
              status: null,
              recordType: null,
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
              const next = [...document.querySelectorAll("a")].find((anchor) =>
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
            requestedParcelIdentifier: parcelIdentifier,
            requestedPropertyId: request.requestedPropertyId ?? null,
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
    },

    async fetchPermitDetail(reference) {
      const page = await (await browser()).newPage();
      try {
        await page.goto(reference.detailUrl, {
          waitUntil: "domcontentloaded",
          timeout: options.timeoutMs ?? 60_000,
        });
        return normalizeAccelaPermitDetail(
          await page.content(),
          reference,
          {
            countyKey: options.countyKey ?? "broward",
            countyName: options.countyName ?? "Broward",
            jurisdiction,
            config,
            requestedParcelIdentifier:
              reference.requestedParcelIdentifier,
            requestedPropertyId: reference.requestedPropertyId,
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
