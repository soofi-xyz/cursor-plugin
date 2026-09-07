import path from "node:path";

import { permitRunManifestSchema } from "./contracts.mjs";
import { writeImmutableJson } from "./storage.mjs";

export async function writePermitRunRevision({
  runDir,
  previous = null,
  state,
  nextAction,
  context = {},
  now = new Date().toISOString(),
}) {
  const revision = (previous?.revision ?? 0) + 1;
  const manifest = permitRunManifestSchema.parse({
    schemaVersion: "elephant.permit-harvest-run.v1",
    revision,
    runId: previous?.runId ?? context.runId,
    countyKey: previous?.countyKey ?? context.countyKey,
    branch: previous?.branch ?? context.branch,
    commitSha: previous?.commitSha ?? context.commitSha,
    profileSha256: previous?.profileSha256 ?? context.profileSha256,
    state,
    sourceCatalogPath:
      previous?.sourceCatalogPath ?? context.sourceCatalogPath,
    sourceCatalogSha256:
      previous?.sourceCatalogSha256 ?? context.sourceCatalogSha256,
    startedAt: previous?.startedAt ?? now,
    updatedAt: now,
    nextAction,
  });
  await writeImmutableJson(
    path.join(
      runDir,
      `run-manifest-r${String(revision).padStart(6, "0")}.json`,
    ),
    manifest,
  );
  return manifest;
}
