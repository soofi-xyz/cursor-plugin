import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/**/*.test.{mjs,ts}"],
    exclude: ["**/node_modules/**"],
    testTimeout: 30000,
    // `core/transform-runner.mjs` uses `process.chdir` (process-global) while
    // running the vendored county transform scripts, so test files must not
    // share a process concurrently (Vitest 4 flat pool options; replaces the
    // removed `poolOptions.forks.singleFork`).
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
  },
});
