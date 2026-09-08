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

import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const require = createRequire(import.meta.url);
/** @type {{ of: (data: Buffer) => Promise<string> }} */
const ipfsHash = require("ipfs-only-hash");

export const FILEBASE_S3_ENDPOINT = "https://s3.filebase.com";
export const FILEBASE_NAMES_API = "https://api.filebase.io/v1/names";
export const FILEBASE_GATEWAY = "https://ipfs.filebase.io";

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
export async function uploadFilebaseObject({ client, bucket, key, body, contentType }) {
  const localCid = await ipfsHash.of(body);
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
  const cid = headerCid?.trim() || localCid;
  if (typeof cid !== "string" || cid.length === 0) {
    throw new Error(`Filebase returned no CID for ${key}`);
  }
  return cid;
}

/**
 * Create or update a Filebase IPNS label to point at a CID.
 *
 * @param {string} token - Filebase platform API bearer token.
 * @param {string} label - Existing IPNS label.
 * @param {string} cid - Target CID.
 * @param {(input: string | URL | Request, init?: RequestInit) => Promise<Response>} [fetchImpl]
 *   Fetch implementation. Defaults to global fetch.
 * @returns {Promise<{ label: string, network_key: string, cid: string }>} Updated name record.
 */
export async function upsertFilebaseName(token, label, cid, fetchImpl = fetch) {
  const listResponse = await fetchImpl(FILEBASE_NAMES_API, {
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
      ? await fetchImpl(FILEBASE_NAMES_API, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ label, cid, enabled: true }),
        })
      : await fetchImpl(`${FILEBASE_NAMES_API}/${encodeURIComponent(label)}`, {
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
 * Update an existing Filebase IPNS label after proving that it resolves to
 * the expected network key. Coverage-only repairs use this stricter path so
 * a typo cannot create a second label or move another county's pointer.
 *
 * @param {string} token - Filebase platform API bearer token.
 * @param {string} label - Existing coverage IPNS label.
 * @param {string} expectedNetworkKey - Current resolvable k51... name.
 * @param {string} cid - New coverage artifact CID.
 * @param {(input: string | URL | Request, init?: RequestInit) => Promise<Response>} [fetchImpl]
 *   Fetch implementation. Defaults to global fetch.
 * @returns {Promise<{ label: string, network_key: string, cid: string }>} Updated name record.
 */
export async function updateExistingFilebaseName(
  token,
  label,
  expectedNetworkKey,
  cid,
  fetchImpl = fetch,
) {
  const listResponse = await fetchImpl(FILEBASE_NAMES_API, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!listResponse.ok) {
    throw new Error(`Filebase name list failed: ${listResponse.status}`);
  }
  const parsed = await listResponse.json();
  if (!Array.isArray(parsed)) throw new Error("Filebase name list is not an array");
  const existing = parsed.find(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      "label" in entry &&
      entry.label === label,
  );
  if (
    existing === undefined ||
    !("network_key" in existing) ||
    existing.network_key !== expectedNetworkKey
  ) {
    throw new Error(
      `Filebase IPNS label ${label} is missing or does not match expected network key ${expectedNetworkKey}`,
    );
  }
  const response = await fetchImpl(
    `${FILEBASE_NAMES_API}/${encodeURIComponent(label)}`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ cid }),
    },
  );
  if (!response.ok) {
    throw new Error(`Filebase IPNS update failed for ${label}: ${response.status}`);
  }
  const updated = await response.json();
  if (
    typeof updated !== "object" ||
    updated === null ||
    updated.label !== label ||
    updated.network_key !== expectedNetworkKey
  ) {
    throw new Error(`Filebase returned an unexpected IPNS record for ${label}`);
  }
  return updated;
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
