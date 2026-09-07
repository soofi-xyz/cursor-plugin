import { describe, expect, it } from "vitest";

import {
  HANDOFF_SCHEMA_VERSION,
  requestDigest,
  type BatchRequest,
} from "../src/batch/contracts.js";
import {
  requiredStageNames,
  validateRequiredHandoffs,
} from "../src/batch/reconciliation.js";
import { syntheticRequest } from "./batch-fixtures.js";

const request = syntheticRequest({
  countyKey: "second-synthetic-county",
  categoryCount: 4,
});
const digest = requestDigest(request);

function handoff(batchRequest: BatchRequest, stage: string) {
  return {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    runId: batchRequest.runId,
    county: batchRequest.county,
    pipelineKey: batchRequest.pipelineKey,
    requestSha256: digest,
    enrichmentProfileSha256: batchRequest.enrichmentProfileSha256,
    stage,
    status: "complete",
    createdAt: "2026-09-05T12:00:00.000Z",
    artifacts: [
      {
        logicalPath: "manifest.json",
        key: `runs/${batchRequest.runId}/artifacts/${stage}/${"f".repeat(64)}/manifest.json`,
        bytes: 10,
        sha256: "f".repeat(64),
      },
    ],
    summary: {},
  };
}

describe("county-enrichment batch handoff reconciliation", () => {
  it("requires Sunbiz and the dynamic request categories exactly once", () => {
    const stages = requiredStageNames(request);
    expect(stages).toEqual([
      "sunbiz",
      ...request.bbb.categories.map(
        (category) => `bbb-${category.key}`,
      ),
    ]);
    expect(stages).toHaveLength(5);
    expect(
      validateRequiredHandoffs(
        stages.map((stage) => handoff(request, stage)),
        request,
        digest,
      ).map((value) => value.stage),
    ).toEqual(stages);
  });

  it("rejects missing and county-mismatched handoffs", () => {
    const stages = requiredStageNames(request);
    expect(() =>
      validateRequiredHandoffs(
        stages.slice(1).map((stage) => handoff(request, stage)),
        request,
        digest,
      ),
    ).toThrow(/missing=sunbiz/);

    const values = stages.map((stage) => handoff(request, stage));
    values[0] = { ...values[0], county: "different-county" };
    expect(() =>
      validateRequiredHandoffs(values, request, digest),
    ).toThrow(/provenance mismatch/);
  });
});
