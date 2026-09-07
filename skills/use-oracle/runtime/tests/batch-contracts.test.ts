import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  enrichmentProfileDigest,
  parseBatchRequest,
  parseRegisteredBatchRequest,
  requestDigest,
  requestKey,
  validateBatchRequestAgainstProfile,
} from "../src/batch/contracts.js";
import {
  syntheticProfile,
  syntheticRequest,
} from "./batch-fixtures.js";

const examplePath = path.join(
  process.cwd(),
  "config",
  "batch",
  "request.example.json",
);

async function exampleRequest(): Promise<unknown> {
  return JSON.parse(await readFile(examplePath, "utf8"));
}

describe("county-enrichment immutable batch request", () => {
  it("validates the reusable example and derives a content-addressed key", async () => {
    const request = parseBatchRequest(await exampleRequest());
    const digest = requestDigest(request);

    expect(request.pipelineKey).toBe("sunbiz-bbb-reconcile");
    expect(request.bbb.categories).toHaveLength(2);
    expect(requestKey(request)).toBe(`requests/${digest}/request.json`);
  });

  it("rejects mutable source keys and duplicate category keys", async () => {
    const mutableSource = (await exampleRequest()) as Record<string, unknown>;
    (
      (mutableSource.sunbiz as Record<string, unknown>).archive as {
        key: string;
      }
    ).key = "inputs/sunbiz/latest/cordata.zip";
    expect(() => parseBatchRequest(mutableSource)).toThrow(
      /full SHA-256 path segment/,
    );

    const duplicateCategory = (await exampleRequest()) as Record<
      string,
      unknown
    >;
    const bbb = duplicateCategory.bbb as {
      categories: Record<string, unknown>[];
    };
    bbb.categories[1] = { ...bbb.categories[0] };
    expect(() => parseBatchRequest(duplicateCategory)).toThrow(
      /category keys must be unique/,
    );
  });

  it("binds ZIP prefixes and exact category URLs to the selected profile", () => {
    const request = syntheticRequest();
    const profile = syntheticProfile();
    expect(validateBatchRequestAgainstProfile(request, profile)).toBe(request);
    expect(request.enrichmentProfileSha256).toBe(
      enrichmentProfileDigest(profile),
    );

    const wrongZipRequest = structuredClone(request);
    wrongZipRequest.sunbiz.zipPrefixes = ["999"];
    expect(() =>
      validateBatchRequestAgainstProfile(wrongZipRequest, profile),
    ).toThrow(/ZIP prefixes/);

    const wrongUrlRequest = structuredClone(request);
    wrongUrlRequest.bbb.categories[0] = {
      key: "synthetic-trade-1",
      url: "https://www.bbb.org/us/tx/dallas/category/synthetic-trade-1",
      reviewedPath: "/us/tx/dallas/category/synthetic-trade-1",
    };
    expect(() =>
      validateBatchRequestAgainstProfile(wrongUrlRequest, profile),
    ).toThrow(/exact reviewed URLs and paths/);

    const changedFullProfile = structuredClone(profile);
    changedFullProfile.publication.bucket = "different-bucket";
    expect(() =>
      validateBatchRequestAgainstProfile(request, changedFullProfile),
    ).toThrow(/full registered profile/);

    const nonFloridaProfile = structuredClone(profile);
    nonFloridaProfile.stateCode = "TX";
    expect(() =>
      validateBatchRequestAgainstProfile(request, nonFloridaProfile),
    ).toThrow(/only supports Florida/);
  });

  it("requires an actually registered county before operator or worker use", async () => {
    await expect(
      parseRegisteredBatchRequest(syntheticRequest()),
    ).rejects.toThrow(/Unknown enrichment --county/);
  });
});
