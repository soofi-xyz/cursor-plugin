/**
 * Filebase S3 + IPNS publication, gated so a live upload only happens when a
 * caller explicitly supplies credentials *and* an approval manifest.
 *
 * Adapted from `oracle-node@ff68b0b6`
 * `scripts/publish-pinellas-pilot-to-filebase.mjs`
 * (`hasFilebaseCredentials`, `fillDerivedFilebaseToken`, `loadEnvFile`,
 * `publishPinellasArtifactsToFilebase`, `uploadFilebaseObject`,
 * `upsertFilebaseName`), generalized to any county's bucket/IPNS labels and
 * with an explicit approval-manifest gate added for this package's CLI.
 *
 * @module core/filebase
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";

export const FILEBASE_S3_ENDPOINT = "https://s3.filebase.com";
export const FILEBASE_NAMES_API = "https://api.filebase.io/v1/names";
export const FILEBASE_GATEWAY = "https://ipfs.filebase.io";
export const FILEBASE_APPROVAL_SCHEMA_VERSION =
  "elephant.filebase-publish-approval.v1";

const approvalArtifactSchema = z
  .object({
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const filebaseApprovalSchema = z
  .object({
    schemaVersion: z.literal(FILEBASE_APPROVAL_SCHEMA_VERSION),
    action: z.literal("publish-query-table-and-coverage"),
    county: z.string().min(1),
    bucket: z.string().min(1),
    queryTableIpnsLabel: z.string().min(1),
    coverageIpnsLabel: z.string().min(1),
    artifacts: z
      .object({
        queryTable: approvalArtifactSchema,
        coverage: approvalArtifactSchema,
      })
      .strict(),
    approved: z.literal(true),
    approvedBy: z.string().min(1),
    approvedAt: z.string().datetime({ offset: true }),
  })
  .strict();

const permitFilebaseApprovalSchema = z
  .object({
    schemaVersion: z.literal(
      "elephant.filebase-permit-publish-approval.v1",
    ),
    action: z.literal(
      "publish-permit-property-and-coverage",
    ),
    county: z.string().min(1),
    bucket: z.string().min(1),
    labels: z
      .object({
        permitTable: z.string().min(1),
        queryTable: z.string().min(1),
        coverage: z.string().min(1),
      })
      .strict(),
    artifacts: z
      .object({
        permitTable: approvalArtifactSchema,
        queryTable: approvalArtifactSchema,
        coverage: approvalArtifactSchema,
        permitCoverage: approvalArtifactSchema,
      })
      .strict(),
    approved: z.literal(true),
    approvedBy: z.string().min(1),
    approvedAt: z.string().datetime({ offset: true }),
  })
  .strict();

/**
 * @typedef {object} FilebaseArtifacts
 * @property {string} county - County key, used only for log/error context.
 * @property {string} parquetPath - Absolute path to the query-table Parquet file.
 * @property {string} coveragePath - Absolute path to the dataset-coverage JSON file.
 * @property {string} bucket - Filebase S3 bucket for this county.
 * @property {string} queryTableIpnsLabel - Existing Filebase IPNS label for the query table.
 * @property {string} coverageIpnsLabel - Existing Filebase IPNS label for dataset coverage.
 */

/**
 * @typedef {object} PublishFilebaseConfig
 * @property {boolean} dryRun - When true, never touches the network; reports intended labels/bucket only.
 * @property {string | null} [approvalManifestPath] - Path to a human-signed approval manifest, required for a live publish.
 * @property {NodeJS.ProcessEnv} [env] - Environment to read Filebase credentials from. Defaults to `process.env`.
 * @property {string} [endpoint] - Override the Filebase S3 endpoint (tests only).
 */

/**
 * Whether Filebase S3 + IPNS credentials are present (values not logged).
 *
 * @param {NodeJS.ProcessEnv} env - Environment map.
 * @returns {boolean} True when the required names are non-empty.
 */
export function hasFilebaseCredentials(env) {
  const names = ["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "FILEBASE_API_TOKEN"];
  return names.every((name) => {
    const value = env[name];
    return typeof value === "string" && value.trim().length > 0;
  });
}

/**
 * Derive a Filebase API token from the S3 access/secret pair when the token
 * itself is missing.
 *
 * @param {NodeJS.ProcessEnv} env - Mutable environment map.
 * @returns {void}
 */
export function fillDerivedFilebaseToken(env) {
  if (typeof env.FILEBASE_API_TOKEN === "string" && env.FILEBASE_API_TOKEN.trim().length > 0) {
    return;
  }
  const access_ = env.S3_ACCESS_KEY_ID?.trim();
  const secret = env.S3_SECRET_ACCESS_KEY?.trim();
  if (!access_ || !secret) return;
  env.FILEBASE_API_TOKEN = Buffer.from(`${access_}:${secret}`, "utf8").toString("base64");
}

/**
 * Load dotenv KEY=value pairs into a mutable env map without overwriting
 * existing keys.
 *
 * @param {string} envFile - Path to a dotenv file.
 * @param {NodeJS.ProcessEnv} [env] - Environment to populate. Defaults to `process.env`.
 * @returns {Promise<void>} Resolves after load; a missing file is not an error.
 */
export async function loadEnvFile(envFile, env = process.env) {
  try {
    const text = await readFile(envFile, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
      const equalsIndex = trimmed.indexOf("=");
      if (equalsIndex <= 0) continue;
      const key = trimmed.slice(0, equalsIndex);
      let value = trimmed.slice(equalsIndex + 1);
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }
      if (env[key] === undefined) env[key] = value;
    }
  } catch (caught) {
    if (caught instanceof Error && "code" in caught && caught.code === "ENOENT") return;
    throw caught;
  }
}

/**
 * @param {string} candidate - Filesystem path.
 * @returns {Promise<boolean>} Whether the path exists and is readable.
 */
async function fileExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

function bufferIntegrity(body) {
  return {
    bytes: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

export function validateFilebaseApproval(
  value,
  artifacts,
  parquetBody,
  coverageBody,
) {
  const approval = filebaseApprovalSchema.parse(value);
  const expected = {
    county: artifacts.county,
    bucket: artifacts.bucket,
    queryTableIpnsLabel: artifacts.queryTableIpnsLabel,
    coverageIpnsLabel: artifacts.coverageIpnsLabel,
    artifacts: {
      queryTable: bufferIntegrity(parquetBody),
      coverage: bufferIntegrity(coverageBody),
    },
  };
  for (const key of [
    "county",
    "bucket",
    "queryTableIpnsLabel",
    "coverageIpnsLabel",
  ]) {
    if (approval[key] !== expected[key]) {
      throw new Error(
        `Filebase approval ${key} does not match the publication artifact`,
      );
    }
  }
  for (const name of ["queryTable", "coverage"]) {
    if (
      approval.artifacts[name].bytes !== expected.artifacts[name].bytes ||
      approval.artifacts[name].sha256 !== expected.artifacts[name].sha256
    ) {
      throw new Error(
        `Filebase approval ${name} integrity does not match the publication artifact`,
      );
    }
  }
  return approval;
}

/**
 * Upload one object to Filebase and return its CID.
 *
 * @param {object} params - Upload parameters.
 * @param {S3Client} params.client - Filebase S3 client.
 * @param {string} params.bucket - Bucket name.
 * @param {string} params.key - Object key.
 * @param {Buffer} params.body - Bytes.
 * @param {string} params.contentType - HTTP content type.
 * @returns {Promise<string>} Filebase CID.
 */
async function uploadFilebaseObject({ client, bucket, key, body, contentType }) {
  const command = new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType });
  /** @type {string | undefined} */
  let headerCid;
  command.middlewareStack.add(
    (next) => async (args) => {
      const result = await next(args);
      const response = result.response;
      if (
        typeof response === "object" &&
        response !== null &&
        "headers" in response &&
        typeof response.headers === "object" &&
        response.headers !== null
      ) {
        headerCid = /** @type {Record<string, string>} */ (response.headers)["x-amz-meta-cid"];
      }
      return result;
    },
    { step: "deserialize", name: `captureFilebaseCid-${key}`, priority: "low" },
  );
  await client.send(command);
  const cid = headerCid?.trim();
  if (typeof cid !== "string" || cid.length === 0) {
    throw new Error(`Filebase returned no x-amz-meta-cid header for ${key}`);
  }
  return cid;
}

async function uploadFilebaseFile({
  client,
  bucket,
  key,
  filePath,
  contentType,
}) {
  const fileStat = await stat(filePath);
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: createReadStream(filePath),
    ContentLength: fileStat.size,
    ContentType: contentType,
  });
  let headerCid;
  command.middlewareStack.add(
    (next) => async (args) => {
      const result = await next(args);
      const response = result.response;
      if (
        typeof response === "object" &&
        response !== null &&
        "headers" in response &&
        typeof response.headers === "object" &&
        response.headers !== null
      ) {
        headerCid = response.headers["x-amz-meta-cid"];
      }
      return result;
    },
    {
      step: "deserialize",
      name: `captureFilebaseStreamCid-${key}`,
      priority: "low",
    },
  );
  await client.send(command);
  const cid = headerCid?.trim();
  if (typeof cid !== "string" || cid.length === 0) {
    throw new Error(`Filebase returned no x-amz-meta-cid header for ${key}`);
  }
  return cid;
}

async function fileIntegrity(filePath) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  let bytes = 0;
  for await (const chunk of stream) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, sha256: hash.digest("hex") };
}

async function writePublicationReceipt(filePath, value) {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporaryPath, filePath);
}

export async function publishPermitFilebase(artifacts, config) {
  const env = config.env ?? process.env;
  fillDerivedFilebaseToken(env);
  if (!hasFilebaseCredentials(env)) {
    throw new Error(
      `Filebase credentials are missing for ${artifacts.county}`,
    );
  }
  if (
    typeof config.approvalManifestPath !== "string" ||
    !(await fileExists(config.approvalManifestPath))
  ) {
    throw new Error(
      `Live Filebase permit publish for ${artifacts.county} requires an approval manifest`,
    );
  }
  const paths = {
    permitTable: artifacts.permitTablePath,
    queryTable: artifacts.queryTablePath,
    coverage: artifacts.coveragePath,
    permitCoverage: artifacts.permitCoveragePath,
  };
  const integrity = Object.fromEntries(
    await Promise.all(
      Object.entries(paths).map(async ([name, filePath]) => [
        name,
        await fileIntegrity(filePath),
      ]),
    ),
  );
  const approval = permitFilebaseApprovalSchema.parse(
    JSON.parse(await readFile(config.approvalManifestPath, "utf8")),
  );
  const expected = {
    county: artifacts.county,
    bucket: artifacts.bucket,
    labels: {
      permitTable: artifacts.permitTableIpnsLabel,
      queryTable: artifacts.queryTableIpnsLabel,
      coverage: artifacts.coverageIpnsLabel,
    },
  };
  for (const key of ["county", "bucket"]) {
    if (approval[key] !== expected[key]) {
      throw new Error(`Permit approval ${key} does not match`);
    }
  }
  for (const [name, label] of Object.entries(expected.labels)) {
    if (approval.labels[name] !== label) {
      throw new Error(`Permit approval label ${name} does not match`);
    }
  }
  for (const [name, actual] of Object.entries(integrity)) {
    if (
      approval.artifacts[name].bytes !== actual.bytes ||
      approval.artifacts[name].sha256 !== actual.sha256
    ) {
      throw new Error(
        `Permit approval ${name} integrity does not match`,
      );
    }
  }
  const receiptPath = config.receiptPath;
  if (typeof receiptPath !== "string" || receiptPath.trim().length === 0) {
    throw new Error("Permit publication requires a resumable receipt path");
  }
  let receipt = {
    schemaVersion: "elephant.filebase-permit-publication-receipt.v1",
    county: artifacts.county,
    bucket: artifacts.bucket,
    approvedBy: approval.approvedBy,
    approvedAt: approval.approvedAt,
    artifacts: integrity,
    uploads: {},
    names: {},
    status: "publishing",
  };
  if (await fileExists(receiptPath)) {
    const existing = JSON.parse(await readFile(receiptPath, "utf8"));
    if (
      existing.county !== receipt.county ||
      existing.bucket !== receipt.bucket ||
      JSON.stringify(existing.artifacts) !== JSON.stringify(integrity)
    ) {
      throw new Error("Existing permit publication receipt is incompatible");
    }
    receipt = existing;
  }
  const client = new S3Client({
    region: "us-east-1",
    endpoint: config.endpoint ?? FILEBASE_S3_ENDPOINT,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID.trim(),
      secretAccessKey: env.S3_SECRET_ACCESS_KEY.trim(),
    },
    forcePathStyle: true,
  });
  const contentTypes = {
    permitTable: "application/vnd.apache.parquet",
    queryTable: "application/vnd.apache.parquet",
    coverage: "application/json",
    permitCoverage: "application/json",
  };
  const objectKeys = {
    permitTable: `${artifacts.county}/permit-table.parquet`,
    queryTable: `${artifacts.county}/query-table.parquet`,
    coverage: `${artifacts.county}/dataset-coverage.json`,
    permitCoverage: `${artifacts.county}/permit-coverage.json`,
  };
  for (const name of Object.keys(paths)) {
    if (!receipt.uploads[name]) {
      receipt.uploads[name] = {
        key: objectKeys[name],
        cid: await uploadFilebaseFile({
          client,
          bucket: artifacts.bucket,
          key: objectKeys[name],
          filePath: paths[name],
          contentType: contentTypes[name],
        }),
      };
      await writePublicationReceipt(receiptPath, receipt);
    }
  }
  const token = env.FILEBASE_API_TOKEN.trim();
  const labels = {
    permitTable: artifacts.permitTableIpnsLabel,
    queryTable: artifacts.queryTableIpnsLabel,
    coverage: artifacts.coverageIpnsLabel,
  };
  for (const [name, label] of Object.entries(labels)) {
    if (!receipt.names[name]) {
      receipt.names[name] = await upsertFilebaseName(
        token,
        label,
        receipt.uploads[name].cid,
      );
      await writePublicationReceipt(receiptPath, receipt);
    }
  }
  receipt.status = "complete";
  receipt.completedAt = new Date().toISOString();
  await writePublicationReceipt(receiptPath, receipt);
  return receipt;
}

/**
 * Create or update a Filebase IPNS label to point at a CID.
 *
 * @param {string} token - Filebase platform API bearer token.
 * @param {string} label - Existing IPNS label.
 * @param {string} cid - Target CID.
 * @returns {Promise<{ label: string, network_key: string, cid: string }>} Updated name record.
 */
async function upsertFilebaseName(token, label, cid) {
  const listResponse = await fetch(FILEBASE_NAMES_API, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!listResponse.ok) {
    throw new Error(`Filebase name list failed: ${listResponse.status}`);
  }
  const parsed = await listResponse.json();
  if (!Array.isArray(parsed)) throw new Error("Filebase name list is not an array");
  const existing = parsed.find(
    (entry) => typeof entry === "object" && entry !== null && "label" in entry && entry.label === label,
  );
  const response =
    existing === undefined
      ? await fetch(FILEBASE_NAMES_API, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ label, cid, enabled: true }),
        })
      : await fetch(`${FILEBASE_NAMES_API}/${encodeURIComponent(label)}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ cid }),
        });
  if (!response.ok) {
    throw new Error(`Filebase IPNS upsert failed for ${label}: ${response.status}`);
  }
  return await response.json();
}

/**
 * Publish query-table + coverage artifacts to Filebase.
 *
 * A dry-run (the default and the only mode ever exercised in CI) never
 * touches the network; it reports the bucket/IPNS labels a live publish
 * would target. A live publish is rejected unless both an approval manifest
 * path is supplied (and exists) and Filebase credentials are present in
 * `config.env`.
 *
 * @param {FilebaseArtifacts} artifacts - Parquet/coverage paths and destination labels.
 * @param {PublishFilebaseConfig} config - Dry-run flag, approval manifest, and credentials source.
 * @returns {Promise<{ dryRun: true, bucket: string, queryTableIpnsLabel: string, coverageIpnsLabel: string } | { dryRun: false, queryTableCid: string, coverageCid: string, queryTableIpns: string, coverageIpns: string }>}
 *   Dry-run report, or the published CIDs/IPNS URLs.
 */
export async function publishFilebase(artifacts, config) {
  const env = config.env ?? process.env;

  if (config.dryRun === true) {
    return {
      dryRun: true,
      bucket: artifacts.bucket,
      queryTableIpnsLabel: artifacts.queryTableIpnsLabel,
      coverageIpnsLabel: artifacts.coverageIpnsLabel,
    };
  }

  if (
    typeof config.approvalManifestPath !== "string" ||
    config.approvalManifestPath.trim().length === 0 ||
    !(await fileExists(config.approvalManifestPath))
  ) {
    throw new Error(
      `Live Filebase publish for ${artifacts.county} requires an approval manifest (--approve <path>); refusing to publish without one.`,
    );
  }

  fillDerivedFilebaseToken(env);
  if (!hasFilebaseCredentials(env)) {
    throw new Error(
      `Filebase credentials are missing for ${artifacts.county}. Set S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, and FILEBASE_API_TOKEN (or access+secret so the token can be derived).`,
    );
  }

  const accessKeyId = env.S3_ACCESS_KEY_ID?.trim() ?? "";
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim() ?? "";
  const token = env.FILEBASE_API_TOKEN?.trim() ?? "";
  const client = new S3Client({
    region: "us-east-1",
    endpoint: config.endpoint ?? FILEBASE_S3_ENDPOINT,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });
  const parquetBody = await readFile(artifacts.parquetPath);
  const coverageBody = await readFile(artifacts.coveragePath);
  const approval = JSON.parse(
    await readFile(config.approvalManifestPath, "utf8"),
  );
  validateFilebaseApproval(
    approval,
    artifacts,
    parquetBody,
    coverageBody,
  );
  const queryTableCid = await uploadFilebaseObject({
    client,
    bucket: artifacts.bucket,
    key: `${artifacts.county}/query-table.parquet`,
    body: parquetBody,
    contentType: "application/vnd.apache.parquet",
  });
  const coverageCid = await uploadFilebaseObject({
    client,
    bucket: artifacts.bucket,
    key: `${artifacts.county}/dataset-coverage.json`,
    body: coverageBody,
    contentType: "application/json",
  });
  const queryName = await upsertFilebaseName(token, artifacts.queryTableIpnsLabel, queryTableCid);
  const coverageName = await upsertFilebaseName(token, artifacts.coverageIpnsLabel, coverageCid);
  return {
    dryRun: false,
    queryTableCid,
    coverageCid,
    queryTableIpns: `${FILEBASE_GATEWAY}/ipns/${queryName.network_key}`,
    coverageIpns: `${FILEBASE_GATEWAY}/ipns/${coverageName.network_key}`,
  };
}
