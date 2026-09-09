import type { GapBatchRequest } from "./gap-contracts.js";

export const GAP_COST_PLAN_SCHEMA_VERSION =
  "elephant.duval-mcp-gap-cost-plan.v1";

const MAXIMUM_HOURS = 12;
const MAXIMUM_ATTEMPTS = 2;
const RATES = {
  vCpuHourUsd: 0.05,
  gbHourUsd: 0.006,
  extraEphemeralGbHourUsd: 0.0002,
  fixedS3LogsAndRequestsUsd: 1,
  contingencyMultiplier: 1.25,
} as const;

function rounded(value: number): number {
  return Number(value.toFixed(4));
}

export function planGapBatchCost(request: GapBatchRequest) {
  const compute =
    MAXIMUM_ATTEMPTS *
    (MAXIMUM_HOURS * 4 * RATES.vCpuHourUsd +
      MAXIMUM_HOURS * 30 * RATES.gbHourUsd +
      MAXIMUM_HOURS * (100 - 20) * RATES.extraEphemeralGbHourUsd);
  const estimatedUsd = rounded(
    (compute + RATES.fixedS3LogsAndRequestsUsd) *
      RATES.contingencyMultiplier,
  );
  return {
    schemaVersion: GAP_COST_PLAN_SCHEMA_VERSION,
    ceilingUsd: request.costCeilingUsd,
    estimatedUsd,
    allowed: estimatedUsd <= request.costCeilingUsd,
    maximumHours: MAXIMUM_HOURS,
    maximumAttempts: MAXIMUM_ATTEMPTS,
    assumptions: RATES,
    excludes:
      "Filebase subscription/storage charges and public-gateway egress",
  };
}

export function assertGapCostAllowed(
  request: GapBatchRequest,
  deploymentCeilingUsd?: number,
) {
  if (
    deploymentCeilingUsd !== undefined &&
    (!Number.isFinite(deploymentCeilingUsd) || deploymentCeilingUsd <= 0)
  ) {
    throw new Error("Deployment cost ceiling must be positive");
  }
  if (
    deploymentCeilingUsd !== undefined &&
    request.costCeilingUsd > deploymentCeilingUsd
  ) {
    throw new Error(
      `Request cost ceiling $${request.costCeilingUsd.toFixed(2)} exceeds ` +
        `deployment ceiling $${deploymentCeilingUsd.toFixed(2)}`,
    );
  }
  const plan = planGapBatchCost(request);
  if (!plan.allowed) {
    throw new Error(
      `Predicted run cost $${plan.estimatedUsd.toFixed(2)} exceeds ` +
        `$${plan.ceilingUsd.toFixed(2)} ceiling`,
    );
  }
  return plan;
}
