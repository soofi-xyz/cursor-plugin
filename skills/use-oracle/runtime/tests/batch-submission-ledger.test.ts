import { describe, expect, it } from "vitest";

import {
  ensureStageSubmission,
  stageSubmissionContractDigest,
  stageSubmissionReceiptKey,
  type ExistingBatchJob,
  type StageSubmissionContract,
  type StageSubmissionLedgerDependencies,
  type StageSubmissionReceipt,
} from "../src/batch/submission-ledger.js";
import { requestDigest, requestKey } from "../src/batch/contracts.js";
import { syntheticRequest } from "./batch-fixtures.js";

const submittedJobId = "11111111-2222-4333-8444-555555555555";
const adoptedJobId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function fixture() {
  const request = syntheticRequest({ categoryCount: 1 });
  const stage = "sunbiz";
  const contract: StageSubmissionContract = {
    runId: request.runId,
    county: request.county,
    pipelineKey: request.pipelineKey,
    requestKey: requestKey(request),
    requestSha256: requestDigest(request),
    enrichmentProfileSha256: request.enrichmentProfileSha256,
    treeDigest: request.provenance.treeDigest,
    stage,
    jobName: `${request.county}-${request.runId}-${stage}`,
    jobQueue:
      "arn:aws:batch:us-east-1:111111111111:job-queue/test-queue",
    jobDefinition:
      "arn:aws:batch:us-east-1:111111111111:job-definition/sunbiz:7",
    runtimeImageProvenance:
      "arn:aws:batch:us-east-1:111111111111:job-definition/sunbiz:7",
    dependencyJobIds: [],
    environment: [
      { name: "REQUEST_KEY", value: requestKey(request) },
      { name: "REQUEST_SHA256", value: requestDigest(request) },
    ],
    tags: { run_id: request.runId },
  };
  return {
    request,
    stage,
    contract,
    receiptKey: stageSubmissionReceiptKey(request, stage),
  };
}

function existingJob(
  contract: StageSubmissionContract,
  overrides: Partial<ExistingBatchJob> = {},
): ExistingBatchJob {
  return {
    jobId: adoptedJobId,
    jobName: contract.jobName,
    jobQueue: contract.jobQueue,
    jobDefinition: contract.jobDefinition,
    dependencyJobIds: contract.dependencyJobIds,
    environment: contract.environment,
    tags: contract.tags,
    ...overrides,
  };
}

function fakeDependencies(options: {
  stored?: Map<string, unknown>;
  jobs?: ExistingBatchJob[];
} = {}) {
  const stored = options.stored ?? new Map<string, unknown>();
  let findCalls = 0;
  let submitCalls = 0;
  const dependencies: StageSubmissionLedgerDependencies = {
    getReceipt: async (key) => stored.get(key) ?? null,
    putReceipt: async (key, receipt) => {
      if (stored.has(key)) throw new Error("immutable conflict");
      stored.set(key, receipt);
    },
    findJobs: async () => {
      findCalls += 1;
      return options.jobs ?? [];
    },
    submitJob: async () => {
      submitCalls += 1;
      return { jobId: submittedJobId };
    },
    now: () => "2026-09-06T01:00:00.000Z",
    actorArn: "arn:aws:iam::111111111111:user/operator",
  };
  return {
    dependencies,
    stored,
    calls: () => ({ findCalls, submitCalls }),
  };
}

describe("durable deterministic stage submissions", () => {
  it("submits once, persists immediately, and reuses the immutable receipt", async () => {
    const { contract, receiptKey } = fixture();
    const fake = fakeDependencies();
    const first = await ensureStageSubmission({
      receiptKey,
      contract,
      dependencies: fake.dependencies,
    });
    const second = await ensureStageSubmission({
      receiptKey,
      contract,
      dependencies: fake.dependencies,
    });

    expect(first).toMatchObject({
      disposition: "submitted",
      jobId: submittedJobId,
      submissionContractSha256:
        stageSubmissionContractDigest(contract),
    });
    expect(second).toEqual(first);
    expect(fake.calls()).toEqual({ findCalls: 1, submitCalls: 1 });
  });

  it("adopts exactly one fully matching queued job without submitting", async () => {
    const { contract, receiptKey } = fixture();
    const fake = fakeDependencies({ jobs: [existingJob(contract)] });
    const receipt = await ensureStageSubmission({
      receiptKey,
      contract,
      dependencies: fake.dependencies,
    });

    expect(receipt).toMatchObject({
      disposition: "adopted",
      jobId: adoptedJobId,
      submissionContract: {
        enrichmentProfileSha256: contract.enrichmentProfileSha256,
        treeDigest: contract.treeDigest,
        runtimeImageProvenance: contract.jobDefinition,
      },
    });
    expect(fake.calls()).toEqual({ findCalls: 1, submitCalls: 0 });
  });

  it("fails closed on duplicate names and adopted-job provenance mismatches", async () => {
    const { contract, receiptKey } = fixture();
    const duplicate = fakeDependencies({
      jobs: [
        existingJob(contract),
        existingJob(contract, {
          jobId: "99999999-8888-4777-8666-555555555555",
        }),
      ],
    });
    await expect(
      ensureStageSubmission({
        receiptKey,
        contract,
        dependencies: duplicate.dependencies,
      }),
    ).rejects.toThrow(/Multiple AWS Batch jobs/);

    const wrongDefinition = fakeDependencies({
      jobs: [
        existingJob(contract, {
          jobDefinition:
            "arn:aws:batch:us-east-1:111111111111:job-definition/sunbiz:8",
        }),
      ],
    });
    await expect(
      ensureStageSubmission({
        receiptKey,
        contract,
        dependencies: wrongDefinition.dependencies,
      }),
    ).rejects.toThrow(/does not match stage submission contract/);
  });

  it("rejects a relocated or provenance-mismatched stage receipt", async () => {
    const { contract, receiptKey } = fixture();
    const original = fakeDependencies();
    const receipt = await ensureStageSubmission({
      receiptKey,
      contract,
      dependencies: original.dependencies,
    });
    const changed = structuredClone(receipt) as StageSubmissionReceipt;
    changed.receiptKey = `${receiptKey}.moved`;
    const stored = new Map<string, unknown>([[receiptKey, changed]]);

    await expect(
      ensureStageSubmission({
        receiptKey,
        contract,
        dependencies: fakeDependencies({ stored }).dependencies,
      }),
    ).rejects.toThrow(/receipt provenance mismatch/);
  });

  it("keys recovery stages by the full evidence digest", () => {
    const { request } = fixture();
    const evidenceDigest = "f".repeat(64);
    expect(
      stageSubmissionReceiptKey(
        request,
        "bbb-synthetic-trade-1-blocked",
        evidenceDigest,
      ),
    ).toBe(
      `runs/${request.runId}/recoveries/${evidenceDigest}/stages/bbb-synthetic-trade-1-blocked.json`,
    );
  });
});
