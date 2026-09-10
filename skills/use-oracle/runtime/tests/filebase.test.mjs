import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  FILEBASE_APPROVAL_SCHEMA_VERSION,
  hasFilebaseCredentials,
  fillDerivedFilebaseToken,
  loadEnvFile,
  publishFilebase,
  validateFilebaseApproval,
} from "../src/core/filebase.mjs";

const ARTIFACTS = {
  county: "pinellas",
  parquetPath: "/does/not/matter.parquet",
  coveragePath: "/does/not/matter.json",
  bucket: "elephant-oracle-query-table-pinellas",
  queryTableIpnsLabel: "oracle-query-table-pinellas",
  coverageIpnsLabel: "oracle-dataset-coverage-pinellas",
};

function approvalFor(parquetBody, coverageBody) {
  return {
    schemaVersion: FILEBASE_APPROVAL_SCHEMA_VERSION,
    action: "publish-query-table-and-coverage",
    county: ARTIFACTS.county,
    bucket: ARTIFACTS.bucket,
    queryTableIpnsLabel: ARTIFACTS.queryTableIpnsLabel,
    coverageIpnsLabel: ARTIFACTS.coverageIpnsLabel,
    artifacts: {
      queryTable: {
        bytes: parquetBody.length,
        sha256:
          "fbc62d3b511368ee275ddc74117d8689b430e1427220e25d30816201d89ca7b6",
      },
      coverage: {
        bytes: coverageBody.length,
        sha256:
          "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      },
    },
    approved: true,
    approvedBy: "Test Operator",
    approvedAt: "2026-09-06T00:00:00.000Z",
  };
}

describe("Filebase credential + dry-run gating", () => {
  it("reports no credentials for an empty environment", () => {
    expect(hasFilebaseCredentials({})).toBe(false);
    expect(hasFilebaseCredentials({ S3_ACCESS_KEY_ID: "  " })).toBe(false);
  });

  it("reports credentials present once all three keys are set", () => {
    expect(
      hasFilebaseCredentials({
        S3_ACCESS_KEY_ID: "id",
        S3_SECRET_ACCESS_KEY: "secret",
        FILEBASE_API_TOKEN: "token",
      }),
    ).toBe(true);
  });

  it("derives a base64 token from the access/secret pair only when no token is already set", () => {
    const env = { S3_ACCESS_KEY_ID: "id", S3_SECRET_ACCESS_KEY: "secret" };
    fillDerivedFilebaseToken(env);
    expect(env.FILEBASE_API_TOKEN).toBe(Buffer.from("id:secret", "utf8").toString("base64"));

    const preset = { ...env, FILEBASE_API_TOKEN: "keep-me" };
    fillDerivedFilebaseToken(preset);
    expect(preset.FILEBASE_API_TOKEN).toBe("keep-me");
  });

  it("loads a dotenv file without overwriting existing environment keys", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "pinellas-filebase-env-"));
    try {
      const envFile = path.join(tempDir, ".env");
      await writeFile(envFile, '# comment\nS3_ACCESS_KEY_ID=from-file\nFILEBASE_API_TOKEN="quoted"\n', "utf8");
      const env = { S3_ACCESS_KEY_ID: "already-set" };
      await loadEnvFile(envFile, env);
      expect(env.S3_ACCESS_KEY_ID).toBe("already-set");
      expect(env.FILEBASE_API_TOKEN).toBe("quoted");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("loadEnvFile is a no-op (not an error) for a missing file", async () => {
    const env = {};
    await expect(loadEnvFile("/tmp/does-not-exist-elephant-county.env", env)).resolves.toBeUndefined();
    expect(env).toEqual({});
  });

  it("never touches the network for a dry-run and reports the intended destination", async () => {
    const result = await publishFilebase(ARTIFACTS, { dryRun: true, env: {} });
    expect(result).toEqual({
      dryRun: true,
      bucket: ARTIFACTS.bucket,
      queryTableIpnsLabel: ARTIFACTS.queryTableIpnsLabel,
      coverageIpnsLabel: ARTIFACTS.coverageIpnsLabel,
    });
  });

  it("requires an explicit approval bound to the exact artifact bytes", () => {
    const parquetBody = Buffer.from("PAR1");
    const coverageBody = Buffer.from("{}");
    const approval = approvalFor(parquetBody, coverageBody);

    expect(
      validateFilebaseApproval(
        approval,
        ARTIFACTS,
        parquetBody,
        coverageBody,
      ),
    ).toEqual(approval);
    expect(() =>
      validateFilebaseApproval(
        {
          ...approval,
          artifacts: {
            ...approval.artifacts,
            queryTable: {
              ...approval.artifacts.queryTable,
              sha256: "0".repeat(64),
            },
          },
        },
        ARTIFACTS,
        parquetBody,
        coverageBody,
      ),
    ).toThrow(/queryTable integrity/);
    expect(() =>
      validateFilebaseApproval(
        { ...approval, approved: false },
        ARTIFACTS,
        parquetBody,
        coverageBody,
      ),
    ).toThrow();
  });

  it("fails closed on a live publish with no approval manifest, even with credentials present", async () => {
    await expect(
      publishFilebase(ARTIFACTS, {
        dryRun: false,
        approvalManifestPath: null,
        env: { S3_ACCESS_KEY_ID: "id", S3_SECRET_ACCESS_KEY: "secret", FILEBASE_API_TOKEN: "token" },
      }),
    ).rejects.toThrow(/requires an approval manifest/);
  });

  it("fails closed on a live publish with an approval manifest but no credentials", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "pinellas-filebase-approve-"));
    try {
      const approvalPath = path.join(tempDir, "approve.json");
      await writeFile(approvalPath, "{}\n", "utf8");
      await expect(
        publishFilebase(ARTIFACTS, { dryRun: false, approvalManifestPath: approvalPath, env: {} }),
      ).rejects.toThrow(/credentials are missing/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails closed on a live publish referencing a non-existent approval manifest path", async () => {
    await expect(
      publishFilebase(ARTIFACTS, {
        dryRun: false,
        approvalManifestPath: "/tmp/does-not-exist-approval.json",
        env: { S3_ACCESS_KEY_ID: "id", S3_SECRET_ACCESS_KEY: "secret", FILEBASE_API_TOKEN: "token" },
      }),
    ).rejects.toThrow(/requires an approval manifest/);
  });
});
