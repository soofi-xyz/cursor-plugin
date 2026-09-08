import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  buildCoverageApprovalPayload,
  exportCoverageArtifact,
  loadCoverageArtifact,
  publishCoverageFilebase,
  signCoverageApproval,
  verifyCoverageApproval,
} from "../src/core/coverage-publication.mjs";
import { FILEBASE_NAMES_API } from "../src/core/filebase.mjs";

const execFileAsync = promisify(execFile);
const RUNTIME_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = path.join(RUNTIME_ROOT, "bin", "elephant-county.mjs");
const COUNTY = "lee";
const BUCKET = "elephant-oracle-dataset-coverage-lee";
const IPNS_NAME =
  "k51qzi5uqu5dimw0elyh4agbtqe7v2fzp0jcd7b1bcu8kxs0hml7yu1no0z0vd";
const FROZEN_AT = "2026-09-07T23:20:00.000Z";
const PROVENANCE_DIGEST = `sha256:${"a".repeat(64)}`;

function coverageEvidence(overrides = {}) {
  return {
    schemaVersion: "1.0",
    county: COUNTY,
    frozenAt: FROZEN_AT,
    reconciled: true,
    provenanceDigest: PROVENANCE_DIGEST,
    datasets: [
      {
        county: COUNTY,
        source: "appraisal",
        ingested_count: 511695,
        expected_count: 511695,
        first_loaded_at: "2026-07-01 00:00:00+00",
        last_loaded_at: "2026-09-07 23:20:00.000000+00",
      },
      {
        county: COUNTY,
        source: "bbb",
        ingested_count: 1200,
        expected_count: null,
        first_loaded_at: "2026-07-02T00:00:00.000Z",
        last_loaded_at: FROZEN_AT,
      },
    ],
    ...overrides,
  };
}

async function createArtifact(tempDir, evidence = coverageEvidence()) {
  const evidencePath = path.join(tempDir, "coverage-evidence.json");
  const outputDir = path.join(tempDir, "publish");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  await exportCoverageArtifact({ county: COUNTY, evidencePath, outputDir });
  return loadCoverageArtifact({ county: COUNTY, inputDir: outputDir });
}

function approvalKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKey: publicKey.export({ type: "spki", format: "pem" }),
  };
}

describe("coverage-only artifact export", () => {
  it("exports deterministic multi-source coverage without a county ingest adapter", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "lee-coverage-export-"));
    try {
      const artifact = await createArtifact(tempDir);
      expect(artifact.county).toBe(COUNTY);
      expect(artifact.coverageIpnsLabel).toBe("oracle-dataset-coverage-lee");
      expect(artifact.objectKey).toMatch(
        /^dataset-coverage\/lee\/[a-f0-9]{64}\/dataset-coverage\.json$/,
      );
      expect(artifact.artifactDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(artifact.sourceEvidenceDigest).toBe(PROVENANCE_DIGEST);
      expect(artifact.coverage.datasets).toHaveLength(2);
      expect(artifact.coverage.datasets[0].first_loaded_at)
        .toBe("2026-07-01T00:00:00.000Z");
      expect(artifact.coverage.datasets[0].last_loaded_at)
        .toBe("2026-09-07T23:20:00.000Z");
      expect(artifact.coverage.datasets[1].expected_count).toBeNull();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects unreconciled, wrong-county, duplicate-source, and invalid-count evidence", async () => {
    const cases = [
      [coverageEvidence({ reconciled: false }), /reconciled: true/],
      [coverageEvidence({ county: "orange" }), /county must equal lee/],
      [
        coverageEvidence({
          datasets: [coverageEvidence().datasets[0], coverageEvidence().datasets[0]],
        }),
        /duplicate source/,
      ],
      [
        coverageEvidence({
          datasets: [{ ...coverageEvidence().datasets[0], ingested_count: -1 }],
        }),
        /non-negative safe integer/,
      ],
    ];
    for (const [evidence, expectedError] of cases) {
      const tempDir = await mkdtemp(path.join(tmpdir(), "bad-coverage-evidence-"));
      try {
        const evidencePath = path.join(tempDir, "evidence.json");
        await writeFile(evidencePath, JSON.stringify(evidence), "utf8");
        await expect(
          exportCoverageArtifact({
            county: COUNTY,
            evidencePath,
            outputDir: path.join(tempDir, "out"),
          }),
        ).rejects.toThrow(expectedError);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  });

  it("detects an artifact changed after export", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "tampered-coverage-"));
    try {
      const artifact = await createArtifact(tempDir);
      await writeFile(artifact.artifactPath, "{}\n", "utf8");
      await expect(
        loadCoverageArtifact({
          county: COUNTY,
          inputDir: path.dirname(artifact.artifactPath),
        }),
      ).rejects.toThrow(/byte length|digest/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("coverage approval", () => {
  it("cryptographically binds approval to the artifact and destination", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "coverage-approval-"));
    try {
      const artifact = await createArtifact(tempDir);
      const keys = approvalKeys();
      const payload = buildCoverageApprovalPayload(artifact, {
        bucket: BUCKET,
        expectedIpnsName: IPNS_NAME,
        approver: "data-publisher@example.com",
        approvedAt: FROZEN_AT,
      });
      const approval = signCoverageApproval(payload, keys.privateKey);
      expect(
        verifyCoverageApproval(approval, keys.publicKey, {
          artifact,
          bucket: BUCKET,
          expectedIpnsName: IPNS_NAME,
        }),
      ).toEqual(payload);

      const wrongBucket = {
        ...approval,
        payload: {
          ...approval.payload,
          destination: { ...approval.payload.destination, bucket: "wrong-bucket" },
        },
      };
      expect(() =>
        verifyCoverageApproval(wrongBucket, keys.publicKey, {
          artifact,
          bucket: BUCKET,
          expectedIpnsName: IPNS_NAME,
        }),
      ).toThrow(/does not match/);

      const badSignature = {
        ...approval,
        signature: { ...approval.signature, value: Buffer.alloc(64).toString("base64") },
      };
      expect(() =>
        verifyCoverageApproval(badSignature, keys.publicKey, {
          artifact,
          bucket: BUCKET,
          expectedIpnsName: IPNS_NAME,
        }),
      ).toThrow(/verification failed/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("coverage-only Filebase publish", () => {
  it("dry-runs with no credentials or network activity", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "coverage-dry-run-"));
    try {
      const artifact = await createArtifact(tempDir);
      const result = await publishCoverageFilebase(artifact, {
        dryRun: true,
        bucket: BUCKET,
        expectedIpnsName: IPNS_NAME,
        env: {},
        client: { send: async () => { throw new Error("S3 must not run"); } },
        fetchImpl: async () => { throw new Error("fetch must not run"); },
      });
      expect(result).toMatchObject({
        dryRun: true,
        county: COUNTY,
        bucket: BUCKET,
        coverageIpnsLabel: "oracle-dataset-coverage-lee",
        expectedIpnsName: IPNS_NAME,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("allows an existing shared bucket but rejects forged query-table artifact metadata", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "coverage-query-table-reject-"));
    try {
      const artifact = await createArtifact(tempDir);
      const sharedBucket = await publishCoverageFilebase(artifact, {
        dryRun: true,
        bucket: "elephant-oracle-query-table-lee",
        expectedIpnsName: IPNS_NAME,
      });
      expect(sharedBucket).toMatchObject({
        bucket: "elephant-oracle-query-table-lee",
        objectKey: artifact.objectKey,
        coverageIpnsLabel: "oracle-dataset-coverage-lee",
      });
      await expect(
        publishCoverageFilebase(
          {
            ...artifact,
            coverageIpnsLabel: "oracle-query-table-lee",
            objectKey: "lee/query-table.parquet",
          },
          {
            dryRun: true,
            bucket: BUCKET,
            expectedIpnsName: IPNS_NAME,
          },
        ),
      ).rejects.toThrow(/coverage artifact label/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uploads one immutable coverage object and updates only the existing coverage label", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "coverage-live-fake-"));
    try {
      const artifact = await createArtifact(tempDir);
      const keys = approvalKeys();
      const publicKeyPath = path.join(tempDir, "approval-public.pem");
      const approvalPath = path.join(tempDir, "approval.json");
      await writeFile(publicKeyPath, keys.publicKey, { encoding: "utf8", mode: 0o600 });
      const payload = buildCoverageApprovalPayload(artifact, {
        bucket: BUCKET,
        expectedIpnsName: IPNS_NAME,
        approver: "data-publisher@example.com",
        approvedAt: FROZEN_AT,
      });
      await writeFile(
        approvalPath,
        `${JSON.stringify(signCoverageApproval(payload, keys.privateKey), null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );

      const s3Commands = [];
      const client = {
        async send(command) {
          s3Commands.push(command);
          if (command?.middlewareStack) {
            const handler = command.middlewareStack.resolve(
              async () => ({
                output: {},
                response: { headers: { "x-amz-meta-cid": "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi" } },
              }),
              {},
            );
            await handler({ input: command.input });
          }
          return {};
        },
      };
      const fetchCalls = [];
      const fetchImpl = async (url, init = {}) => {
        const href = String(url);
        fetchCalls.push({ href, init });
        if (href === FILEBASE_NAMES_API && init.method === undefined) {
          return Response.json([
            {
              label: "oracle-dataset-coverage-lee",
              network_key: IPNS_NAME,
              cid: "old-cid",
            },
          ]);
        }
        if (
          href === `${FILEBASE_NAMES_API}/oracle-dataset-coverage-lee` &&
          init.method === "PUT"
        ) {
          return Response.json({
            label: "oracle-dataset-coverage-lee",
            network_key: IPNS_NAME,
            cid: JSON.parse(init.body).cid,
          });
        }
        if (href.startsWith("https://ipfs.filebase.io/ipfs/")) {
          return new Response(artifact.body, { status: 200 });
        }
        if (href === `https://ipfs.filebase.io/ipns/${IPNS_NAME}`) {
          return new Response(artifact.body, { status: 200 });
        }
        return new Response("unexpected request", { status: 500 });
      };

      const result = await publishCoverageFilebase(artifact, {
        dryRun: false,
        bucket: BUCKET,
        expectedIpnsName: IPNS_NAME,
        approvalManifestPath: approvalPath,
        approvalPublicKeyPath: publicKeyPath,
        env: { S3_ACCESS_KEY_ID: "id", S3_SECRET_ACCESS_KEY: "secret" },
        client,
        fetchImpl,
        sleep: async () => {},
      });

      expect(s3Commands.map((command) => command.constructor.name)).toEqual([
        "HeadBucketCommand",
        "PutObjectCommand",
      ]);
      expect(s3Commands[0].input).toEqual({ Bucket: BUCKET });
      expect(s3Commands[1].input).toMatchObject({
        Bucket: BUCKET,
        Key: artifact.objectKey,
        ContentType: "application/json",
      });
      expect(
        JSON.stringify({
          commands: s3Commands.map((command) => command.input),
          fetchCalls,
          result,
        }),
      ).not.toContain("query-table");
      expect(fetchCalls.filter((call) => call.init.method === "PUT")).toHaveLength(1);
      expect(result).toMatchObject({
        dryRun: false,
        county: COUNTY,
        coverageIpnsLabel: "oracle-dataset-coverage-lee",
        coverageIpns: `https://ipfs.filebase.io/ipns/${IPNS_NAME}`,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects live publication before credentials when approval is absent", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "coverage-live-reject-"));
    try {
      const artifact = await createArtifact(tempDir);
      await expect(
        publishCoverageFilebase(artifact, {
          dryRun: false,
          bucket: BUCKET,
          expectedIpnsName: IPNS_NAME,
          env: { S3_ACCESS_KEY_ID: "id", S3_SECRET_ACCESS_KEY: "secret" },
        }),
      ).rejects.toThrow(/requires --approve/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("coverage-only CLI", () => {
  it("exports and dry-runs Lee without requiring a Lee ingest adapter", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "lee-coverage-cli-"));
    const otherCwd = await mkdtemp(path.join(tmpdir(), "lee-coverage-cli-cwd-"));
    try {
      const evidencePath = path.join(tempDir, "evidence.json");
      const publishDir = path.join(tempDir, "publish");
      await writeFile(
        evidencePath,
        `${JSON.stringify(coverageEvidence(), null, 2)}\n`,
        "utf8",
      );
      const exported = await execFileAsync(
        process.execPath,
        [
          CLI_PATH,
          "export-coverage",
          "--county",
          COUNTY,
          "--evidence",
          evidencePath,
          "--output",
          publishDir,
        ],
        { cwd: otherCwd },
      );
      expect(JSON.parse(exported.stdout).event).toBe("coverage_export_complete");

      const published = await execFileAsync(
        process.execPath,
        [
          CLI_PATH,
          "publish-coverage",
          "--county",
          COUNTY,
          "--input",
          publishDir,
          "--bucket",
          BUCKET,
          "--expected-ipns-name",
          IPNS_NAME,
          "--dry-run",
        ],
        { cwd: otherCwd, env: {} },
      );
      const result = JSON.parse(published.stdout);
      expect(result.event).toBe("coverage_publish_complete");
      expect(result.result.dryRun).toBe(true);
      expect(await readFile(path.join(publishDir, "dataset-coverage.json"), "utf8"))
        .toContain('"county": "lee"');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
      await rm(otherCwd, { recursive: true, force: true });
    }
  });
});
