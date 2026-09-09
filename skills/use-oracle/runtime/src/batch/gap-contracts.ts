import { createHash } from "node:crypto";

import { z } from "zod";

import { immutableObjectSchema } from "./contracts.js";

export const GAP_REQUEST_SCHEMA_VERSION =
  "elephant.duval-mcp-gap-batch-request.v1";
export const GAP_PIPELINE_KEY = "duval-mcp-gap-close";
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
        sunbizLinkedPropertyCount: z.literal(42_184),
      })
      .strict(),
    protectedCids: z
      .object({
        queryTable: z.literal(
          "QmR139dymemJaxD5u8Ftx9mc2fm7KxTDeN4JC3KshMnACZ",
        ),
        permitTable: z.literal(
          "QmTKvaWBmwaVGQheEAWSw59EXZqifPxNxaXx5AMpsSqM62",
        ),
        coverage: z.literal(
          "QmReJrVy627vgRemjDy9N3NTnuCxYVqTr1oraAXmJLmV3y",
        ),
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
    if (request.inputs.hoaMembership === null) return;
    if (request.inputs.hoaMembership.key.includes("candidate")) {
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
