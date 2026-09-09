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
  const propertyId = options
    .get("--property-id")
    .toLowerCase()
    .replaceAll("-", "");
  if (!/^[a-f0-9]{32}$/u.test(propertyId)) {
    throw new Error("--property-id must be a UUID or 32 lowercase hex characters");
  }
  return {
    countyKey: options.get("--county"),
    jurisdictionKey: options.get("--jurisdiction"),
    folio: options.get("--folio"),
    propertyId,
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
    timeoutMs: 20_000,
    async onSearchHtml({
      pageNumber,
      searchKind: actualKind,
      searchValue,
      html,
    }) {
      const valueSlug = String(searchValue ?? "unknown").replace(
        /[^A-Za-z0-9_-]/gu,
        "_",
      );
      await privateWrite(
        path.join(
          rawDir,
          `${actualKind ?? searchKind}-${valueSlug}-page-${pageNumber}.private.html`,
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
  requestedPropertyId: options.propertyId,
  exactPermitNumbers: options.expectedPermits,
  expectedAddress: options.address,
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
const folioListedPermits = [
  ...(records[0]?.sourcePayload.folioSearchPermitNumbers ?? []),
].sort();
const reconciliation = {
  schemaVersion: "elephant.citizenserve-private-pilot.v1",
  countyKey: options.countyKey,
  jurisdictionKey: options.jurisdictionKey,
  sourceSystem: jurisdiction.adapterConfig.sourceSystem,
  address: options.address,
  folio: options.folio,
  elephantPropertyId: options.propertyId,
  expectedPermits: expected,
  folioListedPermits,
  foundPermits,
  missingPermits: expected.filter((permit) => !foundPermits.includes(permit)),
  unexpectedPermits: folioListedPermits.filter(
    (permit) => !expected.includes(permit),
  ),
  sourceHost: records[0]?.sourcePayload.sourceHost ?? null,
  sourceHostRole: records[0]?.sourcePayload.sourceHostRole ?? null,
  officialCanonicalConfirmation:
    "unconfirmed-no-direct-municipal-vendor-link",
  counts: {
    expected: expected.length,
    folioListed:
      records[0]?.sourcePayload.folioSearchReportedTotal ?? 0,
    expectedListed: records.length,
    listed: records.length,
    detailed: records.filter(
      (record) =>
        record.sourcePayload.detailAvailability === "public-detail",
    ).length,
    listingOnly: records.filter(
      (record) =>
        record.sourcePayload.detailAvailability === "not_exposed",
    ).length,
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
    detailAvailability: record.sourcePayload.detailAvailability,
    sourceUrl: record.sourceUrl,
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
