import { z } from "zod";

import { permitProfileDigest } from "../counties/permit-profile.mjs";
import {
  inspectCheckpointInput,
  inspectPropertyInput,
  inspectRepairInput,
  readPermitCheckpoints,
  sha256Json,
} from "./backfill-inputs.mjs";
import { assertPermitProfileReady } from "./readiness.mjs";

export const PERMIT_BACKFILL_PLAN_VERSION =
  "elephant.permit-backfill-plan.v2";

const optionsSchema = z
  .object({
    mode: z.enum(["delta", "repair"]),
    throughDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    initialFromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    propertiesPath: z.string().min(1).nullable(),
    manifestPath: z.string().min(1).nullable(),
    checkpointsPath: z.string().min(1).nullable(),
    jurisdictionKeys: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .superRefine((options, context) => {
    if (options.mode === "delta" && !options.throughDate) {
      context.addIssue({
        code: "custom",
        path: ["throughDate"],
        message: "Delta plans require throughDate",
      });
    }
    if (options.mode === "delta" && !options.propertiesPath) {
      context.addIssue({
        code: "custom",
        path: ["propertiesPath"],
        message: "Delta plans require a property input path",
      });
    }
    if (options.mode === "delta" && !options.checkpointsPath) {
      context.addIssue({
        code: "custom",
        path: ["checkpointsPath"],
        message: "Delta plans require a source checkpoint input path",
      });
    }
    if (options.mode === "repair" && !options.manifestPath) {
      context.addIssue({
        code: "custom",
        path: ["manifestPath"],
        message: "Repair plans require an artifact manifest path",
      });
    }
  });

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const inputDescriptorSchema = z
  .object({
    schemaVersion: z.string().min(1),
    sha256: z.string().regex(SHA256_PATTERN),
    bytes: z.number().int().nonnegative(),
  })
  .passthrough();

const taskSchema = z
  .object({
    taskId: z.string().regex(/^[a-f0-9]{32}$/),
    idempotencyKey: z.string().regex(SHA256_PATTERN),
    executionFingerprint: z.string().regex(SHA256_PATTERN),
    jurisdictionKey: z.string().regex(KEY_PATTERN),
    sourceKey: z.string().regex(KEY_PATTERN),
    adapterRouteKey: z.string().regex(KEY_PATTERN),
    adapterKey: z.string().regex(KEY_PATTERN),
    strategy: z.enum(["bounded-source-enumeration", "property-first"]),
    detailFingerprintVersion: z.string().min(1),
    requireDetailCompletion: z.boolean(),
    runClass: z.enum(["delta", "initial-bounded-backfill", "repair"]),
    window: z
      .object({
        fromDate: z.string().regex(DATE_PATTERN),
        throughDate: z.string().regex(DATE_PATTERN),
        checkpointThroughDate: z.string().regex(DATE_PATTERN).nullable(),
      })
      .strict()
      .nullable(),
    repairSelection: z
      .object({
        candidateCount: z.number().int().nonnegative(),
        candidateSha256: z.string().regex(SHA256_PATTERN),
        reasons: z.record(z.string(), z.number().int().nonnegative()),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const permitBackfillPlanSchema = z
  .object({
    schemaVersion: z.literal(PERMIT_BACKFILL_PLAN_VERSION),
    countyKey: z.string().regex(KEY_PATTERN),
    profileSha256: z.string().regex(SHA256_PATTERN),
    mode: z.enum(["delta", "repair"]),
    throughDate: z.string().regex(DATE_PATTERN).nullable(),
    inputs: z
      .object({
        properties: inputDescriptorSchema.nullable(),
        repairManifest: inputDescriptorSchema.nullable(),
        checkpoints: inputDescriptorSchema.nullable(),
      })
      .strict(),
    readiness: z
      .object({
        jurisdictionCount: z.number().int().positive(),
        harvestableSourceCount: z.number().int().positive(),
        blockedSourceCount: z.number().int().nonnegative(),
      })
      .strict(),
    approval: z
      .object({
        approvedPlanDigestRequired: z.literal(true),
        initialBackfillApprovalRequired: z.boolean(),
        initialBackfillTaskIds: z.array(z.string().regex(/^[a-f0-9]{32}$/)),
      })
      .strict(),
    tasks: z.array(taskSchema).min(1),
    excludedSources: z.array(
      z
        .object({
          jurisdictionKey: z.string().regex(KEY_PATTERN),
          sourceKey: z.string().regex(KEY_PATTERN),
          blockerType: z.string().min(1),
        })
        .strict(),
    ),
    writePolicy: z.literal(
      "artifact-only; no database, publication, or destructive writes",
    ),
    planDigest: z.string().regex(SHA256_PATTERN),
  })
  .strict();

function parseDate(value, label) {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(date.valueOf()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${label} must be a real YYYY-MM-DD date`);
  }
  return date;
}

function previousDate(value) {
  const date = parseDate(value, "Checkpoint date");
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function adapterRoute(jurisdiction, source) {
  if (source.adapterRouteKey === null) return null;
  if (!source.adapterRouteKey || source.adapterRouteKey === "primary") {
    return {
      key: "primary",
      adapterKey: jurisdiction.adapterKey,
      adapterConfig: jurisdiction.adapterConfig,
    };
  }
  return jurisdiction.adapterRoutes.find(
    (route) => route.key === source.adapterRouteKey,
  );
}

export function harvestablePermitSources(profile, jurisdictionKeys = []) {
  const selected = new Set(jurisdictionKeys);
  const unknown = [...selected].filter(
    (key) =>
      !profile.jurisdictions.some(
        (jurisdiction) => jurisdiction.key === key,
      ),
  );
  if (unknown.length) {
    throw new Error(`Unknown permit jurisdictions: ${unknown.join(", ")}`);
  }
  return profile.jurisdictions
    .filter(
      (jurisdiction) =>
        jurisdiction.status === "supported" &&
        (selected.size === 0 || selected.has(jurisdiction.key)),
    )
    .flatMap((jurisdiction) =>
      jurisdiction.sources
        .filter(
          (source) =>
            source.access === "public" &&
            ["certified", "bounded-only"].includes(
              source.enumerationStatus,
            ),
        )
        .map((source) => {
          const route = adapterRoute(jurisdiction, source);
          if (!route) {
            throw new Error(
              `Harvestable source ${jurisdiction.key}/${source.key} has no adapter route`,
            );
          }
          return {
            jurisdiction,
            source,
            route,
            jurisdictionKey: jurisdiction.key,
            sourceKey: source.key,
            adapterRouteKey: route.key,
            adapterKey: route.adapterKey,
            detailFingerprintVersion:
              route.adapterConfig.detailFingerprintVersion,
            requireDetailCompletion:
              source.contractorDetailCapability === "public-detail",
          };
        }),
    )
    .sort((left, right) =>
      `${left.jurisdictionKey}/${left.sourceKey}`.localeCompare(
        `${right.jurisdictionKey}/${right.sourceKey}`,
      ),
    );
}

function planDigest(value) {
  const { planDigest: ignored, ...body } = value;
  return sha256Json(body);
}

export function validatePermitBackfillPlan(value) {
  const plan = permitBackfillPlanSchema.parse(value);
  if (planDigest(plan) !== plan.planDigest) {
    throw new Error("Permit backfill plan digest mismatch");
  }
  const taskIds = plan.tasks.map((task) => task.taskId);
  if (new Set(taskIds).size !== taskIds.length) {
    throw new Error("Permit backfill plan contains duplicate task IDs");
  }
  return plan;
}

export async function createPermitBackfillPlan(profile, rawOptions) {
  const options = optionsSchema.parse(rawOptions);
  const readiness = assertPermitProfileReady(profile);
  const profileSha256 = permitProfileDigest(profile);
  const definitions = harvestablePermitSources(
    profile,
    options.jurisdictionKeys,
  );
  let properties = null;
  let repairManifest = null;
  let checkpointsDescriptor = null;
  let checkpoints = null;
  let repairSelections = null;
  if (options.mode === "delta") {
    parseDate(options.throughDate, "Through date");
    if (options.initialFromDate) {
      parseDate(options.initialFromDate, "Initial backfill start date");
      if (options.initialFromDate > options.throughDate) {
        throw new Error(
          "Initial backfill start date must not follow through date",
        );
      }
    }
    [properties, checkpointsDescriptor, checkpoints] = await Promise.all([
      inspectPropertyInput(options.propertiesPath),
      inspectCheckpointInput(options.checkpointsPath, profile.countyKey),
      readPermitCheckpoints(options.checkpointsPath, profile.countyKey),
    ]);
  } else {
    const inspected = await inspectRepairInput(
      options.manifestPath,
      profile.countyKey,
      definitions.map((definition) => ({
        jurisdictionKey: definition.jurisdictionKey,
        sourceKey: definition.sourceKey,
        profileSha256,
        detailFingerprintVersion:
          definition.detailFingerprintVersion,
        requireDetailCompletion:
          definition.requireDetailCompletion,
      })),
    );
    repairManifest = inspected.descriptor;
    repairSelections = inspected.selections;
  }

  const checkpointBySource = new Map(
    (checkpoints?.sources ?? []).map((checkpoint) => [
      `${checkpoint.jurisdictionKey}/${checkpoint.sourceKey}`,
      checkpoint,
    ]),
  );
  const tasks = definitions.map((definition) => {
    const sourceIdentity = `${definition.jurisdictionKey}/${definition.sourceKey}`;
    const checkpoint = checkpointBySource.get(sourceIdentity);
    const validCheckpoint =
      checkpoint?.status === "complete" &&
      checkpoint.profileSha256 === profileSha256 &&
      checkpoint.detailFingerprintVersion ===
        definition.detailFingerprintVersion;
    if (
      validCheckpoint &&
      checkpoint.throughDate > options.throughDate
    ) {
      throw new Error(
        `Checkpoint for ${sourceIdentity} is newer than the requested through date`,
      );
    }
    const runClass =
      options.mode === "repair"
        ? "repair"
        : validCheckpoint
          ? "delta"
          : "initial-bounded-backfill";
    if (
      runClass === "initial-bounded-backfill" &&
      !options.initialFromDate
    ) {
      throw new Error(
        `Source ${sourceIdentity} has no compatible successful checkpoint; provide --initial-from for an explicitly approved bounded backfill`,
      );
    }
    const window =
      options.mode === "delta"
        ? {
            fromDate: validCheckpoint
              ? previousDate(checkpoint.throughDate)
              : options.initialFromDate,
            throughDate: options.throughDate,
            checkpointThroughDate: validCheckpoint
              ? checkpoint.throughDate
              : null,
          }
        : null;
    const repairSelection =
      options.mode === "repair"
        ? repairSelections[sourceIdentity]
        : null;
    const fingerprintInput = {
      countyKey: profile.countyKey,
      profileSha256,
      mode: options.mode,
      runClass,
      jurisdictionKey: definition.jurisdictionKey,
      sourceKey: definition.sourceKey,
      adapterRouteKey: definition.adapterRouteKey,
      adapterKey: definition.adapterKey,
      detailFingerprintVersion:
        definition.detailFingerprintVersion,
      requireDetailCompletion:
        definition.requireDetailCompletion,
      window,
      propertiesSha256: properties?.sha256 ?? null,
      repairManifestSha256: repairManifest?.sha256 ?? null,
      checkpointsSha256: checkpointsDescriptor?.sha256 ?? null,
      repairSelection,
    };
    const executionFingerprint = sha256Json(fingerprintInput);
    return {
      taskId: sha256Json({
        countyKey: profile.countyKey,
        jurisdictionKey: definition.jurisdictionKey,
        sourceKey: definition.sourceKey,
        mode: options.mode,
      }).slice(0, 32),
      idempotencyKey: sha256Json({
        type: "permit-backfill",
        executionFingerprint,
      }),
      executionFingerprint,
      jurisdictionKey: definition.jurisdictionKey,
      sourceKey: definition.sourceKey,
      adapterRouteKey: definition.adapterRouteKey,
      adapterKey: definition.adapterKey,
      strategy:
        definition.source.role === "daily-bulk-export" ||
        definition.adapterKey === "arcgis-feature-service"
          ? "bounded-source-enumeration"
          : "property-first",
      detailFingerprintVersion:
        definition.detailFingerprintVersion,
      requireDetailCompletion:
        definition.requireDetailCompletion,
      runClass,
      window,
      repairSelection,
    };
  });
  const initialBackfillTaskIds = tasks
    .filter((task) => task.runClass === "initial-bounded-backfill")
    .map((task) => task.taskId);
  const excludedSources = profile.jurisdictions
    .flatMap((jurisdiction) =>
      jurisdiction.sources.map((source) => ({ jurisdiction, source })),
    )
    .filter(
      ({ source }) =>
        source.access !== "public" ||
        source.enumerationStatus === "blocked",
    )
    .map(({ jurisdiction, source }) => ({
      jurisdictionKey: jurisdiction.key,
      sourceKey: source.key,
      blockerType: source.blockerType,
    }))
    .sort((left, right) =>
      `${left.jurisdictionKey}/${left.sourceKey}`.localeCompare(
        `${right.jurisdictionKey}/${right.sourceKey}`,
      ),
    );

  const plan = {
    schemaVersion: PERMIT_BACKFILL_PLAN_VERSION,
    countyKey: profile.countyKey,
    profileSha256,
    mode: options.mode,
    throughDate: options.throughDate,
    inputs: {
      properties,
      repairManifest,
      checkpoints: checkpointsDescriptor,
    },
    approval: {
      approvedPlanDigestRequired: true,
      initialBackfillApprovalRequired:
        initialBackfillTaskIds.length > 0,
      initialBackfillTaskIds,
    },
    writePolicy:
      "artifact-only; no database, publication, or destructive writes",
    readiness: {
      jurisdictionCount: readiness.jurisdictionCount,
      harvestableSourceCount: readiness.harvestableSourceCount,
      blockedSourceCount: readiness.blockedSourceCount,
    },
    tasks,
    excludedSources,
  };
  return validatePermitBackfillPlan({
    ...plan,
    planDigest: planDigest(plan),
  });
}
