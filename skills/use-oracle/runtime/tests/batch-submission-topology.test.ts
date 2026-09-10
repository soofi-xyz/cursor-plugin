import { describe, expect, it } from "vitest";

import {
  buildBlockedRecoveryTopology,
  buildSubmissionTopology,
} from "../src/batch/submission-topology.js";
import { syntheticRequest } from "./batch-fixtures.js";

describe("county-enrichment submission topology", () => {
  it("serializes normal BBB stages only when the request says serial", () => {
    const request = syntheticRequest({
      categoryCount: 3,
      bbbDependencyPolicy: "serial",
    });
    const topology = buildSubmissionTopology(request);

    expect(topology.bbb.map(({ stage, dependsOn }) => ({
      stage,
      dependsOn,
    }))).toEqual([
      { stage: "bbb-synthetic-trade-1", dependsOn: [] },
      {
        stage: "bbb-synthetic-trade-2",
        dependsOn: ["bbb-synthetic-trade-1"],
      },
      {
        stage: "bbb-synthetic-trade-3",
        dependsOn: ["bbb-synthetic-trade-2"],
      },
    ]);
    expect(topology.reconciliation.dependsOn).toEqual([
      "sunbiz",
      "bbb-synthetic-trade-3",
    ]);
  });

  it("fans out normal BBB stages for a parallel request", () => {
    const request = syntheticRequest({
      categoryCount: 3,
      bbbDependencyPolicy: "parallel",
    });
    const topology = buildSubmissionTopology(request);

    expect(topology.bbb.every(({ dependsOn }) => dependsOn.length === 0))
      .toBe(true);
    expect(topology.reconciliation.dependsOn).toEqual([
      "sunbiz",
      "bbb-synthetic-trade-1",
      "bbb-synthetic-trade-2",
      "bbb-synthetic-trade-3",
    ]);
  });

  it("uses an explicit, independent browser-free recovery policy", () => {
    const parallelRecovery = buildBlockedRecoveryTopology(
      syntheticRequest({
        categoryCount: 3,
        bbbDependencyPolicy: "serial",
        recoveryBbbDependencyPolicy: "parallel",
      }),
    );
    expect(parallelRecovery.bbb.map(({ stage }) => stage)).toEqual([
      "bbb-synthetic-trade-1-blocked",
      "bbb-synthetic-trade-2-blocked",
      "bbb-synthetic-trade-3-blocked",
    ]);
    expect(
      parallelRecovery.bbb.every(({ dependsOn }) => dependsOn.length === 0),
    ).toBe(true);

    const serialRecovery = buildBlockedRecoveryTopology(
      syntheticRequest({
        categoryCount: 3,
        bbbDependencyPolicy: "parallel",
        recoveryBbbDependencyPolicy: "serial",
      }),
    );
    expect(serialRecovery.bbb[1]!.dependsOn).toEqual([
      "bbb-synthetic-trade-1-blocked",
    ]);
    expect(serialRecovery.reconciliation.dependsOn).toEqual([
      "sunbiz",
      "bbb-synthetic-trade-3-blocked",
    ]);
  });
});
