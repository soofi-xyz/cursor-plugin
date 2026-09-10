import fs from "node:fs";
import path from "node:path";

import { resolveRoofAge } from "./rule.mjs";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function toInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function structureFiles(dataDir) {
  return fs
    .readdirSync(dataDir)
    .filter((name) => /^structure(?:_\d+)?\.json$/i.test(name))
    .sort((left, right) => left.localeCompare(right));
}

function layoutBuiltYears(dataDir) {
  const years = new Map();
  let firstYear = null;
  for (const name of fs
    .readdirSync(dataDir)
    .filter((candidate) => /^layout_\d+\.json$/i.test(candidate))
    .sort((left, right) => left.localeCompare(right))) {
    const layout = readJson(path.join(dataDir, name));
    if (layout.space_type !== "Building") continue;
    const year = toInteger(layout.built_year);
    if (year === null) continue;
    if (firstYear === null) firstYear = year;
    const buildingNumber = toInteger(layout.building_number);
    if (buildingNumber !== null && !years.has(buildingNumber)) {
      years.set(buildingNumber, year);
    }
  }
  return { years, firstYear };
}

export function populateRoofAgeDefaultsInDataDir({ dataDir, asOfDate }) {
  const propertyPath = path.join(dataDir, "property.json");
  const property = fs.existsSync(propertyPath) ? readJson(propertyPath) : {};
  const layoutYears = layoutBuiltYears(dataDir);
  let updatedStructureCount = 0;
  let defaultedStructureCount = 0;

  for (const name of structureFiles(dataDir)) {
    const filePath = path.join(dataDir, name);
    const structure = readJson(filePath);
    const buildingNumber =
      toInteger(structure.building_number) ??
      toInteger(name.match(/\d+/)?.[0]);
    const builtYear =
      toInteger(structure.built_year) ??
      toInteger(property.property_structure_built_year) ??
      (buildingNumber === null
        ? layoutYears.firstYear
        : (layoutYears.years.get(buildingNumber) ?? layoutYears.firstYear));
    const state = resolveRoofAge({
      explicitRoofDate: structure.roof_date,
      explicitRoofAgeYears: structure.roof_age_years,
      builtYear,
      explicitSource: structure.roof_date_source,
      existingLineage: structure.roof_date_lineage,
      sourceSystem: structure.source_system ?? property.source_system,
      sourceRecordKey:
        structure.source_record_key ?? property.source_record_key,
      asOfDate,
    });
    if (state === null) continue;
    structure.roof_date = state.roofDate;
    structure.roof_age_years = state.roofAgeYears;
    structure.roof_date_source = state.roofDateSource;
    structure.roof_date_lineage = state.roofDateLineage;
    fs.writeFileSync(filePath, `${JSON.stringify(structure, null, 2)}\n`);
    updatedStructureCount += 1;
    if (
      state.roofDateSource === "derived-from-construction-year"
    ) {
      defaultedStructureCount += 1;
    }
  }

  return {
    structureCount: structureFiles(dataDir).length,
    updatedStructureCount,
    defaultedStructureCount,
  };
}
