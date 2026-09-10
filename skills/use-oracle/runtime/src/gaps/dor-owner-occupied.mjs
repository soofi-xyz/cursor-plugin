import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import { DuckDBInstance } from "@duckdb/node-api";

const execFileAsync = promisify(execFile);

export const DUVAL_2026_PRELIMINARY_NAL_URL =
  "https://floridarevenue.com/property/dataportal/Documents/PTO%20Data%20Portal/Tax%20Roll%20Data%20Files/NAL/2026P/Duval%2026%20Preliminary%20NAL%202026.zip";

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function findNalFile(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      try {
        return await findNalFile(fullPath);
      } catch {
        continue;
      }
    }
    if (/\.(csv|txt)$/i.test(entry.name)) return fullPath;
  }
  throw new Error("Duval NAL archive contains no CSV/TXT file");
}

async function queryRows(connection, sql) {
  const reader = await connection.runAndReadAll(sql);
  return reader.getRowObjectsJson();
}

export async function extractDuvalOwnerOccupied({
  outputDir,
  cacheDir,
  frozenAt,
  sourceUrl = DUVAL_2026_PRELIMINARY_NAL_URL,
  expectedSourceSha256 = null,
  expectedRowCount = 404_023,
}) {
  await Promise.all([
    mkdir(outputDir, { recursive: true }),
    mkdir(cacheDir, { recursive: true }),
  ]);
  const archivePath = path.join(cacheDir, "duval-2026-preliminary-nal.zip");
  try {
    await stat(archivePath);
  } catch {
    const response = await fetch(sourceUrl);
    if (!response.ok || response.body === null) {
      throw new Error(`Duval NAL download failed: HTTP ${response.status}`);
    }
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(archivePath),
    );
  }
  const archive = await readFile(archivePath);
  const sourceSha256 = createHash("sha256").update(archive).digest("hex");
  if (
    expectedSourceSha256 !== null &&
    sourceSha256 !== expectedSourceSha256
  ) {
    throw new Error(
      `Duval NAL SHA-256 ${sourceSha256} does not match ${expectedSourceSha256}`,
    );
  }
  const expandedDir = path.join(cacheDir, sourceSha256);
  await mkdir(expandedDir, { recursive: true });
  await execFileAsync("unzip", ["-o", archivePath, "-d", expandedDir]);
  const nalPath = await findNalFile(expandedDir);
  const outputPath = path.join(outputDir, "owner-occupied-nal.jsonl");

  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    const source = `read_csv_auto(${sqlString(nalPath)}, header=true, all_varchar=true, sample_size=-1, ignore_errors=false)`;
    const columns = await queryRows(
      connection,
      `DESCRIBE SELECT * FROM ${source}`,
    );
    const names = columns.map((row) => String(row.column_name).toUpperCase());
    for (const required of ["PARCEL_ID", "AV_HMSTD"]) {
      if (!names.includes(required)) {
        throw new Error(`Duval NAL is missing ${required}`);
      }
    }
    await connection.run(`
      COPY (
        SELECT
          concat(
            substr(regexp_replace(trim(PARCEL_ID), 'R$', ''), 1, 6),
            '-',
            substr(regexp_replace(trim(PARCEL_ID), 'R$', ''), 7, 4)
          ) AS parcel_identifier,
          AV_HMSTD
        FROM ${source}
        ORDER BY parcel_identifier
      ) TO ${sqlString(outputPath)} (FORMAT JSON, ARRAY false);
    `);
    const counts = await queryRows(
      connection,
      `SELECT
         count(*) AS total,
         count(*) FILTER (WHERE try_cast(replace(AV_HMSTD, ',', '') AS DOUBLE) > 0) AS occupied,
         count(*) FILTER (WHERE try_cast(replace(AV_HMSTD, ',', '') AS DOUBLE) = 0) AS not_occupied,
         count(*) FILTER (WHERE try_cast(replace(AV_HMSTD, ',', '') AS DOUBLE) IS NULL) AS unknown
       FROM ${source}`,
    );
    const total = Number(counts[0]?.total ?? 0);
    if (total !== expectedRowCount) {
      throw new Error(`Duval NAL rows ${total} do not match ${expectedRowCount}`);
    }
    const output = await readFile(outputPath);
    const manifest = {
      schemaVersion: "elephant.duval-owner-occupied-nal.v1",
      county: "duval",
      countyFips: "12031",
      sourceUrl,
      sourceSha256,
      sourceBytes: archive.byteLength,
      sourceField: "AV_HMSTD",
      rule: "> 0 true; = 0 false; blank/unparseable/unmatched null",
      total,
      occupied: Number(counts[0]?.occupied ?? 0),
      notOccupied: Number(counts[0]?.not_occupied ?? 0),
      unknown: Number(counts[0]?.unknown ?? 0),
      frozenAt,
      outputBytes: output.byteLength,
      outputSha256: createHash("sha256").update(output).digest("hex"),
    };
    await writeFile(
      path.join(outputDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    return manifest;
  } finally {
    connection.closeSync();
  }
}
