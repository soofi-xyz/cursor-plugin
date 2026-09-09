import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import { DuckDBInstance } from "@duckdb/node-api";

const execFileAsync = promisify(execFile);

export const APPROVED_OVERTURE_PLACE_DATASETS = Object.freeze([
  "meta",
  "microsoft",
  "foursquare",
  "pinmeto",
  "krick",
  "renderseo",
  "dac",
  "brightquery",
  "alltheplaces",
  "overture",
  "overture-signals",
]);

export const DUVAL_PUBLIC_PLACE_COLUMNS = Object.freeze([
  "gers_id",
  "county_key",
  "county_fips",
  "name_primary",
  "taxonomy_primary",
  "taxonomy_hierarchy",
  "basic_category",
  "legacy_category_primary",
  "operating_status",
  "confidence",
  "longitude",
  "latitude",
  "address_freeform",
  "address_locality",
  "address_postcode",
  "address_region",
  "address_country",
  "brand_name",
  "brand_wikidata",
  "is_hosted_service",
  "hosted_service_rule",
  "overture_release",
  "websites",
]);

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function parseTigerBoundarySource(value) {
  const match = /^tiger\/(tl_(\d{4})_us_county)$/.exec(String(value));
  if (match === null) {
    throw new Error("Boundary source must match tiger/tl_YYYY_us_county");
  }
  return {
    stem: match[1],
    year: match[2],
    url: `https://www2.census.gov/geo/tiger/TIGER${match[2]}/COUNTY/${match[1]}.zip`,
  };
}

export function buildOverturePlacesSql({
  release,
  boundaryPath,
  countyFips,
  outputPath,
  limit = null,
}) {
  if (!/^\d{4}-\d{2}-\d{2}\.\d+$/.test(release)) {
    throw new Error("Overture release must be explicitly pinned");
  }
  if (!/^\d{5}$/.test(countyFips)) {
    throw new Error("County FIPS must be five digits");
  }
  const source = `s3://overturemaps-us-west-2/release/${release}/theme=places/type=place/*`;
  const limitSql = limit === null ? "" : `\n  LIMIT ${Number(limit)}`;
  return `
CREATE OR REPLACE TEMP TABLE county_boundary AS
SELECT ST_Union_Agg(
  ST_Transform(geom, 'EPSG:4269', 'OGC:CRS84', always_xy := true)
) AS geometry
FROM ST_Read(${sqlString(boundaryPath)})
WHERE GEOID = ${sqlString(countyFips)};

CREATE OR REPLACE TEMP TABLE county_bbox AS
SELECT
  ST_XMin(geometry) AS xmin,
  ST_XMax(geometry) AS xmax,
  ST_YMin(geometry) AS ymin,
  ST_YMax(geometry) AS ymax
FROM county_boundary;

CREATE OR REPLACE TEMP TABLE duval_places_raw AS
  SELECT
    p.id AS gers_id,
    p.names.primary AS name_primary,
    p.taxonomy.primary AS taxonomy_primary,
    array_to_string(p.taxonomy.hierarchy, '/') AS taxonomy_hierarchy,
    p.basic_category AS basic_category,
    p.categories.primary AS legacy_category_primary,
    p.operating_status AS operating_status,
    p.confidence AS confidence,
    p.websites AS websites,
    p.brand.names.primary AS brand_name,
    p.brand.wikidata AS brand_wikidata,
    p.addresses[1].freeform AS address_freeform,
    p.addresses[1].locality AS address_locality,
    p.addresses[1].postcode AS address_postcode,
    p.addresses[1].region AS address_region,
    p.addresses[1].country AS address_country,
    ST_X(p.geometry) AS longitude,
    ST_Y(p.geometry) AS latitude,
    false AS is_hosted_service,
    NULL::VARCHAR AS hosted_service_rule,
    ${sqlString(release)} AS overture_release,
    'duval' AS county_key,
    ${sqlString(countyFips)} AS county_fips,
    p.sources AS sources
  FROM read_parquet(${sqlString(source)}, hive_partitioning = 1) AS p,
       county_bbox AS b,
       county_boundary AS c
  WHERE p.bbox.xmin >= b.xmin
    AND p.bbox.xmax <= b.xmax
    AND p.bbox.ymin >= b.ymin
    AND p.bbox.ymax <= b.ymax
    AND ST_Within(p.geometry, c.geometry)
  ORDER BY p.id${limitSql};

COPY (
  SELECT
    gers_id,
    'duval' AS county_key,
    ${sqlString(countyFips)} AS county_fips,
    name_primary,
    taxonomy_primary,
    taxonomy_hierarchy,
    basic_category,
    legacy_category_primary,
    operating_status,
    confidence,
    longitude,
    latitude,
    address_freeform,
    address_locality,
    address_postcode,
    address_region,
    address_country,
    brand_name,
    brand_wikidata,
    is_hosted_service,
    hosted_service_rule,
    overture_release,
    array_to_string(websites, '|') AS websites
  FROM duval_places_raw
  ORDER BY gers_id
) TO ${sqlString(outputPath)} (FORMAT PARQUET);
`;
}

async function ensureTigerBoundary(boundarySource, cacheDir) {
  const tiger = parseTigerBoundarySource(boundarySource);
  const targetDir = path.join(cacheDir, tiger.stem);
  const shapefilePath = path.join(targetDir, `${tiger.stem}.shp`);
  const archivePath = path.join(targetDir, `${tiger.stem}.zip`);
  try {
    await Promise.all([stat(shapefilePath), stat(archivePath)]);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(archivePath)) hash.update(chunk);
    return { ...tiger, shapefilePath, archiveSha256: hash.digest("hex") };
  } catch {
    await mkdir(targetDir, { recursive: true });
  }
  const response = await fetch(tiger.url);
  if (!response.ok || response.body === null) {
    throw new Error(`TIGER boundary download failed: HTTP ${response.status}`);
  }
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(archivePath),
  );
  const archive = await readFile(archivePath);
  const archiveSha256 = createHash("sha256").update(archive).digest("hex");
  await execFileAsync("unzip", ["-o", archivePath, "-d", targetDir]);
  await stat(shapefilePath);
  return { ...tiger, shapefilePath, archiveSha256 };
}

async function queryRows(connection, sql) {
  const reader = await connection.runAndReadAll(sql);
  return reader.getRowObjectsJson();
}

export function assertApprovedDatasets(datasets) {
  const normalized = [...new Set(datasets.map((value) => String(value).trim()))]
    .filter(Boolean)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const unknown = normalized.filter(
    (value) =>
      !APPROVED_OVERTURE_PLACE_DATASETS.includes(value.toLowerCase()),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Overture places licence gate rejected dataset(s): ${unknown.join(", ")}`,
    );
  }
  if (normalized.some((value) => value.toLowerCase() === "osm")) {
    throw new Error("Overture places licence gate rejected osm lineage");
  }
  return normalized;
}

export async function extractContactFreeOverturePlaces({
  county,
  countyFips,
  release,
  boundarySource,
  outputDir,
  cacheDir,
  frozenAt,
  limit = null,
}) {
  if (county !== "duval" || countyFips !== "12031") {
    throw new Error("Duval gap extraction requires county=duval, FIPS=12031");
  }
  await mkdir(outputDir, { recursive: true });
  const boundary = await ensureTigerBoundary(boundarySource, cacheDir);
  const outputPath = path.join(outputDir, "places-table.parquet");
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    const extensionSetup =
      process.env.DUCKDB_EXTENSIONS_BUNDLED === "true"
        ? "LOAD spatial; LOAD httpfs;"
        : "INSTALL spatial; LOAD spatial; INSTALL httpfs; LOAD httpfs;";
    await connection.run(
      `${extensionSetup} SET s3_region = 'us-west-2';`,
    );
    await connection.run(
      buildOverturePlacesSql({
        release,
        boundaryPath: boundary.shapefilePath,
        countyFips,
        outputPath,
        limit,
      }),
    );
    const described = await queryRows(
      connection,
      `DESCRIBE SELECT * FROM read_parquet(${sqlString(outputPath)})`,
    );
    const columns = described.map((row) => String(row.column_name));
    if (JSON.stringify(columns) !== JSON.stringify(DUVAL_PUBLIC_PLACE_COLUMNS)) {
      throw new Error(
        `Contact-free places schema mismatch: ${columns.join(", ")}`,
      );
    }
    const websites = described.find((row) => row.column_name === "websites");
    if (String(websites?.column_type) !== "VARCHAR") {
      throw new Error(
        "Contact-free places websites must be pipe-delimited VARCHAR",
      );
    }
    const counts = await queryRows(
      connection,
      `SELECT count(*) AS count, count(DISTINCT gers_id) AS distinct_count
       FROM read_parquet(${sqlString(outputPath)})`,
    );
    const count = Number(counts[0]?.count ?? 0);
    const distinctCount = Number(counts[0]?.distinct_count ?? 0);
    if (count !== distinctCount) {
      throw new Error(`Duplicate Overture GERS IDs: ${count} vs ${distinctCount}`);
    }
    const sourceRows = await queryRows(
      connection,
      `SELECT DISTINCT source.dataset AS dataset
       FROM duval_places_raw,
            UNNEST(sources) AS source_entry(source)
       WHERE source.dataset IS NOT NULL
       ORDER BY dataset`,
    );
    const datasets = assertApprovedDatasets(
      sourceRows.map((row) => String(row.dataset)),
    );
    const body = await readFile(outputPath);
    const manifest = {
      schemaVersion: "elephant.overture-places-table.v1",
      county,
      countyFips,
      release,
      boundarySource,
      tigerVintage: boundary.year,
      tigerArchiveSha256: boundary.archiveSha256,
      clippingRule: "bbox prune followed by ST_Within(point, county polygon)",
      expectedCount: null,
      rowCount: count,
      distinctGersIdCount: distinctCount,
      columns,
      excludedColumns: ["emails", "phones"],
      datasets,
      licenceGatePassed: true,
      frozenAt,
      outputBytes: body.byteLength,
      outputSha256: createHash("sha256").update(body).digest("hex"),
    };
    const notice = [
      "Duval County Overture Places",
      `Overture release: ${release}`,
      `TIGER boundary: ${boundarySource}`,
      "Geometry assignment: ST_Within against the county polygon.",
      "The public artifact excludes Overture emails and phones.",
      `Source datasets: ${datasets.join(", ")}`,
      "Licences: CDLA-Permissive-2.0; Foursquare records are Apache-2.0.",
      "",
    ].join("\n");
    const publicationIndex = {
      county,
      artifact: "places-table",
      rowCount: count,
      overtureRelease: release,
      localOnly: false,
      published: true,
      piiGate: "human-approved-contact-free",
      attribution: {
        notice: "../NOTICE.txt",
        citation: "Overture Maps Foundation Places",
        overtureRelease: release,
        accessedDate: frozenAt.slice(0, 10),
        elephantChangedDate: frozenAt.slice(0, 10),
        foursquareCopyright:
          "Copyright 2024 Foursquare Labs, Inc. All rights reserved.",
        themeLicence:
          "CDLA-Permissive-2.0 and Apache-2.0 per record, with no OpenStreetMap lineage",
        licenceGate: {
          passed: true,
          osmPresent: false,
          unknownDatasets: [],
          distinctDatasets: datasets,
        },
      },
    };
    await Promise.all([
      writeFile(
        path.join(outputDir, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      ),
      writeFile(
        path.join(outputDir, "index.json"),
        `${JSON.stringify(publicationIndex, null, 2)}\n`,
      ),
      writeFile(path.join(outputDir, "NOTICE.txt"), notice),
    ]);
    return manifest;
  } finally {
    connection.closeSync();
  }
}
