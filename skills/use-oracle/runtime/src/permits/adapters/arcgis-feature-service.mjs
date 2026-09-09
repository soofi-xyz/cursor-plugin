import { z } from "zod";

import {
  createStablePermitId,
  normalizedPermitRecordSchema,
} from "../contracts.mjs";
import {
  normalizeSourcePayload,
} from "../normalization.mjs";
import { PermitHttpClient } from "../http.mjs";
import { PermitSourceError } from "../errors.mjs";

const DEFAULT_FIELD_MAP = Object.freeze({
  permitNumber: "PERMIT_NUM",
  permitType: "PERMIT_TYPE",
  status: "PERMIT_STATUS",
  description: "DESCRIPTION",
  address: "ADDRESS",
  parcelIdentifier: "PARCEL_ID",
  issuedAt: "ISSUED_DATE",
  appliedAt: "APPLIED_DATE",
  completedAt: "FINAL_DATE",
  estimatedValue: "JOB_VALUE",
  contractorName: "CONTRACTOR",
  contractorLicense: "LICENSE_NO",
  contractorQualifier: "QUALIFIER",
});

const configSchema = z.object({
  sourceSystem: z.string().min(1),
  layerUrl: z.string().url(),
  objectIdField: z.string().min(1).default("OBJECTID"),
  parcelField: z.string().min(1).nullable(),
  fieldMap: z.record(z.string(), z.string()).default({}),
  bulkPageSize: z.number().int().min(1).max(2000).default(1000),
  maximumResultRecords: z.number().int().min(1).max(10000).default(2000),
  detailFingerprintVersion: z.string().min(1).default("arcgis-v1"),
});

function field(config, key) {
  return config.fieldMap[key] ?? DEFAULT_FIELD_MAP[key];
}

function stringValue(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function dateValue(value) {
  if (value == null || value === "") return null;
  const date =
    typeof value === "number" ? new Date(value) : new Date(String(value));
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function moneyValue(value) {
  if (value == null || value === "") return null;
  const amount = Number(String(value).replace(/[$,\s]/g, ""));
  return Number.isFinite(amount) ? amount : null;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function queryUrl(layerUrl, parameters) {
  const url = new URL(`${layerUrl.replace(/\/+$/, "")}/query`);
  for (const [key, value] of Object.entries(parameters)) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function publicSourceAttributes(attributes) {
  return Object.fromEntries(
    Object.entries(attributes).filter(
      ([key]) => !/(?:owner|applicant|phone|email)/i.test(key),
    ),
  );
}

export function normalizeArcgisPermitFeature(
  feature,
  {
    countyKey,
    countyName,
    jurisdiction,
    config,
    requestedParcelIdentifier,
    requestedPropertyId = null,
  },
) {
  const attributes = feature?.attributes ?? {};
  const permitNumber =
    stringValue(attributes[field(config, "permitNumber")]) ??
    stringValue(attributes[config.objectIdField]);
  if (!permitNumber) {
    throw new PermitSourceError("ArcGIS permit feature has no stable key", {
      classification: "permanent",
      code: "arcgis_missing_permit_key",
    });
  }

  const contractorName = stringValue(
    attributes[field(config, "contractorName")],
  );
  const contractorLicense = stringValue(
    attributes[field(config, "contractorLicense")],
  );
  const contractorQualifier = stringValue(
    attributes[field(config, "contractorQualifier")],
  );
  const sourceParcelIdentifier =
    stringValue(attributes[field(config, "parcelIdentifier")])?.replace(
      /[-\s]/g,
      "",
    ) ?? null;
  if (
    config.parcelField &&
    sourceParcelIdentifier &&
    requestedParcelIdentifier !== "unlinked" &&
    sourceParcelIdentifier !== requestedParcelIdentifier
  ) {
    throw new PermitSourceError(
      `ArcGIS feature parcel ${sourceParcelIdentifier} differs from requested parcel`,
      {
        classification: "permanent",
        code: "arcgis_parcel_mismatch",
      },
    );
  }

  const permitType = stringValue(attributes[field(config, "permitType")]);
  const description = stringValue(attributes[field(config, "description")]);
  const appliedDate =
    dateValue(attributes[field(config, "appliedAt")])?.slice(0, 10) ?? null;
  const issuedDate =
    dateValue(attributes[field(config, "issuedAt")])?.slice(0, 10) ?? null;
  const completedDate =
    dateValue(attributes[field(config, "completedAt")])?.slice(0, 10) ?? null;

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
    improvement_status: stringValue(attributes[field(config, "status")]),
    improvement_action: null,
    permit_issue_date: issuedDate,
    application_received_date: appliedDate,
    final_inspection_date: completedDate,
    permit_close_date: completedDate,
    completion_date: completedDate,
    expiration_date: null,
    opened_date: appliedDate,
    source_system: config.sourceSystem,
    county_name: countyName,
    project_description: description,
    description,
    estimated_job_value: moneyValue(
      attributes[field(config, "estimatedValue")],
    ),
    fee: null,
    countyKey,
    jurisdictionKey: jurisdiction.key,
    sourceRecordId: permitNumber,
    sourceUrl: config.layerUrl,
    requestedParcelIdentifier,
    requestedPropertyId,
    workAddress: stringValue(attributes[field(config, "address")]),
    isRoofPermit: /roof/i.test(`${permitType ?? ""} ${description ?? ""}`),
    contractors:
      contractorName || contractorLicense
        ? [
            {
              businessName: contractorName ?? `License ${contractorLicense}`,
              licenseNumber: contractorLicense,
              qualifierName: contractorQualifier,
              sourceRole: "contractor",
              phone: null,
              email: null,
            },
          ]
        : [],
    inspections: [],
    relatedRecords: [],
    sourcePayload: normalizeSourcePayload({
      attributes: publicSourceAttributes(attributes),
      sourceParcelIdentifier,
      detailFingerprintVersion: config.detailFingerprintVersion,
    }),
  });
}

export function createArcgisFeatureServiceAdapter(
  jurisdiction,
  options = {},
) {
  const countyKey = options.countyKey ?? "broward";
  const countyName = options.countyName ?? "Broward";
  const config = configSchema.parse(jurisdiction.adapterConfig);
  const httpClient =
    options.client ??
    new PermitHttpClient({
      minimumDelayMs: config.minimumDelayMs ?? 500,
      maxAttempts: options.maxAttempts ?? 4,
      timeoutMs: options.timeoutMs ?? 60_000,
    });

  async function executeQuery(parameters) {
    const { body: payload } = await httpClient.json(
      queryUrl(config.layerUrl, {
        f: "json",
        outFields: "*",
        returnGeometry: false,
        ...parameters,
      }),
    );
    if (payload.error) {
      throw new PermitSourceError(
        `ArcGIS query failed: ${payload.error.message ?? "unknown error"}`,
        {
          classification: "permanent",
          code: "arcgis_query_failed",
        },
      );
    }
    return payload;
  }

  async function enumerate({ where = "1=1", limit } = {}) {
    const maximum = Math.min(
      limit ?? config.maximumResultRecords,
      config.maximumResultRecords,
    );
    const features = [];
    let offset = 0;
    while (features.length < maximum) {
      const pageSize = Math.min(config.bulkPageSize, maximum - features.length);
      const payload = await executeQuery({
        where,
        resultOffset: offset,
        resultRecordCount: pageSize,
        orderByFields: `${config.objectIdField} ASC`,
      });
      const page = payload.features ?? [];
      features.push(...page);
      if (!payload.exceededTransferLimit && page.length < pageSize) break;
      if (page.length === 0) break;
      offset += page.length;
    }
    return {
      features,
      count: features.length,
      truncated: features.length >= maximum,
    };
  }

  return {
    key: "arcgis-feature-service",
    async probe() {
      const payload = await executeQuery({
        where: "1=1",
        returnCountOnly: true,
        outFields: "",
      });
      return {
        status: "ready",
        ok: Number.isInteger(payload.count),
        count: payload.count ?? null,
        parcelSearch: Boolean(config.parcelField),
      };
    },

    async searchParcel(parcelIdentifier, request = {}) {
      if (!config.parcelField) {
        throw new PermitSourceError(
          "This ArcGIS layer is bulk-only because it exposes no parcel field",
          {
            classification: "blocked",
            code: "arcgis_parcel_field_unavailable",
          },
        );
      }
      const result = await enumerate({
        where: `${config.parcelField} = ${sqlLiteral(parcelIdentifier)}`,
      });
      const references = result.features.map((feature) => ({
          feature,
          requestedParcelIdentifier: parcelIdentifier,
          requestedPropertyId: request.requestedPropertyId ?? null,
        }));
      return Object.assign(references, {
        reconciliation: {
          returned: result.count,
          truncated: result.truncated,
        },
      });
    },

    async fetchPermitDetail(reference) {
      return normalizeArcgisPermitFeature(reference.feature, {
        countyKey,
        countyName,
        jurisdiction,
        config,
        requestedParcelIdentifier: reference.requestedParcelIdentifier,
        requestedPropertyId: reference.requestedPropertyId,
      });
    },

    async enumerate(options) {
      const result = await enumerate(options);
      return {
        ...result,
        records: result.features.map((feature) =>
          normalizeArcgisPermitFeature(feature, {
            countyKey,
            countyName,
            jurisdiction,
            config,
            requestedParcelIdentifier:
              stringValue(
                feature.attributes?.[field(config, "parcelIdentifier")],
              )?.replace(/[-\s]/g, "") ?? "unlinked",
            requestedPropertyId: null,
          }),
        ),
      };
    },
  };
}
