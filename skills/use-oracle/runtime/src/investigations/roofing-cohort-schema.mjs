import { z } from "zod";

export const ROOFING_COHORT_INPUT_VERSION =
  "elephant.roofing-cohort-input.v5";
export const ROOFING_COHORT_REPORT_VERSION =
  "elephant.roofing-cohort-report.v3";
export const ROOFING_GAP_VERSION = "elephant.investigation-gap.v1";
export const ROOFING_EXPORT_GAP_VERSION =
  "elephant.roofing-cohort-export-gap.v1";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FOLIO = /^[A-Z0-9]{12}$/;

const nullableText = z.string().trim().min(1).nullable();
const nullableDate = z.string().regex(ISO_DATE).nullable();
const nullableCount = z.number().int().nonnegative().nullable();

const evidenceSchema = z
  .object({
    uri: z.string().trim().min(1),
    sha256: z.string().regex(SHA256),
    observedAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();

export const cohortManifestRecordSchema = z
  .object({
    recordType: z.literal("manifest"),
    schemaVersion: z.literal(ROOFING_COHORT_INPUT_VERSION),
    countyKey: z.literal("broward"),
    generatedAt: z.string().datetime({ offset: true }),
    asOfDate: z.string().regex(ISO_DATE),
    seedFolios: z.array(z.string().trim().toUpperCase().regex(FOLIO)).min(1),
    expansionLicenseNumbers: z.array(z.string().trim().toUpperCase().min(1)),
    expansionCompanyNames: z.array(z.string().trim().min(1)),
    sourceCatalogSha256: z.string().regex(SHA256),
    sourceProfileSha256: z.string().regex(SHA256),
    repositoryCommit: z.string().regex(/^[a-f0-9]{40}$/),
    privacy: z.literal("private"),
  })
  .strict();

export const cohortPropertyRecordSchema = z
  .object({
    recordType: z.literal("property"),
    propertyId: nullableText,
    parcelIdentifier: z.string().trim().toUpperCase().regex(FOLIO),
    authority: z.string().regex(KEY).nullable(),
    address: nullableText,
    city: nullableText,
    usageType: nullableText,
    builtYear: z.number().int().min(1700).max(2200).nullable(),
    sourceSystem: z.string().trim().min(1),
    sourceRecordKey: z.string().trim().min(1),
    coverage: z
      .object({
        fromDate: nullableDate,
        throughDate: nullableDate,
        authorityComplete: z.boolean(),
        predecessorComplete: z.boolean(),
        sourceSystems: z.array(z.string().trim().min(1)),
      })
      .strict(),
  })
  .strict();

const permitDatesSchema = z
  .object({
    application: nullableText,
    opened: nullableText,
    issued: nullableText,
    finalInspection: nullableText,
    completion: nullableText,
    closed: nullableText,
    expiration: nullableText,
  })
  .strict();

const contractorAssignmentEvidenceSchema = z
  .object({
    detailCaptured: z.boolean(),
    contactCollectionComplete: z.boolean(),
    sourcePayloadChecked: z.boolean(),
    sourceFieldsWithheld: z.boolean(),
    sourceFieldsUnavailable: z.boolean(),
    observedContractorFields: z.array(z.string().trim().min(1)),
    assignedContractorFields: z.array(z.string().trim().min(1)),
    ownerBuilderFields: z.array(z.string().trim().min(1)),
    directContractorCompanyIdPresent: z.boolean(),
  })
  .strict();

export const cohortPermitRecordSchema = z
  .object({
    recordType: z.literal("permit"),
    propertyImprovementId: z.string().trim().min(1),
    propertyId: nullableText,
    parcelIdentifier: nullableText,
    countyKey: z.literal("broward"),
    authority: z.string().regex(KEY),
    jurisdictionKey: z.string().regex(KEY),
    sourceKey: z.string().regex(KEY),
    sourceSystem: z.string().trim().min(1),
    sourceRecordKey: z.string().trim().min(1),
    permitNumber: nullableText,
    status: nullableText,
    sourceStatus: nullableText,
    recordStatus: nullableText,
    permitType: nullableText,
    workClass: nullableText,
    scope: nullableText,
    description: nullableText,
    trade: nullableText,
    action: nullableText,
    workAddress: nullableText,
    city: nullableText,
    masterPermitNumber: nullableText,
    parentPermitNumber: nullableText,
    dates: permitDatesSchema,
    detailComplete: z.boolean(),
    contractorAssignmentEvidence: contractorAssignmentEvidenceSchema,
    sourceArtifactUri: nullableText,
    evidenceSha256: z.string().regex(SHA256).nullable(),
  })
  .strict();

export const cohortContactRecordSchema = z
  .object({
    recordType: z.literal("permit_contact"),
    propertyImprovementId: z.string().trim().min(1),
    sourceSystem: z.string().trim().min(1),
    sourceRecordKey: z.string().trim().min(1),
    role: z.string().trim().min(1),
    name: nullableText,
    companyId: nullableText,
    companyName: nullableText,
    licenseNumber: nullableText,
    licenseType: nullableText,
    qualifierName: nullableText,
    evidenceSha256: z.string().regex(SHA256).nullable(),
  })
  .strict();

export const cohortEventRecordSchema = z
  .object({
    recordType: z.literal("permit_event"),
    propertyImprovementId: z.string().trim().min(1),
    sourceSystem: z.string().trim().min(1),
    sourceRecordKey: z.string().trim().min(1),
    eventType: z.string().trim().min(1),
    eventStatus: nullableText,
    eventDate: nullableText,
    evidenceSha256: z.string().regex(SHA256).nullable(),
  })
  .strict();

export const cohortInspectionRecordSchema = z
  .object({
    recordType: z.literal("inspection"),
    propertyImprovementId: z.string().trim().min(1),
    sourceSystem: z.string().trim().min(1),
    sourceRecordKey: z.string().trim().min(1),
    inspectionType: nullableText,
    status: nullableText,
    result: nullableText,
    completedDate: nullableText,
    evidenceSha256: z.string().regex(SHA256).nullable(),
  })
  .strict();

export const cohortIdentityRecordSchema = z
  .object({
    recordType: z.literal("license_identity"),
    identityId: z.string().regex(KEY),
    licenseNumber: z.string().trim().toUpperCase().min(1),
    licenseClass: z.enum(["CCC", "RC", "CAC", "CGC", "OTHER"]),
    holderName: nullableText,
    qualifyingBusinessName: nullableText,
    permitContactName: nullableText,
    companyId: nullableText,
    sunbizDocumentNumber: nullableText,
    relationshipType: z.enum([
      "license-holder",
      "primary-qualifying-agent",
      "secondary-qualifying-agent",
      "permit-contact",
      "sunbiz-company",
    ]),
    effectiveFrom: nullableDate,
    effectiveThrough: nullableDate,
    primaryStatus: nullableText,
    secondaryStatus: nullableText,
    current: z.boolean(),
    verified: z.boolean(),
    evidence: z.array(evidenceSchema).min(1),
  })
  .strict();

export const cohortSourceReconciliationRecordSchema = z
  .object({
    recordType: z.literal("source_reconciliation"),
    authority: z.string().regex(KEY),
    sourceKey: z.string().regex(KEY),
    sourceSystem: z.string().trim().min(1),
    access: z.enum([
      "supported",
      "blocked",
      "custodian-only",
      "unavailable",
      "manual-only",
    ]),
    predecessorComplete: z.boolean(),
    reported: nullableCount,
    received: nullableCount,
    missing: nullableCount,
    evidence: z.array(evidenceSchema),
    blockerCategory: nullableText,
    blockerOwner: nullableText,
    blockerFix: nullableText,
  })
  .strict();

export const cohortMatcherStateRecordSchema = z
  .object({
    recordType: z.literal("matcher_state"),
    scope: z.string().trim().min(1),
    permits: z.number().int().nonnegative(),
    contacts: z.number().int().nonnegative(),
    permitCompanyLinked: z.number().int().nonnegative(),
    contactCompanyLinked: z.number().int().nonnegative(),
    contactCompanyUnlinked: z.number().int().nonnegative(),
    confirmedRun: z.boolean(),
    evidence: z.array(evidenceSchema),
  })
  .strict();

export const cohortExportGapRecordSchema = z
  .object({
    recordType: z.literal("export_gap"),
    schemaVersion: z.literal(ROOFING_EXPORT_GAP_VERSION),
    gapType: z.literal("parcel_identifier_quarantine"),
    excludedPermitCount: z.number().int().nonnegative(),
    excludedPropertyCount: z.number().int().nonnegative(),
    excludedChildRecordCount: z.number().int().nonnegative(),
    losslesslyNormalizedPermitCount: z.number().int().nonnegative(),
    losslesslyNormalizedPropertyCount: z.number().int().nonnegative(),
    verifiedSeedFolios: z.array(z.string().regex(FOLIO)).min(1),
    evidence: z.array(
      z
        .object({
          entityType: z.enum(["permit", "property"]),
          sourceSystem: z.string().trim().min(1),
          sourceRecordKeySha256: z.string().regex(SHA256),
          rawParcelSha256: z.string().regex(SHA256),
          reasonCode: z.enum([
            "unsupported_broward_parcel_format",
            "missing_broward_parcel_identifier",
          ]),
        })
        .strict(),
    ),
  })
  .strict();

export const cohortInputRecordSchema = z.discriminatedUnion("recordType", [
  cohortManifestRecordSchema,
  cohortPropertyRecordSchema,
  cohortPermitRecordSchema,
  cohortContactRecordSchema,
  cohortEventRecordSchema,
  cohortInspectionRecordSchema,
  cohortIdentityRecordSchema,
  cohortSourceReconciliationRecordSchema,
  cohortMatcherStateRecordSchema,
  cohortExportGapRecordSchema,
]);

export const investigationGapSchema = z
  .object({
    schemaVersion: z.literal(ROOFING_GAP_VERSION),
    gapId: z.string().regex(KEY),
    fact: z.string().trim().min(1),
    scope: z.record(z.string(), z.unknown()),
    beforeState: z.record(z.string(), z.unknown()),
    blocker: z.record(z.string(), z.unknown()).nullable(),
    evidence: z.array(evidenceSchema),
    proposedIngest: z.record(z.string(), z.unknown()).nullable(),
    afterState: z.record(z.string(), z.unknown()).nullable(),
    status: z.enum(["open", "blocked", "resolved", "partial"]),
    reviewer: nullableText,
  })
  .strict();

export function parseCohortInputRecords(rows) {
  const parsed = rows.map((row) => cohortInputRecordSchema.parse(row));
  const manifests = parsed.filter((row) => row.recordType === "manifest");
  if (manifests.length !== 1 || parsed[0]?.recordType !== "manifest") {
    throw new Error(
      "Cohort input must contain exactly one manifest as the first record",
    );
  }
  return {
    manifest: manifests[0],
    records: parsed.filter((row) => row.recordType !== "manifest"),
  };
}
