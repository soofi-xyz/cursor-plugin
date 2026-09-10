import { describe, expect, it } from "vitest";

import {
  SUBMISSION_RECEIPT_SCHEMA_VERSION,
  requestDigest,
  requestKey,
} from "../src/batch/contracts.js";
import {
  assertRecoverableSunbizStatus,
  recoveryReceiptKey,
  validateBlockedRecoveryInputs,
} from "../src/batch/recovery.js";
import {
  STAGE_SUBMISSION_RECEIPT_SCHEMA_VERSION,
  aggregateSubmissionReceiptKey,
  stageSubmissionContractDigest,
  stageSubmissionReceiptKey,
} from "../src/batch/submission-ledger.js";
import { syntheticRequest } from "./batch-fixtures.js";

function fixture() {
  const request = syntheticRequest({
    countyKey: "second-synthetic-county",
    categoryCount: 4,
  });
  const digest = requestDigest(request);
  const jobId = "11111111-2222-4333-8444-555555555555";
  const observedCategory = request.bbb.categories[0]!;
  const jobQueue =
    "arn:aws:batch:us-east-1:111111111111:job-queue/test-queue";
  const stageReceipt = (stage: string) => {
    const submissionContract = {
      runId: request.runId,
      county: request.county,
      pipelineKey: request.pipelineKey,
      requestKey: requestKey(request),
      requestSha256: digest,
      enrichmentProfileSha256: request.enrichmentProfileSha256,
      treeDigest: request.provenance.treeDigest,
      stage,
      jobName: `${request.county}-${stage}`,
      jobQueue,
      jobDefinition:
        `arn:aws:batch:us-east-1:111111111111:job-definition/${stage}:1`,
      runtimeImageProvenance:
        `arn:aws:batch:us-east-1:111111111111:job-definition/${stage}:1`,
      dependencyJobIds: [],
      environment: [],
      tags: { run_id: request.runId },
    };
    return {
      schemaVersion: STAGE_SUBMISSION_RECEIPT_SCHEMA_VERSION,
      receiptKey: stageSubmissionReceiptKey(request, stage),
      recordedAt: "2026-09-05T17:00:00.000Z",
      recordedByArn: null,
      disposition: "submitted",
      submissionContractSha256:
        stageSubmissionContractDigest(submissionContract),
      submissionContract,
      jobId,
    };
  };
  const stages = [
    "sunbiz",
    ...request.bbb.categories.map(
      (category) => `bbb-${category.key}`,
    ),
    "reconciliation",
  ];
  const receipt = {
    schemaVersion: SUBMISSION_RECEIPT_SCHEMA_VERSION,
    submittedAt: "2026-09-05T17:00:00.000Z",
    submittedByArn: null,
    stackName: "CountyEnrichmentBatchStack",
    runId: request.runId,
    county: request.county,
    pipelineKey: request.pipelineKey,
    requestKey: requestKey(request),
    requestSha256: digest,
    enrichmentProfileSha256: request.enrichmentProfileSha256,
    provenance: request.provenance,
    artifactBucket: "example-artifact-bucket",
    jobQueue,
    receiptKey: aggregateSubmissionReceiptKey(request),
    stageReceipts: Object.fromEntries(
      stages.map((stage) => [stage, stageReceipt(stage)]),
    ),
    jobs: {
      sunbiz: jobId,
      bbb: Object.fromEntries(
        request.bbb.categories.map((category) => [
          category.key,
          { jobId, categoryUrl: category.url },
        ]),
      ),
      reconciliation: jobId,
    },
  };
  const evidence = {
    schemaVersion: "elephant.bbb-source-access-evidence.v1",
    source: "bbb-public-browser",
    runId: request.runId,
    batchRequestSha256: digest,
    observedBatchJobId: jobId,
    observedAt: "2026-09-05T18:00:00.000Z",
    observedCategoryKey: observedCategory.key,
    observedUrl: `${observedCategory.url}?page=2`,
    httpStatus: 403,
    classification: "blocked",
    failureReason: "blocked",
    operatorDirective: "stop_no_further_bbb_requests",
  };
  return { request, receipt, evidence, observedCategory };
}

describe("county-enrichment blocked-source recovery validation", () => {
  it("binds strict evidence and every prior category receipt to one request", () => {
    const { request, receipt, evidence } = fixture();
    const validated = validateBlockedRecoveryInputs(
      request,
      receipt,
      evidence,
    );
    expect(Object.keys(validated.receipt.jobs.bbb)).toHaveLength(4);
    expect(validated.evidence.httpStatus).toBe(403);
    expect(recoveryReceiptKey(request, validated.evidenceDigest)).toBe(
      `runs/${request.runId}/recoveries/${validated.evidenceDigest}/receipt.json`,
    );
  });

  it("fails closed on evidence, receipt, job, or URL mismatch", () => {
    const { request, receipt, evidence, observedCategory } = fixture();
    expect(() =>
      validateBlockedRecoveryInputs(request, receipt, {
        ...evidence,
        batchRequestSha256: "c".repeat(64),
      }),
    ).toThrow(/evidence does not match/);
    expect(() =>
      validateBlockedRecoveryInputs(
        request,
        { ...receipt, county: "different-county" },
        evidence,
      ),
    ).toThrow(/receipt does not match/);
    expect(() =>
      validateBlockedRecoveryInputs(request, receipt, {
        ...evidence,
        observedBatchJobId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      }),
    ).toThrow(/job does not match/);
    expect(() =>
      validateBlockedRecoveryInputs(request, receipt, {
        ...evidence,
        observedUrl: observedCategory.url.replace("testville", "elsewhere"),
      }),
    ).toThrow(/exact reviewed request category URL/);

    const wrongUrlReceipt = structuredClone(receipt);
    wrongUrlReceipt.jobs.bbb[observedCategory.key]!.categoryUrl =
      observedCategory.url.replace("testville", "elsewhere");
    expect(() =>
      validateBlockedRecoveryInputs(request, wrongUrlReceipt, evidence),
    ).toThrow(/category URL does not match/);
  });

  it("permits an in-flight Sunbiz dependency but rejects failure", () => {
    expect(() => assertRecoverableSunbizStatus("RUNNING")).not.toThrow();
    expect(() => assertRecoverableSunbizStatus("SUCCEEDED")).not.toThrow();
    expect(() => assertRecoverableSunbizStatus("FAILED")).toThrow(
      /not recoverable/,
    );
    expect(() => assertRecoverableSunbizStatus(undefined)).toThrow(
      /UNKNOWN/,
    );
  });
});
