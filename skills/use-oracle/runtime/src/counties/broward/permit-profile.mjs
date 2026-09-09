import { validatePermitProfile } from "../permit-profile.mjs";

export const browardPermitProfile = validatePermitProfile({
  countyKey: "broward",
  countyName: "Broward",
  stateCode: "FL",
  countyFips: "12011",
  parcelIdentifierPattern: "^[A-Z0-9]{12}$",
  jurisdictions: [
    {
      key: "southwest-ranches",
      name: "Southwest Ranches",
      routingCities: ["SOUTHWEST RANCHES"],
      defaultForUnmatchedCity: true,
      status: "supported",
      historicalRecords: true,
      adapterKey: "citizenserve",
      adapterConfig: {
        sourceSystem: "broward_southwest_ranches_citizenserve_permits",
        baseUrl: "https://www6.citizenserve.com/Portal",
        apiBaseUrl: null,
        municipalityId: null,
        parcelFieldNames: ["parcelNumber"],
        minimumDelayMs: 1_500,
        maximumSearchPages: 3,
        maximumDetailRecords: 25,
        installationId: 117,
        jurisdictionTokens: ["southwest ranches"],
        contractorDetailCapability: "public-detail",
      },
      parcelSearchFormat: "digits-only",
      sources: [
        {
          key: "citizenserve-current",
          url: "https://www6.citizenserve.com/Portal/PortalController?Action=showSearchPage&ctzPagePrefix=Portal_&installationID=117&original_contactID=0&original_iid=0",
          role: "historical-search",
          access: "public",
          historicalBoundary:
            "Public installation exposes Southwest Ranches records, including legacy SWR permit numbers.",
          contractorDetailCapability: "public-detail",
        },
      ],
      recordsRequest: {
        recipientOffice: "Town of Southwest Ranches Building Department",
        systemScope:
          "Complete Citizenserve/CAP Government permit, contractor, and inspection history with Broward folio identifiers",
        route: "api-first",
        requestUrl:
          "https://www.southwestranches.org/departments/town-engineer/building/",
      },
    },
  ],
  publication: {
    bucket: "elephant-oracle-query-table",
    propertyQueryTableIpnsLabel: "oracle-query-table-broward",
    permitTableIpnsLabel: "oracle-permit-table-broward",
    coverageIpnsLabel: "oracle-dataset-coverage-broward",
  },
});
