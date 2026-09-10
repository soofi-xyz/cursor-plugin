#!/usr/bin/env node

import { requirePermitProfile } from "../src/counties/permit-profiles.mjs";
import { executePermitBackfillPlan } from "../src/permits/backfill-executor.mjs";
import {
  createPermitBackfillPlan,
} from "../src/permits/backfill-plan.mjs";
import { DurablePermitBackfillState } from "../src/permits/backfill-state.mjs";
import {
  readJson,
  writeImmutableJson,
} from "../src/permits/storage.mjs";

function usage() {
  return [
    "Plan or execute an approved artifact-only permit delta/repair run.",
    "",
    "Delta plan (source dates derive from successful checkpoints with one-day overlap):",
    "  permit-backfill plan --county broward --mode delta --through YYYY-MM-DD --properties <jsonl-or-parquet> --checkpoints <json> [--initial-from YYYY-MM-DD] --output <immutable-plan.json>",
    "",
    "Repair plan:",
    "  permit-backfill plan --county broward --mode repair --manifest <repair-candidates.jsonl> --output <immutable-plan.json>",
    "",
    "Execute approved plan (writes artifacts only; never a database):",
    "  permit-backfill execute --plan <plan.json> --approved-plan-sha256 <sha256> --output <run-dir> --owner <operator-run-id> [approved mode inputs]",
    "",
    "Delta execution inputs: --properties <same-file> --checkpoints <same-file>",
    "Repair execution input: --manifest <same-file>",
    "Initial tasks additionally require: --approve-initial-backfill",
    "Optional planning scope: --jurisdiction <key> (repeatable)",
    "Bounded execution tuning: --concurrency 1..4 --page-concurrency 1..4 --lease-seconds 30..900",
  ].join("\n");
}

function parseArguments(argv) {
  if (argv[0] === "--help" || argv[0] === "-h") return { help: true };
  const command = argv[0];
  if (!["plan", "execute"].includes(command)) {
    throw new Error("First argument must be plan or execute");
  }
  const allowed =
    command === "plan"
      ? new Set([
          "--county",
          "--mode",
          "--through",
          "--initial-from",
          "--properties",
          "--manifest",
          "--checkpoints",
          "--output",
          "--jurisdiction",
        ])
      : new Set([
          "--plan",
          "--approved-plan-sha256",
          "--properties",
          "--manifest",
          "--checkpoints",
          "--output",
          "--owner",
          "--concurrency",
          "--page-concurrency",
          "--lease-seconds",
          "--approve-initial-backfill",
        ]);
  const values = new Map();
  const jurisdictions = [];
  const booleans = new Set();
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      return { help: true };
    }
    if (argument === "--approve-initial-backfill") {
      if (!allowed.has(argument)) {
        throw new Error(`${argument} is not valid for ${command}`);
      }
      booleans.add(argument);
      continue;
    }
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected argument "${argument}"`);
    }
    if (!allowed.has(argument)) {
      throw new Error(`Unknown ${command} option "${argument}"`);
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
    command,
    countyKey: values.get("--county") ?? "broward",
    mode: values.get("--mode"),
    throughDate: values.get("--through") ?? null,
    initialFromDate: values.get("--initial-from") ?? null,
    propertiesPath: values.get("--properties") ?? null,
    manifestPath: values.get("--manifest") ?? null,
    checkpointsPath: values.get("--checkpoints") ?? null,
    jurisdictionKeys: jurisdictions,
    outputPath: values.get("--output") ?? null,
    planPath: values.get("--plan") ?? null,
    approvedPlanDigest:
      values.get("--approved-plan-sha256") ?? null,
    ownerId: values.get("--owner") ?? null,
    approveInitialBackfill: booleans.has(
      "--approve-initial-backfill",
    ),
    concurrency: Number(values.get("--concurrency") ?? "1"),
    pageConcurrency: Number(
      values.get("--page-concurrency") ?? "1",
    ),
    leaseSeconds: Number(values.get("--lease-seconds") ?? "120"),
  };
}

try {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    process.exitCode = 0;
  } else if (args.command === "plan") {
    if (!args.outputPath) throw new Error("Plan requires --output");
    const profile = requirePermitProfile(args.countyKey);
    const plan = await createPermitBackfillPlan(profile, {
      mode: args.mode,
      throughDate: args.throughDate,
      initialFromDate: args.initialFromDate,
      propertiesPath: args.propertiesPath,
      manifestPath: args.manifestPath,
      checkpointsPath: args.checkpointsPath,
      jurisdictionKeys: args.jurisdictionKeys,
    });
    await writeImmutableJson(args.outputPath, plan);
    process.stdout.write(
      `${JSON.stringify({
        event: "permit_backfill_plan_created",
        countyKey: plan.countyKey,
        mode: plan.mode,
        planDigest: plan.planDigest,
        taskCount: plan.tasks.length,
        initialBackfillApprovalRequired:
          plan.approval.initialBackfillApprovalRequired,
      })}\n`,
    );
  } else {
    if (!args.planPath) throw new Error("Execution requires --plan");
    if (!args.approvedPlanDigest) {
      throw new Error("Execution requires --approved-plan-sha256");
    }
    if (!args.outputPath) throw new Error("Execution requires --output");
    if (!args.ownerId) throw new Error("Execution requires --owner");
    if (
      !Number.isInteger(args.leaseSeconds) ||
      args.leaseSeconds < 30 ||
      args.leaseSeconds > 900
    ) {
      throw new Error("--lease-seconds must be an integer from 30 through 900");
    }
    const rawPlan = await readJson(args.planPath);
    const profile = requirePermitProfile(rawPlan.countyKey);
    const state = new DurablePermitBackfillState({
      outputDir: args.outputPath,
      ownerId: args.ownerId,
      leaseMs: args.leaseSeconds * 1_000,
    });
    await state.acquire();
    try {
      const summary = await executePermitBackfillPlan({
        rawPlan,
        approvedPlanDigest: args.approvedPlanDigest,
        profile,
        propertiesPath: args.propertiesPath,
        manifestPath: args.manifestPath,
        checkpointsPath: args.checkpointsPath,
        approveInitialBackfill: args.approveInitialBackfill,
        state,
        concurrency: args.concurrency,
        pageConcurrency: args.pageConcurrency,
      });
      process.stdout.write(
        `${JSON.stringify({
          event: "permit_backfill_execution_complete",
          countyKey: summary.countyKey,
          planDigest: summary.planDigest,
          status: summary.status,
          taskCount: summary.taskCount,
          stablePermitRecordCount: summary.stablePermitRecordCount,
          databaseWritesPerformed: false,
          publicationPerformed: false,
        })}\n`,
      );
    } finally {
      await state.release();
    }
  }
} catch (error) {
  process.stderr.write(`${error.message}\n\n${usage()}\n`);
  process.exitCode = 1;
}
