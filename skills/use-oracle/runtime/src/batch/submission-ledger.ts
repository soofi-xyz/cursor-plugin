import { createHash } from "node:crypto";

import { z } from "zod";

import {
  PIPELINE_KEY,
  canonicalJson,
  requestDigest,
  type BatchRequest,
} from "./contracts.js";

export const STAGE_SUBMISSION_RECEIPT_SCHEMA_VERSION =
  "elephant.county-enrichment-stage-submission.v1";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const batchJobIdSchema = z.string().uuid();
const stageSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const environmentEntrySchema = z
  .object({
    name: z.string().min(1),
    value: z.string(),
  })
  .strict();

export const stageSubmissionContractSchema = z
  .object({
    runId: z.string().min(1),
    county: z.string().min(1),
    pipelineKey: z.literal(PIPELINE_KEY),
    requestKey: z.string().min(1),
    requestSha256: sha256Schema,
    enrichmentProfileSha256: sha256Schema,
    treeDigest: sha256Schema,
    stage: stageSchema,
    jobName: z.string().min(1).max(128),
    jobQueue: z.string().min(1),
    jobDefinition: z.string().min(1),
    runtimeImageProvenance: z.string().min(1),
    dependencyJobIds: z.array(batchJobIdSchema),
    environment: z.array(environmentEntrySchema),
    tags: z.record(z.string(), z.string()),
  })
  .strict()
  .superRefine((contract, context) => {
    if (new Set(contract.dependencyJobIds).size !== contract.dependencyJobIds.length) {
      context.addIssue({
        code: "custom",
        path: ["dependencyJobIds"],
        message: "Stage dependency job IDs must be unique",
      });
    }
    const environmentNames = contract.environment.map(({ name }) => name);
    if (new Set(environmentNames).size !== environmentNames.length) {
      context.addIssue({
        code: "custom",
        path: ["environment"],
        message: "Stage environment names must be unique",
      });
    }
  });

export type StageSubmissionContract = z.infer<
  typeof stageSubmissionContractSchema
>;

export const stageSubmissionReceiptSchema = z
  .object({
    schemaVersion: z.literal(STAGE_SUBMISSION_RECEIPT_SCHEMA_VERSION),
    receiptKey: z.string().min(1),
    recordedAt: z.string().datetime(),
    recordedByArn: z.string().nullable(),
    disposition: z.enum(["submitted", "adopted"]),
    submissionContractSha256: sha256Schema,
    submissionContract: stageSubmissionContractSchema,
    jobId: batchJobIdSchema,
  })
  .strict();

export type StageSubmissionReceipt = z.infer<
  typeof stageSubmissionReceiptSchema
>;

export interface ExistingBatchJob {
  jobId: string;
  jobName: string;
  jobQueue: string;
  jobDefinition: string;
  dependencyJobIds: string[];
  environment: { name: string; value: string }[];
  tags: Record<string, string>;
}

export interface StageSubmissionLedgerDependencies {
  getReceipt(key: string): Promise<unknown | null>;
  putReceipt(key: string, receipt: StageSubmissionReceipt): Promise<void>;
  findJobs(jobQueue: string, exactJobName: string): Promise<ExistingBatchJob[]>;
  submitJob(contract: StageSubmissionContract): Promise<{ jobId: string }>;
  now(): string;
  actorArn: string | null;
}

export function deterministicJobName(
  request: BatchRequest,
  stage: string,
): string {
  const fullName = [
    request.county,
    request.pipelineKey,
    request.runId,
    stage,
  ].join("-");
  if (fullName.length <= 128) return fullName;
  const suffix = createHash("sha256").update(fullName).digest("hex").slice(0, 12);
  return `${fullName.slice(0, 115)}-${suffix}`;
}

export function stageSubmissionReceiptKey(
  request: BatchRequest,
  stage: string,
  evidenceDigest?: string,
): string {
  stageSchema.parse(stage);
  if (evidenceDigest !== undefined) {
    sha256Schema.parse(evidenceDigest);
    return `runs/${request.runId}/recoveries/${evidenceDigest}/stages/${stage}.json`;
  }
  return `runs/${request.runId}/submissions/${requestDigest(request)}/stages/${stage}.json`;
}

export function aggregateSubmissionReceiptKey(
  request: BatchRequest,
): string {
  return `runs/${request.runId}/submissions/${requestDigest(request)}/receipt.json`;
}

export function stageSubmissionContractDigest(
  contract: StageSubmissionContract,
): string {
  const parsed = stageSubmissionContractSchema.parse(contract);
  return createHash("sha256").update(canonicalJson(parsed)).digest("hex");
}

function normalizedJob(value: ExistingBatchJob): ExistingBatchJob {
  return {
    ...value,
    dependencyJobIds: [...value.dependencyJobIds],
    environment: [...value.environment],
    tags: { ...value.tags },
  };
}

function assertJobMatchesContract(
  jobValue: ExistingBatchJob,
  contract: StageSubmissionContract,
): void {
  const job = normalizedJob(jobValue);
  const actualEnvironment = new Map(
    job.environment.map(({ name, value }) => [name, value]),
  );
  const requiredEnvironmentMatches = contract.environment.every(
    ({ name, value }) => actualEnvironment.get(name) === value,
  );
  const requiredTagsMatch = Object.entries(contract.tags).every(
    ([name, value]) => job.tags[name] === value,
  );
  if (
    job.jobName !== contract.jobName ||
    job.jobQueue !== contract.jobQueue ||
    job.jobDefinition !== contract.jobDefinition ||
    canonicalJson(job.dependencyJobIds) !==
      canonicalJson(contract.dependencyJobIds) ||
    !requiredEnvironmentMatches ||
    !requiredTagsMatch
  ) {
    throw new Error(
      `Existing AWS Batch job does not match stage submission contract for ${contract.stage}`,
    );
  }
}

function validateExistingReceipt(
  value: unknown,
  receiptKey: string,
  contract: StageSubmissionContract,
): StageSubmissionReceipt {
  const receipt = stageSubmissionReceiptSchema.parse(value);
  const digest = stageSubmissionContractDigest(contract);
  if (
    receipt.receiptKey !== receiptKey ||
    receipt.submissionContractSha256 !== digest ||
    canonicalJson(receipt.submissionContract) !== canonicalJson(contract)
  ) {
    throw new Error(
      `Stage submission receipt provenance mismatch for ${contract.stage}`,
    );
  }
  return receipt;
}

export async function ensureStageSubmission(options: {
  receiptKey: string;
  contract: StageSubmissionContract;
  dependencies: StageSubmissionLedgerDependencies;
}): Promise<StageSubmissionReceipt> {
  const contract = stageSubmissionContractSchema.parse(options.contract);
  const existingReceipt = await options.dependencies.getReceipt(
    options.receiptKey,
  );
  if (existingReceipt !== null) {
    return validateExistingReceipt(
      existingReceipt,
      options.receiptKey,
      contract,
    );
  }

  const matches = (
    await options.dependencies.findJobs(contract.jobQueue, contract.jobName)
  ).filter((job) => job.jobName === contract.jobName);
  if (matches.length > 1) {
    throw new Error(
      `Multiple AWS Batch jobs match deterministic stage name ${contract.jobName}`,
    );
  }

  let jobId: string;
  let disposition: StageSubmissionReceipt["disposition"];
  if (matches.length === 1) {
    const match = matches[0]!;
    assertJobMatchesContract(match, contract);
    jobId = batchJobIdSchema.parse(match.jobId);
    disposition = "adopted";
  } else {
    const submitted = await options.dependencies.submitJob(contract);
    jobId = batchJobIdSchema.parse(submitted.jobId);
    disposition = "submitted";
  }

  const receipt = stageSubmissionReceiptSchema.parse({
    schemaVersion: STAGE_SUBMISSION_RECEIPT_SCHEMA_VERSION,
    receiptKey: options.receiptKey,
    recordedAt: options.dependencies.now(),
    recordedByArn: options.dependencies.actorArn,
    disposition,
    submissionContractSha256: stageSubmissionContractDigest(contract),
    submissionContract: contract,
    jobId,
  });
  await options.dependencies.putReceipt(options.receiptKey, receipt);
  return receipt;
}
