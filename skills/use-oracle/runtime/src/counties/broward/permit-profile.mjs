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
        fallbackBaseUrls: [
          "https://www2.citizenserve.com/Portal",
        ],
        listingOnlyBaseUrls: [
          "https://www2.citizenserve.com/Portal",
        ],
        pinConfiguredHost: true,
        apiBaseUrl: null,
        municipalityId: null,
        parcelFieldNames: ["parcelNumber"],
        minimumDelayMs: 1_500,
        maximumSearchPages: 3,
        maximumDetailRecords: 25,
        installationId: 117,
        jurisdictionTokens: ["southwest ranches"],
        contractorDetailCapability: "unknown",
      },
      parcelSearchFormat: "digits-only",
      sources: [
        {
          key: "citizenserve-current",
          url: "https://www6.citizenserve.com/Portal/PortalController?Action=showSearchPage&ctzPagePrefix=Portal_&installationID=117&original_contactID=0&original_iid=0",
          role: "historical-search",
          access: "unavailable",
          historicalBoundary:
            "Vendor-routed primary host for installation 117; unavailable during the bounded 2026-09-09 recovery.",
          contractorDetailCapability: "unknown",
        },
        {
          key: "citizenserve-www2-operator-fallback",
          url: "https://www2.citizenserve.com/Portal/PortalController?Action=showSearchPage&ctzPagePrefix=Portal_&installationID=117&original_contactID=0&original_iid=0",
          role: "historical-search",
          access: "public",
          historicalBoundary:
            "Operator-approved fallback for installation 117. The public form identifies Southwest Ranches permits, but the Town does not directly link this host and public result rows expose listings without detail links.",
          contractorDetailCapability: "not-exposed",
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
