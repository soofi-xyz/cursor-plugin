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
  maximumDetailRecords: z.number().int().min(1).max(100).default(50),
  detailFingerprintVersion: z
    .string()
    .min(1)
    .default("coconut-creek-status-v1"),
});

function text(value) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized || null;
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

function match(body, label, nextLabels) {
  return text(
    new RegExp(
      `${label}\\s*:\\s*(.*?)(?=${nextLabels.join("|")}|$)`,
      "is",
    ).exec(body)?.[1],
  );
}

export function parseCoconutCreekSearchPage(
  html,
  { pageUrl, maximumRecords = 50 },
) {
  const $ = cheerio.load(html);
  const references = [];
  $('input[name="btnsubmit"]').each((_, element) => {
    const button = $(element);
    const permitNumber = text(button.attr("value"));
    if (!permitNumber) return;
    const cells = button
      .closest("tr")
      .find("td")
      .toArray()
      .map((cell) => text($(cell).text()));
    references.push({
      sourceRecordId: permitNumber,
      permitNumber,
      detailUrl: new URL(
        `permit_status_03.asp?permit_no=${encodeURIComponent(permitNumber)}`,
        pageUrl,
      ).toString(),
      status: cells[1] ?? null,
      permitType: cells[2] ?? null,
      address: cells[4] ?? null,
    });
  });
  if (references.length > maximumRecords) {
    throw new PermitSourceError(
      "Coconut Creek result limit exceeded before detail traversal",
      {
        classification: "permanent",
        code: "coconut_creek_result_limit_exceeded",
      },
    );
  }
  return {
    references,
    noRecords: /no (?:matching )?(?:permits|records|results)/i.test(
      text($("body").text()) ?? "",
    ),
  };
}

export function normalizeCoconutCreekPermitDetail(
  { baseHtml, permitHtml, contractorHtml, inspectionHtml },
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
  const baseText = text(cheerio.load(baseHtml)("body").text()) ?? "";
  const permitText = text(cheerio.load(permitHtml)("body").text()) ?? "";
  const contractorText =
    text(cheerio.load(contractorHtml)("body").text()) ?? "";
  const sourceParcel = match(baseText, "Property ID", [
    "Permit Desc",
  ])?.replace(/[-\s]/g, "");
  if (sourceParcel !== requestedParcelIdentifier) {
    throw new PermitSourceError(
      "Coconut Creek detail parcel differs from requested parcel",
      {
        classification: "permanent",
        code: "coconut_creek_parcel_mismatch",
      },
    );
  }
  const permitNumber =
    match(permitText, "Permit Number", ["Status"]) ??
    match(baseText, "Permit #", ["Property ID"]);
  if (permitNumber !== reference.permitNumber) {
    throw new PermitSourceError(
      "Coconut Creek detail permit identity mismatch",
      {
        classification: "permanent",
        code: "coconut_creek_identity_mismatch",
      },
    );
  }
  const permitType =
    match(permitText, "Type", ["Applied Date"]) ?? reference.permitType;
  const description = match(baseText, "Permit Desc", [
    "Property Address",
  ]);
  const contractor = match(contractorText, "Gen Cont", ["Address"]);
  const contractorPhone = match(contractorText, "Phone", [
    "Wk Comp",
    "Ins Exp",
    "Lic Exp",
    "Status",
  ]);
  const inspections = [];
  const $inspection = cheerio.load(inspectionHtml);
  $inspection("table").each((_, tableElement) => {
    const table = $inspection(tableElement);
    const headers = table
      .find("th")
      .toArray()
      .map((header) => text($inspection(header).text())?.toLowerCase());
    const typeIndex = headers.indexOf("type");
    const dateIndex = headers.indexOf("insp date");
    const statusIndex = headers.indexOf("status");
    if (typeIndex < 0 || dateIndex < 0) return;
    table.find("tbody tr, tr").each((__, element) => {
      const cells = $inspection(element)
        .find("td")
        .toArray()
        .map((cell) => text($inspection(cell).text()));
      if (!cells[typeIndex]) return;
      inspections.push({
        inspectionType: cells[typeIndex],
        inspectionDate: date(cells[dateIndex]),
        result: statusIndex < 0 ? null : cells[statusIndex],
      });
    });
  });

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
    improvement_status:
      match(permitText, "Status", ["Type"]) ?? reference.status,
    improvement_action: null,
    permit_issue_date: date(
      match(permitText, "Issued Date", ["Operator", "Master Number"]),
    ),
    application_received_date: date(
      match(permitText, "Applied Date", ["Operator", "Issued Date"]),
    ),
    final_inspection_date:
      inspections.map((inspection) => inspection.inspectionDate).filter(Boolean)
        .sort()
        .at(-1) ?? null,
    permit_close_date: null,
    completion_date: null,
    expiration_date: null,
    opened_date: date(
      match(permitText, "Applied Date", ["Operator", "Issued Date"]),
    ),
    source_system: config.sourceSystem,
    county_name: countyName,
    project_description: description,
    description,
    estimated_job_value: money(
      match(permitText, "Applied Value", ["Units", "Calc Value"]),
    ),
    fee: money(match(baseText, "Amount Due", ["Pending Payment"])),
    countyKey,
    jurisdictionKey: jurisdiction.key,
    sourceRecordId: permitNumber,
    sourceUrl: reference.detailUrl,
    requestedParcelIdentifier,
    requestedPropertyId,
    workAddress:
      match(baseText, "Property Address", ["Amount Due"]) ??
      reference.address,
    isRoofPermit: /roof/i.test(
      `${permitType ?? ""} ${description ?? ""}`,
    ),
    contractors: contractor
      ? [
          {
            businessName: contractor,
            licenseNumber: null,
            qualifierName: null,
            sourceRole: "general contractor",
            phone: contractorPhone,
            email: null,
          },
        ]
      : [],
    inspections,
    relatedRecords: [],
    sourcePayload: normalizeSourcePayload({
      sourceParcelIdentifier: sourceParcel,
      detailFingerprintVersion: config.detailFingerprintVersion,
    }),
  });
}

export function createCoconutCreekStatusAdapter(
  jurisdiction,
  options = {},
) {
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
        "Coconut Creek requires CHROME_EXECUTABLE_PATH or installed Chrome/Chromium",
        {
          classification: "blocked",
          code: "coconut_creek_browser_unavailable",
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

  return {
    key: "coconut-creek-status",
    async probe() {
      const page = await (await browser()).newPage();
      try {
        await page.goto(config.baseUrl, {
          waitUntil: "domcontentloaded",
          timeout: options.timeoutMs ?? 60_000,
        });
        return {
          status: (await page.$("#parcel_id")) ? "ready" : "unexpected",
          ok: Boolean(await page.$("#parcel_id")),
        };
      } finally {
        await page.close();
      }
    },
    async searchParcel(rawParcelIdentifier, request = {}) {
      const parcelIdentifier =
        normalizeBrowardParcelIdentifier(rawParcelIdentifier);
      const page = await (await browser()).newPage();
      try {
        await page.goto(config.baseUrl, {
          waitUntil: "domcontentloaded",
          timeout: options.timeoutMs ?? 60_000,
        });
        await page.type("#parcel_id", parcelIdentifier);
        await Promise.all([
          page.waitForNavigation({
            waitUntil: "domcontentloaded",
            timeout: options.timeoutMs ?? 60_000,
          }),
          page.click('input[name="submitbutton"]'),
        ]);
        const parsed = parseCoconutCreekSearchPage(await page.content(), {
          pageUrl: page.url(),
          maximumRecords: config.maximumDetailRecords,
        });
        if (parsed.references.length === 0 && !parsed.noRecords) {
          throw new PermitSourceError(
            "Coconut Creek returned an ambiguous empty result",
            {
              classification: "permanent",
              code: "coconut_creek_ambiguous_empty_result",
            },
          );
        }
        return parsed.references.map((reference) => ({
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
      const submitSection = async (name) => {
        await Promise.all([
          page.waitForNavigation({
            waitUntil: "domcontentloaded",
            timeout: options.timeoutMs ?? 60_000,
          }),
          page.$eval(
            `input[name="${name}"]`,
            (element) => element.form.requestSubmit(element),
          ),
        ]);
        return page.content();
      };
      try {
        await page.goto(reference.detailUrl, {
          waitUntil: "domcontentloaded",
          timeout: options.timeoutMs ?? 60_000,
        });
        const baseHtml = await page.content();
        const permitHtml = await submitSection("Permit");
        const contractorHtml = await submitSection("Contractors");
        const inspectionHtml = await submitSection("Inspections");
        return normalizeCoconutCreekPermitDetail(
          { baseHtml, permitHtml, contractorHtml, inspectionHtml },
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
