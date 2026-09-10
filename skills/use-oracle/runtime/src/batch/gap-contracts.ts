import { createHash } from "node:crypto";

import { z } from "zod";

import { immutableObjectSchema } from "./contracts.js";

export const GAP_REQUEST_SCHEMA_VERSION =
  "elephant.duval-mcp-gap-batch-request.v1";
export const GAP_PIPELINE_KEY = "duval-mcp-gap-close";
export const GAP_DEFAULT_COST_CEILING_USD = 15;
export const CURRENT_QUERY_TABLE_CID =
  "QmTfaoKg7yUfHKLcsor1yc7cTZnBcW3CdkjG8je7JQwfSS";
export const CURRENT_PERMIT_TABLE_CID =
  "QmTKvaWBmwaVGQheEAWSw59EXZqifPxNxaXx5AMpsSqM62";
export const CURRENT_COVERAGE_CID =
  "QmcVZjQuAivZoyWMpMdgRfcATQb3tujMNk5FVHvGVNVWDy";
export const GAP_PHASES = [
  "consolidation",
  "sunbiz-attach",
  "owner-occupied",
  "approved-source-overlays",
  "cid-fill",
  "places",
  "validate",
  "publish",
] as const;

const optionalImmutableObjectSchema = immutableObjectSchema.nullable();

export const gapBatchRequestSchema = z
  .object({
    schemaVersion: z.literal(GAP_REQUEST_SCHEMA_VERSION),
    runId: z.string().regex(/^[a-z0-9][a-z0-9-]{7,99}$/),
    county: z.literal("duval"),
    countyFips: z.literal("12031"),
    pipelineKey: z.literal(GAP_PIPELINE_KEY),
    frozenAt: z.string().datetime({ offset: true }),
    phases: z.tuple([
      z.literal("consolidation"),
      z.literal("sunbiz-attach"),
      z.literal("owner-occupied"),
      z.literal("approved-source-overlays"),
      z.literal("cid-fill"),
      z.literal("places"),
      z.literal("validate"),
      z.literal("publish"),
    ]),
    inputs: z
      .object({
        queryTable: immutableObjectSchema,
        permitTable: immutableObjectSchema,
        sunbizHandoff: immutableObjectSchema,
        ownerOccupiedNal: immutableObjectSchema,
        hoaMembership: optionalImmutableObjectSchema,
        avmFeed: optionalImmutableObjectSchema,
        publishApproval: optionalImmutableObjectSchema,
      })
      .strict(),
    overture: z
      .object({
        release: z.string().regex(/^\d{4}-\d{2}-\d{2}\.\d+$/),
        boundarySource: z.literal("tiger/tl_2024_us_county"),
        expectedCount: z.null(),
        includeEmails: z.literal(false),
        includePhones: z.literal(false),
      })
      .strict(),
    expected: z
      .object({
        propertyCount: z.literal(403_885),
        permitCount: z.literal(3_415_527),
        linkedPermitCount: z.literal(3_353_717),
        permitPropertyCount: z.literal(336_451),
        ownerOccupiedSourceCount: z.literal(404_023),
        sunbizSourceCount: z.literal(691_288),
        sunbizLinkCount: z.literal(73_127),
        sunbizLinkedPropertyCount: z.literal(42_184),
        bbbPropertyCount: z.literal(171_134),
        ownerOccupiedTrueCount: z.literal(212_959),
        ownerOccupiedFalseCount: z.literal(0),
        ownerOccupiedNullCount: z.literal(190_926),
      })
      .strict(),
    publication: z
      .object({
        filebaseConcurrency: z.number().int().min(1).max(16).default(8),
        checkpointEvery: z.number().int().min(100).max(10_000).default(10_000),
      })
      .strict(),
    costCeilingUsd: z
      .number()
      .positive()
      .finite()
      .max(100)
      .default(GAP_DEFAULT_COST_CEILING_USD),
    protectedCids: z
      .object({
        queryTable: z.literal(CURRENT_QUERY_TABLE_CID),
        permitTable: z.literal(CURRENT_PERMIT_TABLE_CID),
        coverage: z.literal(CURRENT_COVERAGE_CID),
      })
      .strict(),
    provenance: z
      .object({
        gitCommit: z.string().regex(/^[a-f0-9]{40}$/),
        treeDigest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
  })
  .strict()
  .superRefine((request, context) => {
    const frozenInputs = {
      queryTable: {
        bytes: 167_302_003,
        sha256:
          "3f43ef083328d193ba55bee7ec4279f6a6ba371d8b6279ac6af01864419aa56a",
      },
      permitTable: {
        bytes: 1_108_488_548,
        sha256:
          "6cd60ee4ea6337f3fa55a7a515b516eacef7b7761a3be06078da4b2c81267c5e",
      },
      sunbizHandoff: {
        bytes: 1_703_864,
        sha256:
          "35d5f36ddb7f9cd6754a22d90513af2e33eb8a3016f332d7475bf1dbdc3e4c89",
      },
      ownerOccupiedNal: {
        bytes: 21_825_424,
        sha256:
          "4504bf852552ad24db03ed565d88b6feb39eef750240a14a1c1324bad53df493",
      },
    } as const;
    for (const [name, expected] of Object.entries(frozenInputs)) {
      const observed =
        request.inputs[name as keyof typeof frozenInputs];
      if (
        observed.bytes !== expected.bytes ||
        observed.sha256 !== expected.sha256
      ) {
        context.addIssue({
          code: "custom",
          path: ["inputs", name],
          message:
            `${name} must be the frozen corrected-BBB input ` +
            `${expected.sha256}/${expected.bytes}`,
        });
      }
    }
    if (
      request.inputs.hoaMembership !== null &&
      request.inputs.hoaMembership.key.includes("candidate")
    ) {
      context.addIssue({
        code: "custom",
        path: ["inputs", "hoaMembership"],
        message: "Candidate HOA matches cannot populate hoa_flag",
      });
    }
  });

export type GapBatchRequest = z.infer<typeof gapBatchRequestSchema>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        )
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

export function gapRequestDigest(request: GapBatchRequest): string {
  return createHash("sha256")
    .update(`${JSON.stringify(canonicalize(request))}\n`)
    .digest("hex");
}

export function parseGapBatchRequest(value: unknown): GapBatchRequest {
  if (
    value !== null &&
    typeof value === "object" &&
    ("bbb" in value ||
      (Array.isArray((value as { phases?: unknown }).phases) &&
        (value as { phases: unknown[] }).phases.some((phase) =>
          String(phase).toLowerCase().includes("bbb"),
        )))
  ) {
    throw new Error("Duval MCP gap requests reject every BBB stage and input");
  }
  return gapBatchRequestSchema.parse(value);
}
