import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Size,
  Stack,
  Tags,
  type StackProps,
} from "aws-cdk-lib";
import * as batch from "aws-cdk-lib/aws-batch";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";

export class DuvalGapBatchStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const artifactBucketName = this.requiredContext("artifactBucketName");
    const jobQueueArn = this.requiredContext("jobQueueArn");
    const projectName =
      this.node.tryGetContext("projectName") ?? "duval-mcp-gap-close";
    const gitCommit = this.requiredContext("gitCommit");
    const treeDigest = this.requiredContext("treeDigest");
    if (!/^[a-f0-9]{40}$/.test(gitCommit)) {
      throw new Error("gitCommit must be a full lowercase Git SHA");
    }
    if (!/^[a-f0-9]{64}$/.test(treeDigest)) {
      throw new Error("treeDigest must be a lowercase SHA-256");
    }
    const maxCostCeilingUsd = Number(
      this.node.tryGetContext("maxCostCeilingUsd") ?? 15,
    );
    if (!Number.isFinite(maxCostCeilingUsd) || maxCostCeilingUsd <= 0) {
      throw new Error("maxCostCeilingUsd must be a positive finite number");
    }
    Tags.of(this).add("project_name", projectName);

    const artifactBucket = s3.Bucket.fromBucketName(
      this,
      "ExistingArtifactBucket",
      artifactBucketName,
    );
    const jobQueue = batch.JobQueue.fromJobQueueArn(
      this,
      "ExistingJobQueue",
      jobQueueArn,
    );
    const runtimeRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
    );
    const imageAsset = new ecrAssets.DockerImageAsset(this, "GapImage", {
      directory: runtimeRoot,
      file: "Dockerfile.batch",
      platform: ecrAssets.Platform.LINUX_AMD64,
    });
    const executionRole = new iam.Role(this, "ExecutionRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });
    imageAsset.repository.grantPull(executionRole);
    const logGroup = new logs.LogGroup(this, "GapLogGroup", {
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    logGroup.grantWrite(executionRole);

    const jobRole = new iam.Role(this, "GapJobRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });
    artifactBucket.grantRead(jobRole, "gap-requests/*");
    artifactBucket.grantRead(jobRole, "inputs/*");
    artifactBucket.grantRead(jobRole, "runs/*/handoffs/sunbiz.json");
    artifactBucket.grantRead(jobRole, "runs/*/artifacts/sunbiz/*");
    artifactBucket.grantRead(jobRole, "runs/*/checkpoints/duval-gap/*");
    jobRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:PutObject"],
        resources: [
          artifactBucket.arnForObjects("runs/*/artifacts/duval-gap/*"),
          artifactBucket.arnForObjects("runs/*/checkpoints/duval-gap/*"),
          artifactBucket.arnForObjects(
            "runs/*/handoffs/duval-gap-*.json",
          ),
        ],
      }),
    );

    const filebaseSecretArn = this.node.tryGetContext("filebaseSecretArn");
    const filebaseSecret =
      typeof filebaseSecretArn === "string" && filebaseSecretArn.length > 0
        ? secretsmanager.Secret.fromSecretCompleteArn(
            this,
            "FilebasePublicationSecret",
            filebaseSecretArn,
          )
        : null;
    const container = new batch.EcsFargateContainerDefinition(
      this,
      "GapContainer",
      {
        image: ecs.ContainerImage.fromDockerImageAsset(imageAsset),
        command: ["node", "/app/dist/src/batch/gap-worker.js"],
        cpu: 4,
        memory: Size.mebibytes(30_720),
        ephemeralStorageSize: Size.gibibytes(100),
        assignPublicIp: true,
        executionRole,
        jobRole,
        logging: ecs.LogDrivers.awsLogs({
          logGroup,
          streamPrefix: "duval-gap",
        }),
        user: "node",
        environment: {
          HOME: "/work/home",
          TMPDIR: "/work/tmp",
          MAX_COST_CEILING_USD: String(maxCostCeilingUsd),
          RUNTIME_GIT_COMMIT: gitCommit,
          RUNTIME_TREE_DIGEST: treeDigest,
        },
        secrets:
          filebaseSecret === null
            ? undefined
            : {
                S3_ACCESS_KEY_ID: ecs.Secret.fromSecretsManager(
                  filebaseSecret,
                  "S3_ACCESS_KEY_ID",
                ),
                S3_SECRET_ACCESS_KEY: ecs.Secret.fromSecretsManager(
                  filebaseSecret,
                  "S3_SECRET_ACCESS_KEY",
                ),
                FILEBASE_API_TOKEN: ecs.Secret.fromSecretsManager(
                  filebaseSecret,
                  "FILEBASE_API_TOKEN",
                ),
              },
      },
    );
    const jobDefinition = new batch.EcsJobDefinition(
      this,
      "DuvalGapJobDefinition",
      {
        jobDefinitionName: "county-enrichment-duval-gap",
        container,
        timeout: Duration.hours(12),
        retryAttempts: 2,
        propagateTags: true,
      },
    );
    const operatorPolicy = new iam.ManagedPolicy(
      this,
      "GapOperatorPolicy",
      {
        statements: [
          new iam.PolicyStatement({
            actions: ["s3:GetObject", "s3:PutObject"],
            resources: [
              artifactBucket.arnForObjects("gap-requests/*"),
              artifactBucket.arnForObjects("inputs/*"),
            ],
          }),
          new iam.PolicyStatement({
            actions: ["batch:SubmitJob"],
            resources: [jobQueue.jobQueueArn, jobDefinition.jobDefinitionArn],
          }),
          new iam.PolicyStatement({
            actions: ["batch:ListJobs", "batch:DescribeJobs"],
            resources: ["*"],
          }),
          new iam.PolicyStatement({
            actions: ["cloudformation:DescribeStacks", "sts:GetCallerIdentity"],
            resources: ["*"],
          }),
        ],
      },
    );

    new CfnOutput(this, "ArtifactBucketName", {
      value: artifactBucketName,
    });
    new CfnOutput(this, "JobQueueArn", { value: jobQueueArn });
    new CfnOutput(this, "DuvalGapJobDefinitionArn", {
      value: jobDefinition.jobDefinitionArn,
    });
    new CfnOutput(this, "OperatorSubmissionPolicyArn", {
      value: operatorPolicy.managedPolicyArn,
    });
    new CfnOutput(this, "BatchLogGroupName", {
      value: logGroup.logGroupName,
    });
    new CfnOutput(this, "MaxCostCeilingUsd", {
      value: String(maxCostCeilingUsd),
    });
  }

  private requiredContext(name: string): string {
    const value = this.node.tryGetContext(name);
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`CDK context ${name} is required`);
    }
    return value;
  }
}
