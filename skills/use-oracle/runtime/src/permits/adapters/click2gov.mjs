import * as cheerio from "cheerio";

import {
  createStablePermitId,
  normalizedPermitRecordSchema,
} from "../contracts.mjs";
import { PermitSourceError } from "../errors.mjs";
import { PermitHttpClient } from "../http.mjs";
import {
  isRoofPermit,
  normalizeDuvalParcelIdentifier,
  parsePortalDate,
  parsePortalMoney,
} from "../normalization.mjs";

function cleanText(value) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

function extractFields($) {
  const fields = new Map();
  $("label").each((_, element) => {
    const label = cleanText($(element).text())
      ?.replace(/\*+/g, "")
      .replace(/:$/, "")
      .trim()
      .toLowerCase();
    const value =
      cleanText($(element).next().find(".form-control-static").text()) ??
      cleanText($(element).next(".form-control-static").text()) ??
      cleanText($(element).parent().find(".form-control-static").text());
    if (label && value && !fields.has(label)) fields.set(label, value);
  });
  return fields;
}

export function parseClick2GovPermitNumber(permitNumber) {
  const match = String(permitNumber ?? "")
    .trim()
    .match(/(?:^|[- ])(\d{2})[- ]0*(\d+)(?:\.\d+)?$/);
  return match ? { appYear: match[1], appNumber: match[2] } : null;
}

export function parseClick2GovDetailHtml(html, fallbackPermitNumber) {
  const $ = cheerio.load(html);
  if (
    !/status detail/i.test($.root().text()) &&
    $(".form-control-static").length === 0
  ) {
    throw new PermitSourceError(
      "Click2Gov response did not contain a status detail",
      {
        classification: "permanent",
        code: "click2gov_detail_shape_changed",
      },
    );
  }
  const fields = extractFields($);
  const contractorText = fields.get("general contractor") ?? null;
  const licenseMatch = contractorText?.match(
    /\b(?:CCC|CBC|CGC|CRC|CFC|EC|CAC)\d{5,10}\b/i,
  );
  const contractorName = contractorText
    ?.replace(licenseMatch?.[0] ?? "", "")
    .trim();
  return {
    permitNumber:
      fields.get("application number") ?? fallbackPermitNumber,
    parcelIdentifier:
      fields.get("parcel id") ??
      fields.get("parcel number") ??
      fields.get("re number") ??
      null,
    improvementType: fields.get("application type") ?? null,
    status: fields.get("application status") ?? null,
    description:
      fields.get("description") ?? fields.get("work description") ?? null,
    applicationDate: fields.get("application date") ?? null,
    issueDate: fields.get("issue date") ?? null,
    finalDate: fields.get("final date") ?? null,
    expirationDate: fields.get("expiration date") ?? null,
    workAddress: fields.get("address") ?? null,
    estimatedJobValue: parsePortalMoney(fields.get("valuation")),
    fee: parsePortalMoney(fields.get("total fees")),
    contractors: contractorName
      ? [
          {
            businessName: contractorName,
            licenseNumber: licenseMatch?.[0].toUpperCase() ?? null,
            qualifierName: null,
            phone: null,
            email: null,
          },
        ]
      : [],
  };
}

export function normalizeClick2GovPermit(
  parsed,
  { requestedParcelIdentifier, requestedPropertyId, sourceUrl },
) {
  const requestedParcel = normalizeDuvalParcelIdentifier(
    requestedParcelIdentifier,
  );
  const sourceParcel = normalizeDuvalParcelIdentifier(
    parsed.parcelIdentifier,
  );
  if (sourceParcel !== requestedParcel) {
    throw new PermitSourceError(
      `Click2Gov permit ${parsed.permitNumber} returned parcel ${sourceParcel}, expected ${requestedParcel}`,
      {
        classification: "permanent",
        code: "parcel_evidence_mismatch",
      },
    );
  }
  const sourceRecordId = parsed.permitNumber;
  return normalizedPermitRecordSchema.parse({
    schemaVersion: "elephant.normalized-permit-record.v1",
    property_improvement_id: createStablePermitId({
      countyKey: "duval",
      jurisdictionKey: "jacksonville-beach",
      sourceRecordId,
    }),
    property_id: requestedPropertyId,
    parcel_identifier: requestedParcel,
    permit_number: parsed.permitNumber,
    improvement_type: parsed.improvementType,
    improvement_status: parsed.status,
    improvement_action: null,
    permit_issue_date: parsePortalDate(parsed.issueDate),
    application_received_date: parsePortalDate(parsed.applicationDate),
    final_inspection_date: parsePortalDate(parsed.finalDate),
    permit_close_date: parsePortalDate(parsed.finalDate),
    completion_date: parsePortalDate(parsed.finalDate),
    expiration_date: parsePortalDate(parsed.expirationDate),
    opened_date: parsePortalDate(parsed.applicationDate),
    source_system: "CentralSquare Click2Gov",
    county_name: "Duval",
    project_description: parsed.description,
    description: parsed.description,
    estimated_job_value: parsed.estimatedJobValue,
    fee: parsed.fee,
    countyKey: "duval",
    jurisdictionKey: "jacksonville-beach",
    sourceRecordId,
    sourceUrl,
    requestedParcelIdentifier: requestedParcel,
    requestedPropertyId,
    workAddress: parsed.workAddress,
    isRoofPermit: isRoofPermit(
      parsed.improvementType,
      parsed.description,
      ...parsed.contractors.map((contractor) => contractor.businessName),
    ),
    contractors: parsed.contractors,
    inspections: [],
    relatedRecords: [],
    sourcePayload: parsed,
  });
}

function createSession(client, baseUrl) {
  return client.text(baseUrl, {
    headers: {
      accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
}

function parseSearchReferences(html, baseUrl) {
  const $ = cheerio.load(html);
  const references = [];
  $("a, button").each((_, element) => {
    const text = cleanText($(element).text());
    const href = $(element).attr("href");
    const permitNumber =
      text?.match(/\b[A-Z]{0,8}-?\d{2}-\d+(?:\.\d+)?\b/i)?.[0] ??
      href?.match(/[?&](?:permit|activityNo)=([^&]+)/i)?.[1];
    if (!permitNumber) return;
    references.push({
      sourceRecordId: decodeURIComponent(permitNumber),
      permitNumber: decodeURIComponent(permitNumber),
      sourceUrl: href ? new URL(href, baseUrl).href : baseUrl,
      sourcePayload: { text, href: href ?? null },
    });
  });
  return [
    ...new Map(
      references.map((reference) => [
        reference.sourceRecordId,
        reference,
      ]),
    ).values(),
  ];
}

export function createClick2GovAdapter(jurisdiction, options = {}) {
  const config = jurisdiction.adapterConfig;
  const client =
    options.client ??
    new PermitHttpClient({
      minimumDelayMs: config.minimumDelayMs,
      maxAttempts: options.maxAttempts ?? 3,
    });
  return Object.freeze({
    key: "click2gov",
    async probe() {
      const { body } = await createSession(client, config.baseUrl);
      return {
        status: /select permit|parcel\.parcelNumber/i.test(body)
          ? "ok"
          : "unexpected",
      };
    },
    async searchParcel(parcelIdentifier) {
      const requestedParcel =
        normalizeDuvalParcelIdentifier(parcelIdentifier);
      const { body: initialHtml } = await createSession(
        client,
        config.baseUrl,
      );
      const $ = cheerio.load(initialHtml);
      const csrf = $('input[name="OWASP_CSRFTOKEN"]').val();
      const segments = requestedParcel.split("-");
      const form = new URLSearchParams({
        searchResultsView: "true",
        searchType: "2",
        finish: "Continue",
      });
      config.parcelFieldNames.forEach((name, index) => {
        form.set(name, segments[index] ?? "");
      });
      if (csrf) form.set("OWASP_CSRFTOKEN", csrf);
      const { body } = await client.text(config.baseUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          referer: config.baseUrl,
        },
        body: form.toString(),
      });
      if (/no (?:records|permits) found/i.test(body)) return [];
      return parseSearchReferences(body, config.baseUrl);
    },
    async fetchPermitDetail(reference, request) {
      const parsedNumber = parseClick2GovPermitNumber(
        reference.permitNumber ?? reference.sourceRecordId,
      );
      if (!parsedNumber) {
        throw new PermitSourceError(
          `Unsupported Click2Gov permit number ${reference.sourceRecordId}`,
          {
            classification: "permanent",
            code: "invalid_permit_number",
          },
        );
      }
      const { body: initialHtml } = await createSession(
        client,
        config.baseUrl,
      );
      const $ = cheerio.load(initialHtml);
      const form = new URLSearchParams({
        validatePermitView: "true",
        searchType: "0",
        "permit.appYear": parsedNumber.appYear,
        "permit.appNumber": parsedNumber.appNumber,
        finish: "Continue",
      });
      const csrf = $('input[name="OWASP_CSRFTOKEN"]').val();
      if (csrf) form.set("OWASP_CSRFTOKEN", csrf);
      const { body } = await client.text(config.baseUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          referer: config.baseUrl,
        },
        body: form.toString(),
      });
      const parsed = parseClick2GovDetailHtml(
        body,
        reference.permitNumber ?? reference.sourceRecordId,
      );
      return normalizeClick2GovPermit(parsed, {
        ...request,
        sourceUrl: config.baseUrl,
      });
    },
  });
}
