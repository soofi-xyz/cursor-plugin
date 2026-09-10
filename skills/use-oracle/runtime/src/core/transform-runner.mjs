/**
 * Runs a county's CommonJS mapping + extractor scripts against one parcel's
 * `input.html` + seed JSON, then reads back the resulting `data/*.json` tree.
 *
 * The production county transform scripts (`ownerMapping.js`,
 * `structureMapping.js`, ...) are untouched CommonJS files that call
 * `fs.readFileSync("input.html")` and other cwd-relative paths, and
 * `process.exit(1)` on failure. Adapted from
 * `oracle-node@ff68b0b6` `scripts/pinellas-transform-worker.cjs`
 * (`transformParcel`), generalized to accept any script list, working
 * directory, and result file so it works for other counties too.
 *
 * `process.chdir` is process-global, so callers must not run
 * `runCountyTransform` concurrently within one process; the CLI and tests
 * in this package always run transforms for one parcel at a time.
 *
 * @module core/transform-runner
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { populateRoofAgeDefaultsInDataDir } from "../roof-age/transform.mjs";

const require = createRequire(import.meta.url);

/**
 * @typedef {object} RunCountyTransformOptions
 * @property {string} scriptsDir - Absolute directory containing the county's `.js` scripts.
 * @property {readonly string[]} scriptNames - Script filenames, executed in this order.
 * @property {string} workDir - Absolute directory with `input.html` + seed JSON already written.
 * @property {string} [resultFile] - Path (relative to `workDir`) read back as the return value. Defaults to `data/property.json`.
 * @property {string | Date | null} [roofAgeAsOfDate] - Frozen date used to populate shared roof-age fields. Null skips post-processing.
 */

/**
 * @typedef {object} RunCountyTransformResult
 * @property {Record<string, unknown>} result - Parsed `resultFile` JSON.
 * @property {string} dataDir - Absolute path to `workDir/data`.
 * @property {{ structureCount: number, updatedStructureCount: number, defaultedStructureCount: number } | null} roofAgePopulation - Shared roof-age post-processing counters.
 */

/**
 * County mapping scripts call `process.exit(1)` on a caught error. Throwing
 * instead lets a persistent worker or test survive one bad parcel.
 *
 * @param {number | undefined} code - Exit code the script requested.
 * @returns {never} Always throws.
 */
function throwInsteadOfExit(code) {
  const error = new Error(`COUNTY_SCRIPT_EXIT_${code ?? 0}`);
  error.name = "CountyScriptExit";
  throw error;
}

/**
 * Clear the require cache for one script so the next parcel re-runs its
 * top-level `(function main(){ ... })()` logic instead of reusing a stale
 * module.
 *
 * @param {string} scriptPath - Absolute script path.
 * @returns {void}
 */
function forgetScript(scriptPath) {
  const resolved = require.resolve(scriptPath);
  delete require.cache[resolved];
}

/**
 * Run one county's mapping scripts + extractor, in order, against
 * `workDir/input.html`, then read back the declared result file.
 *
 * @param {RunCountyTransformOptions} options - Scripts, working directory, and result file.
 * @returns {RunCountyTransformResult} Parsed result JSON plus the data directory path.
 */
export function runCountyTransform({
  scriptsDir,
  scriptNames,
  workDir,
  resultFile = "data/property.json",
  roofAgeAsOfDate = null,
}) {
  const previousCwd = process.cwd();
  const previousExit = process.exit;
  const previousLog = console.log;
  try {
    process.chdir(workDir);
    process.exit = /** @type {typeof process.exit} */ (throwInsteadOfExit);
    console.log = () => {};
    for (const name of scriptNames) {
      const absoluteScriptPath = path.join(scriptsDir, name);
      forgetScript(absoluteScriptPath);
      require(absoluteScriptPath);
    }
    const resultPath = path.join(workDir, resultFile);
    if (!fs.existsSync(resultPath)) {
      throw new Error(`County transform did not write ${resultFile}`);
    }
    const dataDir = path.join(workDir, path.dirname(resultFile));
    const roofAgePopulation =
      roofAgeAsOfDate === null
        ? null
        : populateRoofAgeDefaultsInDataDir({
            dataDir,
            asOfDate: roofAgeAsOfDate,
          });
    return {
      result: JSON.parse(fs.readFileSync(resultPath, "utf8")),
      dataDir,
      roofAgePopulation,
    };
  } finally {
    process.exit = previousExit;
    console.log = previousLog;
    process.chdir(previousCwd);
  }
}
