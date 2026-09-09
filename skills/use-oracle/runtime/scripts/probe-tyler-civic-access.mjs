import { createPermitAdapter } from "../src/permits/adapters/index.mjs";
import { requireBrowardTylerJurisdiction } from "../src/counties/broward/tyler-jurisdictions.mjs";
import { normalizeTylerParcelIdentifier } from "../src/permits/adapters/tyler-civic-access.mjs";
import { writeTylerPrivateCapture } from "../src/permits/private-load.mjs";

function parseOptions(argv) {
  const values = new Map();
  const permitNumbers = [];
  let liveFetch = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--live-fetch") {
      liveFetch = true;
      continue;
    }
    const value = argv[index + 1];
    if (!argument.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Invalid Tyler probe argument: ${argument}`);
    }
    index += 1;
    if (argument === "--permit-number") {
      permitNumbers.push(value.trim());
    } else {
      values.set(argument.slice(2), value);
    }
  }
  if (!liveFetch) {
    throw new Error("Tyler probe requires explicit --live-fetch");
  }
  if (permitNumbers.length < 1 || permitNumbers.length > 10) {
    throw new Error("Tyler probe requires 1 through 10 --permit-number values");
  }
  return {
    jurisdictionKey: values.get("jurisdiction"),
    parcelIdentifier: normalizeTylerParcelIdentifier(values.get("folio")),
    permitNumbers,
    chromiumExecutablePath:
      values.get("chromium-executable") ??
      process.env.CHROME_EXECUTABLE_PATH?.trim(),
    outputPath: values.get("output"),
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const jurisdiction = requireBrowardTylerJurisdiction(
    options.jurisdictionKey,
  );
  const adapter = createPermitAdapter(jurisdiction, {
    chromiumExecutablePath: options.chromiumExecutablePath,
  });
  const records = [];
  try {
    for (const permitNumber of options.permitNumbers) {
      const reference = await adapter.searchPermitNumber(
        permitNumber,
        options.parcelIdentifier,
      );
      const record = await adapter.fetchPermitDetail(reference, {
        requestedParcelIdentifier: options.parcelIdentifier,
        requestedPropertyId: null,
      });
      records.push(record);
    }
  } finally {
    await adapter.close?.();
  }
  if (options.outputPath) {
    await writeTylerPrivateCapture(options.outputPath, {
      schemaVersion: "elephant.tyler-private-capture.v1",
      countyKey: "broward",
      jurisdictionKey: jurisdiction.key,
      parcelIdentifier: options.parcelIdentifier,
      records,
    });
  }
  process.stdout.write(
    `${JSON.stringify({
      event: "tyler_bounded_probe_complete",
      jurisdictionKey: jurisdiction.key,
      parcelIdentifier: options.parcelIdentifier,
      requestedPermitCount: options.permitNumbers.length,
      capturedPermitCount: records.length,
      outputPath: options.outputPath ?? null,
      records: records.map((record) => ({
        sourceRecordId: record.sourceRecordId,
        permitNumber: record.permit_number,
        parcelIdentifier: record.parcel_identifier,
        permitType: record.improvement_type,
        workClass: record.improvement_action,
        status: record.improvement_status,
        contractors: record.contractors,
      })),
    })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      event: "tyler_bounded_probe_failed",
      classification: error?.classification ?? "unexpected",
      errorCode: error?.code ?? "unexpected_error",
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
});
