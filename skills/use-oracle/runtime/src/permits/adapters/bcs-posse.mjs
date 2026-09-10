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

const configSchema = z.object({
  sourceSystem: z.string().min(1),
  baseUrl: z.string().url(),
  maximumDetailRecords: z.number().int().min(1).max(125).default(75),
  detailFingerprintVersion: z.string().min(1).default("bcs-posse-v1"),
});

function text(value) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized || null;
}

function date(value) {
  const normalized = text(value);
  if (!normalized || /^mmm dd, yyyy$/i.test(normalized)) return null;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.valueOf())
    ? null
    : parsed.toISOString().slice(0, 10);
}

function detailField($, prefix, objectId) {
  const values = $(`span[id^="${prefix}_"][id$="_${objectId}_sp"]`)
    .toArray()
    .map((element) => text($(element).text()))
    .filter(Boolean);
  if (values.length > 1) {
    throw new PermitSourceError(
      `BCS detail has duplicate ${prefix} fields`,
      { classification: "permanent", code: "bcs_ambiguous_detail" },
    );
  }
  return values[0] ?? null;
}

function gridField(row, prefix, objectId) {
  return text(
    row.find(`span[id^="${prefix}_"][id$="_${objectId}_sp"]`).first().text(),
  );
}

function sourceObjectId(href) {
  const parsed = new URL(href, "https://dpepp.broward.org/BCS/");
  const objectId = parsed.searchParams.get("PosseObjectId");
  return /^\d+$/.test(objectId ?? "") ? objectId : null;
}

export function parseBcsPossePermitList(html, listUrl) {
  const $ = cheerio.load(html);
  const references = [];
  let listedRows = 0;
  let excludedNonPermitRows = 0;
  $("tr.possegrid").each((_, element) => {
    const row = $(element);
    listedRows += 1;
    const anchor = row
      .find(
        'a[href*="PossePresentation=ViewPermit"], a[href*="PossePresentation=ViewMasterPermit"]',
      )
      .first();
    const href = anchor.attr("href");
    if (!href) {
      excludedNonPermitRows += 1;
      return;
    }
    const cells = row
      .find("td")
      .toArray()
      .map((cell) => text($(cell).text()));
    const detailUrl = new URL(href, listUrl).toString();
    const objectId = sourceObjectId(detailUrl);
    if (!objectId) return;
    references.push({
      sourceRecordId: objectId,
      detailUrl,
      permitNumber: cells[1] ?? null,
      sourceRecordKind: /ViewMasterPermit/.test(href) ? "master" : "permit",
      permitType: cells[3] ?? null,
      status: cells[4] ?? null,
      openedAt: date(cells[5]),
      listedContractor: cells[6] ?? null,
    });
  });
  return {
    references,
    listedRows,
    excludedNonPermitRows,
    reportedCount: references.length,
  };
}

export function normalizeBcsPossePermitDetail(
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
  const objectId = reference.sourceRecordId;
  const permitNumber =
    detailField($, "PermitNumber", objectId) ?? reference.permitNumber;
  if (!permitNumber) {
    throw new PermitSourceError("BCS detail has no permit number", {
      classification: "permanent",
      code: "bcs_missing_permit_number",
    });
  }
  const sourceFolio = detailField($, "FolioNumber", objectId);
  const compactSourceFolio = sourceFolio?.replace(/[-\s]/g, "").toUpperCase();
  if (
    compactSourceFolio &&
    (!/^[A-Z0-9]{10}(?:[A-Z0-9]{2})?$/.test(compactSourceFolio) ||
      (compactSourceFolio.length === 12 &&
        compactSourceFolio !== requestedParcelIdentifier))
  ) {
    throw new PermitSourceError(
      `BCS detail folio ${sourceFolio} does not match requested parcel`,
      { classification: "permanent", code: "bcs_parcel_mismatch" },
    );
  }

  const permitType =
    detailField($, "PermitType", objectId) ?? reference.permitType;
  const description = detailField($, "PermitDescription", objectId);
  const contractor =
    detailField($, "GeneralContractor", objectId) ??
    reference.listedContractor;
  const license = detailField($, "ContractorLicenseDisplay", objectId);
  const workAddress = detailField($, "AddressDisplay", objectId);
  const inspections = [];
  $('a[href*="PossePresentation=ViewInspection"]').each((_, anchor) => {
    const row = $(anchor).closest("tr");
    const inspectionId = sourceObjectId($(anchor).attr("href") ?? "");
    const inspectionType =
      inspectionId && gridField(row, "InspectionType", inspectionId);
    if (!inspectionType) return;
    inspections.push({
      inspectionType,
      inspectionDate:
        date(gridField(row, "DateCompleted", inspectionId)) ??
        date(gridField(row, "RequestedDate", inspectionId)),
      result: gridField(row, "Outcome", inspectionId),
    });
  });

  return normalizedPermitRecordSchema.parse({
    schemaVersion: "elephant.normalized-permit-record.v1",
    property_improvement_id: createStablePermitId({
      countyKey,
      jurisdictionKey: jurisdiction.key,
      sourceRecordId: `${reference.sourceRecordKind}:${objectId}`,
    }),
    property_id: requestedPropertyId,
    parcel_identifier: requestedParcelIdentifier,
    permit_number: permitNumber,
    improvement_type: permitType,
    improvement_status: reference.status,
    improvement_action: null,
    permit_issue_date: null,
    application_received_date: reference.openedAt,
    final_inspection_date:
      inspections.map((inspection) => inspection.inspectionDate).filter(Boolean)
        .sort()
        .at(-1) ?? null,
    permit_close_date: null,
    completion_date: null,
    expiration_date: null,
    opened_date: reference.openedAt,
    source_system: config.sourceSystem,
    county_name: countyName,
    project_description: description,
    description,
    estimated_job_value: null,
    fee: null,
    countyKey,
    jurisdictionKey: jurisdiction.key,
    sourceRecordId: `${reference.sourceRecordKind}:${objectId}`,
    sourceUrl: reference.detailUrl,
    requestedParcelIdentifier,
    requestedPropertyId,
    workAddress,
    isRoofPermit: /roof/i.test(
      `${permitType ?? ""} ${description ?? ""}`,
    ),
    contractors: contractor
      ? [
          {
            businessName: contractor,
            licenseNumber: license,
            qualifierName: null,
            sourceRole: "general contractor",
            phone: null,
            email: null,
          },
        ]
      : [],
    inspections,
    relatedRecords: [],
    sourcePayload: normalizeSourcePayload({
      sourceFolio,
      issuingJurisdiction: detailField(
        $,
        "ParcelJurisdiction",
        objectId,
      ),
      legalDescription: detailField(
        $,
        "ParcelLegalDescription",
        objectId,
      ),
      projectId: detailField($, "ProjectId", objectId),
      detailFingerprintVersion: config.detailFingerprintVersion,
    }),
  });
}

export function createBcsPosseAdapter(jurisdiction, options = {}) {
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
        "BCS/POSSE requires CHROME_EXECUTABLE_PATH or installed Chrome/Chromium",
        {
          classification: "blocked",
          code: "bcs_browser_unavailable",
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

  async function loadSearch(parcelIdentifier) {
    const page = await (await browser()).newPage();
    try {
      await page.goto(config.baseUrl, {
        waitUntil: "domcontentloaded",
        timeout: options.timeoutMs ?? 45_000,
      });
      const selector = "#ParcelID_23473057_S0";
      if (!(await page.$(selector))) {
        throw new PermitSourceError("BCS parcel input is unavailable", {
          classification: "blocked",
          code: "bcs_search_contract_changed",
        });
      }
      await page.type(selector, parcelIdentifier);
      await Promise.all([
        page.waitForNavigation({
          waitUntil: "domcontentloaded",
          timeout: options.timeoutMs ?? 45_000,
        }),
        page.click("#ctl00_cphBottomFunctionBand_ctl03_PerformSearch"),
      ]);
      return { html: await page.content(), listUrl: page.url() };
    } finally {
      await page.close();
    }
  }

  return {
    key: "bcs-posse",
    async probe() {
      const page = await (await browser()).newPage();
      try {
        await page.goto(config.baseUrl, {
          waitUntil: "domcontentloaded",
          timeout: options.timeoutMs ?? 45_000,
        });
        return {
          status: "ready",
          ok: Boolean(await page.$("#ParcelID_23473057_S0")),
          title: await page.title(),
        };
      } finally {
        await page.close();
      }
    },

    async searchParcel(rawParcelIdentifier, request = {}) {
      const parcelIdentifier =
        normalizeBrowardParcelIdentifier(rawParcelIdentifier);
      const { html, listUrl } = await loadSearch(parcelIdentifier);
      const parsed = parseBcsPossePermitList(html, listUrl);
      if (parsed.references.length > config.maximumDetailRecords) {
        throw new PermitSourceError(
          `BCS returned ${parsed.references.length} records; configured limit is ${config.maximumDetailRecords}`,
          { classification: "permanent", code: "bcs_result_limit_exceeded" },
        );
      }
      const result = parsed.references.map((reference) => ({
          ...reference,
          requestedParcelIdentifier: parcelIdentifier,
          requestedPropertyId: request.requestedPropertyId ?? null,
        }));
      return Object.assign(result, {
        reconciliation: {
          listedRows: parsed.listedRows,
          extracted: parsed.references.length,
          excludedNonPermitRows: parsed.excludedNonPermitRows,
        },
      });
    },

    async fetchPermitDetail(reference) {
      const page = await (await browser()).newPage();
      try {
        await page.goto(reference.detailUrl, {
          waitUntil: "domcontentloaded",
          timeout: options.timeoutMs ?? 45_000,
        });
        return normalizeBcsPossePermitDetail(
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
