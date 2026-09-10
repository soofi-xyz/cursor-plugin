#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { duvalPermitProfile } from "../src/counties/duval/permit-profile.mjs";
import { resolveRoofAge } from "../src/roof-age/rule.mjs";

export const DEMO_AS_OF_DATE = "2026-09-09";
export const DEMO_PROPERTY_ID = "a".repeat(32);
export const DEMO_REQUEST_IDENTIFIER = "1646340000R";

export function buildDuvalRoofAgeDemo() {
  const parcelState = resolveRoofAge({
    propertyId: DEMO_PROPERTY_ID,
    builtYear: 1990,
    sourceSystem: "duval_appraiser",
    sourceRecordKey: DEMO_REQUEST_IDENTIFIER,
    asOfDate: DEMO_AS_OF_DATE,
  });
  const permit = {
    property_improvement_id: "b".repeat(32),
    property_id: DEMO_PROPERTY_ID,
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
    sourceRecordId: "roof-age-demo",
  };
  const permitState = resolveRoofAge({
    propertyId: DEMO_PROPERTY_ID,
    explicitRoofDate: parcelState.roofDate,
    explicitRoofAgeYears: parcelState.roofAgeYears,
    builtYear: 1990,
    explicitSource: parcelState.roofDateSource,
    existingLineage: parcelState.roofDateLineage,
    permits: [permit],
    permitPolicy: duvalPermitProfile.roofAgePolicy,
    sourceSystem: "duval_appraiser",
    sourceRecordKey: DEMO_REQUEST_IDENTIFIER,
    asOfDate: DEMO_AS_OF_DATE,
  });
  const query =
    "SELECT request_identifier, roof_date, roof_age_years, " +
    "roof_date_source, roof_date_lineage FROM properties " +
    `WHERE request_identifier = '${DEMO_REQUEST_IDENTIFIER}'`;
  return {
    parcelIngest: {
      requestIdentifier: DEMO_REQUEST_IDENTIFIER,
      builtYear: 1990,
      roofDate: parcelState.roofDate,
      roofAgeYears: parcelState.roofAgeYears,
      roofDateSource: parcelState.roofDateSource,
      roofDateLineage: parcelState.roofDateLineage,
    },
    permitIngest: {
      permitNumber: permit.permit_number,
      permitStatus: permit.improvement_status,
      completionDate: permit.completion_date,
      roofDate: permitState.roofDate,
      roofAgeYears: permitState.roofAgeYears,
      roofDateSource: permitState.roofDateSource,
      roofDateLineage: permitState.roofDateLineage,
    },
    mcpLineageQuery: {
      tool: "queryProperties",
      arguments: {
        county: "duval",
        sql: query,
        limit: 1,
      },
      fixtureResult: {
        request_identifier: DEMO_REQUEST_IDENTIFIER,
        roof_date: permitState.roofDate,
        roof_age_years: permitState.roofAgeYears,
        roof_date_source: permitState.roofDateSource,
        roof_date_lineage: JSON.stringify(permitState.roofDateLineage),
      },
      note:
        "fixtureResult is the local contract result; run the same MCP request after an approval-gated Duval republish for remote verification.",
    },
  };
}

function isInvokedDirectly() {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isInvokedDirectly()) {
  const demo = buildDuvalRoofAgeDemo();
  for (const [event, payload] of Object.entries(demo)) {
    console.log(JSON.stringify({ event, ...payload }));
  }
}
