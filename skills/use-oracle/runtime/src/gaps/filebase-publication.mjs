import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  CreateBucketCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutBucketTaggingCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { z } from "zod";

import {
  FILEBASE_NAMES_API,
  FILEBASE_S3_ENDPOINT,
  fillDerivedFilebaseToken,
  hasFilebaseCredentials,
} from "../core/filebase.mjs";
import { computeUnixFsCid } from "./canonical-json.mjs";

export const GAP_APPROVAL_SCHEMA_VERSION =
  "elephant.duval-mcp-gap-publish-approval.v1";

const integritySchema = z
  .object({
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    cid: z.string().min(1),
  })
  .strict();

const gapApprovalSchema = z
  .object({
    schemaVersion: z.literal(GAP_APPROVAL_SCHEMA_VERSION),
    action: z.literal("publish-duval-mcp-gap-artifacts"),
    county: z.literal("duval"),
    protectedCids: z
      .object({
        queryTable: z.string().min(1),
        permitTable: z.string().min(1),
        coverage: z.string().min(1),
      })
      .strict(),
    artifacts: z
      .object({
        propertyIndex: integritySchema,
        propertyManifest: integritySchema,
        placesTable: integritySchema,
        placesIndex: integritySchema,
        placesNotice: integritySchema,
        queryTable: integritySchema,
      })
      .strict(),
    humanPiiApproval: z.literal(true),
    approved: z.literal(true),
    approvedBy: z.string().min(1),
    approvedAt: z.string().datetime({ offset: true }),
  })
  .strict();

async function fileIntegrity(filePath) {
  const body = await readFile(filePath);
  return {
    bytes: body.byteLength,
    sha256: createHash("sha256").update(body).digest("hex"),
    cid: await computeUnixFsCid(body),
  };
}

async function atomicJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, filePath);
}

async function listNames(token) {
  const response = await fetch(FILEBASE_NAMES_API, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Filebase names list failed: HTTP ${response.status}`);
  }
  const names = await response.json();
  if (!Array.isArray(names)) throw new Error("Filebase names response is invalid");
  return names;
}

function nameByLabel(names, label) {
  return names.find((entry) => entry?.label === label) ?? null;
}

async function setName(token, names, label, cid, allowRepoint) {
  const existing = nameByLabel(names, label);
  if (existing !== null && existing.cid === cid) return existing;
  if (existing !== null && !allowRepoint) {
    throw new Error(`Refusing to repoint dedicated IPNS label ${label}`);
  }
  const response =
    existing === null
      ? await fetch(FILEBASE_NAMES_API, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ label, cid, enabled: true }),
        })
      : await fetch(`${FILEBASE_NAMES_API}/${encodeURIComponent(label)}`, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ cid }),
        });
  if (!response.ok) {
    throw new Error(`Filebase IPNS write failed for ${label}: ${response.status}`);
  }
  return response.json();
}

export function assertProtectedNames(names, profile, queryTargetCid = null) {
  const expected = profile.protectedPublications;
  for (const [key, target] of [
    ["permitTable", expected.permitTable],
    ["coverage", expected.coverage],
  ]) {
    const actual = nameByLabel(names, target.label);
    if (
      actual?.network_key !== target.networkKey ||
      actual?.cid !== target.frozenCid
    ) {
      throw new Error(`Protected ${key} IPNS identity changed; refusing publish`);
    }
  }
  const query = nameByLabel(names, profile.publication.queryTableIpnsLabel);
  if (
    query?.network_key !== expected.queryTable.networkKey ||
    ![expected.queryTable.frozenCid, queryTargetCid].includes(query?.cid)
  ) {
    throw new Error("Protected query-table IPNS identity changed; refusing publish");
  }
}

async function ensureBucket(client, bucket) {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (error) {
    const status =
      error !== null &&
      typeof error === "object" &&
      "$metadata" in error
        ? error.$metadata?.httpStatusCode
        : undefined;
    if (
      status !== 404 &&
      (!(error instanceof Error) ||
        !["NotFound", "NoSuchBucket"].includes(error.name))
    ) {
      throw error;
    }
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

async function assertPlacesBucketKeys(client, bucket, county, requireComplete) {
  const allowed = new Set([
    "NOTICE.txt",
    `${county}/index.json`,
    `${county}/places-table.parquet`,
  ]);
  const observed = [];
  let continuationToken;
  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuationToken,
      }),
    );
    observed.push(
      ...(response.Contents ?? []).flatMap((entry) =>
        typeof entry.Key === "string" ? [entry.Key] : [],
      ),
    );
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);
  const unexpected = observed.filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new Error(
      `Dedicated places bucket contains unexpected keys: ${unexpected.join(", ")}`,
    );
  }
  if (
    requireComplete &&
    (observed.length !== allowed.size ||
      [...allowed].some((key) => !observed.includes(key)))
  ) {
    throw new Error("Dedicated places bucket is missing publication objects");
  }
}

async function putFile(client, bucket, key, filePath, contentType) {
  const fileStat = await stat(filePath);
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: createReadStream(filePath),
    ContentLength: fileStat.size,
    ContentType: contentType,
  });
  let cid = null;
  command.middlewareStack.add(
    (next) => async (args) => {
      const result = await next(args);
      cid = result.response?.headers?.["x-amz-meta-cid"] ?? null;
      return result;
    },
    {
      step: "deserialize",
      name: `captureGapCid-${createHash("sha256").update(`${bucket}/${key}`).digest("hex").slice(0, 12)}`,
      priority: "low",
    },
  );
  await client.send(command);
  if (typeof cid !== "string" || cid.length === 0) {
    throw new Error(`Filebase returned no CID for s3://${bucket}/${key}`);
  }
  return cid;
}

async function generateBucketDirectoryCid(client, bucket) {
  const command = new PutBucketTaggingCommand({
    Bucket: bucket,
    Tagging: {
      TagSet: [{ Key: "generateBucketCid", Value: "true" }],
    },
  });
  let cid = null;
  command.middlewareStack.add(
    (next) => async (args) => {
      const result = await next(args);
      cid = result.response?.headers?.["x-amz-meta-cid"] ?? null;
      return result;
    },
    {
      step: "deserialize",
      name: `captureGapBucketCid-${createHash("sha256").update(bucket).digest("hex").slice(0, 12)}`,
      priority: "low",
    },
  );
  await client.send(command);
  if (typeof cid !== "string" || cid.length === 0) {
    throw new Error(`Filebase returned no directory CID for bucket ${bucket}`);
  }
  return cid;
}

async function uploadCheckedFile(options) {
  const cid = await putFile(
    options.client,
    options.bucket,
    options.key,
    options.filePath,
    options.contentType,
  );
  if (cid !== options.expectedCid) {
    throw new Error(
      `CID mismatch for ${options.key}: ${cid} != ${options.expectedCid}`,
    );
  }
  return cid;
}

function assertApprovalIntegrity(approval, integrity) {
  for (const key of Object.keys(integrity)) {
    if (JSON.stringify(approval.artifacts[key]) !== JSON.stringify(integrity[key])) {
      throw new Error(`Approval integrity mismatch for ${key}`);
    }
  }
}

async function uploadPropertyDocuments({
  client,
  bucket,
  propertyOutputDir,
  entries,
  receipt,
  receiptPath,
  concurrency = 16,
  checkpointEvery = 10_000,
}) {
  let next = 0;
  let completedSinceCheckpoint = 0;
  let checkpointWrites = Promise.resolve();
  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      const entry = entries[index];
      if (entry === undefined) return;
      const key = entry.filePath;
      if (receipt.uploads[key] === entry.cid) continue;
      await uploadCheckedFile({
        client,
        bucket,
        key,
        filePath: path.join(propertyOutputDir, entry.filePath),
        contentType: "application/json",
        expectedCid: entry.cid,
      });
      receipt.uploads[key] = entry.cid;
      completedSinceCheckpoint += 1;
      if (completedSinceCheckpoint >= checkpointEvery) {
        completedSinceCheckpoint = 0;
        const snapshot = structuredClone(receipt);
        checkpointWrites = checkpointWrites.then(() =>
          atomicJson(receiptPath, snapshot),
        );
      }
    }
  });
  await Promise.all(workers);
  await checkpointWrites;
  await atomicJson(receiptPath, receipt);
}

export async function publishDuvalGapArtifacts({
  profile,
  propertyOutputDir,
  placesOutputDir,
  queryTablePath,
  approvalPath = null,
  receiptPath,
  dryRun = true,
  env = process.env,
}) {
  const paths = {
    propertyIndex: path.join(propertyOutputDir, "index.json"),
    propertyManifest: path.join(propertyOutputDir, "manifest.json"),
    placesTable: path.join(placesOutputDir, "places-table.parquet"),
    placesIndex: path.join(placesOutputDir, "index.json"),
    placesNotice: path.join(placesOutputDir, "NOTICE.txt"),
    queryTable: queryTablePath,
  };
  const integrity = Object.fromEntries(
    await Promise.all(
      Object.entries(paths).map(async ([key, filePath]) => [
        key,
        await fileIntegrity(filePath),
      ]),
    ),
  );
  const plan = {
    schemaVersion: "elephant.duval-mcp-gap-publish-plan.v1",
    county: "duval",
    dryRun,
    destinations: profile.publication,
    protectedPublications: profile.protectedPublications,
    artifacts: integrity,
    forbiddenOperations: [
      "appraisal ingest",
      "permit ingest",
      "BBB submission",
      "permit IPNS repoint",
      "coverage IPNS repoint",
    ],
  };
  if (dryRun) return plan;

  if (approvalPath === null) {
    throw new Error("Live Duval gap publication requires exact-byte approval");
  }
  const approval = gapApprovalSchema.parse(
    JSON.parse(await readFile(approvalPath, "utf8")),
  );
  assertApprovalIntegrity(approval, integrity);
  if (
    approval.protectedCids.queryTable !==
      profile.protectedPublications.queryTable.frozenCid ||
    approval.protectedCids.permitTable !==
      profile.protectedPublications.permitTable.frozenCid ||
    approval.protectedCids.coverage !==
      profile.protectedPublications.coverage.frozenCid
  ) {
    throw new Error("Approval protected CIDs do not match the frozen profile");
  }
  fillDerivedFilebaseToken(env);
  if (!hasFilebaseCredentials(env)) {
    throw new Error("Filebase credentials are missing");
  }
  const namesBefore = await listNames(env.FILEBASE_API_TOKEN);
  assertProtectedNames(namesBefore, profile, integrity.queryTable.cid);

  const client = new S3Client({
    endpoint: FILEBASE_S3_ENDPOINT,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
  });
  await Promise.all([
    ensureBucket(client, profile.publication.propertyDocumentsBucket),
    ensureBucket(client, profile.publication.placesBucket),
  ]);
  await assertPlacesBucketKeys(
    client,
    profile.publication.placesBucket,
    profile.countyKey,
    false,
  );

  let receipt = {
    schemaVersion: "elephant.duval-mcp-gap-publication-receipt.v1",
    status: "uploading",
    approvedBy: approval.approvedBy,
    approvedAt: approval.approvedAt,
    artifacts: integrity,
    uploads: {},
    names: {},
  };
  try {
    receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    if (JSON.stringify(receipt.artifacts) !== JSON.stringify(integrity)) {
      throw new Error("Existing publication receipt is for different bytes");
    }
    if (
      receipt.uploads === null ||
      typeof receipt.uploads !== "object" ||
      Array.isArray(receipt.uploads)
    ) {
      throw new Error("Existing publication receipt has invalid uploads state");
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
    await atomicJson(receiptPath, receipt);
  }

  const propertyManifest = JSON.parse(
    await readFile(paths.propertyManifest, "utf8"),
  );
  await uploadPropertyDocuments({
    client,
    bucket: profile.publication.propertyDocumentsBucket,
    propertyOutputDir,
    entries: propertyManifest.entries ?? [],
    receipt,
    receiptPath,
  });
  const index = JSON.parse(await readFile(paths.propertyIndex, "utf8"));
  for (const shard of index.shards ?? []) {
    const key = `shards/shard-${String(shard.shardIndex).padStart(4, "0")}.json`;
    if (receipt.uploads[key] === shard.shardCid) continue;
    await uploadCheckedFile({
      client,
      bucket: profile.publication.propertyDocumentsBucket,
      key,
      filePath: path.join(propertyOutputDir, key),
      contentType: "application/json",
      expectedCid: shard.shardCid,
    });
    receipt.uploads[key] = shard.shardCid;
  }
  for (const [key, filePath, expectedCid] of [
    ["manifest.json", paths.propertyManifest, integrity.propertyManifest.cid],
    ["index.json", paths.propertyIndex, integrity.propertyIndex.cid],
  ]) {
    if (receipt.uploads[key] !== expectedCid) {
      await uploadCheckedFile({
        client,
        bucket: profile.publication.propertyDocumentsBucket,
        key,
        filePath,
        contentType: "application/json",
        expectedCid,
      });
      receipt.uploads[key] = expectedCid;
    }
  }
  for (const [key, filePath, expectedCid, contentType] of [
    [
      `${profile.countyKey}/places-table.parquet`,
      paths.placesTable,
      integrity.placesTable.cid,
      "application/vnd.apache.parquet",
    ],
    [
      `${profile.countyKey}/index.json`,
      paths.placesIndex,
      integrity.placesIndex.cid,
      "application/json",
    ],
    [
      "NOTICE.txt",
      paths.placesNotice,
      integrity.placesNotice.cid,
      "text/plain",
    ],
  ]) {
    const checkpointKey = `places/${key}`;
    if (receipt.uploads[checkpointKey] === expectedCid) continue;
    await uploadCheckedFile({
      client,
      bucket: profile.publication.placesBucket,
      key,
      filePath,
      contentType,
      expectedCid,
    });
    receipt.uploads[checkpointKey] = expectedCid;
  }
  await assertPlacesBucketKeys(
    client,
    profile.publication.placesBucket,
    profile.countyKey,
    true,
  );
  const placesDirectoryCid = await generateBucketDirectoryCid(
    client,
    profile.publication.placesBucket,
  );
  receipt.placesDirectoryCid = placesDirectoryCid;
  const queryKey = `duval/query-table-${integrity.queryTable.sha256}.parquet`;
  if (receipt.uploads[queryKey] !== integrity.queryTable.cid) {
    await uploadCheckedFile({
      client,
      bucket: profile.publication.queryTableBucket,
      key: queryKey,
      filePath: paths.queryTable,
      contentType: "application/vnd.apache.parquet",
      expectedCid: integrity.queryTable.cid,
    });
    receipt.uploads[queryKey] = integrity.queryTable.cid;
  }
  await atomicJson(receiptPath, receipt);

  const namesCurrent = await listNames(env.FILEBASE_API_TOKEN);
  assertProtectedNames(namesCurrent, profile, integrity.queryTable.cid);
  receipt.names.propertyDocuments = await setName(
    env.FILEBASE_API_TOKEN,
    namesCurrent,
    profile.publication.propertyDocumentsIpnsLabel,
    integrity.propertyIndex.cid,
    false,
  );
  const namesAfterOpenData = await listNames(env.FILEBASE_API_TOKEN);
  receipt.names.places = await setName(
    env.FILEBASE_API_TOKEN,
    namesAfterOpenData,
    profile.publication.placesIpnsLabel,
    placesDirectoryCid,
    false,
  );
  receipt.placesTableUrl =
    `https://ipfs.filebase.io/ipns/${receipt.names.places.network_key}` +
    `/${profile.countyKey}/places-table.parquet`;
  const namesAfterPlaces = await listNames(env.FILEBASE_API_TOKEN);
  assertProtectedNames(
    namesAfterPlaces,
    profile,
    integrity.queryTable.cid,
  );
  receipt.names.queryTable = await setName(
    env.FILEBASE_API_TOKEN,
    namesAfterPlaces,
    profile.publication.queryTableIpnsLabel,
    integrity.queryTable.cid,
    true,
  );
  const namesAfter = await listNames(env.FILEBASE_API_TOKEN);
  assertProtectedNames(namesAfter, profile, integrity.queryTable.cid);
  receipt.status = "complete";
  receipt.completedAt = new Date().toISOString();
  await atomicJson(receiptPath, receipt);
  return receipt;
}
