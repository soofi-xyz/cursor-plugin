import { describe, expect, it } from "vitest";

import {
  assertApprovedDatasets,
  buildOverturePlacesSql,
  DUVAL_PUBLIC_PLACE_COLUMNS,
  parseTigerBoundarySource,
} from "../src/gaps/overture-places.mjs";

describe("Duval contact-free Overture extraction", () => {
  it("pins the release, TIGER boundary and exact point-in-polygon rule", () => {
    const sql = buildOverturePlacesSql({
      release: "2026-08-19.0",
      boundaryPath: "/tmp/tl_2024_us_county.shp",
      countyFips: "12031",
      outputPath: "/tmp/places.parquet",
    });
    expect(sql).toContain("2026-08-19.0");
    expect(sql).toContain("GEOID = '12031'");
    expect(sql).toContain("'EPSG:4269', 'OGC:CRS84'");
    expect(sql).toContain("ST_Within(p.geometry, c.geometry)");
    expect(sql).toContain("ORDER BY p.id");
    expect(sql).toContain("ORDER BY gers_id");
    expect(sql).toContain("array_to_string(p.taxonomy.hierarchy, '/')");
    expect(sql).toContain("array_to_string(websites, '|') AS websites");
    expect(sql).toContain("'duval' AS county_key");
    for (const column of [
      "gers_id",
      "name_primary",
      "taxonomy_primary",
      "taxonomy_hierarchy",
      "basic_category",
      "operating_status",
      "confidence",
      "longitude",
      "latitude",
      "county_key",
    ]) {
      expect(sql).toContain(column);
    }
    expect(sql).not.toMatch(/\bp\.emails\b/);
    expect(sql).not.toMatch(/\bp\.phones\b/);
    expect(sql).not.toMatch(/\bp\.socials\b/);
    expect(DUVAL_PUBLIC_PLACE_COLUMNS).toHaveLength(23);
    expect(DUVAL_PUBLIC_PLACE_COLUMNS).not.toContain("emails");
    expect(DUVAL_PUBLIC_PLACE_COLUMNS).not.toContain("phones");
    expect(DUVAL_PUBLIC_PLACE_COLUMNS).not.toContain("sources");
  });

  it("rejects an unpinned release and parses only reviewed TIGER sources", () => {
    expect(() =>
      buildOverturePlacesSql({
        release: "latest",
        boundaryPath: "/tmp/county.shp",
        countyFips: "12031",
        outputPath: "/tmp/places.parquet",
      }),
    ).toThrow(/explicitly pinned/);
    expect(parseTigerBoundarySource("tiger/tl_2024_us_county").year).toBe(
      "2024",
    );
    expect(() => parseTigerBoundarySource("custom/duval")).toThrow();
  });

  it("fails the licence gate for OSM or unknown source lineage", () => {
    expect(assertApprovedDatasets(["Microsoft", "Foursquare"])).toEqual([
      "Foursquare",
      "Microsoft",
    ]);
    expect(() => assertApprovedDatasets(["osm"])).toThrow(/rejected/);
    expect(() => assertApprovedDatasets(["mystery-vendor"])).toThrow(
      /rejected/,
    );
  });
});
