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
} from "../normalization.mjs";

function nullableText(value) {
  const text = String(value ?? "").trim();
  return text && !/^(?:no data|not available|not set)$/i.test(text)
    ? text
    : null;
}

function permitIdFromSearchResult(result) {
  const candidate =
    result?.obj?.PermitId ??
    result?.PermitId ??
    result?.key ??
    String(result?.link ?? "").match(/(?:permit\/|permitId=)(\d+)/i)?.[1];
  return /^\d+$/.test(String(candidate ?? "")) ? String(candidate) : null;
}

export function parseJaxEpicsSearchResponse(payload, apiBaseUrl) {
  const values = Array.isArray(payload?.values)
    ? payload.values
    : Array.isArray(payload)
      ? payload
      : [];
  return values.flatMap((result) => {
    const sourceRecordId = permitIdFromSearchResult(result);
    const canView = result?.CanDoOperation?.[0] ?? true;
    if (!sourceRecordId || !canView) return [];
    return [
      {
        sourceRecordId,
        permitNumber:
          nullableText(result?.obj?.FullPermitNumber) ??
          nullableText(result?.title),
        sourceUrl: new URL(`Permits/${sourceRecordId}`, apiBaseUrl).href,
        sourcePayload: result,
      },
    ];
  });
}

function collectInspections(payload) {
  return (payload.PermitInspections ?? []).flatMap((inspection) => {
    const schedules = inspection.InspectionSchedules ?? [];
    if (schedules.length === 0) {
      return [
        {
          inspectionType:
            nullableText(inspection.Label) ??
            nullableText(inspection.InspectionTypeDescription) ??
            "Inspection",
          inspectionDate: parsePortalDate(inspection.DateUpdated),
          result: inspection.IsCompleted ? "Completed" : null,
        },
      ];
    }
    return schedules.map((schedule) => ({
      inspectionType:
        nullableText(schedule.Label) ??
        nullableText(inspection.Label) ??
        "Inspection",
      inspectionDate:
        parsePortalDate(schedule.DateCompleted) ??
        parsePortalDate(schedule.DateRequested),
      result: nullableText(schedule.InspectionStatusDescription),
    }));
  });
}

function collectContractors(payload) {
  const seen = new Set();
  return (payload.PermitCompanies ?? []).flatMap((entry) => {
    const businessName =
      nullableText(entry?.Company?.BusinessName) ??
      nullableText(entry?.Company?.DisplayName);
    if (!businessName) return [];
    const licenseNumber =
      nullableText(entry?.ContractorQaLicense?.LicenseNumber) ??
      nullableText(entry?.Company?.LicenseNumber);
    const key = `${businessName}\u0000${licenseNumber ?? ""}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [
      {
        businessName,
        licenseNumber,
        qualifierName: nullableText(entry?.Contractor?.DisplayName),
        phone: null,
        email: null,
      },
    ];
  });
}

function collectRelatedRecords(payload) {
  const numbers = [
    ...(payload.AssociatedPermits ?? []),
    ...(payload.BasePermits ?? []),
    ...(payload.SubPermits ?? []),
  ]
    .map(
      (record) =>
        nullableText(record.FullPermitNumber) ??
        nullableText(record.PermitNumber),
    )
    .filter(Boolean);
  return [...new Set(numbers)];
}

function invoiceTotal(payload) {
  const invoices = new Map();
  for (const permitInvoice of payload.PermitInvoices ?? []) {
    const invoice = permitInvoice.Invoice;
    if (!invoice) continue;
    const id = String(invoice.InvoiceId ?? permitInvoice.PermitInvoiceId);
    const amount = Number(invoice.InvoiceAmount);
    if (Number.isFinite(amount) && amount >= 0) invoices.set(id, amount);
  }
  return invoices.size
    ? [...invoices.values()].reduce((sum, value) => sum + value, 0)
    : null;
}

export function normalizeJaxEpicsPermit(
  payload,
  { requestedParcelIdentifier, requestedPropertyId },
) {
  const requestedParcel = normalizeDuvalParcelIdentifier(
    requestedParcelIdentifier,
  );
  const sourceParcel = normalizeDuvalParcelIdentifier(payload?.Address?.Re);
  if (sourceParcel !== requestedParcel) {
    throw new PermitSourceError(
      `JaxEPICS permit ${payload.PermitId} returned parcel ${sourceParcel}, expected ${requestedParcel}`,
      {
        classification: "permanent",
        code: "parcel_evidence_mismatch",
      },
    );
  }
  const sourceRecordId = String(payload.PermitId);
  const inspections = collectInspections(payload);
  const finalInspectionDates = inspections
    .filter((inspection) => /final/i.test(inspection.inspectionType))
    .map((inspection) => inspection.inspectionDate)
    .filter(Boolean)
    .sort();
  const description = nullableText(payload.WorkDescription);
  const permitType = nullableText(payload.PermitTypeDescription);
  const workType = nullableText(payload.WorkTypeDescription);
  const workAddress = [
    nullableText(payload?.Address?.FullAddress),
    nullableText(payload?.Address?.City),
    nullableText(payload?.Address?.State),
    nullableText(payload?.Address?.ZipCode),
  ]
    .filter(Boolean)
    .join(", ");
  return normalizedPermitRecordSchema.parse({
    schemaVersion: "elephant.normalized-permit-record.v1",
    property_improvement_id: createStablePermitId({
      countyKey: "duval",
      jurisdictionKey: "jacksonville",
      sourceRecordId,
    }),
    property_id: requestedPropertyId,
    parcel_identifier: requestedParcel,
    permit_number: nullableText(payload.FullPermitNumber),
    improvement_type: permitType,
    improvement_status: nullableText(payload.StatusDescription),
    improvement_action:
      nullableText(payload.WorkAreaDescription) ?? workType,
    permit_issue_date: parsePortalDate(payload.DateIssued),
    application_received_date:
      parsePortalDate(payload.DateLastSubmitted) ??
      parsePortalDate(payload.DateEntered),
    final_inspection_date: finalInspectionDates.at(-1) ?? null,
    permit_close_date: parsePortalDate(payload.DateFinal),
    completion_date: parsePortalDate(payload.DateFinal),
    expiration_date: parsePortalDate(payload.ExpirationDate),
    opened_date: parsePortalDate(payload.DateEntered),
    source_system: "JaxEPICS",
    county_name: "Duval",
    project_description: nullableText(payload.ProjectName),
    description,
    estimated_job_value:
      Number.isFinite(Number(payload.TotalCost)) &&
      Number(payload.TotalCost) >= 0
        ? Number(payload.TotalCost)
        : null,
    fee: invoiceTotal(payload),
    countyKey: "duval",
    jurisdictionKey: "jacksonville",
    sourceRecordId,
    sourceUrl: `https://jaxepicsapi.coj.net/api/Permits/${sourceRecordId}`,
    requestedParcelIdentifier: requestedParcel,
    requestedPropertyId,
    workAddress: workAddress || null,
    isRoofPermit: isRoofPermit(
      permitType,
      workType,
      description,
      payload.WorkAreaDescription,
    ),
    contractors: collectContractors(payload),
    inspections,
    relatedRecords: collectRelatedRecords(payload),
    sourcePayload: payload,
  });
}

export function createJaxEpicsAdapter(jurisdiction, options = {}) {
  const config = jurisdiction.adapterConfig;
  const client =
    options.client ??
    new PermitHttpClient({
      minimumDelayMs: config.minimumDelayMs,
      maxAttempts: options.maxAttempts ?? 3,
    });
  const apiBaseUrl = config.apiBaseUrl;
  return Object.freeze({
    key: "jaxepics",
    async probe() {
      const { body } = await client.json(
        new URL("Searches/GetSearches", apiBaseUrl),
      );
      return {
        status: body.some?.((item) => item.SearchEntity === "Permit")
          ? "ok"
          : "unexpected",
      };
    },
    async searchParcel(parcelIdentifier) {
      const requestedParcel =
        normalizeDuvalParcelIdentifier(parcelIdentifier);
      const url = new URL(
        "Searches/Permits/RENumberSearch",
        apiBaseUrl,
      );
      url.searchParams.set("searchTerm", requestedParcel);
      const { body } = await client.json(url, {
        method: "POST",
        headers: {
          origin: new URL(config.baseUrl).origin,
          referer: config.baseUrl,
          "content-type": "application/json",
        },
      });
      return parseJaxEpicsSearchResponse(body, apiBaseUrl);
    },
    async fetchPermitDetail(reference, request) {
      const { body } = await client.json(reference.sourceUrl);
      return normalizeJaxEpicsPermit(body, request);
    },
  });
}
