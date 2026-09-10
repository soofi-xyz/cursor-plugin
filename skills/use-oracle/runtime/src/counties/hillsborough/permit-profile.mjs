import { validatePermitProfile } from "../permit-profile.mjs";

const TAMPA_SEARCH =
  "https://aca-prod.accela.com/TAMPA/Cap/CapHome.aspx?module=Building&TabName=Building";
const COUNTY_RECORDS =
  "https://hcfl.gov/businesses/permits-and-records/records-and-reports";

export const hillsboroughPermitProfile = validatePermitProfile({
  countyKey: "hillsborough",
  countyName: "Hillsborough",
  stateCode: "FL",
  countyFips: "12057",
  parcelIdentifierPattern: "^\\d{10}$",
  parcelIdentifierFormat: "source-specific",
  defaultRoutingPolicy: "explicit-only",
  jurisdictions: [
    {
      key: "tampa",
      name: "City of Tampa",
      routingCities: ["Tampa"],
      defaultForUnmatchedCity: false,
      status: "supported",
      historicalRecords: true,
      adapterKey: "accela",
      adapterConfig: {
        sourceSystem: "hillsborough_city_of_tampa_accela_permits",
        baseUrl: TAMPA_SEARCH,
        agencyCode: "TAMPA",
        module: "Building",
        contentFrameName: null,
        minimumDelayMs: 1_500,
        maximumSearchPages: 5,
        maximumDetailRecords: 100,
        detailFingerprintVersion: "accela-tampa-v2",
      },
      adapterRoutes: [],
      parcelSearchFormat: "source-specific",
      sources: [
        {
          key: "accela-current",
          url: TAMPA_SEARCH,
          role: "historical-search",
          access: "public",
          historicalBoundary:
            "Official City of Tampa Comprehensive Permit Summary documentation defines Accela as the permitting-history source for addresses within city limits and accepts explicit start/end dates. Exact reconciled address searches may certify 2016-09-10..2026-09-10 per property; broader predecessor coverage remains uncertified.",
          contractorDetailCapability: "public-detail",
          adapterKey: "accela",
          adapterRouteKey: "primary",
          implementationStatus: "adapter-implemented",
          enumerationStatus: "bounded-only",
          anonymousAccess: true,
        },
      ],
      recordsRequest: null,
    },
    {
      key: "hillsborough-other",
      name: "Hillsborough County and other municipal authorities",
      routingCities: [],
      defaultForUnmatchedCity: true,
      status: "custodian-only",
      historicalRecords: false,
      adapterKey: null,
      adapterConfig: null,
      adapterRoutes: [],
      parcelSearchFormat: "source-specific",
      sources: [
        {
          key: "authority-unresolved",
          url: COUNTY_RECORDS,
          role: "records-information",
          access: "blocked",
          historicalBoundary:
            "Authority, municipal delegation, source boundaries, and predecessor coverage require source-by-source certification.",
          contractorDetailCapability: "unknown",
          adapterKey: null,
          adapterRouteKey: null,
          implementationStatus: "coverage-not-certified",
          enumerationStatus: "blocked",
          anonymousAccess: true,
          blockerType: "custodian-only",
        },
      ],
      recordsRequest: {
        recipientOffice:
          "Hillsborough County and applicable municipal building records custodians",
        systemScope:
          "Permit, contractor, inspection, source-boundary, and predecessor records for the requested Hillsborough authority",
        route: "records-first",
        requestUrl: COUNTY_RECORDS,
      },
    },
  ],
  publication: {
    bucket: "elephant-oracle-query-table",
    propertyQueryTableIpnsLabel: "oracle-query-table-hillsborough",
    permitTableIpnsLabel: "oracle-permit-table-hillsborough",
    coverageIpnsLabel: "oracle-dataset-coverage-hillsborough",
  },
});
