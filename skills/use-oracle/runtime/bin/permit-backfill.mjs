#!/usr/bin/env node

import { requirePermitProfile } from "../src/counties/permit-profiles.mjs";
import { createPermitBackfillPlan } from "../src/permits/backfill-plan.mjs";

function usage() {
  return [
    "Plan an idempotent permit delta or repair run (never executes ingestion).",
    "",
    "Delta:",
    "  permit-backfill --county broward --mode delta --from YYYY-MM-DD --through YYYY-MM-DD --properties <jsonl-or-parquet>",
    "",
    "Repair:",
    "  permit-backfill --county broward --mode repair --manifest <permit-artifact-manifest.json>",
    "",
    "Optional: --jurisdiction <key> (repeatable)",
  ].join("\n");
}

function parseArguments(argv) {
  const values = new Map();
  const jurisdictions = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--execute") {
      throw new Error(
        "This command is plan-only and refuses --execute; use an approved ingestion workflow separately.",
      );
    }
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected argument "${argument}"`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${argument}`);
    }
    index += 1;
    if (argument === "--jurisdiction") jurisdictions.push(value);
    else values.set(argument, value);
  }
  return {
    help: false,
    countyKey: values.get("--county") ?? "broward",
    mode: values.get("--mode"),
    fromDate: values.get("--from") ?? null,
    throughDate: values.get("--through") ?? null,
    propertiesPath: values.get("--properties") ?? null,
    manifestPath: values.get("--manifest") ?? null,
    jurisdictionKeys: jurisdictions,
  };
}

try {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    process.exitCode = 0;
  } else {
    const profile = requirePermitProfile(args.countyKey);
    const plan = createPermitBackfillPlan(profile, {
      mode: args.mode,
      fromDate: args.fromDate,
      throughDate: args.throughDate,
      propertiesPath: args.propertiesPath,
      manifestPath: args.manifestPath,
      jurisdictionKeys: args.jurisdictionKeys,
    });
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n\n${usage()}\n`);
  process.exitCode = 1;
}
