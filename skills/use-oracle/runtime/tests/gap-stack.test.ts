import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { DuvalGapBatchStack } from "../infra/duval-gap-batch-stack.js";

describe("isolated Duval gap Batch stack", () => {
  it("adds only the gap job and imports the existing queue/bucket", () => {
    const app = new App({
      context: {
        artifactBucketName: "existing-artifact-bucket",
        jobQueueArn:
          "arn:aws:batch:us-east-1:282516654782:job-queue/existing-queue",
      },
    });
    const stack = new DuvalGapBatchStack(app, "TestDuvalGapBatchStack", {
      env: { account: "282516654782", region: "us-east-1" },
    });
    const rendered = JSON.stringify(Template.fromStack(stack).toJSON());
    expect(rendered).toContain("county-enrichment-duval-gap");
    expect(rendered).toContain("gap-requests/*");
    expect(rendered).toContain("runs/*/artifacts/sunbiz/*");
    expect(rendered).toContain("DuvalGapJobDefinitionArn");
    expect(rendered).not.toContain("county-enrichment-bbb");
    expect(rendered).not.toContain("county-enrichment-permit");
    expect(rendered).not.toContain("county-enrichment-sunbiz");
    expect(rendered).not.toContain("AWS::Batch::ComputeEnvironment");
    expect(rendered).not.toContain("s3:DeleteObject");
  });
});
