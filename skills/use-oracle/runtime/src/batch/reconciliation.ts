import {
  handoffSchema,
  type BatchHandoff,
  type BatchRequest,
} from "./contracts.js";

export function requiredStageNames(request: BatchRequest): string[] {
  return [
    "sunbiz",
    ...request.bbb.categories.map((category) => `bbb-${category.key}`),
  ];
}

export function validateRequiredHandoffs(
  values: unknown[],
  request: BatchRequest,
  requestSha256: string,
): BatchHandoff[] {
  const handoffs = values.map((value) => handoffSchema.parse(value));
  const byStage = new Map<string, BatchHandoff>();
  for (const handoff of handoffs) {
    if (
      handoff.requestSha256 !== requestSha256 ||
      handoff.enrichmentProfileSha256 !==
        request.enrichmentProfileSha256 ||
      handoff.runId !== request.runId ||
      handoff.county !== request.county ||
      handoff.pipelineKey !== request.pipelineKey
    ) {
      throw new Error(`Handoff provenance mismatch for ${handoff.stage}`);
    }
    if (byStage.has(handoff.stage)) {
      throw new Error(`Duplicate handoff for ${handoff.stage}`);
    }
    byStage.set(handoff.stage, handoff);
  }

  const required = requiredStageNames(request);
  const missing = required.filter((stage) => !byStage.has(stage));
  const unexpected = [...byStage.keys()].filter(
    (stage) => !required.includes(stage),
  );
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Invalid handoff set; missing=${missing.join(",") || "none"} unexpected=${unexpected.join(",") || "none"}`,
    );
  }
  return required.map((stage) => byStage.get(stage)!);
}

export function requireArtifact(
  handoff: BatchHandoff,
  logicalPath: string,
) {
  const artifact = handoff.artifacts.find(
    (candidate) => candidate.logicalPath === logicalPath,
  );
  if (!artifact) {
    throw new Error(
      `Handoff ${handoff.stage} is missing artifact ${logicalPath}`,
    );
  }
  return artifact;
}
