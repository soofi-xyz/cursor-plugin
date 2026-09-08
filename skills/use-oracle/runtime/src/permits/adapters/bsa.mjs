import * as cheerio from "cheerio";

import {
  createStablePermitId,
  normalizedPermitRecordSchema,
} from "../contracts.mjs";
import { PermitSourceError } from "../errors.mjs";
import {
  isRoofPermit,
  normalizeDuvalParcelIdentifier,
  parsePortalDate,
  parsePortalMoney,
} from "../normalization.mjs";

function cleanText(value) {
  const text = String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text && !/^(?:no data to display|not available)$/i.test(text)
    ? text
    : null;
}

function labelMap($) {
  const fields = new Map();
  $(".label-value-row").each((_, row) => {
    const label = cleanText($(row).find(".label-value-row-label").text());
    const value = cleanText($(row).find(".label-value-row-value").text());
    if (label && value && !fields.has(label.toLowerCase())) {
      fields.set(label.toLowerCase(), value);
    }
  });
  $("dt").each((_, labelElement) => {
    const label = cleanText($(labelElement).text());
    const value = cleanText($(labelElement).next("dd").text());
    if (label && value && !fields.has(label.toLowerCase())) {
      fields.set(label.toLowerCase(), value);
    }
  });
  return fields;
}

function parseInspectionRows($) {
  const rows = [];
  const grids = $("#GridInspections tbody tr, #Inspections tbody tr");
  grids.each((_, row) => {
    const cells = $(row)
      .find("td")
      .map((__, cell) => cleanText($(cell).text()))
      .get();
    if (!cells[0]) return;
    if ($(row).closest("#GridInspections").length) {
      rows.push({
        inspectionType: cells[0],
        inspectionDate:
          parsePortalDate(cells[4]) ?? parsePortalDate(cells[3]),
        result: cells[2],
      });
    } else {
      rows.push({
        inspectionType: cells[0],
        inspectionDate: parsePortalDate(cells[2]),
        result: cells[1],
      });
    }
  });
  return rows;
}

export function parseBsaPermitDetailHtml(
  html,
  { permitId = null, sourceUrl = null } = {},
) {
  const $ = cheerio.load(html);
  const fields = labelMap($);
  const header = cleanText($(".record-details-header1").text());
  const permitNumber =
    fields.get("permit number") ??
    header?.match(/permit details:\s*(\S+)/i)?.[1] ??
    cleanText($("[data-permit-id]").find("h1").next().text());
  const parcelFromLink = $(
    'a[href*="ReferenceType=ParcelNumber"]',
  )
    .first()
    .text();
  const parcelRaw =
    fields.get("parcel number") ??
    fields.get("parcel") ??
    cleanText(parcelFromLink) ??
    cleanText($(".record-details-header2").text())?.match(
      /parcel:\s*([\d -]{10,12})/i,
    )?.[1];
  const inferredId =
    permitId ??
    new URL(sourceUrl ?? "https://bsaonline.com/")
      .searchParams.get("permitId") ??
    $("[data-permit-id]").attr("data-permit-id");
  if (!permitNumber || !parcelRaw || !inferredId) {
    throw new PermitSourceError(
      "BS&A permit detail omitted permit, parcel, or record identifier",
      {
        classification: "permanent",
        code: "bsa_detail_shape_changed",
      },
    );
  }
  const inspections = parseInspectionRows($);
  const relatedRecords = [
    ...new Set(
      $('a[href*="/CD_RecordDetails/Permit"], [data-record-number]')
        .map(
          (_, element) =>
            cleanText($(element).attr("data-record-number")) ??
            cleanText($(element).text()),
        )
        .get()
        .filter((value) => value && value !== permitNumber),
    ),
  ];
  const description =
    fields.get("work description") ?? fields.get("description") ?? null;
  const improvementType =
    fields.get("permit type") ?? fields.get("type") ?? null;
  const category = fields.get("category") ?? null;
  const workAddress =
    fields.get("address") ??
    cleanText($(".record-details-header2").text())
      ?.replace(/^.*property address:\s*/i, "")
      .replace(/\s*\|\s*parcel:.*$/i, "") ??
    null;
  return {
    sourceRecordId: String(inferredId),
    permitNumber,
    parcelIdentifier: normalizeDuvalParcelIdentifier(parcelRaw),
    improvementType,
    category,
    status: fields.get("status") ?? null,
    description,
    appliedDate:
      fields.get("applied date") ?? fields.get("applied") ?? null,
    issuedDate:
      fields.get("issued date") ?? fields.get("issued") ?? null,
    expirationDate:
      fields.get("expires date") ?? fields.get("expires") ?? null,
    finaledDate:
      fields.get("finaled date") ?? fields.get("finaled") ?? null,
    estimatedJobValue:
      parsePortalMoney(fields.get("project cost")) ??
      parsePortalMoney(fields.get("valuation")),
    fee: parsePortalMoney(fields.get("total fees")),
    workAddress,
    inspections,
    relatedRecords,
  };
}

export function normalizeBsaPermit(
  parsed,
  { requestedParcelIdentifier, requestedPropertyId, sourceUrl },
) {
  const requestedParcel = normalizeDuvalParcelIdentifier(
    requestedParcelIdentifier,
  );
  if (parsed.parcelIdentifier !== requestedParcel) {
    throw new PermitSourceError(
      `BS&A permit ${parsed.permitNumber} returned parcel ${parsed.parcelIdentifier}, expected ${requestedParcel}`,
      {
        classification: "permanent",
        code: "parcel_evidence_mismatch",
      },
    );
  }
  const finalInspectionDates = parsed.inspections
    .filter((inspection) => /final/i.test(inspection.inspectionType))
    .map((inspection) => inspection.inspectionDate)
    .filter(Boolean)
    .sort();
  return normalizedPermitRecordSchema.parse({
    schemaVersion: "elephant.normalized-permit-record.v1",
    property_improvement_id: createStablePermitId({
      countyKey: "duval",
      jurisdictionKey: "atlantic-beach",
      sourceRecordId: parsed.sourceRecordId,
    }),
    property_id: requestedPropertyId,
    parcel_identifier: requestedParcel,
    permit_number: parsed.permitNumber,
    improvement_type: parsed.improvementType,
    improvement_status: parsed.status,
    improvement_action: parsed.category,
    permit_issue_date: parsePortalDate(parsed.issuedDate),
    application_received_date: parsePortalDate(parsed.appliedDate),
    final_inspection_date: finalInspectionDates.at(-1) ?? null,
    permit_close_date: parsePortalDate(parsed.finaledDate),
    completion_date: parsePortalDate(parsed.finaledDate),
    expiration_date: parsePortalDate(parsed.expirationDate),
    opened_date: parsePortalDate(parsed.appliedDate),
    source_system: "BS&A Online",
    county_name: "Duval",
    project_description: parsed.description,
    description: parsed.description,
    estimated_job_value: parsed.estimatedJobValue,
    fee: parsed.fee,
    countyKey: "duval",
    jurisdictionKey: "atlantic-beach",
    sourceRecordId: parsed.sourceRecordId,
    sourceUrl,
    requestedParcelIdentifier: requestedParcel,
    requestedPropertyId,
    workAddress: parsed.workAddress,
    isRoofPermit: isRoofPermit(
      parsed.improvementType,
      parsed.category,
      parsed.description,
    ),
    contractors: [],
    inspections: parsed.inspections,
    relatedRecords: parsed.relatedRecords,
    sourcePayload: parsed,
  });
}
