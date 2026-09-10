import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { duvalEnrichmentProfile } from "../src/counties/duval/enrichment-profile.mjs";
import { duvalPermitProfile } from "../src/counties/duval/permit-profile.mjs";
import { writeQueryTableParquet } from "../src/core/query-table.mjs";
import { normalizeJaxPermitMapFeature } from "../src/permits/adapters/jaxepics-map.mjs";
import {
  permitTableSchemaFields,
  toPermitTableRow,
} from "../src/permits/contracts.mjs";
import { backfillRoofAgeParquet } from "../src/roof-age/backfill.mjs";

const require = createRequire(import.meta.url);
const { ParquetReader } = require("@dsnp/parquetjs");
const temporaryDirectories = [];
const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/permits/duval/jaxepics-map/permit-page.json",
);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("roof-age Parquet backfill", () => {
  it("joins exact property permits and writes default-to-permit lineage", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "roof-backfill-"));
    temporaryDirectories.push(root);
    const propertyPath = path.join(root, "properties.parquet");
    const permitPath = path.join(root, "permits.parquet");
    const outputDir = path.join(root, "output");
    const permitPropertyId = "a".repeat(32);
    const defaultPropertyId = "b".repeat(32);
    await writeQueryTableParquet({
      parquetPath: propertyPath,
      schemaFields: duvalEnrichmentProfile.queryTable.schemaFields,
      rows: [
        {
          property_id: permitPropertyId,
          request_identifier: "1646340000R",
          parcel_identifier: "164634-0000",
          source_system: "duval_appraiser",
          built_year: 1990,
        },
        {
          property_id: defaultPropertyId,
          request_identifier: "0000010000R",
          parcel_identifier: "000001-0000",
          source_system: "duval_appraiser",
          built_year: 2000,
        },
      ],
    });
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    const feature = structuredClone(fixture.features[0]);
    feature.attributes.PermitTypeID = 8;
    feature.attributes.FullPermitNumber = "R-95-24104.000";
    feature.attributes.TypeOfWork = "Re-roof existing building";
    feature.attributes.Comments = "Replace existing shingle roof";
    const permit = normalizeJaxPermitMapFeature(feature, {
      requestedParcelIdentifier: "164634-0000",
      requestedPropertyId: permitPropertyId,
    });
    await writeQueryTableParquet({
      parquetPath: permitPath,
      schemaFields: permitTableSchemaFields,
      rows: [toPermitTableRow(permit)],
    });

    const result = await backfillRoofAgeParquet({
      countyKey: "duval",
      inputPropertyParquet: propertyPath,
      inputPermitParquet: permitPath,
      outputDir,
      propertySchemaFields: duvalEnrichmentProfile.queryTable.schemaFields,
      permitPolicy: duvalPermitProfile.roofAgePolicy,
      asOfDate: "2026-09-09",
    });
    expect(result.manifest.counters).toMatchObject({
      propertyRows: 2,
      derivedFromConstructionYear: 1,
      permitOverlay: 1,
      unresolved: 0,
      permitRowsScanned: 1,
      qualifyingPermitProperties: 1,
    });
    expect(result.manifest.publicationStatus).toBe(
      "pending_human_approval",
    );

    const reader = await ParquetReader.openFile(
      result.outputPropertyParquet,
    );
    const rows = [];
    const cursor = reader.getCursor();
    let row = await cursor.next();
    while (row) {
      rows.push(row);
      row = await cursor.next();
    }
    await reader.close();
    const updated = rows.find(
      (candidate) => candidate.property_id === permitPropertyId,
    );
    expect(updated).toMatchObject({
      roof_date: "1995-05-30",
      roof_age_years: 31n,
      roof_date_source: "permit",
    });
    expect(
      JSON.parse(updated.roof_date_lineage).history.map(
        (event) => event.source,
      ),
    ).toEqual(["derived-from-construction-year", "permit"]);
    expect(
      rows.find(
        (candidate) => candidate.property_id === defaultPropertyId,
      ),
    ).toMatchObject({
      roof_date: "2000-01-01",
      roof_age_years: 26n,
      roof_date_source: "derived-from-construction-year",
    });
  });
});
