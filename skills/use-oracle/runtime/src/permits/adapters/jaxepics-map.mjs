import {
  createStablePermitId,
  normalizedPermitRecordSchema,
} from "../contracts.mjs";
import { PermitSourceError } from "../errors.mjs";
import { PermitHttpClient } from "../http.mjs";
import {
  isRoofPermit,
  normalizeDuvalParcelIdentifier,
  parsePortalMoney,
} from "../normalization.mjs";

const PERMIT_TYPES = new Map([
  [1, "Building Permit"],
  [2, "Mechanical Permit"],
  [3, "Electrical Permit"],
  [4, "Plumbing Permit"],
  [5, "Sign Permit"],
  [6, "Mobile Home Permit"],
  [7, "SiteWork Permit"],
  [8, "Roofing Permit"],
  [9, "Fire Permit"],
  [10, "Right Of Way Permit"],
]);

const PERMIT_STATUSES = new Map([
  [12, "Active"],
  [15, "Inspection"],
  [21, "Canceled"],
  [22, "Expired"],
  [23, "Finalized"],
  [36, "Waiting"],
  [133, "In Review"],
  [134, "Approved Pending Payment"],
  [136, "Re-Opened"],
  [137, "Work Stopped"],
  [139, "Finalized - NIF"],
  [140, "Return For Corrections"],
  [152, "Suspended"],
  [157, "Intake"],
  [159, "Agency Review"],
  [161, "Pending Review Payment"],
]);

function nullableText(value) {
  const text = String(value ?? "").trim();
  return text && !/^(?:na|n\/a|not available|not set)$/i.test(text)
    ? text
    : null;
}

function epochDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const date = new Date(parsed);
  return Number.isNaN(date.valueOf())
    ? null
    : date.toISOString().slice(0, 10);
}

function sourceRecordId(attributes) {
  const value = attributes.RecordID ?? attributes.OBJECTID;
  if (!Number.isInteger(Number(value))) {
    throw new PermitSourceError("BID permit omitted RecordID and OBJECTID", {
      classification: "permanent",
      code: "missing_source_record_id",
    });
  }
  return String(value);
}

export function normalizeJaxPermitMapFeature(
  feature,
  { requestedParcelIdentifier, requestedPropertyId },
) {
  const attributes = feature?.attributes ?? feature;
  const parcelIdentifier = normalizeDuvalParcelIdentifier(
    requestedParcelIdentifier ?? attributes.RE,
  );
  const recordId = sourceRecordId(attributes);
  const status =
    PERMIT_STATUSES.get(Number(attributes.Status)) ??
    (attributes.Status === null || attributes.Status === undefined
      ? null
      : `Status ${attributes.Status}`);
  const permitType =
    PERMIT_TYPES.get(Number(attributes.PermitTypeID)) ??
    nullableText(attributes.FullPermitNumber)?.split("-")[0] ??
    null;
  const openedDate = epochDate(attributes.DateEntered);
  const updatedDate = epochDate(attributes.DateUpdated);
  const paidDate = epochDate(attributes.PaidDay);
  const lastInspectionDate = epochDate(attributes.DateLastInspection);
  const finalized = /^Finalized\b/i.test(status ?? "");
  const expired = status === "Expired";
  const companyName = nullableText(attributes.CompanyName);
  const description = nullableText(attributes.Comments);
  const action =
    nullableText(attributes.TypeOfWork) ??
    nullableText(attributes.TypeOfWorkOtherDesc);
  const workAddress = [
    nullableText(attributes.ADDR),
    nullableText(attributes.APTNUM)
      ? `#${nullableText(attributes.APTNUM)}`
      : null,
    nullableText(attributes.CITY) ?? "JACKSONVILLE",
    "FL",
    nullableText(attributes.ZIPCODE),
  ]
    .filter(Boolean)
    .join(", ");
  return normalizedPermitRecordSchema.parse({
    schemaVersion: "elephant.normalized-permit-record.v1",
    property_improvement_id: createStablePermitId({
      countyKey: "duval",
      jurisdictionKey: "jacksonville",
      sourceRecordId: recordId,
    }),
    property_id: requestedPropertyId ?? null,
    parcel_identifier: parcelIdentifier,
    permit_number: nullableText(attributes.FullPermitNumber),
    improvement_type: permitType,
    improvement_status: status,
    improvement_action: action,
    permit_issue_date: paidDate ?? openedDate,
    application_received_date: openedDate,
    final_inspection_date: lastInspectionDate,
    permit_close_date: finalized ? updatedDate : null,
    completion_date: finalized
      ? (lastInspectionDate ?? updatedDate)
      : null,
    expiration_date: expired ? updatedDate : null,
    opened_date: openedDate,
    source_system: "duval_jaxepics_bid_map",
    county_name: "Duval",
    project_description: nullableText(attributes.ProposedUseDesc),
    description,
    estimated_job_value: parsePortalMoney(attributes.TotalCost),
    fee: null,
    countyKey: "duval",
    jurisdictionKey: "jacksonville",
    sourceRecordId: recordId,
    sourceUrl: `https://maps.coj.net/bid/default.aspx?ID=${encodeURIComponent(recordId)}`,
    requestedParcelIdentifier: parcelIdentifier,
    requestedPropertyId: requestedPropertyId ?? null,
    workAddress: workAddress || null,
    isRoofPermit: isRoofPermit(
      permitType,
      action,
      description,
      attributes.FullPermitNumber,
    ),
    contractors: companyName
      ? [
          {
            businessName: companyName,
            licenseNumber: null,
            qualifierName: null,
            phone: null,
            email: null,
          },
        ]
      : [],
    inspections: lastInspectionDate
      ? [
          {
            inspectionType: "Last inspection",
            inspectionDate: lastInspectionDate,
            result: finalized ? "Finalized" : null,
          },
        ]
      : [],
    relatedRecords:
      attributes.AssociatePermitID === null ||
      attributes.AssociatePermitID === undefined
        ? []
        : [String(attributes.AssociatePermitID)],
    sourcePayload: attributes,
  });
}

export function createJaxPermitMapAdapter(jurisdiction, options = {}) {
  const config = jurisdiction.adapterConfig;
  if (!config?.bulkLayerUrl) {
    throw new Error("JaxEPICS bulk layer URL is not configured");
  }
  const client =
    options.client ??
    new PermitHttpClient({
      minimumDelayMs: config.minimumDelayMs,
      maxAttempts: options.maxAttempts ?? 4,
      timeoutMs: options.timeoutMs ?? 60_000,
    });
  const queryUrl = `${config.bulkLayerUrl}/query`;
  const refererUrl = `${new URL(config.bulkLayerUrl).origin}/bid/default.aspx`;

  async function query(parameters) {
    const { body } = await client.json(queryUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        referer: refererUrl,
      },
      body: new URLSearchParams({ ...parameters, f: "json" }),
    });
    if (body?.error) {
      throw new PermitSourceError(
        `BID permit layer returned ArcGIS error ${body.error.code}: ${body.error.message}`,
        {
          classification: "transient",
          code: "arcgis_query_error",
          status: Number(body.error.code) || null,
        },
      );
    }
    return body;
  }

  return Object.freeze({
    key: "jaxepics-map",
    pageSize: config.bulkPageSize ?? 2000,
    async probe() {
      const body = await query({
        where: "1=1",
        returnCountOnly: "true",
      });
      return { status: "ok", count: Number(body.count) };
    },
    async getSnapshot() {
      const latest = await query({
        where: "1=1",
        outFields: "OBJECTID",
        returnGeometry: "false",
        orderByFields: "OBJECTID DESC",
        resultRecordCount: "1",
      });
      const maxObjectId = Number(
        latest.features?.[0]?.attributes?.OBJECTID,
      );
      if (!Number.isInteger(maxObjectId) || maxObjectId < 1) {
        throw new Error("BID permit layer did not return a maximum OBJECTID");
      }
      const where = `OBJECTID <= ${maxObjectId}`;
      const countResult = await query({
        where,
        returnCountOnly: "true",
      });
      const count = Number(countResult.count);
      if (!Number.isInteger(count) || count < 1) {
        throw new Error("BID permit layer did not return a valid row count");
      }
      return { maxObjectId, count, where };
    },
    async fetchPage({ where, offset, pageSize = config.bulkPageSize ?? 2000 }) {
      const body = await query({
        where,
        outFields: "*",
        returnGeometry: "false",
        orderByFields: "OBJECTID ASC",
        resultOffset: String(offset),
        resultRecordCount: String(pageSize),
      });
      if (!Array.isArray(body.features)) {
        throw new Error("BID permit layer page omitted features");
      }
      return {
        features: body.features,
        exceededTransferLimit: Boolean(body.exceededTransferLimit),
      };
    },
  });
}
