import { z } from "zod";

import {
  PIPELINE_KEY,
  SUBMISSION_RECEIPT_SCHEMA_VERSION,
  canonicalJson,
  requestDigest,
  requestKey,
  sha256Text,
  type BatchRequest,
} from "./contracts.js";
import {
  aggregateSubmissionReceiptKey,
  stageSubmissionContractDigest,
  stageSubmissionReceiptKey,
  stageSubmissionReceiptSchema,
} from "./submission-ledger.js";

export const BLOCKED_SOURCE_EVIDENCE_SCHEMA_VERSION =
  "elephant.bbb-source-access-evidence.v1";
export const RECOVERY_RECEIPT_SCHEMA_VERSION =
  "elephant.county-enrichment-blocked-source-recovery.v1";

const CATEGORY_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const batchJobIdSchema = z.string().uuid();

export const blockedSourceEvidenceSchema = z
  .object({
    schemaVersion: z.literal(BLOCKED_SOURCE_EVIDENCE_SCHEMA_VERSION),
    source: z.literal("bbb-public-browser"),
    runId: z
      .string()
      .min(8)
      .max(100)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    batchRequestSha256: sha256Schema,
    observedBatchJobId: batchJobIdSchema,
    observedAt: z.string().datetime({ offset: true }),
    observedCategoryKey: z.string().regex(CATEGORY_KEY_PATTERN),
    observedUrl: z.string().url(),
    httpStatus: z.literal(403),
    classification: z.literal("blocked"),
    failureReason: z.literal("blocked"),
    operatorDirective: z.literal("stop_no_further_bbb_requests"),
  })
  .strict();

export type BlockedSourceEvidence = z.infer<
  typeof blockedSourceEvidenceSchema
>;

const bbbJobReceiptSchema = z
  .object({
    jobId: batchJobIdSchema,
    categoryUrl: z.string().url(),
  })
  .strict();

export const priorSubmissionReceiptSchema = z
  .object({
    schemaVersion: z.literal(SUBMISSION_RECEIPT_SCHEMA_VERSION),
    submittedAt: z.string().datetime(),
    submittedByArn: z.string().nullable(),
    stackName: z.string().min(1),
    runId: z.string().min(1),
    county: z.string().min(1),
    pipelineKey: z.literal(PIPELINE_KEY),
    requestKey: z.string().min(1),
    requestSha256: sha256Schema,
    enrichmentProfileSha256: sha256Schema,
    provenance: z
      .object({
        gitCommit: z.string().regex(/^[a-f0-9]{40}$/),
        treeDigest: sha256Schema,
      })
      .strict(),
    artifactBucket: z.string().min(1),
    jobQueue: z.string().min(1),
    receiptKey: z.string().min(1),
    stageReceipts: z.record(
      z.string().regex(CATEGORY_KEY_PATTERN),
      stageSubmissionReceiptSchema,
    ),
    jobs: z
      .object({
        sunbiz: batchJobIdSchema,
        bbb: z.record(
          z.string().regex(CATEGORY_KEY_PATTERN),
          bbbJobReceiptSchema,
        ),
        reconciliation: batchJobIdSchema,
      })
      .strict(),
  })
  .strict();

export type PriorSubmissionReceipt = z.infer<
  typeof priorSubmissionReceiptSchema
>;

function assertObservedCategoryUrl(
  observedUrlValue: string,
  reviewedUrlValue: string,
): void {
  const observedUrl = new URL(observedUrlValue);
  const reviewedUrl = new URL(reviewedUrlValue);
  const page = observedUrl.searchParams.get("page");
  const keys = [...observedUrl.searchParams.keys()];
  const validPage =
    page === null ||
    (/^[1-9]\d*$/.test(page) && Number.isSafeInteger(Number(page)));
  if (
    observedUrl.protocol !== reviewedUrl.protocol ||
    observedUrl.hostname !== reviewedUrl.hostname ||
    observedUrl.port !== reviewedUrl.port ||
    observedUrl.username !== "" ||
    observedUrl.password !== "" ||
    observedUrl.hash !== "" ||
    observedUrl.pathname !== reviewedUrl.pathname ||
    !keys.every((key) => key === "page") ||
    keys.length > 1 ||
    !validPage
  ) {
    throw new Error(
      "Blocked-source evidence URL does not match the exact reviewed request category URL",
    );
  }
}

export function validateBlockedRecoveryInputs(
  request: BatchRequest,
  receiptValue: unknown,
  evidenceValue: unknown,
): {
  receipt: PriorSubmissionReceipt;
  evidence: BlockedSourceEvidence;
  digest: string;
  key: string;
  evidenceDigest: string;
} {
  const receipt = priorSubmissionReceiptSchema.parse(receiptValue);
  const evidence = blockedSourceEvidenceSchema.parse(evidenceValue);
  const digest = requestDigest(request);
  const key = requestKey(request);
  if (
    receipt.runId !== request.runId ||
    receipt.county !== request.county ||
    receipt.pipelineKey !== request.pipelineKey ||
    receipt.requestSha256 !== digest ||
    receipt.requestKey !== key ||
    receipt.receiptKey !== aggregateSubmissionReceiptKey(request) ||
    receipt.enrichmentProfileSha256 !==
      request.enrichmentProfileSha256 ||
    canonicalJson(receipt.provenance) !==
      canonicalJson(request.provenance)
  ) {
    throw new Error(
      "Prior submission receipt does not match the recovery request",
    );
  }
  if (
    evidence.runId !== request.runId ||
    evidence.batchRequestSha256 !== digest
  ) {
    throw new Error(
      "Blocked-source evidence does not match the recovery request",
    );
  }

  const requestedCategoryKeys = request.bbb.categories.map(
    (category) => category.key,
  );
  const receiptCategoryKeys = Object.keys(receipt.jobs.bbb);
  const missingReceiptCategories = requestedCategoryKeys.filter(
    (categoryKey) => !receiptCategoryKeys.includes(categoryKey),
  );
  const unexpectedReceiptCategories = receiptCategoryKeys.filter(
    (categoryKey) => !requestedCategoryKeys.includes(categoryKey),
  );
  if (
    missingReceiptCategories.length > 0 ||
    unexpectedReceiptCategories.length > 0
  ) {
    throw new Error(
      `Prior submission BBB jobs do not match the recovery request; missing=${missingReceiptCategories.join(",") || "none"} unexpected=${unexpectedReceiptCategories.join(",") || "none"}`,
    );
  }

  for (const category of request.bbb.categories) {
    const submittedCategory = receipt.jobs.bbb[category.key];
    if (!submittedCategory || submittedCategory.categoryUrl !== category.url) {
      throw new Error(
        `Prior submission category URL does not match the recovery request for ${category.key}`,
      );
    }
  }

  const expectedStageJobIds = new Map<string, string>([
    ["sunbiz", receipt.jobs.sunbiz],
    ...request.bbb.categories.map(
      (category) =>
        [
          `bbb-${category.key}`,
          receipt.jobs.bbb[category.key]!.jobId,
        ] as const,
    ),
    ["reconciliation", receipt.jobs.reconciliation],
  ]);
  const actualStageNames = Object.keys(receipt.stageReceipts);
  const unexpectedStages = actualStageNames.filter(
    (stage) => !expectedStageJobIds.has(stage),
  );
  const missingStages = [...expectedStageJobIds.keys()].filter(
    (stage) => receipt.stageReceipts[stage] === undefined,
  );
  if (unexpectedStages.length > 0 || missingStages.length > 0) {
    throw new Error(
      `Prior submission stage receipts do not match the recovery request; missing=${missingStages.join(",") || "none"} unexpected=${unexpectedStages.join(",") || "none"}`,
    );
  }
  for (const [stage, expectedJobId] of expectedStageJobIds) {
    const stageReceipt = receipt.stageReceipts[stage]!;
    const contract = stageReceipt.submissionContract;
    if (
      stageReceipt.jobId !== expectedJobId ||
      stageReceipt.receiptKey !==
        stageSubmissionReceiptKey(request, stage) ||
      stageReceipt.submissionContractSha256 !==
        stageSubmissionContractDigest(contract) ||
      contract.stage !== stage ||
      contract.runId !== request.runId ||
      contract.county !== request.county ||
      contract.pipelineKey !== request.pipelineKey ||
      contract.requestKey !== key ||
      contract.requestSha256 !== digest ||
      contract.enrichmentProfileSha256 !==
        request.enrichmentProfileSha256 ||
      contract.treeDigest !== request.provenance.treeDigest ||
      contract.jobQueue !== receipt.jobQueue
    ) {
      throw new Error(
        `Prior submission stage receipt provenance mismatch for ${stage}`,
      );
    }
  }

  const observedCategory = request.bbb.categories.find(
    (category) => category.key === evidence.observedCategoryKey,
  );
  const observedSubmission = receipt.jobs.bbb[evidence.observedCategoryKey];
  if (!observedCategory || !observedSubmission) {
    throw new Error(
      "Blocked-source evidence category does not match the recovery request",
    );
  }
  assertObservedCategoryUrl(evidence.observedUrl, observedCategory.url);
  if (observedSubmission.categoryUrl !== observedCategory.url) {
    throw new Error(
      "Blocked-source evidence category URL does not match the prior category submission",
    );
  }
  if (observedSubmission.jobId !== evidence.observedBatchJobId) {
    throw new Error(
      "Blocked-source evidence job does not match the prior category submission",
    );
  }
  return {
    receipt,
    evidence,
    digest,
    key,
    evidenceDigest: sha256Text(canonicalJson(evidence)),
  };
}

const recoverableSunbizStatuses = new Set([
  "SUBMITTED",
  "PENDING",
  "RUNNABLE",
  "STARTING",
  "RUNNING",
  "SUCCEEDED",
]);

export function assertRecoverableSunbizStatus(status: string | undefined): void {
  if (!status || !recoverableSunbizStatuses.has(status)) {
    throw new Error(
      `Sunbiz job is not recoverable from status ${status ?? "UNKNOWN"}`,
    );
  }
}

export function recoveryReceiptKey(
  request: BatchRequest,
  evidenceDigest: string,
): string {
  return `runs/${request.runId}/recoveries/${evidenceDigest}/receipt.json`;
}
