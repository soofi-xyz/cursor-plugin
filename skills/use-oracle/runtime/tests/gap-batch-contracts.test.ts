import { describe, expect, it } from "vitest";

import {
  GAP_PHASES,
  GAP_PIPELINE_KEY,
  GAP_REQUEST_SCHEMA_VERSION,
  gapRequestDigest,
  parseGapBatchRequest,
} from "../src/batch/gap-contracts.js";

const digest = "a".repeat(64);
const object = (name: string) => ({
  key: `inputs/${name}/${digest}/${name}`,
  sha256: digest,
  bytes: 100,
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
      queryTable: object("query-table.parquet"),
      permitTable: object("permit-table.parquet"),
      sunbizHandoff: object("sunbiz-handoff.json"),
      ownerOccupiedNal: object("owner-occupied.jsonl"),
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
      sunbizLinkedPropertyCount: 42_184,
    },
    protectedCids: {
      queryTable: "QmR139dymemJaxD5u8Ftx9mc2fm7KxTDeN4JC3KshMnACZ",
      permitTable: "QmTKvaWBmwaVGQheEAWSw59EXZqifPxNxaXx5AMpsSqM62",
      coverage: "QmReJrVy627vgRemjDy9N3NTnuCxYVqTr1oraAXmJLmV3y",
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
