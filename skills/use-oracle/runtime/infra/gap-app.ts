#!/usr/bin/env node

import { App } from "aws-cdk-lib";

import { DuvalGapBatchStack } from "./duval-gap-batch-stack.js";

const app = new App();
const region =
  app.node.tryGetContext("region") ??
  process.env.CDK_DEFAULT_REGION ??
  "us-east-1";

new DuvalGapBatchStack(app, "DuvalMcpGapBatchStack", {
  stackName:
    app.node.tryGetContext("stackName") ?? "DuvalMcpGapBatchStack",
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
  description:
    "Isolated AWS Batch job for Duval MCP gap closure without appraisal, permit, or BBB jobs",
});
