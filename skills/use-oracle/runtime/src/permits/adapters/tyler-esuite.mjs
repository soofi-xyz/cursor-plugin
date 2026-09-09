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
  searchUrl: z.string().url(),
  maximumSearchPages: z.number().int().min(1).max(10).default(5),
  maximumDetailRecords: z.number().int().min(1).max(100).default(50),
  detailFingerprintVersion: z.string().min(1).default("tyler-esuite-v1"),
});

function text(value) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized || null;
}

function labeledFields($) {
  const result = new Map();
  const idFields = {
    "permit type": "lblPermitTypeValue",
    "permit #": "lblPermitNumberValue",
    status: "lblStatusValue",
    address: "lblAddressValue",
    parcel: "lblParcelIdValue",
    description: "lblDescriptionValue",
    "est. improvement value": "lblImprovementValue",
    expires: "lblExpirationDateValue",
    contractor: "lblOtherPartyValue",
  };
  for (const [label, suffix] of Object.entries(idFields)) {
    const value = text($(`[id$="${suffix}"]`).first().text());
    if (value) result.set(label, value);
  }
  $("dt").each((_, element) => {
    const label = text($(element).text())?.replace(/:$/, "").toLowerCase();
    const value = text($(element).next("dd").text());
    if (label && value) result.set(label, value);
  });
  $("label").each((_, element) => {
    const label = text($(element).text())?.replace(/:$/, "").toLowerCase();
    const value =
      text($(element).next().text()) ??
      text($(element).closest("tr").find("td").last().text());
    if (label && value && !result.has(label)) result.set(label, value);
  });
  return result;
}

function field(fields, ...aliases) {
  for (const alias of aliases) {
    const value = fields.get(alias.toLowerCase());
    if (value) return value;
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

function money(raw) {
  if (!raw) return null;
  const parsed = Number(raw.replace(/[$,\s]/g, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function rowValues($, row) {
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

export function parseTylerEsuiteSearchPage(
  html,
  { pageUrl, sourcePage = 1, maximumRecords = 50 },
) {
  const $ = cheerio.load(html);
  const references = [];
  $('a[href*="ContractorPermitDetails.aspx?id="]').each((_, element) => {
    const anchor = $(element);
    const href = anchor.attr("href");
    const permitNumber = text(anchor.text());
    if (!href || !permitNumber) return;
    const detailUrl = new URL(href, pageUrl).toString();
    const sourceRecordId = new URL(detailUrl).searchParams.get("id");
    if (!/^\d+$/.test(sourceRecordId ?? "")) {
      throw new PermitSourceError("eSuite detail link has no numeric id", {
        classification: "permanent",
        code: "esuite_detail_identity_missing",
      });
    }
    const row = rowValues($, anchor.closest("tr"));
    references.push({
      sourceRecordId,
      permitNumber,
      detailUrl,
      sourcePage,
      address: row.get("address") ?? null,
      status: row.get("status") ?? null,
      permitType: row.get("permit type") ?? row.get("type") ?? null,
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
      "eSuite result limit exceeded before detail traversal",
      {
        classification: "permanent",
        code: "esuite_result_limit_exceeded",
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
    noRecords: /no (?:permits|records|results) (?:were )?found/i.test(
      text($("body").text()) ?? "",
    ),
  };
}

export function normalizeTylerEsuitePermitDetail(
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
  const values = labeledFields($);
  const permitNumber = field(values, "Permit #", "Permit Number");
  if (!permitNumber || permitNumber !== reference.permitNumber) {
    throw new PermitSourceError("eSuite detail permit identity mismatch", {
      classification: "permanent",
      code: "esuite_identity_mismatch",
    });
  }
  const sourceParcel = field(
    values,
    "Parcel",
    "Parcel Number",
    "Folio",
  )?.replace(/[-\s]/g, "");
  if (sourceParcel && sourceParcel !== requestedParcelIdentifier) {
    throw new PermitSourceError(
      "eSuite detail parcel differs from requested parcel",
      {
        classification: "permanent",
        code: "esuite_parcel_mismatch",
      },
    );
  }
  const statusDisplay = field(values, "Status");
  const issuedMatch =
    /^(.*?)\s+on\s+(\d{1,2}\/\d{1,2}\/\d{4})$/i.exec(
      statusDisplay ?? "",
    );
  const permitType =
    field(values, "Permit Type", "Type") ?? reference.permitType;
  const description = field(
    values,
    "Description",
    "Project Description",
  );
  const contractor = field(
    values,
    "Contractor",
    "Primary Contractor",
    "General Contractor",
  );
  const contractorLicense = field(
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
    improvement_status: text(issuedMatch?.[1]) ?? statusDisplay,
    improvement_action: null,
    permit_issue_date: date(
      issuedMatch?.[2] ??
        field(values, "Issued Date", "Issue Date", "Issued On"),
    ),
    application_received_date: date(
      field(values, "Application Date", "Applied On"),
    ),
    final_inspection_date: null,
    permit_close_date: null,
    completion_date: null,
    expiration_date: date(
      field(values, "Expires", "Expiration Date"),
    ),
    opened_date: date(field(values, "Application Date", "Applied On")),
    source_system: config.sourceSystem,
    county_name: countyName,
    project_description: description,
    description,
    estimated_job_value: money(
      field(
        values,
        "Est. Improvement Value",
        "Estimated Improvement Value",
        "Valuation",
      ),
    ),
    fee: null,
    countyKey,
    jurisdictionKey: jurisdiction.key,
    sourceRecordId: reference.sourceRecordId,
    sourceUrl: reference.detailUrl,
    requestedParcelIdentifier,
    requestedPropertyId,
    workAddress:
      field(values, "Address", "Service Address") ?? reference.address,
    isRoofPermit: /roof/i.test(
      `${permitType ?? ""} ${description ?? ""}`,
    ),
    contractors: contractor
      ? [
          {
            businessName: contractor,
            licenseNumber: contractorLicense,
            qualifierName: null,
            sourceRole: "contractor",
            phone: null,
            email: null,
          },
        ]
      : [],
    inspections: [],
    relatedRecords: [],
    sourcePayload: normalizeSourcePayload({
      sourceParcelIdentifier: sourceParcel ?? null,
      searchMethod: "service-address",
      detailFingerprintVersion: config.detailFingerprintVersion,
    }),
  });
}

export function createTylerEsuiteAdapter(jurisdiction, options = {}) {
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
        "eSuite requires CHROME_EXECUTABLE_PATH or installed Chrome/Chromium",
        {
          classification: "blocked",
          code: "esuite_browser_unavailable",
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
    await page.goto(config.searchUrl, {
      waitUntil: "domcontentloaded",
      timeout: options.timeoutMs ?? 60_000,
    });
    await page.waitForSelector('textarea[name$="txtServiceAddress"]', {
      timeout: options.timeoutMs ?? 60_000,
    });
    return page;
  }

  return {
    key: "tyler-esuite",
    async probe() {
      const page = await openSearch();
      await page.close();
      return { status: "ready", ok: true };
    },
    async searchParcel(rawParcelIdentifier, request = {}) {
      const parcelIdentifier =
        normalizeBrowardParcelIdentifier(rawParcelIdentifier);
      if (!text(request.workAddress)) {
        throw new PermitSourceError(
          "eSuite requires a property service address for bounded search",
          {
            classification: "unrouted",
            code: "esuite_service_address_required",
          },
        );
      }
      const page = await openSearch();
      try {
        const addressSelector = 'textarea[name$="txtServiceAddress"]';
        await page.type(
          addressSelector,
          request.workAddress.split(",")[0].trim(),
        );
        await page.waitForSelector('[id$="autoCompletePanel"] > div', {
          visible: true,
          timeout: options.timeoutMs ?? 60_000,
        });
        const selectedIndex = await page.evaluate((desired) => {
          const normalize = (value) =>
            String(value ?? "")
              .toUpperCase()
              .replace(/[^A-Z0-9]+/g, "");
          const expected = normalize(desired);
          const choices = [
            ...document.querySelectorAll(
              '[id$="autoCompletePanel"] > div',
            ),
          ];
          return choices.findIndex(
            (choice) => {
              const candidate = normalize(choice.textContent);
              return (
                candidate === expected ||
                candidate.startsWith(expected) ||
                expected.startsWith(candidate)
              );
            },
          );
        }, request.workAddress);
        if (selectedIndex < 0) {
          throw new PermitSourceError(
            "eSuite autocomplete did not return the exact service address",
            {
              classification: "unrouted",
              code: "esuite_address_identity_unproven",
            },
          );
        }
        for (let index = 0; index <= selectedIndex; index += 1) {
          await page.keyboard.press("ArrowDown");
        }
        await page.keyboard.press("Enter");
        const selectedAddress = await page.$eval(
          addressSelector,
          (element) => element.value,
        );
        const normalizedExpected = request.workAddress
          .toUpperCase()
          .replace(/[^A-Z0-9]+/g, "");
        const normalizedSelected = selectedAddress
          .toUpperCase()
          .replace(/[^A-Z0-9]+/g, "");
        if (
          normalizedSelected !== normalizedExpected &&
          !normalizedSelected.startsWith(normalizedExpected) &&
          !normalizedExpected.startsWith(normalizedSelected)
        ) {
          throw new PermitSourceError(
            "eSuite selected a different service address",
            {
              classification: "unrouted",
              code: "esuite_address_identity_mismatch",
            },
          );
        }
        await Promise.allSettled([
          page.waitForNavigation({
            waitUntil: "domcontentloaded",
            timeout: options.timeoutMs ?? 60_000,
          }),
          page.click('input[name$="btnSearch"]'),
        ]);
        const references = [];
        let explicitNoRecords = false;
        for (let sourcePage = 1; ; sourcePage += 1) {
          const parsed = parseTylerEsuiteSearchPage(await page.content(), {
            pageUrl: page.url(),
            sourcePage,
            maximumRecords: config.maximumDetailRecords,
          });
          references.push(...parsed.references);
          explicitNoRecords ||= parsed.noRecords;
          if (!parsed.nextPage) break;
          if (sourcePage >= config.maximumSearchPages) {
            throw new PermitSourceError(
              "eSuite pagination exceeded the configured limit",
              {
                classification: "permanent",
                code: "esuite_page_limit_exceeded",
              },
            );
          }
          await Promise.allSettled([
            page.waitForNavigation({
              waitUntil: "domcontentloaded",
              timeout: options.timeoutMs ?? 60_000,
            }),
            page.click(`a[data-page="${parsed.nextPage}"]`),
          ]);
        }
        if (references.length > config.maximumDetailRecords) {
          throw new PermitSourceError(
            "eSuite result limit exceeded before detail traversal",
            {
              classification: "permanent",
              code: "esuite_result_limit_exceeded",
            },
          );
        }
        if (references.length === 0 && !explicitNoRecords) {
          throw new PermitSourceError(
            "eSuite returned an ambiguous empty result",
            {
              classification: "permanent",
              code: "esuite_ambiguous_empty_result",
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
        return normalizeTylerEsuitePermitDetail(
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
