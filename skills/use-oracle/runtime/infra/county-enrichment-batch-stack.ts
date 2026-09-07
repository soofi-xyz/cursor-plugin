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
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as events from "aws-cdk-lib/aws-events";
import * as eventTargets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import type { Construct } from "constructs";

interface JobDefinitionOptions {
  id: string;
  name: string;
  command: string[];
  cpu: number;
  memoryMib: number;
  ephemeralStorageGib: number;
  timeout: Duration;
  jobRole: iam.IRole;
}

export class CountyEnrichmentBatchStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const alertEmail = this.node.tryGetContext("alertEmail");
    if (
      typeof alertEmail !== "string" ||
      !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(alertEmail)
    ) {
      throw new Error(
        "CDK context alertEmail is required and must be a valid email address",
      );
    }
    const maxCostCeilingUsd = Number(
      this.node.tryGetContext("maxCostCeilingUsd") ?? 5,
    );
    if (!Number.isFinite(maxCostCeilingUsd) || maxCostCeilingUsd <= 0) {
      throw new Error(
        "CDK context maxCostCeilingUsd must be a positive finite number",
      );
    }

    const projectName =
      this.node.tryGetContext("projectName") ?? "county-enrichment";
    Tags.of(this).add("project_name", projectName);

    const artifactBucket = new s3.Bucket(this, "ArtifactBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
      lifecycleRules: [
        {
          id: "AbortIncompleteMultipartUploads",
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
    });

    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });
    const securityGroup = new ec2.SecurityGroup(this, "BatchSecurityGroup", {
      vpc,
      allowAllOutbound: false,
      description: "No inbound access; HTTPS-only outbound for Batch jobs",
    });
    securityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      "HTTPS to AWS services and reviewed public sources",
    );
    securityGroup.addEgressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.udp(53),
      "DNS through the VPC resolver",
    );
    securityGroup.addEgressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(53),
      "TCP DNS fallback through the VPC resolver",
    );

    const computeEnvironment = new batch.FargateComputeEnvironment(
      this,
      "ComputeEnvironment",
      {
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        securityGroups: [securityGroup],
        maxvCpus: 6,
        spot: false,
      },
    );
    const jobQueue = new batch.JobQueue(this, "JobQueue", {
      priority: 1,
      computeEnvironments: [
        { computeEnvironment, order: 1 },
      ],
    });

    const logGroup = new logs.LogGroup(this, "BatchLogGroup", {
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const runtimeRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
    );
    const imageAsset = new ecrAssets.DockerImageAsset(this, "BatchImage", {
      directory: runtimeRoot,
      file: "Dockerfile.batch",
      platform: ecrAssets.Platform.LINUX_AMD64,
    });
    const image = ecs.ContainerImage.fromDockerImageAsset(imageAsset);

    const executionRole = new iam.Role(this, "ExecutionRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });
    imageAsset.repository.grantPull(executionRole);
    logGroup.grantWrite(executionRole);

    const sunbizRole = this.jobRole("SunbizJobRole");
    const bbbRole = this.jobRole("BbbJobRole");
    const permitRole = this.jobRole("PermitJobRole");
    const reconciliationRole = this.jobRole("ReconciliationJobRole");

    this.grantObjects(sunbizRole, artifactBucket, "s3:GetObject", [
      "requests/*",
      "inputs/*",
      "runs/*/artifacts/sunbiz/*",
      "runs/*/handoffs/sunbiz.json",
    ]);
    this.grantObjects(sunbizRole, artifactBucket, "s3:PutObject", [
      "runs/*/artifacts/sunbiz/*",
      "runs/*/handoffs/sunbiz.json",
    ]);
    this.grantList(sunbizRole, artifactBucket, [
      "runs/*/handoffs/sunbiz.json",
    ]);

    this.grantObjects(bbbRole, artifactBucket, "s3:GetObject", [
      "requests/*",
      "runs/*/artifacts/bbb-*/*",
      "runs/*/checkpoints/bbb/*",
      "runs/*/handoffs/bbb-*.json",
    ]);
    this.grantObjects(bbbRole, artifactBucket, "s3:PutObject", [
      "runs/*/artifacts/bbb-*/*",
      "runs/*/checkpoints/bbb/*",
      "runs/*/handoffs/bbb-*.json",
    ]);
    this.grantList(bbbRole, artifactBucket, [
      "runs/*/checkpoints/bbb/*",
      "runs/*/handoffs/bbb-*.json",
    ]);

    this.grantObjects(permitRole, artifactBucket, "s3:GetObject", [
      "inputs/*",
      "runs/*/artifacts/reconciliation/*",
      "runs/*/artifacts/permit/*",
      "runs/*/handoffs/permit.json",
    ]);
    this.grantObjects(permitRole, artifactBucket, "s3:PutObject", [
      "runs/*/artifacts/permit/*",
      "runs/*/handoffs/permit.json",
    ]);
    this.grantList(permitRole, artifactBucket, [
      "runs/*/handoffs/permit.json",
    ]);

    this.grantObjects(reconciliationRole, artifactBucket, "s3:GetObject", [
      "requests/*",
      "runs/*/artifacts/*",
      "runs/*/handoffs/*",
    ]);
    this.grantObjects(reconciliationRole, artifactBucket, "s3:PutObject", [
      "runs/*/artifacts/reconciliation/*",
      "runs/*/handoffs/reconciliation.json",
    ]);
    this.grantList(reconciliationRole, artifactBucket, [
      "runs/*/handoffs/*",
    ]);

    const createJobDefinition = (
      options: JobDefinitionOptions,
    ): batch.EcsJobDefinition => {
      const container = new batch.EcsFargateContainerDefinition(
        this,
        `${options.id}Container`,
        {
          image,
          command: options.command,
          cpu: options.cpu,
          memory: Size.mebibytes(options.memoryMib),
          ephemeralStorageSize: Size.gibibytes(
            options.ephemeralStorageGib,
          ),
          assignPublicIp: true,
          executionRole,
          jobRole: options.jobRole,
          logging: ecs.LogDrivers.awsLogs({
            logGroup,
            streamPrefix: options.name,
          }),
          user: "node",
          environment: {
            HOME: "/work/home",
            TMPDIR: "/work/tmp",
            CHROME_EXECUTABLE_PATH: "/usr/bin/chromium",
            MAX_COST_CEILING_USD: String(maxCostCeilingUsd),
          },
        },
      );
      return new batch.EcsJobDefinition(this, options.id, {
        jobDefinitionName: options.name,
        container,
        timeout: options.timeout,
        retryAttempts: 1,
        propagateTags: true,
      });
    };

    const sunbizJob = createJobDefinition({
      id: "SunbizJobDefinition",
      name: "county-enrichment-sunbiz",
      command: ["node", "/app/dist/src/batch/worker.js", "sunbiz"],
      cpu: 4,
      memoryMib: 16_384,
      ephemeralStorageGib: 80,
      timeout: Duration.hours(4),
      jobRole: sunbizRole,
    });
    const bbbJob = createJobDefinition({
      id: "BbbJobDefinition",
      name: "county-enrichment-bbb",
      command: ["node", "/app/dist/src/batch/worker.js", "bbb"],
      cpu: 2,
      memoryMib: 4_096,
      ephemeralStorageGib: 30,
      timeout: Duration.hours(6),
      jobRole: bbbRole,
    });
    const reconciliationJob = createJobDefinition({
      id: "ReconciliationJobDefinition",
      name: "county-enrichment-reconciliation",
      command: ["node", "/app/dist/src/batch/worker.js", "reconciliation"],
      cpu: 0.25,
      memoryMib: 512,
      ephemeralStorageGib: 21,
      timeout: Duration.minutes(20),
      jobRole: reconciliationRole,
    });
    const permitJob = createJobDefinition({
      id: "PermitJobDefinition",
      name: "county-enrichment-permit",
      command: ["node", "/app/dist/src/batch/permit-worker.js"],
      cpu: 4,
      memoryMib: 16_384,
      ephemeralStorageGib: 80,
      timeout: Duration.hours(4),
      jobRole: permitRole,
    });

    const operatorPolicy = new iam.ManagedPolicy(
      this,
      "OperatorSubmissionPolicy",
      {
        description:
          "Least-privilege policy for durable county-enrichment submissions",
        statements: [
          new iam.PolicyStatement({
            actions: ["s3:GetObject", "s3:PutObject"],
            resources: [
              artifactBucket.arnForObjects("requests/*"),
              artifactBucket.arnForObjects("runs/*/submissions/*"),
              artifactBucket.arnForObjects("runs/*/recoveries/*"),
            ],
          }),
          new iam.PolicyStatement({
            actions: ["batch:SubmitJob"],
            resources: [
              jobQueue.jobQueueArn,
              sunbizJob.jobDefinitionArn,
              bbbJob.jobDefinitionArn,
              reconciliationJob.jobDefinitionArn,
              permitJob.jobDefinitionArn,
            ],
          }),
          new iam.PolicyStatement({
            actions: ["batch:ListJobs", "batch:DescribeJobs"],
            resources: ["*"],
          }),
          new iam.PolicyStatement({
            actions: ["cloudformation:DescribeStacks"],
            resources: [this.stackId],
          }),
          new iam.PolicyStatement({
            actions: ["sts:GetCallerIdentity"],
            resources: ["*"],
          }),
        ],
      },
    );

    const failureTopic = new sns.Topic(this, "BatchFailureTopic", {
      displayName: "County enrichment AWS Batch failures",
    });
    failureTopic.addSubscription(
      new subscriptions.EmailSubscription(alertEmail),
    );
    const failedJobs = new events.Rule(this, "FailedBatchJobs", {
      eventPattern: {
        source: ["aws.batch"],
        detailType: ["Batch Job State Change"],
        detail: {
          status: ["FAILED"],
          jobQueue: [jobQueue.jobQueueArn],
        },
      },
    });
    failedJobs.addTarget(new eventTargets.SnsTopic(failureTopic));

    new CfnOutput(this, "ArtifactBucketName", {
      value: artifactBucket.bucketName,
    });
    new CfnOutput(this, "JobQueueArn", {
      value: jobQueue.jobQueueArn,
    });
    new CfnOutput(this, "SunbizJobDefinitionArn", {
      value: sunbizJob.jobDefinitionArn,
    });
    new CfnOutput(this, "BbbJobDefinitionArn", {
      value: bbbJob.jobDefinitionArn,
    });
    new CfnOutput(this, "ReconciliationJobDefinitionArn", {
      value: reconciliationJob.jobDefinitionArn,
    });
    new CfnOutput(this, "PermitJobDefinitionArn", {
      value: permitJob.jobDefinitionArn,
    });
    new CfnOutput(this, "BatchLogGroupName", {
      value: logGroup.logGroupName,
    });
    new CfnOutput(this, "FailureTopicArn", {
      value: failureTopic.topicArn,
    });
    new CfnOutput(this, "MaxCostCeilingUsd", {
      value: String(maxCostCeilingUsd),
    });
    new CfnOutput(this, "OperatorSubmissionPolicyArn", {
      value: operatorPolicy.managedPolicyArn,
    });
  }

  private jobRole(id: string): iam.Role {
    return new iam.Role(this, id, {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });
  }

  private grantObjects(
    role: iam.IRole,
    bucket: s3.IBucket,
    action: "s3:GetObject" | "s3:PutObject",
    paths: string[],
  ): void {
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [action],
        resources: paths.map((objectPath) =>
          bucket.arnForObjects(objectPath),
        ),
      }),
    );
  }

  private grantList(
    role: iam.IRole,
    bucket: s3.IBucket,
    prefixes: string[],
  ): void {
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["s3:ListBucket"],
        resources: [bucket.bucketArn],
        conditions: {
          StringLike: {
            "s3:prefix": prefixes,
          },
        },
      }),
    );
  }
}
