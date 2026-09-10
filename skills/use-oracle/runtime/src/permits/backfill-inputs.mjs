import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import readline from "node:readline";

import { z } from "zod";

const require = createRequire(import.meta.url);
const { ParquetReader } = require("@dsnp/parquetjs");

export const PERMIT_CHECKPOINTS_VERSION =
  "elephant.permit-source-checkpoints.v1";
export const PERMIT_REPAIR_CANDIDATE_VERSION =
  "elephant.permit-repair-candidate.v1";
export const PERMIT_PROPERTY_INPUT_VERSION =
  "elephant.permit-property-input.v1";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const STABLE_ID_PATTERN = /^[a-f0-9]{32}$/;
const KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const dateSchema = z
  .string()
  .regex(DATE_PATTERN)
  .refine((value) => {
    const parsed = Date.parse(`${value}T00:00:00.000Z`);
    return (
      Number.isFinite(parsed) &&
      new Date(parsed).toISOString().slice(0, 10) === value
    );
  }, "Date must be a real YYYY-MM-DD value");
const optionalText = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? null : value,
  z.string().trim().min(1).nullable().optional(),
);

const propertySchema = z
  .object({
    property_id: z.string().regex(STABLE_ID_PATTERN).nullable().optional(),
    propertyId: z.string().regex(STABLE_ID_PATTERN).nullable().optional(),
    parcel_identifier: z.string().trim().min(1).optional(),
    parcelIdentifier: z.string().trim().min(1).optional(),
    address_city: optionalText,
    city: optionalText,
    address_full: optionalText,
    situs_address: optionalText,
    siteAddress: optionalText,
    address_street: optionalText,
    address: optionalText,
  })
  .passthrough()
  .superRefine((value, context) => {
    if (!value.parcel_identifier && !value.parcelIdentifier) {
      context.addIssue({
        code: "custom",
        path: ["parcel_identifier"],
        message: "Property input requires parcel_identifier",
      });
    }
    if (
      !value.address_city &&
      !value.city &&
      !value.address_full &&
      !value.situs_address &&
      !value.siteAddress &&
      !value.address_street &&
      !value.address
    ) {
      context.addIssue({
        code: "custom",
        path: ["address_city"],
        message: "Property input requires city or address routing evidence",
      });
    }
  });

const checkpointSchema = z
  .object({
    jurisdictionKey: z.string().regex(KEY_PATTERN),
    sourceKey: z.string().regex(KEY_PATTERN),
    status: z.enum(["complete", "failed", "blocked"]),
    throughDate: dateSchema,
    profileSha256: z.string().regex(SHA256_PATTERN),
    detailFingerprintVersion: z.string().min(1),
    executionFingerprint: z.string().regex(SHA256_PATTERN),
  })
  .strict();

export const permitSourceCheckpointsSchema = z
  .object({
    schemaVersion: z.literal(PERMIT_CHECKPOINTS_VERSION),
    countyKey: z.string().regex(KEY_PATTERN),
    generatedAt: z.string().datetime({ offset: true }),
    sources: z.array(checkpointSchema),
  })
  .strict()
  .superRefine((value, context) => {
    const keys = value.sources.map(
      (source) => `${source.jurisdictionKey}/${source.sourceKey}`,
    );
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        path: ["sources"],
        message: "Permit source checkpoints must be unique by source",
      });
    }
  });

const repairPropertySchema = z
  .object({
    propertyId: z.string().regex(STABLE_ID_PATTERN).nullable(),
    parcelIdentifier: z.string().trim().min(1),
    city: z.string().trim().min(1).nullable(),
    workAddress: z.string().trim().min(1).nullable(),
  })
  .strict();

export const permitRepairCandidateSchema = z
  .object({
    schemaVersion: z.literal(PERMIT_REPAIR_CANDIDATE_VERSION),
    countyKey: z.string().regex(KEY_PATTERN),
    jurisdictionKey: z.string().regex(KEY_PATTERN),
    sourceKey: z.string().regex(KEY_PATTERN),
    property: repairPropertySchema,
    prior: z
      .object({
        status: z.enum(["done", "failed", "transient", "blocked", "missing"]),
        profileSha256: z.string().regex(SHA256_PATTERN).nullable(),
        detailFingerprintVersion: z.string().min(1).nullable(),
        detailComplete: z.boolean(),
      })
      .strict(),
  })
  .strict();

function normalizedProperty(value) {
  const parsed = propertySchema.parse(value);
  return {
    propertyId: parsed.property_id ?? parsed.propertyId ?? null,
    parcelIdentifier:
      parsed.parcel_identifier ?? parsed.parcelIdentifier,
    city: parsed.address_city ?? parsed.city ?? null,
    workAddress:
      parsed.address_full ??
      parsed.situs_address ??
      parsed.siteAddress ??
      parsed.address_street ??
      parsed.address ??
      null,
  };
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

export function sha256Json(value) {
  return createHash("sha256")
    .update(`${JSON.stringify(canonicalize(value))}\n`)
    .digest("hex");
}

async function requireReadableFile(filePath, label) {
  try {
    await access(filePath);
    const details = await stat(filePath);
    if (!details.isFile()) throw new Error("not a regular file");
    return details;
  } catch (error) {
    throw new Error(
      `${label} must be a readable regular file: ${error.message}`,
    );
  }
}

async function fileDigest(filePath) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest("hex") };
}

async function* jsonLines(filePath, label) {
  const input = createReadStream(filePath, "utf8");
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch (error) {
      throw new Error(
        `${label} contains invalid JSON at line ${lineNumber}: ${error.message}`,
      );
    }
  }
}

export async function* readPermitProperties(filePath) {
  await requireReadableFile(filePath, "Property input");
  if (path.extname(filePath).toLowerCase() === ".parquet") {
    const reader = await ParquetReader.openFile(filePath);
    try {
      const cursor = reader.getCursor();
      while (true) {
        const row = await cursor.next();
        if (row === null) break;
        yield normalizedProperty(row);
      }
    } finally {
      await reader.close();
    }
    return;
  }
  for await (const row of jsonLines(filePath, "Property input")) {
    yield normalizedProperty(row);
  }
}

export async function inspectPropertyInput(filePath) {
  await requireReadableFile(filePath, "Property input");
  let rowCount = 0;
  const identities = new Set();
  for await (const property of readPermitProperties(filePath)) {
    const identity = `${property.propertyId ?? ""}\u0000${property.parcelIdentifier}`;
    if (identities.has(identity)) {
      throw new Error(
        `Property input contains a duplicate identity at row ${rowCount + 1}`,
      );
    }
    identities.add(identity);
    rowCount += 1;
  }
  if (rowCount === 0) throw new Error("Property input must contain at least one row");
  return {
    schemaVersion: PERMIT_PROPERTY_INPUT_VERSION,
    mediaType:
      path.extname(filePath).toLowerCase() === ".parquet"
        ? "application/vnd.apache.parquet"
        : "application/x-ndjson",
    ...(await fileDigest(filePath)),
    rowCount,
  };
}

export async function readPermitCheckpoints(filePath, countyKey) {
  await requireReadableFile(filePath, "Checkpoint input");
  let unvalidated;
  try {
    unvalidated = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Checkpoint input must be valid JSON: ${error.message}`);
  }
  const checkpoints = permitSourceCheckpointsSchema.parse(unvalidated);
  if (checkpoints.countyKey !== countyKey) {
    throw new Error(
      `Checkpoint county ${checkpoints.countyKey} does not match ${countyKey}`,
    );
  }
  return checkpoints;
}

export async function inspectCheckpointInput(filePath, countyKey) {
  const checkpoints = await readPermitCheckpoints(filePath, countyKey);
  return {
    schemaVersion: PERMIT_CHECKPOINTS_VERSION,
    ...(await fileDigest(filePath)),
    sourceCount: checkpoints.sources.length,
  };
}

export async function* readRepairCandidates(filePath, countyKey) {
  await requireReadableFile(filePath, "Repair manifest");
  for await (const value of jsonLines(filePath, "Repair manifest")) {
    const candidate = permitRepairCandidateSchema.parse(value);
    if (candidate.countyKey !== countyKey) {
      throw new Error(
        `Repair candidate county ${candidate.countyKey} does not match ${countyKey}`,
      );
    }
    yield candidate;
  }
}

export function repairSelectionReason(
  candidate,
  { profileSha256, detailFingerprintVersion, requireDetailCompletion },
) {
  if (candidate.prior.status === "blocked") return null;
  if (["missing", "failed", "transient"].includes(candidate.prior.status)) {
    return candidate.prior.status;
  }
  if (candidate.prior.profileSha256 !== profileSha256) {
    return "stale-profile";
  }
  if (
    candidate.prior.detailFingerprintVersion !== detailFingerprintVersion
  ) {
    return "stale-detail-fingerprint";
  }
  if (requireDetailCompletion && !candidate.prior.detailComplete) {
    return "summary-only";
  }
  return null;
}

export async function inspectRepairInput(filePath, countyKey, taskDefinitions) {
  const bySource = new Map(
    taskDefinitions.map((task) => [
      `${task.jurisdictionKey}/${task.sourceKey}`,
      { count: 0, values: [], reasons: {} },
    ]),
  );
  let rowCount = 0;
  const candidateKeys = new Set();
  for await (const candidate of readRepairCandidates(filePath, countyKey)) {
    rowCount += 1;
    const sourceKey = `${candidate.jurisdictionKey}/${candidate.sourceKey}`;
    const selection = bySource.get(sourceKey);
    if (!selection) {
      throw new Error(
        `Repair candidate references non-harvestable source ${sourceKey}`,
      );
    }
    const identity = `${sourceKey}\u0000${candidate.property.propertyId ?? ""}\u0000${candidate.property.parcelIdentifier}`;
    if (candidateKeys.has(identity)) {
      throw new Error(
        `Repair manifest contains a duplicate candidate at row ${rowCount}`,
      );
    }
    candidateKeys.add(identity);
    const task = taskDefinitions.find(
      (value) =>
        value.jurisdictionKey === candidate.jurisdictionKey &&
        value.sourceKey === candidate.sourceKey,
    );
    const reason = repairSelectionReason(candidate, task);
    if (reason === null) continue;
    selection.count += 1;
    selection.reasons[reason] = (selection.reasons[reason] ?? 0) + 1;
    selection.values.push(
      sha256Json({
        jurisdictionKey: candidate.jurisdictionKey,
        sourceKey: candidate.sourceKey,
        property: candidate.property,
        reason,
      }),
    );
  }
  if (rowCount === 0) {
    throw new Error("Repair manifest must contain at least one candidate row");
  }
  return {
    descriptor: {
      schemaVersion: PERMIT_REPAIR_CANDIDATE_VERSION,
      ...(await fileDigest(filePath)),
      rowCount,
    },
    selections: Object.fromEntries(
      [...bySource.entries()].map(([key, value]) => [
        key,
        {
          candidateCount: value.count,
          candidateSha256: sha256Json(value.values.sort()),
          reasons: value.reasons,
        },
      ]),
    ),
  };
}

export async function verifyInputDescriptor(filePath, expected, inspect) {
  const actual = await inspect(filePath);
  if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
    throw new Error("Approved input content does not match the plan digest");
  }
  return actual;
}
