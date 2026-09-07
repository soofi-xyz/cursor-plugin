import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_ARCHIVE_BYTES = 3 * 1024 ** 3;
const DEFAULT_MAX_EXPANDED_BYTES = 25 * 1024 ** 3;

export function validateSunbizArchiveEntries(
  entries,
  { maxExpandedBytes = DEFAULT_MAX_EXPANDED_BYTES } = {},
) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("Sunbiz archive contains no entries");
  }
  let expandedBytes = 0;
  const fileNames = [];
  for (const entry of entries) {
    const normalizedName = String(entry.name).replaceAll("\\", "/");
    if (
      normalizedName.startsWith("/") ||
      normalizedName.includes("../") ||
      path.posix.isAbsolute(normalizedName)
    ) {
      throw new Error(`Unsafe Sunbiz archive entry: ${normalizedName}`);
    }
    if (!/^cordata[^/]*\.txt$/i.test(normalizedName)) {
      throw new Error(`Unexpected Sunbiz archive entry: ${normalizedName}`);
    }
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      throw new Error(`Invalid size for Sunbiz archive entry: ${normalizedName}`);
    }
    expandedBytes += entry.bytes;
    if (expandedBytes > maxExpandedBytes) {
      throw new Error(
        `Sunbiz archive expands beyond ${maxExpandedBytes} bytes`,
      );
    }
    fileNames.push(normalizedName);
  }
  return { fileNames: fileNames.sort(), expandedBytes };
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function listArchiveEntries(archivePath) {
  const { stdout } = await execFileAsync("unzip", ["-l", archivePath], {
    maxBuffer: 10 * 1024 * 1024,
  });
  const entries = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+\S+\s+\S+\s+(.+?)\s*$/.exec(line);
    if (!match || /^-+$/.test(match[2]) || match[2] === "Name") continue;
    entries.push({ bytes: Number(match[1]), name: match[2] });
  }
  return entries;
}

export async function prepareSunbizArchive({
  archivePath,
  outputDir,
  expectedSha256,
  maxArchiveBytes = DEFAULT_MAX_ARCHIVE_BYTES,
  maxExpandedBytes = DEFAULT_MAX_EXPANDED_BYTES,
}) {
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256)) {
    throw new Error("Sunbiz archive requires an expected SHA-256 digest");
  }
  const archiveStat = await stat(archivePath);
  if (archiveStat.size > maxArchiveBytes) {
    throw new Error(
      `Sunbiz archive exceeds ${maxArchiveBytes} bytes: ${archiveStat.size}`,
    );
  }
  const actualSha256 = await sha256File(archivePath);
  if (actualSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new Error(
      `Sunbiz archive SHA-256 mismatch: ${actualSha256} vs ${expectedSha256}`,
    );
  }
  const entries = await listArchiveEntries(archivePath);
  const validated = validateSunbizArchiveEntries(entries, {
    maxExpandedBytes,
  });
  const existing = await readdir(outputDir).catch((error) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  if (existing.length > 0) {
    throw new Error(`Sunbiz extraction directory is not empty: ${outputDir}`);
  }
  await mkdir(outputDir, { recursive: true });
  await execFileAsync("unzip", ["-t", archivePath], {
    maxBuffer: 10 * 1024 * 1024,
  });
  await execFileAsync("unzip", ["-q", archivePath, "-d", outputDir], {
    maxBuffer: 10 * 1024 * 1024,
  });
  const extractedFiles = (await readdir(outputDir))
    .filter((name) => /^cordata.*\.txt$/i.test(name))
    .sort();
  if (JSON.stringify(extractedFiles) !== JSON.stringify(validated.fileNames)) {
    throw new Error("Sunbiz extracted files do not match the validated archive entries");
  }
  const receipt = {
    schemaVersion: "elephant.sunbiz-archive-preparation.v1",
    archive: {
      fileName: path.basename(archivePath),
      bytes: archiveStat.size,
      sha256: actualSha256,
    },
    expandedBytes: validated.expandedBytes,
    extractedFiles,
  };
  await writeFile(
    path.join(outputDir, "source-receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    "utf8",
  );
  return receipt;
}
