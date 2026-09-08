/**
 * Coverage-only export, approval, and Filebase publication.
 *
 * This path is deliberately independent of county ingest adapters and never
 * accepts a query-table path or IPNS label. It exists for repairing or
 * refreshing dataset coverage without risking the healthy property table.
 *
 * @module core/coverage-publication
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import {
  FILEBASE_GATEWAY,
  FILEBASE_S3_ENDPOINT,
  fillDerivedFilebaseToken,
  hasFilebaseCredentials,
  updateExistingFilebaseName,
  uploadFilebaseObject,
} from "./filebase.mjs";

export const COVERAGE_SCHEMA_VERSION = "1.0";
export const COVERAGE_ARTIFACT_FILE = "dataset-coverage.json";
export const COVERAGE_MANIFEST_FILE = "coverage-manifest.json";
export const COVERAGE_APPROVAL_KIND = "oracle-dataset-coverage-publish";

const COUNTY_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SOURCE_PATTERN = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const POSTGRES_UTC_TIMESTAMP_PATTERN =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?\+00(?::00)?$/;

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {asserts value is Record<string, unknown>}
 */
function assertObject(value, field) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {asserts value is string}
 */
function assertIsoTimestamp(value, field) {
  if (
    typeof value !== "string" ||
    !ISO_TIMESTAMP_PATTERN.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new Error(`${field} must be an ISO-8601 UTC timestamp`);
  }
}

/**
 * Accept the ISO timestamps emitted by artifact manifests and PostgreSQL UTC
 * timestamps read from oracle_dataset_coverage, then return canonical ISO.
 *
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function normalizeUtcTimestamp(value, field) {
  if (typeof value !== "string") {
    throw new Error(`${field} must be an ISO or PostgreSQL UTC timestamp`);
  }
  if (ISO_TIMESTAMP_PATTERN.test(value) && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  const postgres = POSTGRES_UTC_TIMESTAMP_PATTERN.exec(value);
  if (postgres !== null) {
    const fraction =
      postgres[3] === undefined
        ? ".000"
        : `.${postgres[3].slice(0, 3).padEnd(3, "0")}`;
    const iso = `${postgres[1]}T${postgres[2]}${fraction}Z`;
    if (!Number.isNaN(Date.parse(iso))) return new Date(iso).toISOString();
  }
  throw new Error(`${field} must be an ISO or PostgreSQL UTC timestamp`);
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {asserts value is string}
 */
function assertDigest(value, field) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${field} must be a lowercase sha256:<64-hex> digest`);
  }
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {asserts value is number}
 */
function assertNonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
}

/**
 * @param {string} county
 * @returns {string}
 */
export function coverageIpnsLabel(county) {
  if (!COUNTY_KEY_PATTERN.test(county)) {
    throw new Error("county must be normalized lowercase kebab-case");
  }
  return `oracle-dataset-coverage-${county}`;
}

/**
 * @param {Buffer | string} bytes
 * @returns {string}
 */
export function sha256Digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Recursively serialize JSON with lexicographically sorted object keys.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot canonicalize a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  assertObject(value, "canonical JSON value");
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

/**
 * @param {unknown} datasets
 * @param {string} county
 * @returns {Array<{
 *   county: string,
 *   source: string,
 *   ingested_count: number,
 *   expected_count: number | null,
 *   first_loaded_at: string | null,
 *   last_loaded_at: string | null
 * }>}
 */
function validateCoverageDatasets(datasets, county) {
  if (!Array.isArray(datasets) || datasets.length === 0) {
    throw new Error("datasets must be a non-empty array");
  }
  const sources = new Set();
  return datasets.map((dataset, index) => {
    assertObject(dataset, `datasets[${index}]`);
    if (dataset.county !== county) {
      throw new Error(`datasets[${index}].county must equal ${county}`);
    }
    if (typeof dataset.source !== "string" || !SOURCE_PATTERN.test(dataset.source)) {
      throw new Error(`datasets[${index}].source must be normalized lowercase snake/kebab-case`);
    }
    if (sources.has(dataset.source)) {
      throw new Error(`datasets contains duplicate source '${dataset.source}'`);
    }
    sources.add(dataset.source);
    assertNonNegativeInteger(dataset.ingested_count, `datasets[${index}].ingested_count`);
    if (dataset.expected_count !== null) {
      assertNonNegativeInteger(dataset.expected_count, `datasets[${index}].expected_count`);
    }
    const firstLoadedAt =
      dataset.first_loaded_at === null
        ? null
        : normalizeUtcTimestamp(
            dataset.first_loaded_at,
            `datasets[${index}].first_loaded_at`,
          );
    const lastLoadedAt =
      dataset.last_loaded_at === null
        ? null
        : normalizeUtcTimestamp(
            dataset.last_loaded_at,
            `datasets[${index}].last_loaded_at`,
          );
    if (
      firstLoadedAt !== null &&
      lastLoadedAt !== null &&
      Date.parse(firstLoadedAt) > Date.parse(lastLoadedAt)
    ) {
      throw new Error(`datasets[${index}] first_loaded_at is after last_loaded_at`);
    }
    return {
      county,
      source: dataset.source,
      ingested_count: dataset.ingested_count,
      expected_count: dataset.expected_count,
      first_loaded_at: firstLoadedAt,
      last_loaded_at: lastLoadedAt,
    };
  });
}

/**
 * Validate frozen, reconciled source evidence used to build public coverage.
 *
 * @param {unknown} input
 * @param {string} expectedCounty
 * @returns {{
 *   schemaVersion: "1.0",
 *   county: string,
 *   frozenAt: string,
 *   reconciled: true,
 *   provenanceDigest: string,
 *   datasets: ReturnType<typeof validateCoverageDatasets>
 * }}
 */
export function validateCoverageEvidence(input, expectedCounty) {
  if (!COUNTY_KEY_PATTERN.test(expectedCounty)) {
    throw new Error("county must be normalized lowercase kebab-case");
  }
  assertObject(input, "coverage evidence");
  if (input.schemaVersion !== COVERAGE_SCHEMA_VERSION) {
    throw new Error(`coverage evidence schemaVersion must be '${COVERAGE_SCHEMA_VERSION}'`);
  }
  if (input.county !== expectedCounty) {
    throw new Error(`coverage evidence county must equal ${expectedCounty}`);
  }
  assertIsoTimestamp(input.frozenAt, "coverage evidence frozenAt");
  if (input.reconciled !== true) {
    throw new Error("coverage evidence must declare reconciled: true");
  }
  assertDigest(input.provenanceDigest, "coverage evidence provenanceDigest");
  return {
    schemaVersion: COVERAGE_SCHEMA_VERSION,
    county: expectedCounty,
    frozenAt: input.frozenAt,
    reconciled: true,
    provenanceDigest: input.provenanceDigest,
    datasets: validateCoverageDatasets(input.datasets, expectedCounty),
  };
}

/**
 * @param {unknown} input
 * @param {string} expectedCounty
 * @param {string} expectedLabel
 * @returns {{ county: string, exportedAt: string, datasets: Array<Record<string, unknown>> }}
 */
function validateCoverageSnapshot(input, expectedCounty, expectedLabel) {
  assertObject(input, "coverage snapshot");
  if (input.county !== expectedCounty) {
    throw new Error(`coverage snapshot county must equal ${expectedCounty}`);
  }
  assertIsoTimestamp(input.exportedAt, "coverage snapshot exportedAt");
  const datasets = validateCoverageDatasets(input.datasets, expectedCounty);
  for (let index = 0; index < input.datasets.length; index += 1) {
    const raw = input.datasets[index];
    if (raw.cid !== null) throw new Error(`datasets[${index}].cid must be null`);
    if (raw.ipns_label !== expectedLabel) {
      throw new Error(`datasets[${index}].ipns_label must equal ${expectedLabel}`);
    }
  }
  return {
    county: expectedCounty,
    exportedAt: input.exportedAt,
    datasets: datasets.map((dataset) => ({
      ...dataset,
      cid: null,
      ipns_label: expectedLabel,
    })),
  };
}

/**
 * Export a deterministic coverage snapshot from frozen evidence.
 *
 * @param {{ county: string, evidencePath: string, outputDir: string }} options
 * @returns {Promise<Record<string, unknown>>}
 */
export async function exportCoverageArtifact({ county, evidencePath, outputDir }) {
  const evidenceBytes = await readFile(evidencePath);
  const evidence = validateCoverageEvidence(
    JSON.parse(evidenceBytes.toString("utf8")),
    county,
  );
  const ipnsLabel = coverageIpnsLabel(county);
  const snapshot = {
    county,
    exportedAt: evidence.frozenAt,
    datasets: evidence.datasets.map((dataset) => ({
      ...dataset,
      cid: null,
      ipns_label: ipnsLabel,
    })),
  };
  const artifactBytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  const artifactDigest = sha256Digest(artifactBytes);
  const digestHex = artifactDigest.slice("sha256:".length);
  const objectKey = `dataset-coverage/${county}/${digestHex}/${COVERAGE_ARTIFACT_FILE}`;
  const manifest = {
    schemaVersion: COVERAGE_SCHEMA_VERSION,
    kind: "oracle-dataset-coverage-artifact",
    county,
    exportedAt: evidence.frozenAt,
    sourceEvidenceDigest: evidence.provenanceDigest,
    evidenceFileDigest: sha256Digest(evidenceBytes),
    artifactFile: COVERAGE_ARTIFACT_FILE,
    artifactDigest,
    artifactBytes: artifactBytes.length,
    coverageIpnsLabel: ipnsLabel,
    objectKey,
  };
  await mkdir(outputDir, { recursive: true });
  const artifactPath = path.join(outputDir, COVERAGE_ARTIFACT_FILE);
  const manifestPath = path.join(outputDir, COVERAGE_MANIFEST_FILE);
  await writeFile(artifactPath, artifactBytes);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { ...manifest, artifactPath, manifestPath };
}

/**
 * Load and re-verify an exported coverage artifact.
 *
 * @param {{ county: string, inputDir: string }} options
 * @returns {Promise<Record<string, unknown> & { artifactPath: string, body: Buffer, coverage: Record<string, unknown> }>}
 */
export async function loadCoverageArtifact({ county, inputDir }) {
  const manifestPath = path.join(inputDir, COVERAGE_MANIFEST_FILE);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assertObject(manifest, "coverage manifest");
  if (
    manifest.schemaVersion !== COVERAGE_SCHEMA_VERSION ||
    manifest.kind !== "oracle-dataset-coverage-artifact"
  ) {
    throw new Error("coverage manifest has an unsupported schemaVersion or kind");
  }
  if (manifest.county !== county) throw new Error(`coverage manifest county must equal ${county}`);
  assertIsoTimestamp(manifest.exportedAt, "coverage manifest exportedAt");
  assertDigest(manifest.sourceEvidenceDigest, "coverage manifest sourceEvidenceDigest");
  assertDigest(manifest.evidenceFileDigest, "coverage manifest evidenceFileDigest");
  assertDigest(manifest.artifactDigest, "coverage manifest artifactDigest");
  assertNonNegativeInteger(manifest.artifactBytes, "coverage manifest artifactBytes");
  if (manifest.artifactFile !== COVERAGE_ARTIFACT_FILE) {
    throw new Error(`coverage manifest artifactFile must equal ${COVERAGE_ARTIFACT_FILE}`);
  }
  const expectedLabel = coverageIpnsLabel(county);
  if (manifest.coverageIpnsLabel !== expectedLabel) {
    throw new Error(`coverage manifest coverageIpnsLabel must equal ${expectedLabel}`);
  }
  const digestHex = manifest.artifactDigest.slice("sha256:".length);
  const expectedObjectKey =
    `dataset-coverage/${county}/${digestHex}/${COVERAGE_ARTIFACT_FILE}`;
  if (manifest.objectKey !== expectedObjectKey) {
    throw new Error("coverage manifest objectKey is not bound to its artifact digest");
  }
  const artifactPath = path.join(inputDir, COVERAGE_ARTIFACT_FILE);
  const body = await readFile(artifactPath);
  if (body.length !== manifest.artifactBytes) {
    throw new Error("coverage artifact byte length does not match its manifest");
  }
  if (sha256Digest(body) !== manifest.artifactDigest) {
    throw new Error("coverage artifact digest does not match its manifest");
  }
  const coverage = validateCoverageSnapshot(
    JSON.parse(body.toString("utf8")),
    county,
    expectedLabel,
  );
  if (coverage.exportedAt !== manifest.exportedAt) {
    throw new Error("coverage artifact exportedAt does not match its manifest");
  }
  return { ...manifest, manifestPath, artifactPath, body, coverage };
}

/**
 * @param {Record<string, unknown>} artifact
 * @param {{ bucket: string, expectedIpnsName: string, approver: string, approvedAt: string }} options
 * @returns {Record<string, unknown>}
 */
export function buildCoverageApprovalPayload(
  artifact,
  { bucket, expectedIpnsName, approver, approvedAt },
) {
  if (typeof bucket !== "string" || bucket.trim().length === 0) {
    throw new Error("coverage destination bucket is required");
  }
  if (typeof expectedIpnsName !== "string" || expectedIpnsName.trim().length === 0) {
    throw new Error("expected coverage IPNS network key is required");
  }
  if (typeof approver !== "string" || approver.trim().length === 0) {
    throw new Error("approval approver is required");
  }
  assertIsoTimestamp(approvedAt, "approval approvedAt");
  return {
    schemaVersion: COVERAGE_SCHEMA_VERSION,
    kind: COVERAGE_APPROVAL_KIND,
    county: artifact.county,
    artifactDigest: artifact.artifactDigest,
    sourceEvidenceDigest: artifact.sourceEvidenceDigest,
    destination: {
      provider: "filebase",
      bucket: bucket.trim(),
      objectKey: artifact.objectKey,
      ipnsLabel: artifact.coverageIpnsLabel,
      expectedIpnsName: expectedIpnsName.trim(),
    },
    approver: approver.trim(),
    approvedAt,
  };
}

/**
 * @param {import("node:crypto").KeyObject | string | Buffer} key
 * @returns {string}
 */
function approvalPublicKeyId(key) {
  const publicKey =
    typeof key === "object" && key !== null && "type" in key && key.type === "public"
      ? key
      : createPublicKey(key);
  const der = publicKey.export({ type: "spki", format: "der" });
  return sha256Digest(der);
}

/**
 * Sign an approval payload with Ed25519.
 *
 * @param {Record<string, unknown>} payload
 * @param {string | Buffer} privateKeyPem
 * @returns {Record<string, unknown>}
 */
export function signCoverageApproval(payload, privateKeyPem) {
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("coverage approval private key must be Ed25519");
  }
  const publicKey = createPublicKey(privateKey);
  const signature = signBytes(
    null,
    Buffer.from(canonicalJson(payload), "utf8"),
    privateKey,
  );
  return {
    payload,
    signature: {
      algorithm: "ed25519",
      keyId: approvalPublicKeyId(publicKey),
      value: signature.toString("base64"),
    },
  };
}

/**
 * @param {unknown} manifest
 * @param {string | Buffer} publicKeyPem
 * @param {{ artifact: Record<string, unknown>, bucket: string, expectedIpnsName: string }} expected
 * @returns {Record<string, unknown>}
 */
export function verifyCoverageApproval(manifest, publicKeyPem, expected) {
  assertObject(manifest, "coverage approval");
  assertObject(manifest.payload, "coverage approval payload");
  assertObject(manifest.signature, "coverage approval signature");
  const payload = manifest.payload;
  const expectedPayload = buildCoverageApprovalPayload(expected.artifact, {
    bucket: expected.bucket,
    expectedIpnsName: expected.expectedIpnsName,
    approver: String(payload.approver ?? ""),
    approvedAt: String(payload.approvedAt ?? ""),
  });
  if (canonicalJson(payload) !== canonicalJson(expectedPayload)) {
    throw new Error("coverage approval payload does not match the artifact and destination");
  }
  if (manifest.signature.algorithm !== "ed25519") {
    throw new Error("coverage approval signature algorithm must be ed25519");
  }
  const publicKey = createPublicKey(publicKeyPem);
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("coverage approval public key must be Ed25519");
  }
  const expectedKeyId = approvalPublicKeyId(publicKey);
  if (manifest.signature.keyId !== expectedKeyId) {
    throw new Error("coverage approval signature keyId does not match the trusted public key");
  }
  if (
    typeof manifest.signature.value !== "string" ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(manifest.signature.value)
  ) {
    throw new Error("coverage approval signature value must be base64");
  }
  const valid = verifyBytes(
    null,
    Buffer.from(canonicalJson(payload), "utf8"),
    publicKey,
    Buffer.from(manifest.signature.value, "base64"),
  );
  if (!valid) throw new Error("coverage approval signature verification failed");
  return payload;
}

/**
 * Create and write a signed approval manifest. This is intentionally a
 * separate human-run action from publication.
 *
 * @param {{
 *   artifact: Record<string, unknown>,
 *   bucket: string,
 *   expectedIpnsName: string,
 *   approver: string,
 *   approvedAt: string,
 *   privateKeyPath: string,
 *   outputPath: string
 * }} options
 * @returns {Promise<Record<string, unknown>>}
 */
export async function writeCoverageApproval(options) {
  const payload = buildCoverageApprovalPayload(options.artifact, options);
  const privateKey = await readFile(options.privateKeyPath);
  const manifest = signCoverageApproval(payload, privateKey);
  await writeFile(options.outputPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return manifest;
}

/**
 * @param {(input: string | URL | Request, init?: RequestInit) => Promise<Response>} fetchImpl
 * @param {string} url
 * @param {string} expectedDigest
 * @param {(ms: number) => Promise<void>} sleep
 * @returns {Promise<void>}
 */
async function verifyRemoteArtifact(fetchImpl, url, expectedDigest, sleep) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = Buffer.from(await response.arrayBuffer());
      if (sha256Digest(body) !== expectedDigest) {
        throw new Error("digest mismatch");
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(1000 * 2 ** (attempt - 1));
    }
  }
  throw new Error(
    `Coverage remote readback failed for ${url}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

/**
 * Publish only dataset-coverage.json. Query-table objects and labels are not
 * accepted by this API and therefore cannot be mutated by this path.
 *
 * @param {Record<string, unknown> & { body: Buffer }} artifact
 * @param {{
 *   dryRun: boolean,
 *   bucket: string,
 *   expectedIpnsName: string,
 *   approvalManifestPath?: string | null,
 *   approvalPublicKeyPath?: string | null,
 *   env?: NodeJS.ProcessEnv,
 *   endpoint?: string,
 *   client?: { send: (command: unknown) => Promise<unknown> },
 *   fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
 *   sleep?: (ms: number) => Promise<void>
 * }} config
 * @returns {Promise<Record<string, unknown>>}
 */
export async function publishCoverageFilebase(artifact, config) {
  if (
    typeof artifact.county !== "string" ||
    !COUNTY_KEY_PATTERN.test(artifact.county)
  ) {
    throw new Error("coverage artifact county must be normalized lowercase kebab-case");
  }
  assertDigest(artifact.artifactDigest, "coverage artifact artifactDigest");
  assertDigest(artifact.sourceEvidenceDigest, "coverage artifact sourceEvidenceDigest");
  if (!Buffer.isBuffer(artifact.body)) {
    throw new Error("coverage artifact body must be a Buffer");
  }
  if (sha256Digest(artifact.body) !== artifact.artifactDigest) {
    throw new Error("coverage artifact body does not match artifactDigest");
  }
  const expectedLabel = coverageIpnsLabel(artifact.county);
  if (artifact.coverageIpnsLabel !== expectedLabel) {
    throw new Error(`coverage artifact label must equal ${expectedLabel}`);
  }
  const expectedObjectKey =
    `dataset-coverage/${artifact.county}/${artifact.artifactDigest.slice("sha256:".length)}/${COVERAGE_ARTIFACT_FILE}`;
  if (artifact.objectKey !== expectedObjectKey) {
    throw new Error("coverage artifact objectKey is not the immutable coverage-only key");
  }
  const bucket = config.bucket?.trim();
  const expectedIpnsName = config.expectedIpnsName?.trim();
  if (!bucket) throw new Error("coverage destination bucket is required");
  if (!expectedIpnsName || !/^k51[a-z0-9]+$/.test(expectedIpnsName)) {
    throw new Error("expected coverage IPNS network key must be a k51... name");
  }
  const intended = {
    dryRun: true,
    county: artifact.county,
    bucket,
    objectKey: artifact.objectKey,
    coverageIpnsLabel: artifact.coverageIpnsLabel,
    expectedIpnsName,
    artifactDigest: artifact.artifactDigest,
  };
  if (config.dryRun === true) return intended;

  if (!config.approvalManifestPath || !config.approvalPublicKeyPath) {
    throw new Error(
      "Live coverage publish requires --approve <manifest> and --approval-public-key <trusted-ed25519-public-key>",
    );
  }
  const [approvalBytes, publicKey] = await Promise.all([
    readFile(config.approvalManifestPath),
    readFile(config.approvalPublicKeyPath),
  ]);
  verifyCoverageApproval(
    JSON.parse(approvalBytes.toString("utf8")),
    publicKey,
    { artifact, bucket, expectedIpnsName },
  );

  const env = { ...(config.env ?? process.env) };
  fillDerivedFilebaseToken(env);
  if (!hasFilebaseCredentials(env)) {
    throw new Error(
      `Filebase credentials are missing for ${artifact.county}. Set S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY; FILEBASE_API_TOKEN may be derived from them.`,
    );
  }
  const client =
    config.client ??
    new S3Client({
      region: "us-east-1",
      endpoint: config.endpoint ?? FILEBASE_S3_ENDPOINT,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID.trim(),
        secretAccessKey: env.S3_SECRET_ACCESS_KEY.trim(),
      },
      forcePathStyle: true,
    });
  const fetchImpl = config.fetchImpl ?? fetch;
  const sleep =
    config.sleep ??
    ((ms) => new Promise((resolve) => {
      setTimeout(resolve, ms);
    }));

  await client.send(new HeadBucketCommand({ Bucket: bucket }));
  const coverageCid = await uploadFilebaseObject({
    client,
    bucket,
    key: artifact.objectKey,
    body: artifact.body,
    contentType: "application/json",
  });
  await verifyRemoteArtifact(
    fetchImpl,
    `${FILEBASE_GATEWAY}/ipfs/${coverageCid}`,
    artifact.artifactDigest,
    sleep,
  );
  const name = await updateExistingFilebaseName(
    env.FILEBASE_API_TOKEN.trim(),
    artifact.coverageIpnsLabel,
    expectedIpnsName,
    coverageCid,
    fetchImpl,
  );
  const coverageIpns = `${FILEBASE_GATEWAY}/ipns/${name.network_key}`;
  await verifyRemoteArtifact(fetchImpl, coverageIpns, artifact.artifactDigest, sleep);
  return {
    dryRun: false,
    county: artifact.county,
    bucket,
    objectKey: artifact.objectKey,
    artifactDigest: artifact.artifactDigest,
    coverageCid,
    coverageIpnsLabel: artifact.coverageIpnsLabel,
    coverageIpns,
  };
}
