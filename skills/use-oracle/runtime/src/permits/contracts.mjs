import { createHash } from "node:crypto";

import { z } from "zod";

export const PERMIT_RECORD_SCHEMA_VERSION =
  "elephant.normalized-permit-record.v1";
export const PERMIT_RUN_SCHEMA_VERSION = "elephant.permit-harvest-run.v1";
export const PERMIT_ARTIFACT_MANIFEST_SCHEMA_VERSION =
  "elephant.permit-artifact-manifest.v1";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const STABLE_ID_PATTERN = /^[a-f0-9]{32}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const COUNTY_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const nullableText = z.string().trim().min(1).nullable();
const nullableDate = z.string().regex(ISO_DATE_PATTERN).nullable();
const nullableMoney = z.number().finite().nonnegative().nullable();

export const permitTableSchemaFields = Object.freeze({
  property_improvement_id: { type: "UTF8" },
  property_id: { type: "UTF8", optional: true },
  parcel_identifier: { type: "UTF8", optional: true },
  permit_number: { type: "UTF8", optional: true },
  improvement_type: { type: "UTF8", optional: true },
  improvement_status: { type: "UTF8", optional: true },
  improvement_action: { type: "UTF8", optional: true },
  permit_issue_date: { type: "UTF8", optional: true },
  application_received_date: { type: "UTF8", optional: true },
  final_inspection_date: { type: "UTF8", optional: true },
  permit_close_date: { type: "UTF8", optional: true },
  completion_date: { type: "UTF8", optional: true },
  expiration_date: { type: "UTF8", optional: true },
  opened_date: { type: "UTF8", optional: true },
  source_system: { type: "UTF8", optional: true },
  county_name: { type: "UTF8", optional: true },
  project_description: { type: "UTF8", optional: true },
  description: { type: "UTF8", optional: true },
  estimated_job_value: { type: "DOUBLE", optional: true },
  fee: { type: "DOUBLE", optional: true },
});

export const permitTableRowSchema = z
  .object({
    property_improvement_id: z.string().regex(STABLE_ID_PATTERN),
    property_id: z.string().regex(STABLE_ID_PATTERN).nullable(),
    parcel_identifier: nullableText,
    permit_number: nullableText,
    improvement_type: nullableText,
    improvement_status: nullableText,
    improvement_action: nullableText,
    permit_issue_date: nullableDate,
    application_received_date: nullableDate,
    final_inspection_date: nullableDate,
    permit_close_date: nullableDate,
    completion_date: nullableDate,
    expiration_date: nullableDate,
    opened_date: nullableDate,
    source_system: nullableText,
    county_name: nullableText,
    project_description: nullableText,
    description: nullableText,
    estimated_job_value: nullableMoney,
    fee: nullableMoney,
  })
  .strict();

const contractorSchema = z
  .object({
    businessName: z.string().trim().min(1),
    licenseNumber: nullableText,
    qualifierName: nullableText,
    phone: nullableText,
    email: nullableText,
  })
  .strict();

const inspectionSchema = z
  .object({
    inspectionType: z.string().trim().min(1),
    inspectionDate: nullableDate,
    result: nullableText,
  })
  .strict();

export const normalizedPermitRecordSchema = permitTableRowSchema
  .extend({
    schemaVersion: z.literal(PERMIT_RECORD_SCHEMA_VERSION),
    countyKey: z.string().regex(COUNTY_KEY_PATTERN),
    jurisdictionKey: z.string().regex(KEY_PATTERN),
    sourceRecordId: z.string().trim().min(1),
    sourceUrl: z.string().url(),
    requestedParcelIdentifier: z.string().trim().min(1),
    requestedPropertyId: z.string().regex(STABLE_ID_PATTERN).nullable(),
    workAddress: nullableText,
    isRoofPermit: z.boolean(),
    contractors: z.array(contractorSchema),
    inspections: z.array(inspectionSchema),
    relatedRecords: z.array(z.string().trim().min(1)),
    sourcePayload: z.record(z.string(), z.unknown()),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.property_id !== record.requestedPropertyId) {
      context.addIssue({
        code: "custom",
        path: ["property_id"],
        message:
          "Permit property_id must be bound to the explicitly requested property",
      });
    }
    if (record.parcel_identifier !== record.requestedParcelIdentifier) {
      context.addIssue({
        code: "custom",
        path: ["parcel_identifier"],
        message:
          "Permit parcel_identifier must be bound to the explicitly requested parcel",
      });
    }
    if (new URL(record.sourceUrl).protocol !== "https:") {
      context.addIssue({
        code: "custom",
        path: ["sourceUrl"],
        message: "Permit source URL must use HTTPS",
      });
    }
  });

export const permitFailureSchema = z
  .object({
    parcelIdentifier: z.string().trim().min(1),
    propertyId: z.string().regex(STABLE_ID_PATTERN).nullable(),
    jurisdictionKey: z.string().regex(KEY_PATTERN),
    classification: z.enum([
      "permanent",
      "transient",
      "blocked",
      "unrouted",
    ]),
    errorCode: z.string().regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/),
    message: z.string().min(1),
    attempts: z.number().int().positive(),
    nextAttemptAt: z.string().datetime({ offset: true }).nullable(),
    observedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const parcelPermitStatusSchema = z
  .object({
    countyKey: z.string().regex(COUNTY_KEY_PATTERN),
    jobId: z.string().min(1),
    parcelIdentifier: z.string().min(1),
    propertyId: z.string().regex(STABLE_ID_PATTERN).nullable(),
    jurisdictionKey: z.string().regex(KEY_PATTERN),
    status: z.enum(["done", "failed", "blocked", "unrouted"]),
    permitCount: z.number().int().nonnegative(),
    failureCount: z.number().int().nonnegative(),
    attempts: z.number().int().positive(),
    completedAt: z.string().datetime({ offset: true }),
  })
  .strict();

const jurisdictionCoverageSchema = z
  .object({
    jurisdictionKey: z.string().regex(KEY_PATTERN),
    sourceStatus: z.enum([
      "supported",
      "blocked",
      "manual-only",
      "unavailable",
    ]),
    attemptedParcels: z.number().int().nonnegative(),
    succeededParcels: z.number().int().nonnegative(),
    failedParcels: z.number().int().nonnegative(),
    permitCount: z.number().int().nonnegative(),
    firstPermitDate: nullableDate,
    lastPermitDate: nullableDate,
    gapReason: nullableText,
  })
  .strict();

export const permitCoverageSchema = z
  .object({
    schemaVersion: z.literal("elephant.permit-coverage.v1"),
    countyKey: z.string().regex(COUNTY_KEY_PATTERN),
    exportedAt: z.string().datetime({ offset: true }),
    availability: z.enum(["unsupported", "supported_partial", "supported_full"]),
    attemptedParcels: z.number().int().nonnegative(),
    succeededParcels: z.number().int().nonnegative(),
    failedParcels: z.number().int().nonnegative(),
    validUnlinkedPermits: z.number().int().nonnegative(),
    linkedPermits: z.number().int().nonnegative(),
    jurisdictions: z.array(jurisdictionCoverageSchema).min(1),
  })
  .strict();

const artifactSchema = z
  .object({
    path: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(SHA256_PATTERN),
    rowCount: z.number().int().nonnegative().nullable(),
    privacy: z.enum(["public", "private"]),
  })
  .strict();

export const permitArtifactManifestSchema = z
  .object({
    schemaVersion: z.literal(PERMIT_ARTIFACT_MANIFEST_SCHEMA_VERSION),
    countyKey: z.string().regex(COUNTY_KEY_PATTERN),
    jobId: z.string().min(1),
    profileSha256: z.string().regex(SHA256_PATTERN),
    generatedAt: z.string().datetime({ offset: true }),
    artifacts: z.array(artifactSchema).min(1),
  })
  .strict();

export const permitRunManifestSchema = z
  .object({
    schemaVersion: z.literal(PERMIT_RUN_SCHEMA_VERSION),
    revision: z.number().int().positive(),
    runId: z.string().min(1),
    countyKey: z.string().regex(COUNTY_KEY_PATTERN),
    branch: z.string().min(1),
    commitSha: z.string().regex(/^[a-f0-9]{7,40}$/),
    profileSha256: z.string().regex(SHA256_PATTERN),
    state: z.enum([
      "DISCOVERING",
      "READINESS_BLOCKED",
      "READY",
      "RUNNING",
      "COOLING_DOWN",
      "WAITING_HUMAN",
      "PUBLISHING",
      "VERIFYING",
      "COMPLETE",
      "FAILED_EXHAUSTED",
    ]),
    sourceCatalogPath: z.string().min(1),
    sourceCatalogSha256: z.string().regex(SHA256_PATTERN),
    startedAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    nextAction: z.string().min(1),
  })
  .strict();

export function createStablePermitId({
  countyKey,
  jurisdictionKey,
  sourceRecordId,
}) {
  return createHash("sha256")
    .update(`${countyKey}\u0000${jurisdictionKey}\u0000${sourceRecordId}`)
    .digest("hex")
    .slice(0, 32);
}

export function toPermitTableRow(record) {
  const parsed = normalizedPermitRecordSchema.parse(record);
  return permitTableRowSchema.parse(
    Object.fromEntries(
      Object.keys(permitTableSchemaFields).map((key) => [key, parsed[key]]),
    ),
  );
}
