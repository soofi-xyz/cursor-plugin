import {
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { normalizedPermitRecordSchema } from "./contracts.mjs";
import {
  atomicWriteJson,
  fileIntegrity,
  readJson,
  stableArtifactKey,
} from "./storage.mjs";

export const tylerPrivateCaptureSchema = z
  .object({
    schemaVersion: z.literal("elephant.tyler-private-capture.v1"),
    countyKey: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    jurisdictionKey: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    parcelIdentifier: z.string().trim().min(1),
    records: z.array(normalizedPermitRecordSchema).min(1),
  })
  .strict()
  .superRefine((capture, context) => {
    for (const [index, record] of capture.records.entries()) {
      if (
        record.countyKey !== capture.countyKey ||
        record.jurisdictionKey !== capture.jurisdictionKey ||
        record.requestedParcelIdentifier !== capture.parcelIdentifier ||
        record.parcel_identifier !== capture.parcelIdentifier
      ) {
        context.addIssue({
          code: "custom",
          path: ["records", index],
          message: "capture record identity does not match its envelope",
        });
      }
    }
  });

export const permitContactLoadRowSchema = z
  .object({
    schemaVersion: z.literal("elephant.permit-contact-private-load.v1"),
    parentSourceSystem: z.string().trim().min(1),
    parentSourceRecordKey: z.string().trim().min(1),
    sourceSystem: z.string().trim().min(1),
    sourceRecordKey: z.string().trim().min(1),
    contactRole: z.literal("Contractor"),
    companyId: z.null(),
    rawName: z.string().trim().min(1),
    qualifierName: z.string().trim().min(1).nullable(),
    phone: z.string().trim().min(1).nullable(),
    email: z.string().trim().min(1).nullable(),
    licenseNumber: z.string().trim().min(1).nullable(),
    sourcePayload: z.record(z.string(), z.unknown()),
  })
  .strict();

export const tylerPrivateLoadManifestSchema = z
  .object({
    schemaVersion: z.literal(
      "elephant.tyler-private-load-manifest.v1",
    ),
    countyKey: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    jurisdictions: z.array(
      z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    ),
    parcelIdentifiers: z.array(z.string().trim().min(1)),
    permitCount: z.number().int().nonnegative(),
    contractorCount: z.number().int().nonnegative(),
    artifacts: z.array(
      z
        .object({
          path: z.string().trim().min(1),
          bytes: z.number().int().nonnegative(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          rowCount: z.number().int().nonnegative(),
          privacy: z.literal("private"),
        })
        .strict(),
    ),
  })
  .strict();

async function atomicWriteJsonLines(filePath, rows) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(
    temporaryPath,
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
  await rename(temporaryPath, filePath);
  await chmod(filePath, 0o600);
}

export async function writeTylerPrivateCapture(filePath, capture) {
  const parsed = tylerPrivateCaptureSchema.parse(capture);
  await atomicWriteJson(filePath, parsed);
  await chmod(filePath, 0o600);
  return parsed;
}

export async function prepareTylerPrivateLoad({
  capturePaths,
  outputDir,
}) {
  if (!Array.isArray(capturePaths) || capturePaths.length === 0) {
    throw new Error("At least one Tyler private capture is required");
  }
  const captures = await Promise.all(
    capturePaths.map(async (capturePath) =>
      tylerPrivateCaptureSchema.parse(await readJson(capturePath)),
    ),
  );
  const recordsById = new Map();
  for (const capture of captures) {
    for (const record of capture.records) {
      const existing = recordsById.get(record.property_improvement_id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
        throw new Error(
          `Conflicting permit payloads for ${record.property_improvement_id}`,
        );
      }
      recordsById.set(record.property_improvement_id, record);
    }
  }
  const records = [...recordsById.values()].sort((left, right) =>
    left.property_improvement_id.localeCompare(
      right.property_improvement_id,
    ),
  );
  const contacts = records
    .flatMap((record) =>
      record.contractors.map((contractor) =>
        permitContactLoadRowSchema.parse({
          schemaVersion: "elephant.permit-contact-private-load.v1",
          parentSourceSystem: record.source_system,
          parentSourceRecordKey: record.sourceRecordId,
          sourceSystem: record.source_system,
          sourceRecordKey: stableArtifactKey(
            [
              record.sourceRecordId,
              contractor.businessName,
              contractor.licenseNumber,
              contractor.qualifierName,
              contractor.phone,
              contractor.email,
            ].join("\u0000"),
          ),
          contactRole: "Contractor",
          companyId: null,
          rawName: contractor.businessName,
          qualifierName: contractor.qualifierName,
          phone: contractor.phone,
          email: contractor.email,
          licenseNumber: contractor.licenseNumber,
          sourcePayload: {
            qualifierName: contractor.qualifierName,
            sourceRole: contractor.sourceRole ?? null,
            permitNumber: record.permit_number,
            parcelIdentifier: record.parcel_identifier,
          },
        }),
      ),
    )
    .sort((left, right) =>
      left.sourceRecordKey.localeCompare(right.sourceRecordKey),
    );
  const permitPath = path.join(
    outputDir,
    "normalized-permits.private.jsonl",
  );
  const contactPath = path.join(
    outputDir,
    "permit-contacts.private.jsonl",
  );
  await Promise.all([
    atomicWriteJsonLines(permitPath, records),
    atomicWriteJsonLines(contactPath, contacts),
  ]);
  const artifacts = await Promise.all(
    [
      [permitPath, records.length],
      [contactPath, contacts.length],
    ].map(async ([filePath, rowCount]) => ({
      path: path.basename(filePath),
      ...(await fileIntegrity(filePath)),
      rowCount,
      privacy: "private",
    })),
  );
  const manifest = {
    schemaVersion: "elephant.tyler-private-load-manifest.v1",
    countyKey: captures[0].countyKey,
    jurisdictions: [
      ...new Set(captures.map((capture) => capture.jurisdictionKey)),
    ].sort(),
    parcelIdentifiers: [
      ...new Set(captures.map((capture) => capture.parcelIdentifier)),
    ].sort(),
    permitCount: records.length,
    contractorCount: contacts.length,
    artifacts,
  };
  await atomicWriteJson(
    path.join(outputDir, "private-load-manifest.json"),
    manifest,
  );
  await chmod(
    path.join(outputDir, "private-load-manifest.json"),
    0o600,
  );
  return manifest;
}

async function readJsonLines(filePath, schema) {
  const text = await readFile(filePath, "utf8");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => schema.parse(JSON.parse(line)));
}

export async function readTylerPrivateLoadBundle(inputDir) {
  const manifest = tylerPrivateLoadManifestSchema.parse(
    await readJson(path.join(inputDir, "private-load-manifest.json")),
  );
  const expectedArtifacts = new Map([
    [
      "normalized-permits.private.jsonl",
      normalizedPermitRecordSchema,
    ],
    ["permit-contacts.private.jsonl", permitContactLoadRowSchema],
  ]);
  if (
    manifest.artifacts.length !== expectedArtifacts.size ||
    manifest.artifacts.some(
      (artifact) => !expectedArtifacts.has(artifact.path),
    )
  ) {
    throw new Error("Private load manifest has unexpected artifacts");
  }
  const rows = new Map();
  for (const artifact of manifest.artifacts) {
    const filePath = path.join(inputDir, artifact.path);
    const integrity = await fileIntegrity(filePath);
    if (
      integrity.bytes !== artifact.bytes ||
      integrity.sha256 !== artifact.sha256
    ) {
      throw new Error(
        `Private load artifact integrity mismatch: ${artifact.path}`,
      );
    }
    const artifactRows = await readJsonLines(
      filePath,
      expectedArtifacts.get(artifact.path),
    );
    if (artifactRows.length !== artifact.rowCount) {
      throw new Error(
        `Private load artifact row count mismatch: ${artifact.path}`,
      );
    }
    rows.set(artifact.path, artifactRows);
  }
  const permits = rows.get("normalized-permits.private.jsonl");
  const contacts = rows.get("permit-contacts.private.jsonl");
  if (
    permits.length !== manifest.permitCount ||
    contacts.length !== manifest.contractorCount
  ) {
    throw new Error("Private load manifest total count mismatch");
  }
  const parentKeys = new Set(
    permits.map(
      (record) => `${record.source_system}\u0000${record.sourceRecordId}`,
    ),
  );
  for (const contact of contacts) {
    const parentKey =
      `${contact.parentSourceSystem}\u0000${contact.parentSourceRecordKey}`;
    if (!parentKeys.has(parentKey)) {
      throw new Error(
        `Contractor ${contact.sourceRecordKey} has no permit parent`,
      );
    }
  }
  return { manifest, permits, contacts };
}

// Source-neutral aliases retain compatibility with existing Tyler artifacts
// while allowing another certified permit adapter to use the same loader.
export const writePermitPrivateCapture = writeTylerPrivateCapture;
export const preparePermitPrivateLoad = prepareTylerPrivateLoad;
export const readPermitPrivateLoadBundle = readTylerPrivateLoadBundle;
