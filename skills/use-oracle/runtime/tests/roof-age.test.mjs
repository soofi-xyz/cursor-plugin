import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { duvalPermitProfile } from "../src/counties/duval/permit-profile.mjs";
import { buildDuvalRoofAgeDemo } from "../scripts/demo-duval-roof-age.mjs";
import {
  calculateRoofAgeYears,
  resolveRoofAge,
  selectQualifyingRoofPermit,
} from "../src/roof-age/rule.mjs";
import { populateRoofAgeDefaultsInDataDir } from "../src/roof-age/transform.mjs";

const temporaryDirectories = [];
const propertyId = "a".repeat(32);

function permit(overrides = {}) {
  return {
    property_improvement_id: "b".repeat(32),
    property_id: propertyId,
    permit_number: "R-24-00001.000",
    improvement_type: "Roofing Permit",
    improvement_status: "Finalized",
    improvement_action: "Re-roof existing building",
    project_description: "Residential",
    description: "Replace existing shingle roof",
    completion_date: "2024-06-15",
    permit_close_date: "2024-06-16",
    final_inspection_date: "2024-06-14",
    source_system: "duval_jaxepics_bid_map",
    sourceRecordId: "12345",
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("shared roof-age rule", () => {
  it("defaults missing parcel roof data from actual year built with year precision", () => {
    const state = resolveRoofAge({
      propertyId,
      builtYear: 1998,
      asOfDate: "2026-09-09",
    });
    expect(state).toMatchObject({
      roofDate: "1998-01-01",
      roofAgeYears: 28,
      roofDateSource: "derived-from-construction-year",
      roofDateLineage: {
        schemaVersion: "elephant.roof-age.v1",
        asOfDate: "2026-09-09",
        current: {
          datePrecision: "year",
          constructionYear: 1998,
        },
      },
    });
  });

  it("preserves explicit parcel age instead of replacing it from construction year", () => {
    expect(
      resolveRoofAge({
        propertyId,
        explicitRoofAgeYears: 12,
        builtYear: 1998,
        asOfDate: "2026-09-09",
      }),
    ).toMatchObject({
      roofDate: null,
      roofAgeYears: 12,
      roofDateSource: "parcel",
    });
  });

  it("overlays the latest linked closed replacement permit and keeps default lineage", () => {
    const state = resolveRoofAge({
      propertyId,
      builtYear: 1998,
      permits: [
        permit({
          property_improvement_id: "c".repeat(32),
          completion_date: "2020-03-01",
        }),
        permit(),
      ],
      permitPolicy: duvalPermitProfile.roofAgePolicy,
      asOfDate: "2026-09-09",
    });
    expect(state).toMatchObject({
      roofDate: "2024-06-15",
      roofAgeYears: 2,
      roofDateSource: "permit",
      roofDateLineage: {
        current: {
          source: "permit",
          dateField: "completion_date",
          permitNumber: "R-24-00001.000",
        },
      },
    });
    expect(state.roofDateLineage.history.map((event) => event.source)).toEqual([
      "derived-from-construction-year",
      "permit",
    ]);
  });

  it("fails closed for ambiguous status, work, source, linkage, and dates", () => {
    const rejected = [
      permit({ improvement_status: "Finalized - NIF" }),
      permit({ improvement_action: "Existing Building", description: null }),
      permit({ description: "New construction roof" }),
      permit({ property_id: "c".repeat(32) }),
      permit({ source_system: "unknown-system" }),
      permit({ completion_date: "2027-01-01" }),
      permit({ completion_date: "1980-01-01" }),
    ];
    for (const candidate of rejected) {
      expect(
        selectQualifyingRoofPermit({
          permits: [candidate],
          propertyId,
          builtYear: 1998,
          asOfDate: "2026-09-09",
          permitPolicy: duvalPermitProfile.roofAgePolicy,
        }),
      ).toBeNull();
    }
  });

  it("keeps existing permit lineage stable when a later pass has no new permit", () => {
    const first = resolveRoofAge({
      propertyId,
      builtYear: 1998,
      permits: [permit()],
      permitPolicy: duvalPermitProfile.roofAgePolicy,
      asOfDate: "2026-09-09",
    });
    const second = resolveRoofAge({
      propertyId,
      explicitRoofDate: first.roofDate,
      explicitRoofAgeYears: first.roofAgeYears,
      explicitSource: first.roofDateSource,
      existingLineage: first.roofDateLineage,
      builtYear: 1998,
      asOfDate: "2026-09-10",
    });
    expect(second.roofDateLineage.history).toEqual(
      first.roofDateLineage.history,
    );
    expect(second.roofDateSource).toBe("permit");
  });

  it("calculates whole years against the frozen as-of date", () => {
    expect(calculateRoofAgeYears("2020-09-10", "2026-09-09")).toBe(5);
    expect(calculateRoofAgeYears("2020-09-09", "2026-09-09")).toBe(6);
  });
});

describe("transform roof-age post-processing", () => {
  it("writes the shared default and lineage into structure artifacts", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "roof-transform-"));
    temporaryDirectories.push(dataDir);
    await writeFile(
      path.join(dataDir, "property.json"),
      JSON.stringify({
        property_structure_built_year: 2001,
        source_system: "fixture_appraiser",
      }),
    );
    await writeFile(path.join(dataDir, "structure_1.json"), "{}");

    expect(
      populateRoofAgeDefaultsInDataDir({
        dataDir,
        asOfDate: "2026-09-09",
      }),
    ).toEqual({
      structureCount: 1,
      updatedStructureCount: 1,
      defaultedStructureCount: 1,
    });
    const structure = JSON.parse(
      await readFile(path.join(dataDir, "structure_1.json"), "utf8"),
    );
    expect(structure).toMatchObject({
      roof_date: "2001-01-01",
      roof_age_years: 25,
      roof_date_source: "derived-from-construction-year",
      roof_date_lineage: {
        current: {
          source: "derived-from-construction-year",
          datePrecision: "year",
        },
      },
    });
  });
});

describe("Duval roof-age demo", () => {
  it("shows default, permit override, and the MCP lineage query contract", () => {
    const demo = buildDuvalRoofAgeDemo();
    expect(demo.parcelIngest).toMatchObject({
      roofDate: "1990-01-01",
      roofDateSource: "derived-from-construction-year",
    });
    expect(demo.permitIngest).toMatchObject({
      roofDate: "2024-06-15",
      roofDateSource: "permit",
    });
    expect(demo.mcpLineageQuery.arguments).toMatchObject({
      county: "duval",
      limit: 1,
    });
    expect(
      JSON.parse(
        demo.mcpLineageQuery.fixtureResult.roof_date_lineage,
      ).history.map((event) => event.source),
    ).toEqual(["derived-from-construction-year", "permit"]);
  });
});
