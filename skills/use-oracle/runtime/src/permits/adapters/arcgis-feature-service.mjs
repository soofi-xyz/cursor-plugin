import { z } from "zod";

import {
  createStablePermitId,
  normalizedPermitRecordSchema,
} from "../contracts.mjs";
import { sha256Json } from "../backfill-inputs.mjs";
import { normalizeSourcePayload } from "../normalization.mjs";
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
  bulkConcurrency: z.number().int().min(1).max(4).default(2),
  maximumResultRecords: z.number().int().min(1).max(10000).default(2000),
  minimumDelayMs: z.number().int().min(250).default(500),
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

function combineWhere(...clauses) {
  const values = clauses.filter((value) => value && value !== "1=1");
  return values.length === 0
    ? "1=1"
    : values.map((value) => `(${value})`).join(" AND ");
}

function dateWhere(config, fromDate, throughDate) {
  if (!fromDate && !throughDate) return null;
  const dateField =
    config.fieldMap.issuedAt ?? config.fieldMap.appliedAt ?? null;
  if (!dateField) {
    throw new PermitSourceError(
      "ArcGIS delta enumeration requires a configured source date field",
      {
        classification: "permanent",
        code: "arcgis_date_field_unavailable",
      },
    );
  }
  const nextDay = new Date(`${throughDate}T00:00:00.000Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  return `${dateField} >= DATE ${sqlLiteral(fromDate)} AND ${dateField} < DATE ${sqlLiteral(nextDay.toISOString().slice(0, 10))}`;
}

async function mapConcurrent(values, concurrency, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, Math.max(values.length, 1)) },
      () => worker(),
    ),
  );
  return results;
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

  async function sourceCount(where) {
    const payload = await executeQuery({
      where,
      returnCountOnly: true,
      outFields: "",
    });
    if (!Number.isInteger(payload.count) || payload.count < 0) {
      throw new PermitSourceError("ArcGIS source did not return a valid count", {
        classification: "permanent",
        code: "arcgis_count_unavailable",
      });
    }
    return payload.count;
  }

  async function sourceSnapshot(where) {
    const [count, idsPayload] = await Promise.all([
      sourceCount(where),
      executeQuery({
        where,
        returnIdsOnly: true,
        outFields: "",
      }),
    ]);
    const objectIds = [...(idsPayload.objectIds ?? [])].sort((left, right) =>
      String(left).localeCompare(String(right), undefined, {
        numeric: true,
      }),
    );
    if (
      objectIds.length !== count ||
      new Set(objectIds.map(String)).size !== count
    ) {
      throw new PermitSourceError(
        `ArcGIS source identity reconciliation failed: count=${count}, ids=${objectIds.length}`,
        {
          classification: "permanent",
          code: "arcgis_source_reconciliation_failed",
        },
      );
    }
    return {
      count,
      objectIds,
      objectIdsSha256: sha256Json(objectIds.map(String)),
      where,
    };
  }

  async function enumerateBounded({ where = "1=1", limit } = {}) {
    const maximum = Math.min(
      limit ?? config.maximumResultRecords,
      config.maximumResultRecords,
    );
    const reportedCount = await sourceCount(where);
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
      reportedCount,
      truncated: features.length < reportedCount,
    };
  }

  async function enumerateAll({
    where = "1=1",
    fromDate = null,
    throughDate = null,
    pageConcurrency = config.bulkConcurrency,
    loadPageCheckpoint = async () => null,
    onPage = async () => {},
  } = {}) {
    if (
      !Number.isInteger(pageConcurrency) ||
      pageConcurrency < 1 ||
      pageConcurrency > config.bulkConcurrency
    ) {
      throw new Error(
        `ArcGIS page concurrency must be between 1 and ${config.bulkConcurrency}`,
      );
    }
    const boundedWhere = combineWhere(
      where,
      dateWhere(config, fromDate, throughDate),
    );
    const startingSnapshot = await sourceSnapshot(boundedWhere);
    const pages = [];
    for (
      let offset = 0;
      offset < startingSnapshot.objectIds.length;
      offset += config.bulkPageSize
    ) {
      pages.push(
        startingSnapshot.objectIds.slice(
          offset,
          offset + config.bulkPageSize,
        ),
      );
    }
    let received = 0;
    let resumedPages = 0;
    await mapConcurrent(pages, pageConcurrency, async (objectIds, index) => {
      const pageKey = `page-${String(index + 1).padStart(6, "0")}`;
      const pageIdentity = {
        pageKey,
        pageIndex: index,
        objectIds: objectIds.map(String),
        objectIdsSha256: sha256Json(objectIds.map(String)),
        snapshotSha256: startingSnapshot.objectIdsSha256,
      };
      const checkpoint = await loadPageCheckpoint(pageIdentity);
      if (
        checkpoint?.status === "complete" &&
        checkpoint.snapshotSha256 === pageIdentity.snapshotSha256 &&
        checkpoint.objectIdsSha256 === pageIdentity.objectIdsSha256 &&
        checkpoint.receivedCount === objectIds.length
      ) {
        received += objectIds.length;
        resumedPages += 1;
        return;
      }
      const payload = await executeQuery({
        objectIds: objectIds.join(","),
        where: boundedWhere,
        orderByFields: `${config.objectIdField} ASC`,
      });
      const features = payload.features ?? [];
      const receivedIds = features.map((feature) =>
        String(feature.attributes?.[config.objectIdField] ?? ""),
      );
      const expectedIds = new Set(objectIds.map(String));
      if (
        payload.exceededTransferLimit ||
        features.length !== objectIds.length ||
        new Set(receivedIds).size !== receivedIds.length ||
        receivedIds.some((objectId) => !expectedIds.has(objectId))
      ) {
        throw new PermitSourceError(
          `ArcGIS page ${pageKey} reconciliation failed`,
          {
            classification: "permanent",
            code: "arcgis_page_reconciliation_failed",
          },
        );
      }
      const records = features.map((feature) =>
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
      );
      await onPage({
        ...pageIdentity,
        status: "complete",
        receivedCount: features.length,
        records,
      });
      received += features.length;
    });
    const endingSnapshot = await sourceSnapshot(boundedWhere);
    if (
      endingSnapshot.count !== startingSnapshot.count ||
      endingSnapshot.objectIdsSha256 !==
        startingSnapshot.objectIdsSha256 ||
      received !== startingSnapshot.count
    ) {
      throw new PermitSourceError(
        "ArcGIS source drifted during enumeration; completion is refused",
        {
          classification: "transient",
          code: "arcgis_source_drift",
        },
      );
    }
    return {
      status: "complete",
      sourceCount: startingSnapshot.count,
      receivedCount: received,
      pageCount: pages.length,
      resumedPageCount: resumedPages,
      snapshotSha256: startingSnapshot.objectIdsSha256,
      where: boundedWhere,
    };
  }

  return {
    key: "arcgis-feature-service",
    async probe() {
      const count = await sourceCount("1=1");
      return {
        status: "ready",
        ok: true,
        count,
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
      const result = await enumerateBounded({
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
          reported: result.reportedCount,
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
      const result = await enumerateBounded(options);
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
    enumerateAll,
  };
}
