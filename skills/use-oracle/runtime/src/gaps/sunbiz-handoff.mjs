import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

async function getJson(client, bucket, key) {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!response.Body) throw new Error(`S3 object has no body: ${key}`);
  const body = Buffer.from(await response.Body.transformToByteArray());
  const sha256 = createHash("sha256").update(body).digest("hex");
  if (response.Metadata?.sha256 && response.Metadata.sha256 !== sha256) {
    throw new Error(`S3 handoff metadata SHA mismatch for ${key}`);
  }
  return { value: JSON.parse(body.toString("utf8")), sha256, bytes: body.byteLength };
}

async function fileMatches(filePath, receipt) {
  try {
    const fileStat = await stat(filePath);
    if (fileStat.size !== receipt.bytes) return false;
    const body = await readFile(filePath);
    return createHash("sha256").update(body).digest("hex") === receipt.sha256;
  } catch {
    return false;
  }
}

async function downloadReceipt(client, bucket, receipt, filePath) {
  if (await fileMatches(filePath, receipt)) return "skipped";
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: receipt.key }),
  );
  if (!response.Body) throw new Error(`S3 artifact has no body: ${receipt.key}`);
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  await pipeline(response.Body, createWriteStream(temporary));
  if (!(await fileMatches(temporary, receipt))) {
    throw new Error(`Sunbiz artifact integrity failure: ${receipt.logicalPath}`);
  }
  const { rename } = await import("node:fs/promises");
  await rename(temporary, filePath);
  return "downloaded";
}

export async function materializeSunbizHandoff({
  bucket,
  handoffKey,
  outputDir,
  region = "us-east-1",
  concurrency = 8,
}) {
  const client = new S3Client({ region });
  const handoff = await getJson(client, bucket, handoffKey);
  if (
    handoff.value?.stage !== "sunbiz" ||
    handoff.value?.status !== "complete"
  ) {
    throw new Error("Sunbiz handoff must be complete");
  }
  const artifacts = (handoff.value.artifacts ?? []).filter(
    (artifact) =>
      artifact.logicalPath?.startsWith("extract/") ||
      artifact.logicalPath === "enriched/sunbiz-property-links.jsonl",
  );
  if (
    !artifacts.some(
      (artifact) => artifact.logicalPath === "extract/manifest.json",
    ) ||
    !artifacts.some(
      (artifact) =>
        artifact.logicalPath === "enriched/sunbiz-property-links.jsonl",
    )
  ) {
    throw new Error("Sunbiz handoff lacks extract manifest or property links");
  }
  let next = 0;
  let downloaded = 0;
  let skipped = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      const artifact = artifacts[index];
      if (artifact === undefined) return;
      const status = await downloadReceipt(
        client,
        bucket,
        artifact,
        path.join(outputDir, artifact.logicalPath),
      );
      if (status === "downloaded") downloaded += 1;
      else skipped += 1;
    }
  });
  await Promise.all(workers);
  const manifest = {
    schemaVersion: "elephant.sunbiz-handoff-materialization.v1",
    bucket,
    handoffKey,
    handoffSha256: handoff.sha256,
    handoffBytes: handoff.bytes,
    runId: handoff.value.runId,
    artifacts: artifacts.length,
    artifactBytes: artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0),
    downloaded,
    skipped,
    extractDir: path.join(outputDir, "extract"),
    linksPath: path.join(
      outputDir,
      "enriched",
      "sunbiz-property-links.jsonl",
    ),
  };
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    path.join(outputDir, "materialization-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}
