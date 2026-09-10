#!/usr/bin/env node

import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { browardPermitProfile } from "../src/counties/broward/permit-profile.mjs";
import { createPermitAdapterForSource } from "../src/permits/adapters/index.mjs";

function parseArguments(argv) {
  const allowed = new Set([
    "--jurisdiction",
    "--source",
    "--parcel",
    "--address",
    "--permit",
    "--limit",
    "--output",
  ]);
  const values = new Map();
  const permitNumbers = [];
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error("Every probe option must be a --key value pair");
    }
    if (!allowed.has(key)) throw new Error(`Unknown probe option "${key}"`);
    if (key === "--permit") permitNumbers.push(value.trim().toUpperCase());
    else values.set(key, value);
  }
  return { values, permitNumbers: [...new Set(permitNumbers)] };
}

function assertPrivateOutputPath(outputPath) {
  if (!outputPath) return;
  const segments = path.resolve(outputPath).split(path.sep);
  if (
    !segments.some((segment) =>
      ["downloads", "private", ".private"].includes(segment),
    )
  ) {
    throw new Error(
      "Output path must be under a downloads, private, or .private directory",
    );
  }
}

async function requireAbsent(filePath) {
  if (!filePath) return;
  try {
    await access(filePath);
    throw new Error(`Output already exists: ${filePath}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

const { values: args, permitNumbers: requestedPermitNumbers } =
  parseArguments(process.argv.slice(2));
const jurisdictionKey = args.get("--jurisdiction");
const sourceKey = args.get("--source");
const parcelIdentifier = args.get("--parcel") ?? null;
const workAddress = args.get("--address") ?? null;
const outputPath = args.get("--output") ?? null;
const limit = Number(args.get("--limit") ?? "3");
if (!jurisdictionKey || !sourceKey) {
  throw new Error("--jurisdiction and --source are required");
}
if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
  throw new Error("--limit must be an integer from 1 through 10");
}
assertPrivateOutputPath(outputPath);
if (outputPath) await mkdir(path.dirname(outputPath), { recursive: true });
await requireAbsent(outputPath);

const jurisdiction = browardPermitProfile.jurisdictions.find(
  (candidate) => candidate.key === jurisdictionKey,
);
if (!jurisdiction) throw new Error(`Unknown jurisdiction "${jurisdictionKey}"`);
const source = jurisdiction.sources.find(
  (candidate) => candidate.key === sourceKey,
);
if (!source) throw new Error(`Unknown source "${sourceKey}"`);
if (
  source.access !== "public" ||
  !["certified", "bounded-only"].includes(source.enumerationStatus)
) {
  throw new Error(
    `Source "${sourceKey}" is explicitly blocked and cannot be probed`,
  );
}

const adapter = createPermitAdapterForSource(jurisdiction, source);
try {
  const probe = await adapter.probe();
  let records = [];
  let reconciliation = null;
  if (parcelIdentifier) {
    const search = await adapter.searchParcel(parcelIdentifier, {
      requestedPropertyId: null,
      workAddress,
    });
    const references = Array.isArray(search) ? search : search.references;
    reconciliation = search.reconciliation ?? {
      extracted: references.length,
    };
    const referencesByPermit = new Map(
      references.map((reference) => [
        reference.permitNumber.toUpperCase(),
        reference,
      ]),
    );
    const selectedReferences = requestedPermitNumbers.length
      ? requestedPermitNumbers.map((permitNumber) => {
          const reference = referencesByPermit.get(permitNumber);
          if (!reference) {
            throw new Error(
              `Requested permit ${permitNumber} is absent from the reconciled parcel search`,
            );
          }
          return reference;
        })
      : references.slice(0, limit);
    for (const reference of selectedReferences) {
      records.push(
        await adapter.fetchPermitDetail(reference, {
          requestedParcelIdentifier: parcelIdentifier,
          requestedPropertyId: null,
        }),
      );
    }
    reconciliation = {
      ...reconciliation,
      enumeratedPermitNumbers: references.map(
        (reference) => reference.permitNumber,
      ),
      selectedPermitNumbers: selectedReferences.map(
        (reference) => reference.permitNumber,
      ),
    };
  } else if (typeof adapter.enumerate === "function") {
    const enumeration = await adapter.enumerate({ limit });
    records = enumeration.records;
    reconciliation = {
      extracted: enumeration.records.length,
      truncated: enumeration.truncated,
    };
  }
  const artifact = {
    schemaVersion: "elephant.bounded-permit-probe.v1",
    generatedAt: new Date().toISOString(),
    privacy: "private",
    bounded: true,
    writesPerformed: false,
    jurisdictionKey,
    sourceKey,
    adapterKey: adapter.key,
    parcelIdentifier,
    workAddress,
    probe,
    reconciliation,
    records,
  };
  if (outputPath) {
    await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        bounded: true,
        writesPerformed: false,
        jurisdictionKey,
        sourceKey,
        adapterKey: adapter.key,
        probe,
        reconciliation,
        normalizedRecordCount: records.length,
        contractorCount: records.reduce(
          (total, record) => total + record.contractors.length,
          0,
        ),
        permitNumbers: records.map((record) => record.permit_number),
        outputPath,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await adapter.close?.();
}
