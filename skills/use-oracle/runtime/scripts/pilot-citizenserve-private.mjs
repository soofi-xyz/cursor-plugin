import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { requirePermitProfile } from "../src/counties/permit-profiles.mjs";
import { createCitizenserveAdapter } from "../src/permits/adapters/citizenserve.mjs";
import { writePermitPrivateCapture } from "../src/permits/private-load.mjs";
import { atomicWriteJson } from "../src/permits/storage.mjs";

function parseOptions(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag ?? "argument"}`);
    }
    options.set(flag, value);
  }
  const required = [
    "--county",
    "--jurisdiction",
    "--folio",
    "--property-id",
    "--address",
    "--expected-permits",
    "--output",
  ];
  if (required.some((flag) => !options.get(flag))) {
    throw new Error(
      "Usage: pilot-citizenserve-private.mjs --county <key> --jurisdiction <key> --folio <identifier> --property-id <uuid> --address <address> --expected-permits <comma-separated permit numbers> --output <ignored directory>",
    );
  }
  return {
    countyKey: options.get("--county"),
    jurisdictionKey: options.get("--jurisdiction"),
    folio: options.get("--folio"),
    propertyId: options.get("--property-id"),
    address: options.get("--address"),
    expectedPermits: options
      .get("--expected-permits")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    outputDir: options.get("--output"),
  };
}

async function privateWrite(filePath, contents) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, { encoding: "utf8", mode: 0o600 });
  await chmod(filePath, 0o600);
}

const options = parseOptions(process.argv.slice(2));
const profile = requirePermitProfile(options.countyKey);
const jurisdiction = profile.jurisdictions.find(
  (candidate) => candidate.key === options.jurisdictionKey,
);
if (!jurisdiction || jurisdiction.adapterKey !== "citizenserve") {
  throw new Error(
    `No Citizenserve jurisdiction ${options.jurisdictionKey} in ${options.countyKey}`,
  );
}
await mkdir(options.outputDir, { recursive: true, mode: 0o700 });
await chmod(options.outputDir, 0o700);
const rawDir = path.join(options.outputDir, "raw-private");
function createPilotAdapter(searchKind) {
  return createCitizenserveAdapter(jurisdiction, {
    async onSearchHtml({ pageNumber, searchKind: actualKind, html }) {
      await privateWrite(
        path.join(
          rawDir,
          `${actualKind ?? searchKind}-search-page-${pageNumber}.private.html`,
        ),
        html,
      );
    },
    async onDetailHtml({ reference, html }) {
      await privateWrite(
        path.join(
          rawDir,
          `${reference.permitNumber.replace(/[^A-Za-z0-9_-]/gu, "_")}.private.html`,
        ),
        html,
      );
    },
  });
}
const adapter = createPilotAdapter("folio");
const references = await adapter.searchParcel(options.folio, {
  requestedPropertyId: null,
  fallbackAddress: options.address.split(",")[0].trim(),
});
const records = await Promise.all(
  references.map((reference) => adapter.fetchPermitDetail(reference)),
);
const capturePath = path.join(options.outputDir, "capture.private.json");
await writePermitPrivateCapture(capturePath, {
  schemaVersion: "elephant.tyler-private-capture.v1",
  countyKey: options.countyKey,
  jurisdictionKey: options.jurisdictionKey,
  parcelIdentifier: options.folio,
  records,
});
const foundPermits = records
  .map((record) => record.permit_number)
  .sort();
const expected = [...new Set(options.expectedPermits)].sort();
const reconciliation = {
  schemaVersion: "elephant.citizenserve-private-pilot.v1",
  countyKey: options.countyKey,
  jurisdictionKey: options.jurisdictionKey,
  sourceSystem: jurisdiction.adapterConfig.sourceSystem,
  address: options.address,
  folio: options.folio,
  elephantPropertyId: options.propertyId,
  expectedPermits: expected,
  foundPermits,
  missingPermits: expected.filter((permit) => !foundPermits.includes(permit)),
  unexpectedPermits: foundPermits.filter(
    (permit) => !expected.includes(permit),
  ),
  counts: {
    expected: expected.length,
    folioListed:
      records[0]?.sourcePayload.sourceSearchKind === "address"
        ? 0
        : references.length,
    addressFallbackUsed:
      records[0]?.sourcePayload.sourceSearchKind === "address",
    listed: references.length,
    detailed: records.length,
    contractorBearing: records.filter(
      (record) => record.contractors.length > 0,
    ).length,
    contractorRows: records.reduce(
      (count, record) => count + record.contractors.length,
      0,
    ),
  },
  permitContractors: records.map((record) => ({
    permitNumber: record.permit_number,
    contractors: record.contractors,
    contractorDisclosure: record.sourcePayload.contractorDisclosure,
  })),
};
const reconciliationPath = path.join(
  options.outputDir,
  "reconciliation.private.json",
);
await atomicWriteJson(reconciliationPath, reconciliation);
await chmod(reconciliationPath, 0o600);
process.stdout.write(
  `${JSON.stringify({
    event: "citizenserve_private_pilot_complete",
    outputDir: options.outputDir,
    capturePath,
    reconciliationPath,
    counts: reconciliation.counts,
    missingPermits: reconciliation.missingPermits,
    unexpectedPermits: reconciliation.unexpectedPermits,
  })}\n`,
);
