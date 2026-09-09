#!/usr/bin/env node

import { requirePermitProfile } from "../src/counties/permit-profiles.mjs";
import { evaluatePermitProfileReadiness } from "../src/permits/readiness.mjs";

const countyIndex = process.argv.indexOf("--county");
const countyKey =
  countyIndex >= 0 ? process.argv[countyIndex + 1] : "broward";
if (!countyKey || countyKey.startsWith("--")) {
  throw new Error("--county requires a county key");
}

const report = evaluatePermitProfileReadiness(
  requirePermitProfile(countyKey),
);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ready) process.exitCode = 1;
