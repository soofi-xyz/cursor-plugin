import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { CountyEnrichmentBatchStack } from "../infra/county-enrichment-batch-stack.js";

describe("county enrichment Batch IAM", () => {
  it("uses ledger-only operator prefixes and no fixed final-manifest key", () => {
    const app = new App({
      context: {
        alertEmail: "alerts@example.test",
        maxCostCeilingUsd: 5,
      },
    });
    const stack = new CountyEnrichmentBatchStack(
      app,
      "TestCountyEnrichmentBatchStack",
    );
    const rendered = JSON.stringify(Template.fromStack(stack).toJSON());

    expect(rendered).toContain("runs/*/submissions/*");
    expect(rendered).toContain("runs/*/recoveries/*");
    expect(rendered).toContain("OperatorSubmissionPolicyArn");
    expect(rendered).not.toContain("final-manifest.json");
  });
});
