import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { z } from "zod";

export const REQUEST_SCHEMA_VERSION =
  "elephant.county-enrichment-batch-request.v1";
export const HANDOFF_SCHEMA_VERSION =
  "elephant.county-enrichment-batch-handoff.v1";
export const SUBMISSION_RECEIPT_SCHEMA_VERSION =
  "elephant.county-enrichment-batch-submission.v1";
export const DEFAULT_COST_CEILING_USD = 5;
export const PIPELINE_KEY = "sunbiz-bbb-reconcile";

const COUNTY_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CATEGORY_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ZIP_PREFIX_PATTERN = /^\d{3,5}$/;
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const objectKeySchema = z
  .string()
  .min(1)
  .max(900)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.split("/").some((segment) => segment === ".."),
    "S3 keys must be relative and cannot contain parent traversal",
  );

export const immutableObjectSchema = z
  .object({
    key: objectKeySchema,
    sha256: sha256Schema,
    bytes: z.number().int().positive(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.key.split("/").includes(value.sha256)) {
      context.addIssue({
        code: "custom",
        message: "Immutable object key must contain its full SHA-256 path segment",
        path: ["key"],
      });
    }
  });

export const bbbCategorySchema = z
  .object({
    key: z.string().regex(CATEGORY_KEY_PATTERN),
    url: z.string().url(),
    reviewedPath: z.string().startsWith("/"),
  })
  .strict()
  .superRefine((category, context) => {
    const url = new URL(category.url);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "www.bbb.org" ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.pathname !== category.reviewedPath ||
      !url.pathname.includes("/category/")
    ) {
      context.addIssue({
        code: "custom",
        path: ["url"],
        message:
          "BBB category URL must be an exact reviewed www.bbb.org HTTPS category path without query or fragment",
      });
    }
  });

const sunbizBoundsSchema = z
  .object({
    maxArchiveBytes: z
      .number()
      .int()
      .min(1)
      .max(3 * 1024 ** 3)
      .default(3 * 1024 ** 3),
    maxExpandedBytes: z
      .number()
      .int()
      .min(1)
      .max(25 * 1024 ** 3)
      .default(25 * 1024 ** 3),
    maxSourceRecords: z.number().int().positive().nullable().default(null),
    chunkRecordLimit: z.number().int().min(1).max(50_000).default(5_000),
    partRecordLimit: z.number().int().min(1).max(50_000).default(5_000),
    maxDurationMinutes: z.number().int().min(1).max(240).default(240),
  })
  .strict();

const bbbBoundsSchema = z
  .object({
    maxPages: z.number().int().min(1).max(15),
    maxProfiles: z.number().int().min(1).max(5_000),
    maxRequests: z.number().int().min(1).max(20_000),
    maxDurationMinutes: z.number().int().min(1).max(360),
    partRecordLimit: z.number().int().min(1).max(500).default(25),
    pageDelayMs: z.number().int().min(1_000).max(60_000).default(2_000),
    profileDelayMs: z.number().int().min(1_000).max(60_000).default(1_500),
    navigationTimeoutMs: z
      .number()
      .int()
      .min(5_000)
      .max(180_000)
      .default(90_000),
    challengeAttempts: z.number().int().min(1).max(5).default(3),
    challengeCheckIntervalMs: z
      .number()
      .int()
      .min(1_000)
      .max(30_000)
      .default(3_000),
    challengeChecksPerAttempt: z.number().int().min(1).max(12).default(6),
    includeHtml: z.boolean().default(true),
    profileSubpages: z
      .array(z.enum(["customer-reviews", "complaints", "more-info"]))
      .max(3)
      .default([]),
  })
  .strict();

export const batchRequestSchema = z
  .object({
    schemaVersion: z.literal(REQUEST_SCHEMA_VERSION),
    runId: z
      .string()
      .min(8)
      .max(100)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    county: z.string().regex(COUNTY_KEY_PATTERN),
    pipelineKey: z.literal(PIPELINE_KEY),
    quarter: z.string().regex(/^\d{4}Q[1-4]$/),
    enrichmentProfileSha256: sha256Schema,
    inputs: z
      .object({
        queryTable: immutableObjectSchema,
        coverage: immutableObjectSchema,
      })
      .strict(),
    sunbiz: z
      .object({
        archive: immutableObjectSchema,
        zipPrefixes: z
          .array(z.string().regex(ZIP_PREFIX_PATTERN))
          .min(1),
        bounds: sunbizBoundsSchema,
      })
      .strict(),
    bbb: z
      .object({
        categories: z.array(bbbCategorySchema).min(1),
        bounds: bbbBoundsSchema,
      })
      .strict(),
    execution: z
      .object({
        bbbDependencyPolicy: z.enum(["serial", "parallel"]),
        recoveryBbbDependencyPolicy: z.enum(["serial", "parallel"]),
      })
      .strict(),
    costCeilingUsd: z
      .number()
      .positive()
      .finite()
      .max(1_000)
      .default(DEFAULT_COST_CEILING_USD),
    provenance: z
      .object({
        gitCommit: z.string().regex(/^[a-f0-9]{40}$/),
        treeDigest: sha256Schema,
      })
      .strict(),
  })
  .strict()
  .superRefine((request, context) => {
    if (new Set(request.sunbiz.zipPrefixes).size !== request.sunbiz.zipPrefixes.length) {
      context.addIssue({
        code: "custom",
        path: ["sunbiz", "zipPrefixes"],
        message: "Sunbiz ZIP prefixes must be unique",
      });
    }
    const categoryKeys = request.bbb.categories.map((category) => category.key);
    if (new Set(categoryKeys).size !== categoryKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["bbb", "categories"],
        message: "BBB category keys must be unique",
      });
    }
    const categoryUrls = request.bbb.categories.map((category) => category.url);
    if (new Set(categoryUrls).size !== categoryUrls.length) {
      context.addIssue({
        code: "custom",
        path: ["bbb", "categories"],
        message: "BBB category URLs must be unique",
      });
    }
  });

export type BatchRequest = z.infer<typeof batchRequestSchema>;
export type ImmutableObject = z.infer<typeof immutableObjectSchema>;
export type BbbCategory = z.infer<typeof bbbCategorySchema>;
export type BbbDependencyPolicy =
  BatchRequest["execution"]["bbbDependencyPolicy"];

export interface RegisteredEnrichmentProfile {
  countyKey: string;
  countyName: string;
  stateCode: string;
  sunbiz: { zipPrefixes: readonly string[] };
  bbb: { categories: readonly BbbCategory[] };
  queryTable: { schemaFields: Readonly<Record<string, unknown>> };
  publication: Readonly<Record<string, string>>;
}

export function enrichmentProfileDigest(
  profile: RegisteredEnrichmentProfile,
): string {
  return sha256Text(canonicalJson(profile));
}

export function validateBatchRequestAgainstProfile(
  request: BatchRequest,
  profile: RegisteredEnrichmentProfile,
): BatchRequest {
  if (request.county !== profile.countyKey) {
    throw new Error(
      `Batch request county ${request.county} does not match enrichment profile ${profile.countyKey}`,
    );
  }
  if (profile.stateCode !== "FL") {
    throw new Error(
      `Pipeline ${request.pipelineKey} only supports Florida enrichment profiles; received ${profile.stateCode}`,
    );
  }
  const profileDigest = enrichmentProfileDigest(profile);
  if (request.enrichmentProfileSha256 !== profileDigest) {
    throw new Error(
      `Batch request enrichment profile digest does not match the full registered profile for ${request.county}`,
    );
  }
  if (
    JSON.stringify(request.sunbiz.zipPrefixes) !==
    JSON.stringify(profile.sunbiz.zipPrefixes)
  ) {
    throw new Error(
      `Batch request ZIP prefixes do not match the reviewed enrichment profile for ${request.county}`,
    );
  }
  if (
    canonicalJson(request.bbb.categories) !==
    canonicalJson(profile.bbb.categories)
  ) {
    throw new Error(
      `Batch request BBB categories do not match the exact reviewed URLs and paths for ${request.county}`,
    );
  }
  return request;
}

interface EnrichmentProfilesModule {
  requireEnrichmentProfile(countyKey: string): RegisteredEnrichmentProfile;
}

async function requireRegisteredProfile(
  countyKey: string,
): Promise<RegisteredEnrichmentProfile> {
  const runtimeRoot = path.resolve(
    process.env.ORACLE_RUNTIME_ROOT ??
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../.."),
  );
  const moduleUrl = pathToFileURL(
    path.join(runtimeRoot, "src/counties/enrichment-profiles.mjs"),
  ).href;
  const profiles = (await import(moduleUrl)) as EnrichmentProfilesModule;
  return profiles.requireEnrichmentProfile(countyKey);
}

export async function parseRegisteredBatchRequest(
  value: unknown,
): Promise<BatchRequest> {
  const request = batchRequestSchema.parse(value);
  return validateBatchRequestAgainstProfile(
    request,
    await requireRegisteredProfile(request.county),
  );
}

export const artifactReceiptSchema = z
  .object({
    logicalPath: z.string().min(1),
    key: objectKeySchema,
    bytes: z.number().int().nonnegative(),
    sha256: sha256Schema,
  })
  .strict();

export const handoffSchema = z
  .object({
    schemaVersion: z.literal(HANDOFF_SCHEMA_VERSION),
    runId: z.string().min(1),
    county: z.string().regex(COUNTY_KEY_PATTERN),
    pipelineKey: z.literal(PIPELINE_KEY),
    requestSha256: sha256Schema,
    enrichmentProfileSha256: sha256Schema,
    stage: z.string().min(1),
    status: z.literal("complete"),
    createdAt: z.string().datetime(),
    artifacts: z.array(artifactReceiptSchema),
    summary: z.record(z.string(), z.unknown()),
  })
  .strict();

export type ArtifactReceipt = z.infer<typeof artifactReceiptSchema>;
export type BatchHandoff = z.infer<typeof handoffSchema>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value))}\n`;
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function parseBatchRequest(value: unknown): BatchRequest {
  return batchRequestSchema.parse(value);
}

export function requestDigest(request: BatchRequest): string {
  return sha256Text(canonicalJson(request));
}

export function requestKey(request: BatchRequest): string {
  const digest = requestDigest(request);
  return `requests/${digest}/request.json`;
}

export function handoffKey(
  request: BatchRequest,
  stage: string,
): string {
  return `runs/${request.runId}/handoffs/${stage}.json`;
}
