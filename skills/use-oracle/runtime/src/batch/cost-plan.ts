import type { BatchRequest } from "./contracts.js";

export const COST_PLAN_SCHEMA_VERSION =
  "elephant.county-enrichment-cost-plan.v1";

/**
 * Deliberately conservative rates above typical us-east-1 on-demand Fargate
 * prices. They are a safety gate, not billing forecasts.
 */
const RATES = {
  vCpuHourUsd: 0.05,
  gbHourUsd: 0.006,
  extraEphemeralGbHourUsd: 0.0002,
  fixedS3LogsAndRequestsUsd: 0.6,
  contingencyMultiplier: 1.25,
} as const;

export interface CostComponent {
  name: string;
  maximumHours: number;
  estimatedUsd: number;
}

export interface CostPlan {
  schemaVersion: typeof COST_PLAN_SCHEMA_VERSION;
  ceilingUsd: number;
  estimatedUsd: number;
  allowed: boolean;
  components: CostComponent[];
  assumptions: typeof RATES;
}

function fargateCost(
  maximumHours: number,
  vCpu: number,
  memoryGb: number,
  ephemeralGb: number,
): number {
  return (
    maximumHours * vCpu * RATES.vCpuHourUsd +
    maximumHours * memoryGb * RATES.gbHourUsd +
    maximumHours *
      Math.max(0, ephemeralGb - 20) *
      RATES.extraEphemeralGbHourUsd
  );
}

function rounded(value: number): number {
  return Number(value.toFixed(4));
}

export function planBatchCost(request: BatchRequest): CostPlan {
  const sunbizHours = request.sunbiz.bounds.maxDurationMinutes / 60;
  const bbbHours = request.bbb.bounds.maxDurationMinutes / 60;

  const components: CostComponent[] = [
    {
      name: "sunbiz",
      maximumHours: sunbizHours,
      estimatedUsd: rounded(fargateCost(sunbizHours, 4, 16, 80)),
    },
    ...request.bbb.categories.map((category) => ({
      name: `bbb:${category.key}`,
      maximumHours: bbbHours,
      estimatedUsd: rounded(fargateCost(bbbHours, 2, 4, 30)),
    })),
    {
      name: "reconciliation",
      maximumHours: 1 / 3,
      estimatedUsd: rounded(fargateCost(1 / 3, 0.25, 0.5, 20)),
    },
    {
      name: "s3-logs-requests",
      maximumHours: 0,
      estimatedUsd: RATES.fixedS3LogsAndRequestsUsd,
    },
  ];

  const subtotal = components.reduce(
    (sum, component) => sum + component.estimatedUsd,
    0,
  );
  const estimatedUsd = rounded(subtotal * RATES.contingencyMultiplier);

  return {
    schemaVersion: COST_PLAN_SCHEMA_VERSION,
    ceilingUsd: request.costCeilingUsd,
    estimatedUsd,
    allowed: estimatedUsd <= request.costCeilingUsd,
    components,
    assumptions: RATES,
  };
}

export function assertCostAllowed(
  request: BatchRequest,
  deploymentCeilingUsd?: number,
): CostPlan {
  if (
    deploymentCeilingUsd !== undefined &&
    (!Number.isFinite(deploymentCeilingUsd) || deploymentCeilingUsd <= 0)
  ) {
    throw new Error("Deployment cost ceiling must be a positive finite number");
  }
  if (
    deploymentCeilingUsd !== undefined &&
    request.costCeilingUsd > deploymentCeilingUsd
  ) {
    throw new Error(
      `Request cost ceiling $${request.costCeilingUsd.toFixed(2)} exceeds the deployment ceiling $${deploymentCeilingUsd.toFixed(2)}`,
    );
  }
  const plan = planBatchCost(request);
  if (!plan.allowed) {
    throw new Error(
      `Predicted run cost $${plan.estimatedUsd.toFixed(2)} exceeds the configured $${plan.ceilingUsd.toFixed(2)} ceiling`,
    );
  }
  return plan;
}
