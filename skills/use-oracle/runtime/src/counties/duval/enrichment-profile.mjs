import { validateEnrichmentProfile } from "../enrichment-profile.mjs";

export const duvalEnrichmentProfile = validateEnrichmentProfile({
  countyKey: "duval",
  countyName: "Duval",
  stateCode: "FL",
  sunbiz: {
    zipPrefixes: ["322", "32099"],
  },
  bbb: {
    categories: [
      {
        key: "roofing-contractors",
        url: "https://www.bbb.org/us/fl/jacksonville/category/roofing-contractors",
        reviewedPath: "/us/fl/jacksonville/category/roofing-contractors",
      },
      {
        key: "solar-energy-system-contractors",
        url: "https://www.bbb.org/us/fl/jacksonville/category/solar-energy-system-contractors",
        reviewedPath:
          "/us/fl/jacksonville/category/solar-energy-system-contractors",
      },
      {
        key: "heating-and-air-conditioning",
        url: "https://www.bbb.org/us/fl/jacksonville/category/heating-and-air-conditioning",
        reviewedPath:
          "/us/fl/jacksonville/category/heating-and-air-conditioning",
      },
    ],
  },
  queryTable: {
    schemaFields: {
      property_id: { type: "UTF8" },
      property_cid: { type: "UTF8", optional: true },
      request_identifier: { type: "UTF8", optional: true },
      parcel_identifier: { type: "UTF8", optional: true },
      source_system: { type: "UTF8", optional: true },
      county_name: { type: "UTF8", optional: true },
      state_code: { type: "UTF8", optional: true },
      address_street: { type: "UTF8", optional: true },
      address_city: { type: "UTF8", optional: true },
      address_zip: { type: "UTF8", optional: true },
      latitude: { type: "DOUBLE", optional: true },
      longitude: { type: "DOUBLE", optional: true },
      lot_size_acre: { type: "DOUBLE", optional: true },
      lot_area_sqft: { type: "DOUBLE", optional: true },
      exterior_wall_material: { type: "UTF8", optional: true },
      roof_covering_material: { type: "UTF8", optional: true },
      property_type: { type: "UTF8", optional: true },
      property_usage_type: { type: "UTF8", optional: true },
      built_year: { type: "INT64", optional: true },
      livable_floor_area: { type: "DOUBLE", optional: true },
      total_area: { type: "DOUBLE", optional: true },
      assessed_value: { type: "DOUBLE", optional: true },
      market_value: { type: "DOUBLE", optional: true },
      land_value: { type: "DOUBLE", optional: true },
      avm_value: { type: "DOUBLE", optional: true },
      owner_name: { type: "UTF8", optional: true },
      owners_text: { type: "UTF8", optional: true },
      owner_count: { type: "INT64", optional: true },
      owner_occupied: { type: "BOOLEAN", optional: true },
      last_sale_date: { type: "UTF8", optional: true },
      last_sale_price: { type: "DOUBLE", optional: true },
      subdivision: { type: "UTF8", optional: true },
      has_permits: { type: "BOOLEAN", optional: true },
      permit_count: { type: "INT64", optional: true },
      has_sunbiz_tenant: { type: "BOOLEAN", optional: true },
      has_bbb_contractor: { type: "BOOLEAN", optional: true },
      has_pa_corp_tenant: { type: "BOOLEAN", optional: true },
      hoa_flag: { type: "BOOLEAN", optional: true },
    },
  },
  publication: {
    bucket: "elephant-oracle-query-table",
    queryTableIpnsLabel: "oracle-query-table-duval",
    coverageIpnsLabel: "oracle-dataset-coverage-duval",
  },
});
