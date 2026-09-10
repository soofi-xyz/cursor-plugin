import { createPermitAdapterForSource } from "./adapters/index.mjs";
import {
  inspectCheckpointInput,
  inspectPropertyInput,
  inspectRepairInput,
  readPermitCheckpoints,
  readPermitProperties,
  readRepairCandidates,
  repairSelectionReason,
  sha256Json,
  verifyInputDescriptor,
} from "./backfill-inputs.mjs";
import {
  harvestablePermitSources,
  validatePermitBackfillPlan,
} from "./backfill-plan.mjs";
import {
  normalizedPermitRecordSchema,
} from "./contracts.mjs";
import { classifyPermitError, PermitSourceError } from "./errors.mjs";
import {
  normalizePermitParcelIdentifier,
  routePermitJurisdiction,
} from "./normalization.mjs";
import { permitProfileDigest } from "../counties/permit-profile.mjs";

function sourceFingerprint(plan, task) {
  return sha256Json({
    countyKey: plan.countyKey,
    profileSha256: plan.profileSha256,
    jurisdictionKey: task.jurisdictionKey,
    sourceKey: task.sourceKey,
    detailFingerprintVersion: task.detailFingerprintVersion,
    requireDetailCompletion: task.requireDetailCompletion,
  });
}

function candidateKey(task, property) {
  return [
    task.jurisdictionKey,
    task.sourceKey,
    property.propertyId ?? "",
    property.parcelIdentifier,
  ].join("\u0000");
}

function completionFingerprint(task, property) {
  return sha256Json({
    executionFingerprint: task.executionFingerprint,
    property,
    requireDetailCompletion: task.requireDetailCompletion,
  });
}

export function resumableReceiptDecision(
  receipt,
  {
    completionFingerprint: expectedCompletion,
    sourceFingerprint: expectedSource,
    requireDetailCompletion,
  },
) {
  if (!receipt) return "retry";
  if (
    receipt.status === "done" &&
    receipt.completionFingerprint === expectedCompletion &&
    (!requireDetailCompletion || receipt.detailComplete === true)
  ) {
    return "completed";
  }
  if (
    receipt.status === "blocked" &&
    receipt.sourceFingerprint === expectedSource
  ) {
    return "blocked";
  }
  return "retry";
}

function recordInWindow(record, window) {
  if (!window) return true;
  const dates = [
    record.permit_issue_date,
    record.application_received_date,
    record.opened_date,
    record.completion_date,
  ].filter(Boolean);
  if (dates.length === 0) return true;
  return dates.some(
    (value) =>
      value >= window.fromDate && value <= window.throughDate,
  );
}

async function mapConcurrent(values, concurrency, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, Math.max(values.length, 1)) },
      () => worker(),
    ),
  );
  return results;
}

async function* deltaCandidates(filePath, profile, task) {
  for await (const property of readPermitProperties(filePath)) {
    const jurisdiction = routePermitJurisdiction(
      profile,
      property.city ?? property.workAddress,
    );
    if (jurisdiction?.key !== task.jurisdictionKey) continue;
    yield {
      ...property,
      parcelIdentifier: normalizePermitParcelIdentifier(
        profile,
        property.parcelIdentifier,
      ),
    };
  }
}

async function* repairCandidates(filePath, profile, plan, task) {
  for await (const candidate of readRepairCandidates(
    filePath,
    profile.countyKey,
  )) {
    if (
      candidate.jurisdictionKey !== task.jurisdictionKey ||
      candidate.sourceKey !== task.sourceKey
    ) {
      continue;
    }
    const reason = repairSelectionReason(candidate, {
      profileSha256: plan.profileSha256,
      detailFingerprintVersion: task.detailFingerprintVersion,
      requireDetailCompletion: task.requireDetailCompletion,
    });
    if (reason === null) continue;
    yield {
      ...candidate.property,
      parcelIdentifier: normalizePermitParcelIdentifier(
        profile,
        candidate.property.parcelIdentifier,
      ),
      repairReason: reason,
    };
  }
}

async function processPropertyCandidate({
  adapter,
  plan,
  task,
  property,
  state,
}) {
  const workKey = candidateKey(task, property);
  const expectedCompletion = completionFingerprint(task, property);
  const expectedSource = sourceFingerprint(plan, task);
  const previous = await state.readWork(task.taskId, workKey);
  const resumeDecision = resumableReceiptDecision(previous, {
    completionFingerprint: expectedCompletion,
    sourceFingerprint: expectedSource,
    requireDetailCompletion: task.requireDetailCompletion,
  });
  if (resumeDecision === "completed") {
    return { status: "done", resumed: true, blockedPreserved: false };
  }
  if (resumeDecision === "blocked") {
    return { status: "blocked", resumed: true, blockedPreserved: true };
  }

  const records = [];
  try {
    const search = await adapter.searchParcel(property.parcelIdentifier, {
      requestedPropertyId: property.propertyId,
      workAddress: property.workAddress,
      fromDate: task.window?.fromDate ?? null,
      throughDate: task.window?.throughDate ?? null,
    });
    const references = Array.isArray(search) ? search : search.references;
    if (!Array.isArray(references)) {
      throw new PermitSourceError(
        "Permit adapter returned no reference list",
        {
          classification: "permanent",
          code: "permit_reference_contract_invalid",
        },
      );
    }
    if (search.reconciliation?.truncated === true) {
      throw new PermitSourceError(
        "Permit source search was capped or truncated",
        {
          classification: "permanent",
          code: "permit_source_reconciliation_failed",
        },
      );
    }
    const referenceKeys = new Set();
    for (const reference of references) {
      const referenceKey =
        reference.sourceRecordId ?? sha256Json(reference);
      if (referenceKeys.has(referenceKey)) continue;
      referenceKeys.add(referenceKey);
      const record = normalizedPermitRecordSchema.parse(
        await adapter.fetchPermitDetail(reference, {
          requestedParcelIdentifier: property.parcelIdentifier,
          requestedPropertyId: property.propertyId,
        }),
      );
      if (recordInWindow(record, task.window)) records.push(record);
    }
    await state.commitRecords(records, task.executionFingerprint);
    await state.commitWork(task.taskId, workKey, {
      status: "done",
      sourceFingerprint: expectedSource,
      completionFingerprint: expectedCompletion,
      detailComplete: true,
      permitIds: records.map(
        (record) => record.property_improvement_id,
      ),
      completedAt: new Date().toISOString(),
      failure: null,
    });
    return {
      status: "done",
      resumed: false,
      blockedPreserved: false,
      recordCount: records.length,
    };
  } catch (error) {
    const classified = classifyPermitError(error);
    const status =
      classified.classification === "blocked" ? "blocked" : "failed";
    await state.commitWork(task.taskId, workKey, {
      status,
      sourceFingerprint: expectedSource,
      completionFingerprint: expectedCompletion,
      detailComplete: false,
      permitIds: records.map(
        (record) => record.property_improvement_id,
      ),
      completedAt: new Date().toISOString(),
      failure: {
        classification: classified.classification,
        code: classified.code,
        message: classified.message,
      },
    });
    return {
      status,
      resumed: false,
      blockedPreserved: false,
      recordCount: records.length,
    };
  }
}

async function executePropertyTask({
  adapter,
  candidates,
  plan,
  task,
  state,
  concurrency,
}) {
  const counters = {
    candidateCount: 0,
    doneCount: 0,
    failedCount: 0,
    blockedCount: 0,
    resumedCount: 0,
    blockedPreservedCount: 0,
    recordCount: 0,
  };
  let batch = [];
  async function flush() {
    if (batch.length === 0) return;
    const results = await mapConcurrent(batch, concurrency, (property) =>
      processPropertyCandidate({
        adapter,
        plan,
        task,
        property,
        state,
      }),
    );
    for (const result of results) {
      counters[`${result.status}Count`] += 1;
      if (result.resumed) counters.resumedCount += 1;
      if (result.blockedPreserved) counters.blockedPreservedCount += 1;
      counters.recordCount += result.recordCount ?? 0;
    }
    await state.commitCheckpoint(task.taskId, "progress", {
      status: "running",
      executionFingerprint: task.executionFingerprint,
      counters,
      updatedAt: new Date().toISOString(),
    });
    batch = [];
  }
  for await (const property of candidates) {
    counters.candidateCount += 1;
    batch.push(property);
    if (batch.length >= concurrency) await flush();
  }
  await flush();
  return {
    ...counters,
    status:
      counters.failedCount > 0
        ? "failed"
        : counters.blockedCount > 0
          ? "blocked"
          : counters.candidateCount === 0
            ? "no-candidates"
            : "complete",
  };
}

async function executeArcgisTask({
  adapter,
  task,
  state,
  pageConcurrency,
}) {
  if (typeof adapter.enumerateAll !== "function") {
    throw new Error(
      `${task.jurisdictionKey}/${task.sourceKey} does not support full enumeration`,
    );
  }
  const result = await adapter.enumerateAll({
    fromDate: task.window?.fromDate ?? null,
    throughDate: task.window?.throughDate ?? null,
    pageConcurrency,
    loadPageCheckpoint: async (page) => {
      const checkpoint = await state.readCheckpoint(
        task.taskId,
        page.pageKey,
      );
      return checkpoint?.executionFingerprint ===
        task.executionFingerprint
        ? checkpoint
        : null;
    },
    onPage: async (page) => {
      await state.commitCheckpoint(task.taskId, page.pageKey, {
        status: "complete",
        executionFingerprint: task.executionFingerprint,
        snapshotSha256: page.snapshotSha256,
        objectIdsSha256: page.objectIdsSha256,
        receivedCount: page.receivedCount,
        records: page.records,
      });
    },
  });
  let committedRecords = 0;
  for (let index = 0; index < result.pageCount; index += 1) {
    const pageKey = `page-${String(index + 1).padStart(6, "0")}`;
    const checkpoint = await state.readCheckpoint(task.taskId, pageKey);
    if (
      checkpoint?.status !== "complete" ||
      checkpoint.executionFingerprint !== task.executionFingerprint ||
      checkpoint.snapshotSha256 !== result.snapshotSha256 ||
      checkpoint.records?.length !== checkpoint.receivedCount
    ) {
      throw new Error(
        `ArcGIS checkpoint ${pageKey} is incompatible after reconciliation`,
      );
    }
    await state.commitRecords(
      checkpoint.records,
      task.executionFingerprint,
    );
    committedRecords += checkpoint.records.length;
  }
  if (committedRecords !== result.receivedCount) {
    throw new Error("ArcGIS committed record count failed reconciliation");
  }
  return {
    status: "complete",
    candidateCount: result.sourceCount,
    doneCount: result.receivedCount,
    failedCount: 0,
    blockedCount: 0,
    resumedCount: result.resumedPageCount,
    blockedPreservedCount: 0,
    recordCount: committedRecords,
    reconciliation: result,
  };
}

function assertPlanMatchesProfile(plan, profile) {
  if (
    plan.countyKey !== profile.countyKey ||
    plan.profileSha256 !== permitProfileDigest(profile)
  ) {
    throw new Error("Permit plan does not match the current county profile");
  }
  const jurisdictions = [
    ...new Set(plan.tasks.map((task) => task.jurisdictionKey)),
  ];
  const expected = harvestablePermitSources(profile, jurisdictions).map(
    (source) => `${source.jurisdictionKey}/${source.sourceKey}`,
  );
  const actual = plan.tasks.map(
    (task) => `${task.jurisdictionKey}/${task.sourceKey}`,
  );
  if (
    expected.length !== actual.length ||
    expected.some((value, index) => value !== actual[index])
  ) {
    throw new Error(
      "Permit plan task inventory does not match harvestable profile routes",
    );
  }
}

async function verifyExecutionInputs({
  plan,
  profile,
  propertiesPath,
  manifestPath,
  checkpointsPath,
}) {
  if (plan.mode === "delta") {
    if (!propertiesPath || !checkpointsPath || manifestPath) {
      throw new Error(
        "Delta execution requires only --properties and --checkpoints inputs",
      );
    }
    await Promise.all([
      verifyInputDescriptor(
        propertiesPath,
        plan.inputs.properties,
        inspectPropertyInput,
      ),
      verifyInputDescriptor(
        checkpointsPath,
        plan.inputs.checkpoints,
        (filePath) =>
          inspectCheckpointInput(filePath, profile.countyKey),
      ),
    ]);
    return;
  }
  if (!manifestPath || propertiesPath || checkpointsPath) {
    throw new Error("Repair execution requires only --manifest input");
  }
  const definitions = plan.tasks.map((task) => ({
    jurisdictionKey: task.jurisdictionKey,
    sourceKey: task.sourceKey,
    profileSha256: plan.profileSha256,
    detailFingerprintVersion: task.detailFingerprintVersion,
    requireDetailCompletion: task.requireDetailCompletion,
  }));
  const actual = await inspectRepairInput(
    manifestPath,
    profile.countyKey,
    definitions,
  );
  if (
    actual.descriptor.sha256 !== plan.inputs.repairManifest.sha256 ||
    actual.descriptor.bytes !== plan.inputs.repairManifest.bytes
  ) {
    throw new Error("Approved repair manifest does not match the plan digest");
  }
  for (const task of plan.tasks) {
    const key = `${task.jurisdictionKey}/${task.sourceKey}`;
    if (
      sha256Json(actual.selections[key]) !==
      sha256Json(task.repairSelection)
    ) {
      throw new Error(`Repair selection changed for ${key}`);
    }
  }
}

export async function executePermitBackfillPlan({
  rawPlan,
  approvedPlanDigest,
  profile,
  propertiesPath = null,
  manifestPath = null,
  checkpointsPath = null,
  approveInitialBackfill = false,
  state,
  concurrency = 1,
  pageConcurrency = 1,
  adapterFactory = createPermitAdapterForSource,
  clock = Date.now,
}) {
  const plan = validatePermitBackfillPlan(rawPlan);
  if (approvedPlanDigest !== plan.planDigest) {
    throw new Error(
      "Execution requires the exact independently approved plan digest",
    );
  }
  if (
    plan.approval.initialBackfillApprovalRequired &&
    !approveInitialBackfill
  ) {
    throw new Error(
      "Initial bounded backfill tasks require --approve-initial-backfill",
    );
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw new Error("Backfill concurrency must be between 1 and 4");
  }
  if (
    !Number.isInteger(pageConcurrency) ||
    pageConcurrency < 1 ||
    pageConcurrency > 4
  ) {
    throw new Error("ArcGIS page concurrency must be between 1 and 4");
  }
  assertPlanMatchesProfile(plan, profile);
  await verifyExecutionInputs({
    plan,
    profile,
    propertiesPath,
    manifestPath,
    checkpointsPath,
  });
  await state.bindPlan(plan);

  const definitions = new Map(
    harvestablePermitSources(
      profile,
      [...new Set(plan.tasks.map((task) => task.jurisdictionKey))],
    ).map((definition) => [
      `${definition.jurisdictionKey}/${definition.sourceKey}`,
      definition,
    ]),
  );
  const taskResults = [];
  for (const task of plan.tasks) {
    const definition = definitions.get(
      `${task.jurisdictionKey}/${task.sourceKey}`,
    );
    const adapter = adapterFactory(
      definition.jurisdiction,
      definition.source,
    );
    if (!adapter) {
      throw new Error(
        `Approved task ${task.jurisdictionKey}/${task.sourceKey} has no adapter`,
      );
    }
    try {
      let result;
      if (task.strategy === "bounded-source-enumeration") {
        if (
          plan.mode === "repair" &&
          task.repairSelection.candidateCount === 0
        ) {
          result = {
            status: "no-candidates",
            candidateCount: 0,
            doneCount: 0,
            failedCount: 0,
            blockedCount: 0,
            resumedCount: 0,
            blockedPreservedCount: 0,
            recordCount: 0,
          };
        } else {
          result = await executeArcgisTask({
            adapter,
            task,
            state,
            pageConcurrency,
          });
        }
      } else {
        const candidates =
          plan.mode === "delta"
            ? deltaCandidates(propertiesPath, profile, task)
            : repairCandidates(
                manifestPath,
                profile,
                plan,
                task,
              );
        result = await executePropertyTask({
          adapter,
          candidates,
          plan,
          task,
          state,
          concurrency,
        });
      }
      taskResults.push({
        taskId: task.taskId,
        jurisdictionKey: task.jurisdictionKey,
        sourceKey: task.sourceKey,
        executionFingerprint: task.executionFingerprint,
        runClass: task.runClass,
        window: task.window,
        ...result,
      });
      await state.commitCheckpoint(task.taskId, "task-summary", {
        status: result.status,
        executionFingerprint: task.executionFingerprint,
        result,
        updatedAt: new Date(clock()).toISOString(),
      });
    } finally {
      await adapter.close?.();
    }
  }
  const completedAt = new Date(clock()).toISOString();
  const sourceCheckpoints = new Map(
    (
      plan.mode === "delta"
        ? (await readPermitCheckpoints(
            checkpointsPath,
            plan.countyKey,
          )).sources
        : []
    ).map((checkpoint) => [
      `${checkpoint.jurisdictionKey}/${checkpoint.sourceKey}`,
      checkpoint,
    ]),
  );
  for (const result of taskResults.filter(
    (taskResult) =>
      plan.mode === "delta" && taskResult.status === "complete",
  )) {
      const task = plan.tasks.find(
        (candidate) => candidate.taskId === result.taskId,
      );
      sourceCheckpoints.set(
        `${result.jurisdictionKey}/${result.sourceKey}`,
        {
        jurisdictionKey: result.jurisdictionKey,
        sourceKey: result.sourceKey,
        status: "complete",
        throughDate: task.window.throughDate,
        profileSha256: plan.profileSha256,
        detailFingerprintVersion: task.detailFingerprintVersion,
        executionFingerprint: task.executionFingerprint,
        },
      );
  }
  await state.commitArtifact("source-checkpoints.json", {
    schemaVersion: "elephant.permit-source-checkpoints.v1",
    countyKey: plan.countyKey,
    generatedAt: completedAt,
    sources: [...sourceCheckpoints.values()].sort((left, right) =>
      `${left.jurisdictionKey}/${left.sourceKey}`.localeCompare(
        `${right.jurisdictionKey}/${right.sourceKey}`,
      ),
    ),
  });
  const summary = await state.commitSummary({
    schemaVersion: "elephant.permit-backfill-execution.v1",
    countyKey: plan.countyKey,
    planDigest: plan.planDigest,
    completedAt,
    status: taskResults.some((result) => result.status === "failed")
      ? "failed"
      : taskResults.some((result) => result.status === "blocked")
        ? "blocked"
        : "complete",
    taskCount: taskResults.length,
    excludedBlockedSourceCount: plan.excludedSources.length,
    stablePermitRecordCount: await state.recordCount(),
    taskResults,
    databaseWritesPerformed: false,
    publicationPerformed: false,
  });
  return summary;
}
