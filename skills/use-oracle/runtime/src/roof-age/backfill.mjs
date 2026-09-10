import { mkdir, rename } from "node:fs/promises";
import path from "node:path";

import {
  ParquetReader,
  ParquetSchema,
  ParquetWriter,
} from "@dsnp/parquetjs";

import { toParquetRecord } from "../core/query-table.mjs";
import { atomicWriteJson, fileIntegrity } from "../permits/storage.mjs";
import {
  ROOF_AGE_RULE_VERSION,
  normalizeAsOfDate,
  resolveRoofAge,
  selectQualifyingRoofPermit,
} from "./rule.mjs";

function parseLineage(value) {
  if (value !== null && typeof value === "object") return value;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function laterCandidate(left, right) {
  if (left === null) return right;
  if (right === null) return left;
  if (right.eventDate !== left.eventDate) {
    return right.eventDate > left.eventDate ? right : left;
  }
  return String(right.permit.property_improvement_id ?? "") >
    String(left.permit.property_improvement_id ?? "")
    ? right
    : left;
}

async function readRoofPermitCandidates({
  permitParquet,
  permitPolicy,
  asOfDate,
}) {
  const candidates = new Map();
  let permitRowsScanned = 0;
  if (permitParquet === null) {
    return { candidates, permitRowsScanned };
  }
  const reader = await ParquetReader.openFile(permitParquet);
  try {
    const cursor = reader.getCursor();
    let row = await cursor.next();
    while (row) {
      permitRowsScanned += 1;
      const propertyId =
        row.property_id === null || row.property_id === undefined
          ? null
          : String(row.property_id);
      if (propertyId !== null) {
        const candidate = selectQualifyingRoofPermit({
          permits: [row],
          propertyId,
          builtYear: null,
          asOfDate,
          permitPolicy,
        });
        if (candidate !== null) {
          candidates.set(
            propertyId,
            laterCandidate(candidates.get(propertyId) ?? null, candidate),
          );
        }
      }
      row = await cursor.next();
    }
  } finally {
    await reader.close();
  }
  return { candidates, permitRowsScanned };
}

export async function backfillRoofAgeParquet({
  countyKey,
  inputPropertyParquet,
  inputPermitParquet = null,
  outputDir,
  propertySchemaFields,
  permitPolicy = null,
  asOfDate,
}) {
  const normalizedAsOfDate = normalizeAsOfDate(asOfDate);
  if (inputPermitParquet !== null && permitPolicy === null) {
    throw new Error(
      "A county-reviewed permit policy is required when joining permit Parquet",
    );
  }
  const { candidates, permitRowsScanned } =
    await readRoofPermitCandidates({
      permitParquet: inputPermitParquet,
      permitPolicy,
      asOfDate: normalizedAsOfDate,
    });
  await mkdir(outputDir, { recursive: true });
  const outputPropertyParquet = path.join(outputDir, "query-table.parquet");
  if (path.resolve(inputPropertyParquet) === path.resolve(outputPropertyParquet)) {
    throw new Error("Roof-age backfill output must not overwrite its input");
  }
  const temporaryPath = `${outputPropertyParquet}.tmp-${process.pid}`;
  const reader = await ParquetReader.openFile(inputPropertyParquet);
  const writer = await ParquetWriter.openFile(
    new ParquetSchema(structuredClone(propertySchemaFields)),
    temporaryPath,
  );
  const counters = {
    propertyRows: 0,
    derivedFromConstructionYear: 0,
    parcelExplicit: 0,
    permitOverlay: 0,
    unresolved: 0,
    permitRowsScanned,
    qualifyingPermitProperties: candidates.size,
  };
  try {
    const cursor = reader.getCursor();
    let row = await cursor.next();
    while (row) {
      counters.propertyRows += 1;
      const propertyId = String(row.property_id);
      const permitCandidate = candidates.get(propertyId)?.permit;
      const state = resolveRoofAge({
        propertyId,
        explicitRoofDate: row.roof_date,
        explicitRoofAgeYears: row.roof_age_years,
        builtYear: row.built_year,
        explicitSource: row.roof_date_source,
        existingLineage: parseLineage(row.roof_date_lineage),
        permits:
          permitCandidate === undefined ? [] : [permitCandidate],
        permitPolicy,
        sourceSystem: row.source_system,
        sourceRecordKey: row.request_identifier,
        asOfDate: normalizedAsOfDate,
      });
      if (state === null) {
        counters.unresolved += 1;
        await writer.appendRow(toParquetRecord(row));
      } else {
        if (state.roofDateSource === "permit") {
          counters.permitOverlay += 1;
        } else if (
          state.roofDateSource === "derived-from-construction-year"
        ) {
          counters.derivedFromConstructionYear += 1;
        } else {
          counters.parcelExplicit += 1;
        }
        await writer.appendRow(
          toParquetRecord({
            ...row,
            roof_date: state.roofDate,
            roof_age_years: state.roofAgeYears,
            roof_date_source: state.roofDateSource,
            roof_date_lineage: JSON.stringify(state.roofDateLineage),
          }),
        );
      }
      row = await cursor.next();
    }
  } finally {
    await Promise.all([reader.close(), writer.close()]);
  }
  await rename(temporaryPath, outputPropertyParquet);

  const manifestPath = path.join(outputDir, "roof-age-backfill-manifest.json");
  const manifest = {
    schemaVersion: "elephant.roof-age-backfill-manifest.v1",
    countyKey,
    ruleVersion: ROOF_AGE_RULE_VERSION,
    permitPolicyVersion: permitPolicy?.policyVersion ?? null,
    asOfDate: normalizedAsOfDate,
    inputs: {
      property: {
        path: inputPropertyParquet,
        ...(await fileIntegrity(inputPropertyParquet)),
      },
      permit:
        inputPermitParquet === null
          ? null
          : {
              path: inputPermitParquet,
              ...(await fileIntegrity(inputPermitParquet)),
            },
    },
    output: {
      path: outputPropertyParquet,
      ...(await fileIntegrity(outputPropertyParquet)),
    },
    counters,
    publicationStatus: "pending_human_approval",
  };
  await atomicWriteJson(manifestPath, manifest);
  return {
    outputPropertyParquet,
    manifestPath,
    manifest,
  };
}
