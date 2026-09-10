#!/usr/bin/env node

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
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";

import {
  gapRequestDigest,
  parseGapBatchRequest,
  type GapBatchRequest,
} from "../src/batch/gap-contracts.js";
import {
  assertGapCostAllowed,
} from "../src/batch/gap-cost-plan.js";
import { putImmutableJson } from "../src/batch/s3-integrity.js";

const STACK_NAME = "DuvalMcpGapBatchStack";
const EXPECTED_ACCOUNT = "282516654782";
const EXPECTED_REGION = "us-east-1";

function parseFlags(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value) {
      throw new Error(`Expected --name value, received ${name ?? "end"}`);
    }
    result[name.slice(2)] = value;
  }
  return result;
}

function requiredFlag(flags: Record<string, string>, name: string): string {
  const value = flags[name];
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

async function requestFromFile(filePath: string): Promise<GapBatchRequest> {
  return parseGapBatchRequest(JSON.parse(await readFile(filePath, "utf8")));
}

async function stackOutputs(stackName: string): Promise<Record<string, string>> {
  const response = await new CloudFormationClient({
    region: EXPECTED_REGION,
  }).send(new DescribeStacksCommand({ StackName: stackName }));
  return Object.fromEntries(
    (response.Stacks?.[0]?.Outputs ?? []).flatMap((entry) =>
      entry.OutputKey && entry.OutputValue
        ? [[entry.OutputKey, entry.OutputValue]]
        : [],
    ),
  );
}

async function assertAwsIdentity(): Promise<string> {
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (region !== EXPECTED_REGION) {
    throw new Error(
      `AWS region must be ${EXPECTED_REGION}; received ${region ?? "unset"}`,
    );
  }
  const response = await new STSClient({ region }).send(
    new GetCallerIdentityCommand({}),
  );
  if (response.Account !== EXPECTED_ACCOUNT) {
    throw new Error(
      `AWS account must be ${EXPECTED_ACCOUNT}; received ${response.Account ?? "unknown"}`,
    );
  }
  return response.Arn ?? "unknown";
}

async function existingJob(
  batch: BatchClient,
  queue: string,
  jobName: string,
): Promise<{ jobId: string; status: string | undefined } | null> {
  const listed = await batch.send(
    new ListJobsCommand({
      jobQueue: queue,
      filters: [{ name: "JOB_NAME", values: [jobName] }],
      maxResults: 100,
    }),
  );
  const match = (listed.jobSummaryList ?? []).find(
    (entry) => entry.jobName === jobName && entry.jobId,
  );
  return match?.jobId
    ? { jobId: match.jobId, status: match.status }
    : null;
}

async function main(): Promise<void> {
  const [command, ...argv] = process.argv.slice(2);
  const flags = parseFlags(argv);
  if (command === "status") {
    const jobId = requiredFlag(flags, "job-id");
    const response = await new BatchClient({ region: EXPECTED_REGION }).send(
      new DescribeJobsCommand({ jobs: [jobId] }),
    );
    process.stdout.write(`${JSON.stringify(response.jobs?.[0] ?? null, null, 2)}\n`);
    return;
  }

  const request = await requestFromFile(requiredFlag(flags, "request"));
  const digest = gapRequestDigest(request);
  const cost = assertGapCostAllowed(request);
  const plan = {
    schemaVersion: "elephant.duval-mcp-gap-batch-plan.v1",
    requestDigest: digest,
    runId: request.runId,
    phases: request.phases,
    submitsBbb: false,
    protectedCids: request.protectedCids,
    livePublishRequested: request.inputs.publishApproval !== null,
    cost,
  };
  if (command === "plan") {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  if (command !== "submit") {
    throw new Error("Usage: gap-batch <plan|submit|status> [...flags]");
  }

  const actorArn = await assertAwsIdentity();
  const outputs = await stackOutputs(flags.stack ?? STACK_NAME);
  const bucket = outputs.ArtifactBucketName;
  const queue = outputs.JobQueueArn;
  const jobDefinition = outputs.DuvalGapJobDefinitionArn;
  const deploymentCostCeiling = Number(outputs.MaxCostCeilingUsd);
  if (
    !bucket ||
    !queue ||
    !jobDefinition ||
    !Number.isFinite(deploymentCostCeiling)
  ) {
    throw new Error("Duval gap Batch stack outputs are incomplete");
  }
  assertGapCostAllowed(request, deploymentCostCeiling);
  const requestKey = `gap-requests/${digest}/request.json`;
  const s3 = new S3Client({ region: EXPECTED_REGION });
  await putImmutableJson(s3, bucket, requestKey, request);
  const jobName = `duval-gap-${request.runId}-${digest.slice(0, 10)}`.slice(
    0,
    128,
  );
  const batch = new BatchClient({ region: EXPECTED_REGION });
  const existing = await existingJob(batch, queue, jobName);
  if (existing !== null) {
    process.stdout.write(
      `${JSON.stringify({ ...plan, actorArn, existingJob: existing }, null, 2)}\n`,
    );
    return;
  }
  const response = await batch.send(
    new SubmitJobCommand({
      jobName,
      jobQueue: queue,
      jobDefinition,
      containerOverrides: {
        environment: [
          { name: "ARTIFACT_BUCKET", value: bucket },
          { name: "REQUEST_KEY", value: requestKey },
          { name: "REQUEST_SHA256", value: digest },
          {
            name: "GAP_LIVE_PUBLISH",
            value: request.inputs.publishApproval === null ? "false" : "true",
          },
        ],
      },
      tags: {
        project_name: "duval-mcp-gap-close",
        county: "duval",
        pipeline_key: "duval-mcp-gap-close",
        run_id: request.runId,
        submitted_by: actorArn.slice(0, 256),
      },
    }),
  );
  process.stdout.write(
    `${JSON.stringify({ ...plan, actorArn, jobId: response.jobId }, null, 2)}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
