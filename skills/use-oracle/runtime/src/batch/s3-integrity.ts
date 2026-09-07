import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import {
  artifactReceiptSchema,
  canonicalJson,
  type ArtifactReceipt,
} from "./contracts.js";

const MAX_PUT_OBJECT_BYTES = 5 * 1024 ** 3;

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "NoSuchKey" ||
      error.name === "NotFound" ||
      ("$metadata" in error &&
        (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode === 404))
  );
}

function isPreconditionFailed(error: unknown): boolean {
  return (
    error instanceof Error &&
    ("$metadata" in error
      ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode === 412
      : error.name === "PreconditionFailed")
  );
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

function base64Sha256(hexDigest: string): string {
  return Buffer.from(hexDigest, "hex").toString("base64");
}

async function objectBytes(responseBody: unknown): Promise<Uint8Array> {
  if (
    responseBody !== null &&
    typeof responseBody === "object" &&
    "transformToByteArray" in responseBody &&
    typeof responseBody.transformToByteArray === "function"
  ) {
    return responseBody.transformToByteArray();
  }
  throw new Error("S3 returned an unsupported response body");
}

export async function getVerifiedJson(
  client: S3Client,
  bucket: string,
  key: string,
  expectedSha256?: string,
): Promise<unknown> {
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  const body = Buffer.from(await objectBytes(response.Body));
  const actualSha256 = createHash("sha256").update(body).digest("hex");
  const metadataSha256 = response.Metadata?.sha256;
  const requiredSha256 = expectedSha256 ?? metadataSha256;
  if (!requiredSha256 || actualSha256 !== requiredSha256) {
    throw new Error(
      `S3 JSON integrity failure for s3://${bucket}/${key}: ${actualSha256} vs ${requiredSha256 ?? "missing metadata"}`,
    );
  }
  return JSON.parse(body.toString("utf8"));
}

export async function getVerifiedJsonIfExists(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<unknown | null> {
  try {
    return await getVerifiedJson(client, bucket, key);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function putImmutableJson(
  client: S3Client,
  bucket: string,
  key: string,
  value: unknown,
): Promise<{ key: string; bytes: number; sha256: string }> {
  const body = Buffer.from(canonicalJson(value));
  const sha256 = createHash("sha256").update(body).digest("hex");
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: "application/json",
        ContentLength: body.length,
        ChecksumSHA256: base64Sha256(sha256),
        Metadata: { sha256 },
        IfNoneMatch: "*",
      }),
    );
  } catch (error) {
    if (!isPreconditionFailed(error)) throw error;
    await getVerifiedJson(client, bucket, key, sha256);
  }
  return { key, bytes: body.length, sha256 };
}

export async function putImmutableFile(
  client: S3Client,
  bucket: string,
  key: string,
  filePath: string,
  logicalPath: string,
): Promise<ArtifactReceipt> {
  const fileStat = await stat(filePath);
  if (fileStat.size > MAX_PUT_OBJECT_BYTES) {
    throw new Error(
      `Artifact exceeds the single immutable upload limit: ${logicalPath}`,
    );
  }
  const sha256 = await sha256File(filePath);
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: createReadStream(filePath),
        ContentLength: fileStat.size,
        ChecksumSHA256: base64Sha256(sha256),
        Metadata: { sha256, logicalpath: encodeURIComponent(logicalPath) },
        IfNoneMatch: "*",
      }),
    );
  } catch (error) {
    if (!isPreconditionFailed(error)) throw error;
  }
  const head = await client.send(
    new HeadObjectCommand({ Bucket: bucket, Key: key }),
  );
  if (head.ContentLength !== fileStat.size || head.Metadata?.sha256 !== sha256) {
    throw new Error(`Uploaded artifact failed S3 verification: ${logicalPath}`);
  }
  return artifactReceiptSchema.parse({
    logicalPath,
    key,
    bytes: fileStat.size,
    sha256,
  });
}

async function filesRecursively(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(current, entry.name);
      return entry.isDirectory()
        ? filesRecursively(root, entryPath)
        : [path.relative(root, entryPath).replaceAll(path.sep, "/")];
    }),
  );
  return paths.flat().sort();
}

export async function uploadDirectoryImmutable(
  client: S3Client,
  bucket: string,
  prefix: string,
  directory: string,
  options: { exclude?: (logicalPath: string) => boolean } = {},
): Promise<ArtifactReceipt[]> {
  const files = await filesRecursively(directory);
  const receipts: ArtifactReceipt[] = [];
  for (const logicalPath of files) {
    if (options.exclude?.(logicalPath)) continue;
    const filePath = path.join(directory, logicalPath);
    const sha256 = await sha256File(filePath);
    const key = `${prefix}/objects/${sha256}/${logicalPath}`;
    receipts.push(
      await putImmutableFile(
        client,
        bucket,
        key,
        filePath,
        logicalPath,
      ),
    );
  }
  return receipts;
}

export async function downloadVerifiedObject(
  client: S3Client,
  bucket: string,
  receipt: { key: string; bytes: number; sha256: string },
  outputPath: string,
): Promise<void> {
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: receipt.key }),
  );
  if (!response.Body) throw new Error(`S3 object has no body: ${receipt.key}`);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await pipeline(
    response.Body as NodeJS.ReadableStream,
    createWriteStream(outputPath),
  );
  const outputStat = await stat(outputPath);
  const actualSha256 = await sha256File(outputPath);
  if (
    outputStat.size !== receipt.bytes ||
    actualSha256 !== receipt.sha256
  ) {
    throw new Error(`Downloaded object failed integrity check: ${receipt.key}`);
  }
}
