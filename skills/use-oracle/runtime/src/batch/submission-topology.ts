import type {
  BatchRequest,
  BbbDependencyPolicy,
} from "./contracts.js";

export interface BbbSubmissionStage {
  categoryKey: string;
  stage: string;
  dependsOn: string[];
}

export interface BatchSubmissionTopology {
  sunbiz: { stage: "sunbiz"; dependsOn: [] };
  bbb: BbbSubmissionStage[];
  reconciliation: {
    stage: "reconciliation";
    dependsOn: string[];
  };
}

function topologyForPolicy(
  request: BatchRequest,
  policy: BbbDependencyPolicy,
  bbbStage: (categoryKey: string) => string,
): BatchSubmissionTopology {
  const bbb = request.bbb.categories.map((category, index, categories) => ({
    categoryKey: category.key,
    stage: bbbStage(category.key),
    dependsOn:
      policy === "serial" && index > 0
        ? [bbbStage(categories[index - 1]!.key)]
        : [],
  }));
  const bbbReconciliationDependencies =
    policy === "serial"
      ? bbb.slice(-1).map((stage) => stage.stage)
      : bbb.map((stage) => stage.stage);
  return {
    sunbiz: { stage: "sunbiz", dependsOn: [] },
    bbb,
    reconciliation: {
      stage: "reconciliation",
      dependsOn: ["sunbiz", ...bbbReconciliationDependencies],
    },
  };
}

export function buildSubmissionTopology(
  request: BatchRequest,
): BatchSubmissionTopology {
  return topologyForPolicy(
    request,
    request.execution.bbbDependencyPolicy,
    (categoryKey) => `bbb-${categoryKey}`,
  );
}

export function buildBlockedRecoveryTopology(
  request: BatchRequest,
): BatchSubmissionTopology {
  return topologyForPolicy(
    request,
    request.execution.recoveryBbbDependencyPolicy,
    (categoryKey) => `bbb-${categoryKey}-blocked`,
  );
}
