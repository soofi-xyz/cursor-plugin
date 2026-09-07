import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export function stableArtifactKey(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 24);
}

export async function atomicWriteJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
  await rename(temporaryPath, filePath);
}

export async function writeImmutableJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify(value, null, 2)}\n`,
    {
      encoding: "utf8",
      flag: "wx",
    },
  );
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function fileIntegrity(filePath) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  const details = await stat(filePath);
  return { bytes: details.size, sha256: hash.digest("hex") };
}

export function artifactPaths(outputDir, jurisdictionKey, parcelIdentifier) {
  const key = stableArtifactKey(
    `${jurisdictionKey}\u0000${parcelIdentifier}`,
  );
  return {
    key,
    raw: path.join(outputDir, "raw", jurisdictionKey, `${key}.json`),
    extracted: path.join(
      outputDir,
      "extracted",
      jurisdictionKey,
      `${key}.json`,
    ),
    status: path.join(
      outputDir,
      "status",
      jurisdictionKey,
      `${key}.json`,
    ),
  };
}
