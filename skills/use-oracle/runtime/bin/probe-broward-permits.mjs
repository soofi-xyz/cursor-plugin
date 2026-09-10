#!/usr/bin/env node

import { browardPermitProfile } from "../src/counties/broward/permit-profile.mjs";
import { createPermitAdapterForSource } from "../src/permits/adapters/index.mjs";

function argumentsMap(argv) {
  const result = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error("Every probe option must be a --key value pair");
    }
    result.set(key, value);
  }
  return result;
}

const args = argumentsMap(process.argv.slice(2));
const jurisdictionKey = args.get("--jurisdiction");
const sourceKey = args.get("--source");
const parcelIdentifier = args.get("--parcel") ?? null;
const workAddress = args.get("--address") ?? null;
const limit = Number(args.get("--limit") ?? "3");
if (!jurisdictionKey || !sourceKey) {
  throw new Error("--jurisdiction and --source are required");
}
if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
  throw new Error("--limit must be an integer from 1 through 10");
}

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
    for (const reference of references.slice(0, limit)) {
      records.push(
        await adapter.fetchPermitDetail(reference, {
          requestedParcelIdentifier: parcelIdentifier,
          requestedPropertyId: null,
        }),
      );
    }
  } else if (typeof adapter.enumerate === "function") {
    const enumeration = await adapter.enumerate({ limit });
    records = enumeration.records;
    reconciliation = {
      extracted: enumeration.records.length,
      truncated: enumeration.truncated,
    };
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
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await adapter.close?.();
}
