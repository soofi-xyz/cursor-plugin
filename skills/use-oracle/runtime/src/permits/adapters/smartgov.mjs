import { existsSync } from "node:fs";

import * as cheerio from "cheerio";
import { z } from "zod";

import {
  createStablePermitId,
  normalizedPermitRecordSchema,
} from "../contracts.mjs";
import { PermitSourceError } from "../errors.mjs";
import {
  normalizeBrowardParcelIdentifier,
  normalizeSourcePayload,
} from "../normalization.mjs";

const configSchema = z.object({
  sourceSystem: z.string().min(1),
  baseUrl: z.string().url(),
  searchUrl: z.string().url().optional(),
  maximumSearchPages: z.number().int().min(1).max(10).default(5),
  maximumDetailRecords: z.number().int().min(1).max(100).default(50),
  detailFingerprintVersion: z.string().min(1).default("smartgov-v1"),
});

function text(value) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized || null;
}

function fields($) {
  const result = new Map();
  $("dt").each((_, element) => {
    const label = text($(element).text())?.replace(/:$/, "").toLowerCase();
    const value = text($(element).next("dd").text());
    if (label && value && !result.has(label)) result.set(label, value);
  });
  $("label").each((_, element) => {
    const label = text($(element).text())?.replace(/:$/, "").toLowerCase();
    const value =
      text($(element).next().text()) ??
      text($(element).closest(".control-group").find(".controls").text());
    if (label && value && !result.has(label)) result.set(label, value);
  });
  return result;
}

function value(fieldMap, ...names) {
  for (const name of names) {
    const found = fieldMap.get(name.toLowerCase());
    if (found) return found;
  }
  return null;
}

function date(raw) {
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.valueOf())
    ? null
    : parsed.toISOString().slice(0, 10);
}

function number(raw) {
  if (!raw) return null;
  const parsed = Number(raw.replace(/[$,\s]/g, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function rowMap($, row) {
  const headers = row
    .closest("table")
    .find("thead th")
    .toArray()
    .map((header) => text($(header).text())?.toLowerCase() ?? "");
  const cells = row
    .find("td")
    .toArray()
    .map((cell) => text($(cell).text()));
  return new Map(headers.map((header, index) => [header, cells[index]]));
}

export function parseSmartGovSearchPage(
  html,
  { pageUrl, sourcePage = 1, maximumRecords = 50 },
) {
  const $ = cheerio.load(html);
  const references = [];
  $(
    'a[href*="/ApplicationPublic/"][href*="ApplicationDetail"], a[href*="/ApplicationPublic/Application/"]',
  ).each((_, element) => {
    const anchor = $(element);
    const href = anchor.attr("href");
    if (!href) return;
    const detailUrl = new URL(href, pageUrl).toString();
    const pathIdentity = new URL(detailUrl).pathname
      .split("/")
      .filter(Boolean)
      .at(-1);
    const permitNumber = text(anchor.text());
    if (!pathIdentity || !permitNumber) return;
    const row = rowMap($, anchor.closest("tr"));
    references.push({
      sourceRecordId: pathIdentity,
      permitNumber,
      detailUrl,
      sourcePage,
      address: row.get("site address") ?? row.get("address") ?? null,
      status: row.get("process status") ?? row.get("status") ?? null,
      permitType:
        row.get("application type") ?? row.get("type") ?? null,
    });
  });
  const deduped = [
    ...new Map(
      references.map((reference) => [
        reference.sourceRecordId,
        reference,
      ]),
    ).values(),
  ];
  if (deduped.length > maximumRecords) {
    throw new PermitSourceError(
      "SmartGov result limit exceeded before detail traversal",
      {
        classification: "permanent",
        code: "smartgov_result_limit_exceeded",
      },
    );
  }
  const nextPage = Number(
    $(`a[data-page="${sourcePage + 1}"]`).attr("data-page") ??
      $("a[rel='next']").attr("data-page") ??
      NaN,
  );
  return {
    references: deduped,
    nextPage: Number.isInteger(nextPage) ? nextPage : null,
    noRecords: /no (?:applications|records|results) (?:were )?found/i.test(
      text($("#search-results").text()) ?? "",
    ),
  };
}

export function normalizeSmartGovPermitDetail(
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
  const values = fields($);
  const permitNumber = value(
    values,
    "Application Number",
    "Permit Number",
  );
  if (!permitNumber || permitNumber !== reference.permitNumber) {
    throw new PermitSourceError(
      "SmartGov detail application identity mismatch",
      {
        classification: "permanent",
        code: "smartgov_identity_mismatch",
      },
    );
  }
  const sourceParcel = value(values, "Parcel Number", "Parcel")?.replace(
    /[-\s]/g,
    "",
  );
  if (sourceParcel && sourceParcel !== requestedParcelIdentifier) {
    throw new PermitSourceError(
      "SmartGov detail parcel differs from requested parcel",
      {
        classification: "permanent",
        code: "smartgov_parcel_mismatch",
      },
    );
  }
  const permitType =
    value(values, "Application Type", "Type") ?? reference.permitType;
  const description = value(
    values,
    "Permit Project Name",
    "Project Name",
    "Description",
  );
  const contractor = value(
    values,
    "Primary Contractor",
    "Contractor",
  );
  const license = value(
    values,
    "Contractor License",
    "License Number",
  );

  return normalizedPermitRecordSchema.parse({
    schemaVersion: "elephant.normalized-permit-record.v1",
    property_improvement_id: createStablePermitId({
      countyKey,
      jurisdictionKey: jurisdiction.key,
      sourceRecordId: reference.sourceRecordId,
    }),
    property_id: requestedPropertyId,
    parcel_identifier: requestedParcelIdentifier,
    permit_number: permitNumber,
    improvement_type: permitType,
    improvement_status:
      value(values, "Process Status", "Status") ?? reference.status,
    improvement_action: null,
    permit_issue_date: date(value(values, "Issued On", "Issued Date")),
    application_received_date: date(
      value(values, "Submitted On", "Application Date"),
    ),
    final_inspection_date: null,
    permit_close_date: null,
    completion_date: null,
    expiration_date: date(
      value(values, "Expiration Date", "Expires"),
    ),
    opened_date: date(
      value(values, "Submitted On", "Application Date"),
    ),
    source_system: config.sourceSystem,
    county_name: countyName,
    project_description: description,
    description,
    estimated_job_value: number(
      value(values, "Valuation", "Project Value"),
    ),
    fee: null,
    countyKey,
    jurisdictionKey: jurisdiction.key,
    sourceRecordId: reference.sourceRecordId,
    sourceUrl: reference.detailUrl,
    requestedParcelIdentifier,
    requestedPropertyId,
    workAddress:
      value(values, "Site Address", "Address") ?? reference.address,
    isRoofPermit: /roof/i.test(
      `${permitType ?? ""} ${description ?? ""}`,
    ),
    contractors: contractor
      ? [
          {
            businessName: contractor,
            licenseNumber: license,
            qualifierName: null,
            sourceRole: "primary contractor",
            phone: null,
            email: null,
          },
        ]
      : [],
    inspections: [],
    relatedRecords: [],
    sourcePayload: normalizeSourcePayload({
      sourceParcelIdentifier: sourceParcel ?? null,
      detailFingerprintVersion: config.detailFingerprintVersion,
    }),
  });
}

export function createSmartGovAdapter(jurisdiction, options = {}) {
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
        "SmartGov requires CHROME_EXECUTABLE_PATH or installed Chrome/Chromium",
        {
          classification: "blocked",
          code: "smartgov_browser_unavailable",
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

  async function openSearch() {
    const page = await (await browser()).newPage();
    await page.goto(config.searchUrl ?? config.baseUrl, {
      waitUntil: "domcontentloaded",
      timeout: options.timeoutMs ?? 60_000,
    });
    await page.waitForSelector(
      'input[name="PrimaryParcel.Parcel.ParcelNumber"]',
      { timeout: options.timeoutMs ?? 60_000 },
    );
    return page;
  }

  return {
    key: "smartgov",
    async probe() {
      const page = await openSearch();
      await page.close();
      return { status: "ready", ok: true };
    },
    async searchParcel(rawParcelIdentifier, request = {}) {
      const parcelIdentifier =
        normalizeBrowardParcelIdentifier(rawParcelIdentifier);
      const page = await openSearch();
      try {
        await page.select("#Module", "Permitting");
        await page.type(
          'input[name="PrimaryParcel.Parcel.ParcelNumber"]',
          parcelIdentifier,
        );
        await page.click("#Search");
        await page.waitForFunction(
          () => {
            const results = document.querySelector("#search-results");
            return (
              results &&
              (/no (applications|records|results)/i.test(
                results.textContent ?? "",
              ) ||
                results.querySelector("a[href*='ApplicationPublic']"))
            );
          },
          { timeout: options.timeoutMs ?? 60_000 },
        );
        const references = [];
        for (let sourcePage = 1; ; sourcePage += 1) {
          const parsed = parseSmartGovSearchPage(await page.content(), {
            pageUrl: page.url(),
            sourcePage,
            maximumRecords: config.maximumDetailRecords,
          });
          references.push(...parsed.references);
          if (!parsed.nextPage) {
            if (references.length === 0 && !parsed.noRecords) {
              throw new PermitSourceError(
                "SmartGov returned an ambiguous empty result",
                {
                  classification: "permanent",
                  code: "smartgov_ambiguous_empty_result",
                },
              );
            }
            break;
          }
          if (sourcePage >= config.maximumSearchPages) {
            throw new PermitSourceError(
              "SmartGov pagination exceeded the configured limit",
              {
                classification: "permanent",
                code: "smartgov_page_limit_exceeded",
              },
            );
          }
          await page.click(`a[data-page="${parsed.nextPage}"]`);
          await page.waitForNetworkIdle({
            idleTime: 500,
            timeout: options.timeoutMs ?? 60_000,
          });
        }
        if (references.length > config.maximumDetailRecords) {
          throw new PermitSourceError(
            "SmartGov result limit exceeded before detail traversal",
            {
              classification: "permanent",
              code: "smartgov_result_limit_exceeded",
            },
          );
        }
        return references.map((reference) => ({
          ...reference,
          requestedParcelIdentifier: parcelIdentifier,
          requestedPropertyId: request.requestedPropertyId ?? null,
        }));
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
        return normalizeSmartGovPermitDetail(
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
