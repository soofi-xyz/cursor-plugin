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
  GetObjectCommand,
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
import {
  EXCLUDED_SUNBIZ_FIELDS,
  PUBLIC_SUNBIZ_FIELDS,
} from "./property-consolidation.mjs";

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
    destinations: z
      .object({
        propertyDocumentsBucket: z.string().min(1),
        propertyDocumentsIpnsLabel: z.string().min(1),
        placesBucket: z.string().min(1),
        placesIpnsLabel: z.string().min(1),
        queryTableBucket: z.string().min(1),
        queryTableIpnsLabel: z.string().min(1),
      })
      .strict(),
    publicationBounds: z
      .object({
        uploadConcurrency: z.number().int().min(1).max(16),
        checkpointEvery: z.number().int().min(100).max(10_000),
      })
      .strict(),
    privacyPolicy: z
      .object({
        ownerOccupied: z.string().min(1),
        sunbizPublicFields: z.array(z.string().min(1)),
        sunbizExcludedFields: z.array(z.string().min(1)),
        bbbProfilesPublished: z.literal(false),
        placesEmailsPublished: z.literal(false),
        placesPhonesPublished: z.literal(false),
      })
      .strict(),
    createsDedicatedLabels: z.array(z.string().min(1)).length(2),
    humanPiiApproval: z.literal(true),
    approved: z.literal(true),
    approvedBy: z.string().min(1),
    approvedAt: z.string().datetime({ offset: true }),
  })
  .strict();

const OWNER_OCCUPIED_POLICY =
  "AV_HMSTD > 0 true; = 0 false; blank, unparseable, or unmatched null";

function gapPrivacyPolicy() {
  return {
    ownerOccupied: OWNER_OCCUPIED_POLICY,
    sunbizPublicFields: [...PUBLIC_SUNBIZ_FIELDS],
    sunbizExcludedFields: [...EXCLUDED_SUNBIZ_FIELDS],
    bbbProfilesPublished: false,
    placesEmailsPublished: false,
    placesPhonesPublished: false,
  };
}

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

async function readBackObject({
  client,
  bucket,
  key,
  expectedBytes,
  expectedSha256,
}) {
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  if (response.Body === undefined) {
    throw new Error(`Filebase readback returned no body for ${bucket}/${key}`);
  }
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of response.Body) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  const sha256 = hash.digest("hex");
  if (bytes !== expectedBytes || sha256 !== expectedSha256) {
    throw new Error(
      `Filebase readback failed for ${bucket}/${key}: ` +
        `${bytes}/${sha256} != ${expectedBytes}/${expectedSha256}`,
    );
  }
  return { bucket, key, bytes, sha256 };
}

function assertApprovalIntegrity(approval, integrity) {
  for (const key of Object.keys(integrity)) {
    if (JSON.stringify(approval.artifacts[key]) !== JSON.stringify(integrity[key])) {
      throw new Error(`Approval integrity mismatch for ${key}`);
    }
  }
}

export function validateGapApproval(value, plan, profile) {
  const approval = gapApprovalSchema.parse(value);
  assertApprovalIntegrity(approval, plan.artifacts);
  for (const key of [
    "destinations",
    "publicationBounds",
    "privacyPolicy",
    "createsDedicatedLabels",
  ]) {
    if (JSON.stringify(approval[key]) !== JSON.stringify(plan[key])) {
      throw new Error(`Approval ${key} does not match the publication plan`);
    }
  }
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
  return approval;
}

async function uploadPropertyDocuments({
  client,
  bucket,
  propertyOutputDir,
  entries,
  receipt,
  persistReceipt,
  concurrency = 16,
  checkpointEvery = 10_000,
  onProgress = async () => {},
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
        checkpointWrites = checkpointWrites.then(async () => {
          await persistReceipt(snapshot);
          await onProgress({
            stage: "filebase-property-upload",
            completedObjects: Object.keys(snapshot.uploads).length,
            totalObjects: entries.length,
          });
        });
      }
    }
  });
  await Promise.all(workers);
  await checkpointWrites;
  await persistReceipt(receipt);
}

export async function publishDuvalGapArtifacts({
  profile,
  propertyOutputDir,
  placesOutputDir,
  queryTablePath,
  approvalPath = null,
  receiptPath,
  dryRun = true,
  checkpointStore = null,
  checkpointIdentity = null,
  uploadConcurrency = 8,
  checkpointEvery = 10_000,
  onProgress = async () => {},
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
    checkpointIdentity,
    publicationBounds: {
      uploadConcurrency,
      checkpointEvery,
    },
    privacyPolicy: gapPrivacyPolicy(),
    createsDedicatedLabels: [
      profile.publication.propertyDocumentsIpnsLabel,
      profile.publication.placesIpnsLabel,
    ],
    forbiddenOperations: [
      "appraisal ingest",
      "permit ingest",
      "BBB submission",
      "permit IPNS repoint",
      "coverage IPNS repoint",
    ],
  };
  await atomicJson(
    path.join(path.dirname(receiptPath), "publication-plan.json"),
    plan,
  );
  if (dryRun) return plan;

  if (approvalPath === null) {
    throw new Error("Live Duval gap publication requires exact-byte approval");
  }
  const approval = validateGapApproval(
    JSON.parse(await readFile(approvalPath, "utf8")),
    plan,
    profile,
  );
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
    checkpointIdentity,
    uploads: {},
    names: {},
  };
  const persistReceipt = async (value) => {
    const snapshot = structuredClone(value);
    snapshot.checkpoint = {
      uploadCount: Object.keys(snapshot.uploads ?? {}).length,
      savedAt: new Date().toISOString(),
    };
    await atomicJson(receiptPath, snapshot);
    if (checkpointStore?.save) await checkpointStore.save(snapshot);
  };
  try {
    const remoteReceipt = checkpointStore?.load
      ? await checkpointStore.load()
      : null;
    receipt =
      remoteReceipt ??
      JSON.parse(await readFile(receiptPath, "utf8"));
    if (JSON.stringify(receipt.artifacts) !== JSON.stringify(integrity)) {
      throw new Error("Existing publication receipt is for different bytes");
    }
    if (
      JSON.stringify(receipt.checkpointIdentity ?? null) !==
      JSON.stringify(checkpointIdentity)
    ) {
      throw new Error("Existing publication receipt has different provenance");
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
    await persistReceipt(receipt);
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
    persistReceipt,
    concurrency: uploadConcurrency,
    checkpointEvery,
    onProgress,
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
  await persistReceipt(receipt);

  const propertySamples = [
    propertyManifest.entries?.[0],
    propertyManifest.entries?.[
      Math.floor((propertyManifest.entries?.length ?? 1) / 2)
    ],
    propertyManifest.entries?.at(-1),
  ].filter(
    (entry, index, values) =>
      entry !== undefined &&
      values.findIndex((candidate) => candidate?.filePath === entry.filePath) ===
        index,
  );
  const readbackTargets = [
    {
      bucket: profile.publication.propertyDocumentsBucket,
      key: "index.json",
      expectedBytes: integrity.propertyIndex.bytes,
      expectedSha256: integrity.propertyIndex.sha256,
    },
    {
      bucket: profile.publication.propertyDocumentsBucket,
      key: "manifest.json",
      expectedBytes: integrity.propertyManifest.bytes,
      expectedSha256: integrity.propertyManifest.sha256,
    },
    ...propertySamples.map((entry) => ({
      bucket: profile.publication.propertyDocumentsBucket,
      key: entry.filePath,
      expectedBytes: entry.fileSizeBytes,
      expectedSha256: entry.sha256,
    })),
    {
      bucket: profile.publication.placesBucket,
      key: `${profile.countyKey}/places-table.parquet`,
      expectedBytes: integrity.placesTable.bytes,
      expectedSha256: integrity.placesTable.sha256,
    },
    {
      bucket: profile.publication.placesBucket,
      key: `${profile.countyKey}/index.json`,
      expectedBytes: integrity.placesIndex.bytes,
      expectedSha256: integrity.placesIndex.sha256,
    },
    {
      bucket: profile.publication.placesBucket,
      key: "NOTICE.txt",
      expectedBytes: integrity.placesNotice.bytes,
      expectedSha256: integrity.placesNotice.sha256,
    },
    {
      bucket: profile.publication.queryTableBucket,
      key: queryKey,
      expectedBytes: integrity.queryTable.bytes,
      expectedSha256: integrity.queryTable.sha256,
    },
  ];
  receipt.remoteReadback = [];
  for (const target of readbackTargets) {
    receipt.remoteReadback.push(
      await readBackObject({ client, ...target }),
    );
  }
  await persistReceipt(receipt);

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
  await persistReceipt(receipt);
  return receipt;
}
