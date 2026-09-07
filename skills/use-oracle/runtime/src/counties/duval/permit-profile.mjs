import { validatePermitProfile } from "../permit-profile.mjs";

export const duvalPermitProfile = validatePermitProfile({
  countyKey: "duval",
  countyName: "Duval",
  stateCode: "FL",
  countyFips: "12031",
  parcelIdentifierPattern: "^\\d{6}-\\d{4}$",
  jurisdictions: [
    {
      key: "jacksonville",
      name: "Jacksonville consolidated city/county",
      routingCities: ["JACKSONVILLE", "DUVAL"],
      defaultForUnmatchedCity: true,
      status: "supported",
      historicalRecords: true,
      adapterKey: "jaxepics",
      adapterConfig: {
        baseUrl: "https://jaxepics.coj.net/",
        apiBaseUrl: "https://jaxepicsapi.coj.net/api/",
        bulkLayerUrl:
          "https://maps.coj.net/bid/duval.ashx?HTTPS://CMVXDWVZDA.QQQ/Z4",
        bulkPageSize: 2000,
        municipalityId: null,
        parcelFieldNames: [],
        minimumDelayMs: 1000,
      },
      parcelSearchFormat: "duval-re",
      sources: [
        {
          key: "bid-permit-map",
          url: "https://maps.coj.net/bid/default.aspx",
          role: "daily-bulk-export",
          access: "public",
        },
        {
          key: "jaxepics",
          url: "https://jaxepics.coj.net/Search/AdvancedSearch",
          role: "historical-search",
          access: "public",
        },
      ],
      recordsRequest: {
        recipientOffice: "City of Jacksonville Building Inspection Division",
        systemScope:
          "Complete issued building-permit and inspection history with RE parcel identifiers",
        route: "api-first",
        requestUrl: "https://jacksonville.gov/public-records",
      },
    },
    {
      key: "jacksonville-beach",
      name: "Jacksonville Beach",
      routingCities: ["JACKSONVILLE BEACH", "JAX BEACH"],
      defaultForUnmatchedCity: false,
      status: "blocked",
      historicalRecords: true,
      adapterKey: "click2gov",
      adapterConfig: {
        baseUrl:
          "https://jakb-egov.aspgov.com/Click2GovBP/selectpermit.html",
        apiBaseUrl: null,
        municipalityId: null,
        parcelFieldNames: [
          "parcel.parcelNumber1",
          "parcel.parcelNumber2",
        ],
        minimumDelayMs: 1500,
      },
      parcelSearchFormat: "duval-re",
      sources: [
        {
          key: "coast-click2gov",
          url: "https://jakb-egov.aspgov.com/Click2GovBP/index.html",
          role: "historical-search",
          access: "blocked",
        },
      ],
      recordsRequest: {
        recipientOffice: "City of Jacksonville Beach Planning and Development",
        systemScope:
          "Complete COAST building-permit and inspection history with parcel RE identifiers",
        route: "api-first",
        requestUrl:
          "https://jacksonvillebeach.justfoia.com/publicportal/home/newrequest",
      },
    },
    {
      key: "atlantic-beach",
      name: "Atlantic Beach",
      routingCities: ["ATLANTIC BEACH"],
      defaultForUnmatchedCity: false,
      status: "manual-only",
      historicalRecords: true,
      adapterKey: null,
      adapterConfig: null,
      parcelSearchFormat: "source-specific",
      sources: [
        {
          key: "bsa-online",
          url: "https://bsaonline.com/?uid=3261",
          role: "historical-search",
          access: "manual-only",
        },
        {
          key: "etrakit-history",
          url: "https://atlb-trk.aspgov.com/eTRAKiT/Search/permit.aspx",
          role: "historical-search",
          access: "blocked",
        },
      ],
      recordsRequest: {
        recipientOffice: "City of Atlantic Beach Building Division",
        systemScope:
          "Complete permit and inspection export including parcel identifiers and predecessor eTRAKiT records",
        route: "records-first",
        requestUrl:
          "https://atlanticbeachfl.justfoia.com/publicportal/home/newrequest",
      },
    },
    {
      key: "neptune-beach",
      name: "Neptune Beach",
      routingCities: ["NEPTUNE BEACH"],
      defaultForUnmatchedCity: false,
      status: "unavailable",
      historicalRecords: false,
      adapterKey: null,
      adapterConfig: null,
      parcelSearchFormat: "duval-re",
      sources: [
        {
          key: "neptune-beach-records",
          url: "https://www.nbfl.gov/planning-community-development",
          role: "records-information",
          access: "unavailable",
        },
      ],
      recordsRequest: {
        recipientOffice: "City of Neptune Beach Planning and Community Development",
        systemScope:
          "Complete issued building-permit and inspection history, including parcel identifiers and predecessor records",
        route: "records-first",
        requestUrl: "https://www.nbfl.gov/public-records",
      },
    },
    {
      key: "baldwin",
      name: "Baldwin",
      routingCities: ["BALDWIN"],
      defaultForUnmatchedCity: false,
      status: "unavailable",
      historicalRecords: false,
      adapterKey: null,
      adapterConfig: null,
      parcelSearchFormat: "duval-re",
      sources: [
        {
          key: "baldwin-forms",
          url: "https://baldwinfl.govoffice2.com/?SEC=989BD37A-6DA4-49F8-A566-4D52BFF1E945",
          role: "records-information",
          access: "unavailable",
        },
      ],
      recordsRequest: {
        recipientOffice: "Town of Baldwin",
        systemScope:
          "Complete issued building-permit and inspection ledger, including parcel identifiers and historical records",
        route: "records-first",
        requestUrl: "https://baldwinfl.govoffice2.com/",
      },
    },
  ],
  publication: {
    bucket: "elephant-oracle-query-table",
    propertyQueryTableIpnsLabel: "oracle-query-table-duval",
    permitTableIpnsLabel: "oracle-permit-table-duval",
    coverageIpnsLabel: "oracle-dataset-coverage-duval",
  },
});
