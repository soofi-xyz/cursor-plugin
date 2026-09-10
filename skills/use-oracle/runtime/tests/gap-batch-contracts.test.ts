import { describe, expect, it } from "vitest";

import {
  CURRENT_COVERAGE_CID,
  CURRENT_PERMIT_TABLE_CID,
  CURRENT_QUERY_TABLE_CID,
  GAP_PHASES,
  GAP_PIPELINE_KEY,
  GAP_REQUEST_SCHEMA_VERSION,
  gapRequestDigest,
  parseGapBatchRequest,
} from "../src/batch/gap-contracts.js";
import {
  assertGapCostAllowed,
  planGapBatchCost,
} from "../src/batch/gap-cost-plan.js";

const digest = "a".repeat(64);
const object = (name: string) => ({
  key: `inputs/${name}/${digest}/${name}`,
  sha256: digest,
  bytes: 100,
});

const frozenObject = (name: string, sha256: string, bytes: number) => ({
  key: `inputs/${name}/${sha256}/${name}`,
  sha256,
  bytes,
});

function request() {
  return {
    schemaVersion: GAP_REQUEST_SCHEMA_VERSION,
    runId: "duval-gap-20260908",
    county: "duval",
    countyFips: "12031",
    pipelineKey: GAP_PIPELINE_KEY,
    frozenAt: "2026-09-08T04:45:00Z",
    phases: [...GAP_PHASES],
    inputs: {
      queryTable: frozenObject(
        "query-table.parquet",
        "3f43ef083328d193ba55bee7ec4279f6a6ba371d8b6279ac6af01864419aa56a",
        167_302_003,
      ),
      permitTable: frozenObject(
        "permit-table.parquet",
        "6cd60ee4ea6337f3fa55a7a515b516eacef7b7761a3be06078da4b2c81267c5e",
        1_108_488_548,
      ),
      sunbizHandoff: frozenObject(
        "sunbiz-handoff.json",
        "35d5f36ddb7f9cd6754a22d90513af2e33eb8a3016f332d7475bf1dbdc3e4c89",
        1_703_864,
      ),
      ownerOccupiedNal: frozenObject(
        "owner-occupied-nal.jsonl",
        "4504bf852552ad24db03ed565d88b6feb39eef750240a14a1c1324bad53df493",
        21_825_424,
      ),
      hoaMembership: null,
      avmFeed: null,
      publishApproval: null,
    },
    overture: {
      release: "2026-08-19.0",
      boundarySource: "tiger/tl_2024_us_county",
      expectedCount: null,
      includeEmails: false,
      includePhones: false,
    },
    expected: {
      propertyCount: 403_885,
      permitCount: 3_415_527,
      linkedPermitCount: 3_353_717,
      permitPropertyCount: 336_451,
      ownerOccupiedSourceCount: 404_023,
      sunbizSourceCount: 691_288,
      sunbizLinkCount: 73_127,
      sunbizLinkedPropertyCount: 42_184,
      bbbPropertyCount: 171_134,
      ownerOccupiedTrueCount: 212_959,
      ownerOccupiedFalseCount: 0,
      ownerOccupiedNullCount: 190_926,
    },
    publication: {
      filebaseConcurrency: 8,
      checkpointEvery: 10_000,
    },
    costCeilingUsd: 15,
    protectedCids: {
      queryTable: CURRENT_QUERY_TABLE_CID,
      permitTable: CURRENT_PERMIT_TABLE_CID,
      coverage: CURRENT_COVERAGE_CID,
    },
    provenance: {
      gitCommit: "b".repeat(40),
      treeDigest: "c".repeat(64),
    },
  };
}

describe("Duval gap AWS request contract", () => {
  it("accepts only the frozen, contact-free, ordered gap contract", () => {
    const parsed = parseGapBatchRequest(request());
    expect(parsed.phases).toEqual(GAP_PHASES);
    expect(parsed.overture.includeEmails).toBe(false);
    expect(parsed.overture.includePhones).toBe(false);
    expect(gapRequestDigest(parsed)).toMatch(/^[a-f0-9]{64}$/);
    expect(planGapBatchCost(parsed).allowed).toBe(true);
    expect(() => assertGapCostAllowed(parsed, 15)).not.toThrow();
  });

  it("rejects stale pre-BBB query bytes and an undersized cost ceiling", () => {
    expect(() =>
      parseGapBatchRequest({
        ...request(),
        inputs: {
          ...request().inputs,
          queryTable: object("query-table.parquet"),
        },
      }),
    ).toThrow(/frozen corrected-BBB input/);
    const parsed = parseGapBatchRequest({
      ...request(),
      costCeilingUsd: 1,
    });
    expect(() => assertGapCostAllowed(parsed)).toThrow(/Predicted run cost/);
  });

  it("rejects BBB anywhere in the request", () => {
    expect(() =>
      parseGapBatchRequest({ ...request(), bbb: { enabled: true } }),
    ).toThrow(/reject every BBB/);
    expect(() =>
      parseGapBatchRequest({
        ...request(),
        phases: [...GAP_PHASES.slice(0, -1), "bbb-harvest"],
      }),
    ).toThrow(/reject every BBB/);
  });

  it("rejects candidate HOA artifacts and contact-bearing places", () => {
    expect(() =>
      parseGapBatchRequest({
        ...request(),
        inputs: {
          ...request().inputs,
          hoaMembership: object("candidate-hoa.jsonl"),
        },
      }),
    ).toThrow(/Candidate HOA/);
    expect(() =>
      parseGapBatchRequest({
        ...request(),
        overture: { ...request().overture, includePhones: true },
      }),
    ).toThrow();
  });
});
