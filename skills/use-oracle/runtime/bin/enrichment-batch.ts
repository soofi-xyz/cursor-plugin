#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  BatchClient,
  DescribeJobsCommand,
  ListJobsCommand,
  SubmitJobCommand,
} from "@aws-sdk/client-batch";
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import { S3Client } from "@aws-sdk/client-s3";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";

import {
  SUBMISSION_RECEIPT_SCHEMA_VERSION,
  canonicalJson,
  parseRegisteredBatchRequest,
  requestDigest,
  requestKey,
  type BatchRequest,
} from "../src/batch/contracts.js";
import { assertCostAllowed, planBatchCost } from "../src/batch/cost-plan.js";
import {
  RECOVERY_RECEIPT_SCHEMA_VERSION,
  assertRecoverableSunbizStatus,
  recoveryReceiptKey,
  validateBlockedRecoveryInputs,
} from "../src/batch/recovery.js";
import {
  getVerifiedJson,
  getVerifiedJsonIfExists,
  putImmutableJson,
} from "../src/batch/s3-integrity.js";
import {
  aggregateSubmissionReceiptKey,
  deterministicJobName,
  ensureStageSubmission,
  stageSubmissionReceiptKey,
  type ExistingBatchJob,
  type StageSubmissionContract,
  type StageSubmissionLedgerDependencies,
  type StageSubmissionReceipt,
} from "../src/batch/submission-ledger.js";
import {
  buildBlockedRecoveryTopology,
  buildSubmissionTopology,
  type BbbSubmissionStage,
} from "../src/batch/submission-topology.js";

const DEFAULT_STACK_NAME = "CountyEnrichmentBatchStack";
const BATCH_JOB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) break;
    if (!token.startsWith("--")) throw new Error(`Unexpected argument ${token}`);
    const name = token.slice(2);
    if (name === "resume") {
      flags[name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${name}`);
    }
    flags[name] = value;
    index += 1;
  }
  return flags;
}

function requiredFlag(
  flags: Record<string, string | boolean>,
  name: string,
): string {
  const value = flags[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

async function readRequest(configPath: string): Promise<BatchRequest> {
  return parseRegisteredBatchRequest(
    JSON.parse(await readFile(configPath, "utf8")),
  );
}

async function stackOutputs(
  stackName: string,
): Promise<Record<string, string>> {
  const response = await new CloudFormationClient({}).send(
    new DescribeStacksCommand({ StackName: stackName }),
  );
  const stack = response.Stacks?.[0];
  if (!stack) throw new Error(`CloudFormation stack not found: ${stackName}`);
  return Object.fromEntries(
    (stack.Outputs ?? []).flatMap((stackOutput) =>
      stackOutput.OutputKey && stackOutput.OutputValue
        ? [[stackOutput.OutputKey, stackOutput.OutputValue]]
        : [],
    ),
  );
}

function output(outputs: Record<string, string>, name: string): string {
  const value = outputs[name];
  if (!value) throw new Error(`Stack output ${name} is missing`);
  return value;
}

function deploymentCostCeiling(outputs: Record<string, string>): number {
  const ceiling = Number(output(outputs, "MaxCostCeilingUsd"));
  if (!Number.isFinite(ceiling) || ceiling <= 0) {
    throw new Error("Stack MaxCostCeilingUsd output is invalid");
  }
  return ceiling;
}

function environment(
  bucket: string,
  key: string,
  digest: string,
  extras: Record<string, string> = {},
) {
  return Object.entries({
    ARTIFACT_BUCKET: bucket,
    REQUEST_KEY: key,
    REQUEST_SHA256: digest,
    ...extras,
  }).map(([name, value]) => ({ name, value }));
}

function commonTags(
  request: BatchRequest,
  extras: Record<string, string> = {},
): Record<string, string> {
  return {
    project_name: "county-enrichment",
    county: request.county,
    pipeline_key: request.pipelineKey,
    run_id: request.runId,
    ...extras,
  };
}

function dependencyJobIds(
  stageNames: string[],
  submittedJobs: ReadonlyMap<string, string>,
): { jobId: string }[] | undefined {
  if (stageNames.length === 0) return undefined;
  return stageNames.map((stage) => {
    const jobId = submittedJobs.get(stage);
    if (!jobId) throw new Error(`Missing submitted dependency ${stage}`);
    return { jobId };
  });
}

function stageContract(options: {
  request: BatchRequest;
  stage: string;
  jobNameStage?: string;
  dependencyStages: string[];
  submittedJobs: ReadonlyMap<string, string>;
  queue: string;
  jobDefinition: string;
  bucket: string;
  key: string;
  digest: string;
  extras?: Record<string, string>;
  tags: Record<string, string>;
}): StageSubmissionContract {
  return {
    runId: options.request.runId,
    county: options.request.county,
    pipelineKey: options.request.pipelineKey,
    requestKey: options.key,
    requestSha256: options.digest,
    enrichmentProfileSha256:
      options.request.enrichmentProfileSha256,
    treeDigest: options.request.provenance.treeDigest,
    stage: options.stage,
    jobName: deterministicJobName(
      options.request,
      options.jobNameStage ?? options.stage,
    ),
    jobQueue: options.queue,
    jobDefinition: options.jobDefinition,
    runtimeImageProvenance: options.jobDefinition,
    dependencyJobIds:
      dependencyJobIds(
        options.dependencyStages,
        options.submittedJobs,
      )?.map(({ jobId }) => jobId) ?? [],
    environment: environment(
      options.bucket,
      options.key,
      options.digest,
      {
        ...(options.extras ?? {}),
        RUNTIME_IMAGE_PROVENANCE: options.jobDefinition,
      },
    ),
    tags: options.tags,
  };
}

async function findExistingJobs(
  batch: BatchClient,
  queue: string,
  exactJobName: string,
): Promise<ExistingBatchJob[]> {
  const jobIds: string[] = [];
  let nextToken: string | undefined;
  do {
    const response = await batch.send(
      new ListJobsCommand({
        jobQueue: queue,
        filters: [{ name: "JOB_NAME", values: [exactJobName] }],
        maxResults: 100,
        ...(nextToken === undefined ? {} : { nextToken }),
      }),
    );
    for (const summary of response.jobSummaryList ?? []) {
      if (summary.jobName !== exactJobName) continue;
      if (!summary.jobId) {
        throw new Error(
          `AWS Batch returned a matching job without an ID for ${exactJobName}`,
        );
      }
      jobIds.push(summary.jobId);
    }
    nextToken = response.nextToken;
  } while (nextToken !== undefined);
  if (jobIds.length === 0) return [];

  const jobs: ExistingBatchJob[] = [];
  for (let index = 0; index < jobIds.length; index += 100) {
    const response = await batch.send(
      new DescribeJobsCommand({ jobs: jobIds.slice(index, index + 100) }),
    );
    for (const job of response.jobs ?? []) {
      if (
        !job.jobId ||
        !job.jobName ||
        !job.jobQueue ||
        !job.jobDefinition
      ) {
        throw new Error(
          `AWS Batch returned incomplete provenance for ${exactJobName}`,
        );
      }
      jobs.push({
        jobId: job.jobId,
        jobName: job.jobName,
        jobQueue: job.jobQueue,
        jobDefinition: job.jobDefinition,
        dependencyJobIds: (job.dependsOn ?? []).flatMap((dependency) =>
          dependency.jobId ? [dependency.jobId] : [],
        ),
        environment: (job.container?.environment ?? []).flatMap((entry) =>
          entry.name !== undefined && entry.value !== undefined
            ? [{ name: entry.name, value: entry.value }]
            : [],
        ),
        tags: Object.fromEntries(
          Object.entries(job.tags ?? {}).flatMap(([name, value]) =>
            value === undefined ? [] : [[name, value]],
          ),
        ),
      });
    }
  }
  return jobs;
}

function ledgerDependencies(options: {
  batch: BatchClient;
  s3: S3Client;
  bucket: string;
  actorArn: string | null;
}): StageSubmissionLedgerDependencies {
  return {
    getReceipt: (key) =>
      getVerifiedJsonIfExists(options.s3, options.bucket, key),
    putReceipt: async (key, receipt) => {
      await putImmutableJson(options.s3, options.bucket, key, receipt);
    },
    findJobs: (queue, exactJobName) =>
      findExistingJobs(options.batch, queue, exactJobName),
    submitJob: async (contract) => {
      const response = await options.batch.send(
        new SubmitJobCommand({
          jobName: contract.jobName,
          jobQueue: contract.jobQueue,
          jobDefinition: contract.jobDefinition,
          dependsOn:
            contract.dependencyJobIds.length === 0
              ? undefined
              : contract.dependencyJobIds.map((jobId) => ({ jobId })),
          containerOverrides: {
            environment: contract.environment,
          },
          tags: contract.tags,
        }),
      );
      if (!response.jobId) {
        throw new Error(
          `AWS Batch did not return a job ID for ${contract.stage}`,
        );
      }
      return { jobId: response.jobId };
    },
    now: () => new Date().toISOString(),
    actorArn: options.actorArn,
  };
}

async function submitBbbStages(options: {
  request: BatchRequest;
  stages: BbbSubmissionStage[];
  submittedJobs: Map<string, string>;
  queue: string;
  jobDefinition: string;
  bucket: string;
  key: string;
  digest: string;
  resume: boolean;
  suffix?: string;
  evidenceJson?: string;
  tags: Record<string, string>;
  ledger: StageSubmissionLedgerDependencies;
  evidenceDigest?: string;
}): Promise<{
  jobs: Record<string, { jobId: string; categoryUrl: string }>;
  stageReceipts: Record<string, StageSubmissionReceipt>;
}> {
  const jobs: Record<string, { jobId: string; categoryUrl: string }> = {};
  const stageReceipts: Record<string, StageSubmissionReceipt> = {};
  for (const stage of options.stages) {
    const category = options.request.bbb.categories.find(
      (candidate) => candidate.key === stage.categoryKey,
    );
    if (!category) {
      throw new Error(`Missing request category ${stage.categoryKey}`);
    }
    const receipt = await ensureStageSubmission({
      receiptKey: stageSubmissionReceiptKey(
        options.request,
        stage.stage,
        options.evidenceDigest,
      ),
      contract: stageContract({
        request: options.request,
        stage: stage.stage,
        jobNameStage: options.suffix
          ? `${stage.stage}-${options.suffix}`
          : stage.stage,
        dependencyStages: stage.dependsOn,
        submittedJobs: options.submittedJobs,
        queue: options.queue,
        jobDefinition: options.jobDefinition,
        bucket: options.bucket,
        key: options.key,
        digest: options.digest,
        extras: {
          BBB_CATEGORY: category.key,
          RESUME_BBB: options.resume ? "true" : "false",
          ...(options.evidenceJson === undefined
            ? {}
            : { BBB_SOURCE_ACCESS_EVIDENCE: options.evidenceJson }),
        },
        tags: options.tags,
      }),
      dependencies: options.ledger,
    });
    options.submittedJobs.set(stage.stage, receipt.jobId);
    stageReceipts[stage.stage] = receipt;
    jobs[category.key] = {
      jobId: receipt.jobId,
      categoryUrl: category.url,
    };
  }
  return { jobs, stageReceipts };
}

async function persistAggregateReceipt<T>(
  s3: S3Client,
  bucket: string,
  key: string,
  receipt: T,
): Promise<T> {
  const existing = await getVerifiedJsonIfExists(s3, bucket, key);
  if (existing !== null) {
    if (canonicalJson(existing) !== canonicalJson(receipt)) {
      throw new Error(
        `Existing aggregate submission receipt does not match ${key}`,
      );
    }
    return existing as T;
  }
  await putImmutableJson(s3, bucket, key, receipt);
  return receipt;
}

async function submit(
  request: BatchRequest,
  flags: Record<string, string | boolean>,
): Promise<void> {
  const plan = assertCostAllowed(request);
  const digest = requestDigest(request);
  const key = requestKey(request);
  const stackName =
    typeof flags["stack-name"] === "string"
      ? flags["stack-name"]
      : DEFAULT_STACK_NAME;
  const outputs = await stackOutputs(stackName);
  assertCostAllowed(request, deploymentCostCeiling(outputs));
  const bucket = output(outputs, "ArtifactBucketName");
  const queue = output(outputs, "JobQueueArn");
  const s3 = new S3Client({});
  const batch = new BatchClient({});
  const identity = await new STSClient({}).send(
    new GetCallerIdentityCommand({}),
  );

  await putImmutableJson(s3, bucket, key, request);
  const tags = commonTags(request);
  const topology = buildSubmissionTopology(request);
  const submittedJobs = new Map<string, string>();
  const ledger = ledgerDependencies({
    batch,
    s3,
    bucket,
    actorArn: identity.Arn ?? null,
  });
  const sunbizJobDefinition = output(outputs, "SunbizJobDefinitionArn");
  const sunbiz = await ensureStageSubmission({
    receiptKey: stageSubmissionReceiptKey(
      request,
      topology.sunbiz.stage,
    ),
    contract: stageContract({
      request,
      stage: topology.sunbiz.stage,
      dependencyStages: topology.sunbiz.dependsOn,
      submittedJobs,
      queue,
      jobDefinition: sunbizJobDefinition,
      bucket,
      key,
      digest,
      tags,
    }),
    dependencies: ledger,
  });
  submittedJobs.set(topology.sunbiz.stage, sunbiz.jobId);

  const bbbSubmission = await submitBbbStages({
    request,
    stages: topology.bbb,
    submittedJobs,
    queue,
    jobDefinition: output(outputs, "BbbJobDefinitionArn"),
    bucket,
    key,
    digest,
    resume: flags.resume === true,
    tags,
    ledger,
  });

  const reconciliationJobDefinition = output(
    outputs,
    "ReconciliationJobDefinitionArn",
  );
  const reconciliation = await ensureStageSubmission({
    receiptKey: stageSubmissionReceiptKey(
      request,
      topology.reconciliation.stage,
    ),
    contract: stageContract({
      request,
      stage: topology.reconciliation.stage,
      dependencyStages: topology.reconciliation.dependsOn,
      submittedJobs,
      queue,
      jobDefinition: reconciliationJobDefinition,
      bucket,
      key,
      digest,
      tags,
    }),
    dependencies: ledger,
  });

  const receiptKey = aggregateSubmissionReceiptKey(request);
  const submissionReceipt = await persistAggregateReceipt(
    s3,
    bucket,
    receiptKey,
    {
      schemaVersion: SUBMISSION_RECEIPT_SCHEMA_VERSION,
      submittedAt: reconciliation.recordedAt,
      submittedByArn: reconciliation.recordedByArn,
      stackName,
      runId: request.runId,
      county: request.county,
      pipelineKey: request.pipelineKey,
      requestKey: key,
      requestSha256: digest,
      enrichmentProfileSha256: request.enrichmentProfileSha256,
      provenance: request.provenance,
      artifactBucket: bucket,
      jobQueue: queue,
      receiptKey,
      stageReceipts: {
        [topology.sunbiz.stage]: sunbiz,
        ...bbbSubmission.stageReceipts,
        [topology.reconciliation.stage]: reconciliation,
      },
      jobs: {
        sunbiz: sunbiz.jobId,
        bbb: bbbSubmission.jobs,
        reconciliation: reconciliation.jobId,
      },
    },
  );
  console.error(
    `Cost gate passed: estimated $${plan.estimatedUsd.toFixed(2)} of $${plan.ceilingUsd.toFixed(2)}`,
  );
  process.stdout.write(
    canonicalJson(submissionReceipt),
  );
}

function collectJobIds(value: unknown): string[] {
  if (typeof value === "string") {
    return BATCH_JOB_ID_PATTERN.test(value) ? [value] : [];
  }
  if (Array.isArray(value)) return value.flatMap(collectJobIds);
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(collectJobIds);
  }
  return [];
}

async function status(receiptPath: string): Promise<void> {
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
    jobs?: unknown;
  };
  const jobs = [...new Set(collectJobIds(receipt.jobs))];
  if (jobs.length === 0) throw new Error("Submission receipt contains no job IDs");
  const response = await new BatchClient({}).send(
    new DescribeJobsCommand({ jobs }),
  );
  process.stdout.write(
    canonicalJson({
      jobs: (response.jobs ?? []).map((job) => ({
        jobId: job.jobId,
        jobName: job.jobName,
        status: job.status,
        statusReason: job.statusReason,
        attempts: job.attempts?.length ?? 0,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        stoppedAt: job.stoppedAt,
      })),
    }),
  );
}

async function recoverBlockedSource(
  request: BatchRequest,
  flags: Record<string, string | boolean>,
): Promise<void> {
  const plan = assertCostAllowed(request);
  const priorReceiptValue = JSON.parse(
    await readFile(requiredFlag(flags, "receipt"), "utf8"),
  );
  const evidenceValue = JSON.parse(
    await readFile(requiredFlag(flags, "evidence"), "utf8"),
  );
  const {
    receipt: priorReceipt,
    evidence,
    digest,
    key,
    evidenceDigest,
  } = validateBlockedRecoveryInputs(
    request,
    priorReceiptValue,
    evidenceValue,
  );
  const stackName =
    typeof flags["stack-name"] === "string"
      ? flags["stack-name"]
      : priorReceipt.stackName;
  const outputs = await stackOutputs(stackName);
  assertCostAllowed(request, deploymentCostCeiling(outputs));
  const bucket = output(outputs, "ArtifactBucketName");
  if (bucket !== priorReceipt.artifactBucket) {
    throw new Error(
      "Current stack artifact bucket does not match the prior submission",
    );
  }
  const queue = output(outputs, "JobQueueArn");
  if (queue !== priorReceipt.jobQueue) {
    throw new Error(
      "Current stack job queue does not match the prior submission",
    );
  }

  const s3 = new S3Client({});
  const batch = new BatchClient({});
  const remoteRequest = await parseRegisteredBatchRequest(
    await getVerifiedJson(s3, bucket, key, digest),
  );
  if (requestDigest(remoteRequest) !== digest) {
    throw new Error("Stored recovery request does not match its digest");
  }
  const receiptKey = recoveryReceiptKey(request, evidenceDigest);

  const sunbizResponse = await batch.send(
    new DescribeJobsCommand({ jobs: [priorReceipt.jobs.sunbiz] }),
  );
  const sunbiz = sunbizResponse.jobs?.find(
    (job) => job.jobId === priorReceipt.jobs.sunbiz,
  );
  if (!sunbiz) {
    throw new Error("Prior Sunbiz job was not returned by AWS Batch");
  }
  assertRecoverableSunbizStatus(sunbiz.status);
  const identity = await new STSClient({}).send(
    new GetCallerIdentityCommand({}),
  );
  const ledger = ledgerDependencies({
    batch,
    s3,
    bucket,
    actorArn: identity.Arn ?? null,
  });

  const tags = commonTags(request, { recovery: "blocked-source" });
  const topology = buildBlockedRecoveryTopology(request);
  const submittedJobs = new Map<string, string>([
    [topology.sunbiz.stage, priorReceipt.jobs.sunbiz],
  ]);
  const suffix = evidenceDigest.slice(0, 12);
  const bbbSubmission = await submitBbbStages({
    request,
    stages: topology.bbb,
    submittedJobs,
    queue,
    jobDefinition: output(outputs, "BbbJobDefinitionArn"),
    bucket,
    key,
    digest,
    resume: false,
    suffix,
    evidenceJson: JSON.stringify(evidence),
    tags,
    ledger,
    evidenceDigest,
  });

  const reconciliationJobDefinition = output(
    outputs,
    "ReconciliationJobDefinitionArn",
  );
  const reconciliation = await ensureStageSubmission({
    receiptKey: stageSubmissionReceiptKey(
      request,
      topology.reconciliation.stage,
      evidenceDigest,
    ),
    contract: stageContract({
      request,
      stage: topology.reconciliation.stage,
      jobNameStage:
        `${topology.reconciliation.stage}-blocked-${suffix}`,
      dependencyStages: topology.reconciliation.dependsOn,
      submittedJobs,
      queue,
      jobDefinition: reconciliationJobDefinition,
      bucket,
      key,
      digest,
      tags,
    }),
    dependencies: ledger,
  });

  const recoveryReceipt = {
    schemaVersion: RECOVERY_RECEIPT_SCHEMA_VERSION,
    submittedAt: reconciliation.recordedAt,
    submittedByArn: reconciliation.recordedByArn,
    stackName,
    runId: request.runId,
    county: request.county,
    pipelineKey: request.pipelineKey,
    requestKey: key,
    requestSha256: digest,
    enrichmentProfileSha256: request.enrichmentProfileSha256,
    provenance: request.provenance,
    artifactBucket: bucket,
    jobQueue: queue,
    receiptKey,
    priorSubmission: {
      receiptSha256: requestDigestFromValue(priorReceipt),
      sunbizJobId: priorReceipt.jobs.sunbiz,
      sunbizStatus: sunbiz.status,
    },
    sourceAccessEvidence: evidence,
    sourceAccessEvidenceSha256: evidenceDigest,
    stageReceipts: {
      ...bbbSubmission.stageReceipts,
      [topology.reconciliation.stage]: reconciliation,
    },
    jobs: {
      sunbiz: priorReceipt.jobs.sunbiz,
      bbb: bbbSubmission.jobs,
      reconciliation: reconciliation.jobId,
    },
  };
  const persistedReceipt = await persistAggregateReceipt(
    s3,
    bucket,
    receiptKey,
    recoveryReceipt,
  );
  console.error(
    `Cost gate passed: estimated $${plan.estimatedUsd.toFixed(2)} of $${plan.ceilingUsd.toFixed(2)}`,
  );
  process.stdout.write(canonicalJson(persistedReceipt));
}

function requestDigestFromValue(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  if (command === "plan") {
    const request = await readRequest(requiredFlag(flags, "config"));
    process.stdout.write(canonicalJson(planBatchCost(request)));
    return;
  }
  if (command === "submit") {
    const request = await readRequest(requiredFlag(flags, "config"));
    await submit(request, flags);
    return;
  }
  if (command === "status") {
    await status(requiredFlag(flags, "receipt"));
    return;
  }
  if (command === "recover-blocked") {
    const request = await readRequest(requiredFlag(flags, "config"));
    await recoverBlockedSource(request, flags);
    return;
  }
  throw new Error(
    "Usage: enrichment-batch <plan --config file|submit --config file [--stack-name name] [--resume]|status --receipt file|recover-blocked --config file --receipt prior.json --evidence evidence.json [--stack-name name]>",
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
