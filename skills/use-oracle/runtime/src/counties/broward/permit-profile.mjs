import { validatePermitProfile } from "../permit-profile.mjs";

const COUNTY_CONTACTS =
  "https://www.broward.org/CodeAppeals/Pages/BuildingContacts.aspx";
const SYSTEM_SCOPE =
  "Complete permit, contractor, and inspection history with Broward folio identifiers, including predecessor systems";

function recordsRequest(name, requestUrl = COUNTY_CONTACTS) {
  return {
    recipientOffice: `${name} building records custodian`,
    systemScope: SYSTEM_SCOPE,
    route: "records-first",
    requestUrl,
  };
}

function publicSource({
  key,
  url,
  adapterKey,
  adapterRouteKey = "primary",
  boundary,
  contractor = "unknown",
  enumerationStatus = "bounded-only",
  implementationStatus = "adapter-implemented",
}) {
  return {
    key,
    url,
    role: "historical-search",
    access: "public",
    historicalBoundary: boundary,
    contractorDetailCapability: contractor,
    adapterKey,
    adapterRouteKey,
    implementationStatus,
    enumerationStatus,
    anonymousAccess: true,
  };
}

function blockedSource({
  key,
  url,
  access = "blocked",
  blockerType,
  boundary,
  adapterKey = null,
  adapterRouteKey = null,
  implementationStatus,
  role = "historical-search",
}) {
  return {
    key,
    url,
    role,
    access,
    historicalBoundary: boundary,
    contractorDetailCapability: "unknown",
    adapterKey,
    adapterRouteKey,
    implementationStatus,
    enumerationStatus: "blocked",
    anonymousAccess: access === "public",
    blockerType,
  };
}

function accelaConfig(
  sourceSystem,
  baseUrl,
  agencyCode,
  module = "Building",
  contentFrameName = null,
) {
  return {
    sourceSystem,
    baseUrl,
    agencyCode,
    module,
    contentFrameName,
    minimumDelayMs: 1_500,
    maximumSearchPages: 5,
    maximumDetailRecords: 100,
    detailFingerprintVersion: "accela-broward-v1",
  };
}

function tylerConfig(sourceSystem, baseUrl) {
  return {
    countyKey: "broward",
    countyName: "Broward",
    sourceSystem,
    baseUrl,
    apiBaseUrl: baseUrl,
    municipalityId: null,
    parcelFieldNames: [],
    minimumDelayMs: 1_500,
    maximumSearchPages: 10,
    maximumContactPages: 5,
    detailFingerprintVersion: "tyler-civic-access-v1",
  };
}

function citizenserveConfig(sourceSystem, installationId, tokens) {
  return {
    sourceSystem,
    baseUrl: "https://www6.citizenserve.com/Portal",
    fallbackBaseUrls: ["https://www2.citizenserve.com/Portal"],
    listingOnlyBaseUrls: ["https://www2.citizenserve.com/Portal"],
    pinConfiguredHost: true,
    apiBaseUrl: null,
    municipalityId: null,
    parcelFieldNames: ["parcelNumber"],
    minimumDelayMs: 1_500,
    maximumSearchPages: 3,
    maximumDetailRecords: 25,
    installationId,
    jurisdictionTokens: tokens,
    contractorDetailCapability: "unknown",
    detailFingerprintVersion: "citizenserve-listing-v1",
  };
}

function supportedJurisdiction({
  key,
  name,
  cities,
  adapterKey,
  adapterConfig,
  sources,
  adapterRoutes = [],
  defaultForUnmatchedCity = false,
}) {
  return {
    key,
    name,
    routingCities: cities,
    defaultForUnmatchedCity,
    status: "supported",
    historicalRecords: true,
    adapterKey,
    adapterConfig,
    adapterRoutes,
    parcelSearchFormat: "digits-only",
    sources,
    recordsRequest: null,
  };
}

function blockedJurisdiction({
  key,
  name,
  cities,
  source,
  adapterKey = null,
  adapterConfig = null,
  status = "blocked",
}) {
  return {
    key,
    name,
    routingCities: cities,
    status,
    historicalRecords: true,
    adapterKey,
    adapterConfig,
    parcelSearchFormat: "source-specific",
    sources: [source],
    recordsRequest: recordsRequest(name),
  };
}

export const browardPermitProfile = validatePermitProfile({
  countyKey: "broward",
  countyName: "Broward",
  stateCode: "FL",
  countyFips: "12011",
  parcelIdentifierPattern: "^[A-Z0-9]{12}$",
  parcelIdentifierFormat: "broward-folio",
  defaultRoutingPolicy: "explicit-only",
  jurisdictions: [
    supportedJurisdiction({
      key: "unincorporated-broward",
      name: "Unincorporated Broward County",
      cities: [
        "UNINCORPORATED BROWARD",
        "UNINCORPORATED BROWARD COUNTY",
        "UNINCORPORATED",
        "BROWARD COUNTY",
      ],
      defaultForUnmatchedCity: true,
      adapterKey: "bcs-posse",
      adapterConfig: {
        sourceSystem: "broward_county_bcs_posse_permits",
        baseUrl:
          "https://dpepp.broward.org/BCS/Default.aspx?PossePresentation=ParcelSearchByAddress",
        minimumDelayMs: 1_500,
        maximumDetailRecords: 75,
        detailFingerprintVersion: "bcs-posse-v1",
      },
      sources: [
        publicSource({
          key: "bcs-posse",
          url: "https://dpepp.broward.org/BCS/Default.aspx?PossePresentation=ParcelSearchByAddress",
          adapterKey: "bcs-posse",
          boundary:
            "Official county POSSE parcel search; legacy ten-character folios are retained as source provenance and never substituted for requested BCPA folios.",
          contractor: "public-detail",
        }),
        publicSource({
          key: "hced-arcgis-bulk",
          url: "https://bcgishub.broward.org/posse/rest/services/HCED/HCEDPossePermitsRef/MapServer/4",
          adapterKey: "arcgis-feature-service",
          adapterRouteKey: "hced-arcgis",
          boundary:
            "Official HCED reference layer is bulk-enumerable but exposes no certified BCPA parcel field; records remain unlinked until reconciled.",
          enumerationStatus: "bounded-only",
        }),
      ],
      adapterRoutes: [
        {
          key: "hced-arcgis",
          adapterKey: "arcgis-feature-service",
          adapterConfig: {
            sourceSystem: "broward_hced_arcgis_permits",
            baseUrl:
              "https://bcgishub.broward.org/posse/rest/services/HCED/HCEDPossePermitsRef/MapServer/4",
            layerUrl:
              "https://bcgishub.broward.org/posse/rest/services/HCED/HCEDPossePermitsRef/MapServer/4",
            objectIdField: "OBJECTID",
            parcelField: null,
            fieldMap: {
              permitNumber: "PERMITNUM",
              permitType: "PERMITTYPE",
              status: "FISTATUS",
              description: "WORKDESCRIPTION",
              address: "JOBADDRESS",
              issuedAt: "ISSUEDATE",
              contractorName: "PERMITTEE",
              contractorQualifier: "QUALIFIER",
            },
            bulkPageSize: 1_000,
            maximumResultRecords: 2_000,
            minimumDelayMs: 500,
            detailFingerprintVersion: "hced-arcgis-v1",
          },
        },
      ],
    }),
    supportedJurisdiction({
      key: "hollywood",
      name: "Hollywood",
      cities: ["HOLLYWOOD"],
      adapterKey: "accela",
      adapterConfig: accelaConfig(
        "broward_hollywood_accela_permits",
        "https://aca-prod.accela.com/HOLLYWOOD/Cap/CapHome.aspx?module=Building&TabName=Building",
        "HOLLYWOOD",
      ),
      sources: [
        publicSource({
          key: "accela-current",
          url: "https://aca-prod.accela.com/HOLLYWOOD/Cap/CapHome.aspx?module=Building&TabName=Building",
          adapterKey: "accela",
          boundary:
            "Current anonymous Accela Building search; no certified migration cutoff from BCLA.",
          contractor: "public-detail",
        }),
        blockedSource({
          key: "bcla-legacy",
          url: "https://apps.hollywoodfl.org/building/PermitStatus.aspx",
          access: "public",
          blockerType: "identity-unproven",
          boundary:
            "Official address-only BCLA search states 1988-present; no certified parcel crosswalk or Accela migration cutoff.",
          implementationStatus: "address-only-predecessor-blocked",
        }),
      ],
    }),
    supportedJurisdiction({
      key: "plantation",
      name: "Plantation",
      cities: ["PLANTATION"],
      adapterKey: "accela",
      adapterConfig: accelaConfig(
        "broward_plantation_accela_permits",
        "https://aca.plantation.org/CitizenAccess/Cap/CapHome.aspx?TabName=Building&module=Building",
        "PLANTATION",
        "Building",
        "ACAFrame",
      ),
      sources: [
        publicSource({
          key: "accela",
          url: "https://aca.plantation.org/CitizenAccess/Cap/CapHome.aspx?TabName=Building&module=Building",
          adapterKey: "accela",
          boundary:
            "Anonymous Accela Building parcel search; official microfilm route covers pre-2004 records.",
          contractor: "public-detail",
        }),
      ],
    }),
    supportedJurisdiction({
      key: "fort-lauderdale",
      name: "Fort Lauderdale",
      cities: ["FORT LAUDERDALE"],
      adapterKey: "accela",
      adapterConfig: accelaConfig(
        "broward_fort_lauderdale_accela_permits",
        "https://aca-prod.accela.com/FTL/Cap/CapHome.aspx?module=Permits&TabName=Permits",
        "FTL",
        "Permits",
      ),
      sources: [
        publicSource({
          key: "accela",
          url: "https://aca-prod.accela.com/FTL/Cap/CapHome.aspx?module=Permits&TabName=Permits",
          adapterKey: "accela",
          boundary: "Anonymous current Accela Permits parcel search.",
          contractor: "public-detail",
        }),
        publicSource({
          key: "official-arcgis-bulk",
          url: "https://gis.fortlauderdale.gov/arcgis/rest/services/GeneralPurpose/gisdata/MapServer/27",
          adapterKey: "arcgis-feature-service",
          adapterRouteKey: "official-arcgis",
          boundary:
            "Official open-data layer; parcel-linked bulk records supplement, but do not replace, Accela detail.",
          contractor: "not-exposed",
          enumerationStatus: "certified",
        }),
      ],
      adapterRoutes: [
        {
          key: "official-arcgis",
          adapterKey: "arcgis-feature-service",
          adapterConfig: {
            sourceSystem: "broward_fort_lauderdale_arcgis_permits",
            baseUrl:
              "https://gis.fortlauderdale.gov/arcgis/rest/services/GeneralPurpose/gisdata/MapServer/27",
            layerUrl:
              "https://gis.fortlauderdale.gov/arcgis/rest/services/GeneralPurpose/gisdata/MapServer/27",
            objectIdField: "OBJECTID",
            parcelField: "PARCELID",
            fieldMap: {
              permitNumber: "PERMITID",
              permitType: "PERMITTYPE",
              status: "PERMITSTAT",
              description: "PERMITDESC",
              address: "FULLADDR",
              parcelIdentifier: "PARCELID",
              issuedAt: "APPROVEDT",
              appliedAt: "SUBMITDT",
              completedAt: "COISSUE",
              estimatedValue: "ESTCOST",
              contractorName: "CONTRACTOR",
              contractorLicense: "CONTRACTID",
            },
            bulkPageSize: 1_000,
            maximumResultRecords: 2_000,
            minimumDelayMs: 500,
            detailFingerprintVersion: "fort-lauderdale-arcgis-v1",
          },
        },
      ],
    }),
    blockedJurisdiction({
      key: "coral-springs",
      name: "Coral Springs",
      cities: ["CORAL SPRINGS"],
      source: blockedSource({
        key: "etrakit",
        url: "https://etrakit.coralsprings.gov/eTRAKiT/Search/permit.aspx",
        blockerType: "captcha",
        boundary:
          "Public eTRAKiT permit search requires CAPTCHA; no bypass is attempted.",
        implementationStatus: "captcha-required",
      }),
    }),
    blockedJurisdiction({
      key: "pompano-beach",
      name: "Pompano Beach",
      cities: ["POMPANO BEACH"],
      adapterKey: "click2gov",
      adapterConfig: {
        countyKey: "broward",
        countyName: "Broward",
        sourceSystem: "broward_pompano_beach_click2gov_permits",
        baseUrl:
          "https://c2g.pompanobeachfl.gov/Click2GovBP/selectpermit.html",
        parcelFieldNames: [
          "parcel.parcelNumber",
          "parcel.parcelNumber2",
          "parcel.parcelNumber3",
        ],
        minimumDelayMs: 1_500,
        detailFingerprintVersion: "click2gov-v1",
      },
      source: blockedSource({
        key: "click2gov",
        url: "https://c2g.pompanobeachfl.gov/Click2GovBP/selectpermit.html",
        access: "public",
        blockerType: "identity-unproven",
        adapterKey: "click2gov",
        adapterRouteKey: "primary",
        boundary:
          "Anonymous Click2Gov is reachable; Broward folio segmentation and parcel reconciliation are not yet certified.",
        implementationStatus: "adapter-routed-identity-blocked",
      }),
    }),
    supportedJurisdiction({
      key: "davie",
      name: "Davie",
      cities: ["DAVIE"],
      adapterKey: "tyler-esuite",
      adapterConfig: {
        sourceSystem: "broward_davie_tyler_esuite_permits",
        baseUrl:
          "https://esuite.davie-fl.gov/eSuite.Permits/AdvancedSearchPage/AdvancedSearch.aspx",
        searchUrl:
          "https://esuite.davie-fl.gov/eSuite.Permits/AdvancedSearchPage/AdvancedSearch.aspx",
        minimumDelayMs: 1_500,
        maximumSearchPages: 5,
        maximumDetailRecords: 50,
        detailFingerprintVersion: "tyler-esuite-v1",
      },
      sources: [
        publicSource({
          key: "tyler-esuite",
          url: "https://esuite.davie-fl.gov/eSuite.Permits/AdvancedSearchPage/AdvancedSearch.aspx",
          adapterKey: "tyler-esuite",
          boundary:
            "Anonymous legacy eSuite address search; new 2026 submissions also use a separate login-gated Avolve route.",
          contractor: "public-detail",
        }),
      ],
    }),
    supportedJurisdiction({
      key: "pembroke-pines",
      name: "Pembroke Pines",
      cities: ["PEMBROKE PINES"],
      adapterKey: "tyler-civic-access",
      adapterConfig: tylerConfig(
        "broward_pembroke_pines_tyler_permits",
        "https://pembrokepinesfl-energovweb.tylerhost.net/apps/selfservice",
      ),
      sources: [
        publicSource({
          key: "tyler-civic-access",
          url: "https://pembrokepinesfl-energovweb.tylerhost.net/apps/selfservice",
          adapterKey: "tyler-civic-access",
          boundary:
            "Anonymous Tyler global parcel search; complete migrated history start is unverified.",
          contractor: "public-detail",
          implementationStatus: "bounded-pilot-certified",
        }),
      ],
    }),
    supportedJurisdiction({
      key: "coconut-creek",
      name: "Coconut Creek",
      cities: ["COCONUT CREEK"],
      adapterKey: "coconut-creek-status",
      adapterConfig: {
        sourceSystem: "broward_coconut_creek_status_permits",
        baseUrl:
          "https://www3.coconutcreek.gov/sd/permit/permit_status_01.asp",
        minimumDelayMs: 1_500,
        maximumDetailRecords: 50,
        detailFingerprintVersion: "coconut-creek-status-v1",
      },
      sources: [
        publicSource({
          key: "municipal-status",
          url: "https://www3.coconutcreek.gov/sd/permit/permit_status_01.asp",
          adapterKey: "coconut-creek-status",
          boundary:
            "Anonymous folio search with permit, contractor, inspection, and fee detail sections.",
          contractor: "public-detail",
        }),
      ],
    }),
    supportedJurisdiction({
      key: "cooper-city",
      name: "Cooper City",
      cities: ["COOPER CITY"],
      adapterKey: "accela",
      adapterConfig: accelaConfig(
        "broward_cooper_city_accela_permits",
        "https://aca-prod.accela.com/COOPER/Cap/CapHome.aspx?module=Building&TabName=Building",
        "COOPER",
      ),
      sources: [
        publicSource({
          key: "accela",
          url: "https://aca-prod.accela.com/COOPER/Cap/CapHome.aspx?module=Building&TabName=Building",
          adapterKey: "accela",
          boundary: "Anonymous Accela Building parcel search.",
          contractor: "public-detail",
        }),
      ],
    }),
    blockedJurisdiction({
      key: "dania-beach",
      name: "Dania Beach",
      cities: ["DANIA BEACH"],
      adapterKey: "tyler-esuite",
      adapterConfig: {
        sourceSystem: "broward_dania_beach_tyler_esuite_permits",
        baseUrl:
          "https://cityofdaniabeachfl.nwerp.tylerapp.com/nwprod/eSuite.Permits/AdvancedSearchPage/AdvancedSearch.aspx",
        searchUrl:
          "https://cityofdaniabeachfl.nwerp.tylerapp.com/nwprod/eSuite.Permits/AdvancedSearchPage/AdvancedSearch.aspx",
        minimumDelayMs: 1_500,
        maximumSearchPages: 5,
        maximumDetailRecords: 50,
        detailFingerprintVersion: "tyler-esuite-v1",
      },
      source: blockedSource({
        key: "tyler-esuite",
        url: "https://cityofdaniabeachfl.nwerp.tylerapp.com/nwprod/eSuite.Permits/AdvancedSearchPage/AdvancedSearch.aspx",
        access: "public",
        blockerType: "identity-unproven",
        adapterKey: "tyler-esuite",
        adapterRouteKey: "primary",
        boundary:
          "Reusable anonymous address/pagination/detail adapter is registered; positive parcel reconciliation remains to be certified.",
        implementationStatus: "adapter-routed-positive-detail-pending",
      }),
    }),
    blockedJurisdiction({
      key: "deerfield-beach",
      name: "Deerfield Beach",
      cities: ["DEERFIELD BEACH"],
      source: blockedSource({
        key: "gov-easy",
        url: "https://apps.gov-easy.com/Home/PermitInspection/Search?clientId=dce877e0-e162-4827-a60d-7249ec4e8fe2",
        blockerType: "captcha",
        boundary:
          "Gov-Easy/GeoCivix requires CAPTCHA and authenticated flows; no bypass or stored credentials are used.",
        implementationStatus: "captcha-login-required",
      }),
    }),
    supportedJurisdiction({
      key: "hallandale-beach",
      name: "Hallandale Beach",
      cities: ["HALLANDALE BEACH"],
      adapterKey: "tyler-civic-access",
      adapterConfig: tylerConfig(
        "broward_hallandale_beach_tyler_permits",
        "https://hallandalefl-energovpub.tylerhost.net/Apps/SelfService",
      ),
      sources: [
        publicSource({
          key: "tyler-civic-access",
          url: "https://hallandalefl-energovpub.tylerhost.net/Apps/SelfService",
          adapterKey: "tyler-civic-access",
          boundary:
            "Official FAQ certifies anonymous permit/parcel/address search; migrated-history start is unverified.",
          contractor: "public-detail",
          implementationStatus: "bounded-pilot-certified",
        }),
      ],
    }),
    blockedJurisdiction({
      key: "hillsboro-beach",
      name: "Hillsboro Beach",
      cities: ["HILLSBORO BEACH"],
      source: blockedSource({
        key: "communitycore",
        url: "https://app.communitycore.com/app/public-portal/c98c7b46-2cba-4ba2-bbd5-7a76966f42dd",
        blockerType: "login",
        boundary:
          "CommunityCore public portal requires an account for record access.",
        implementationStatus: "account-required",
      }),
    }),
    blockedJurisdiction({
      key: "lauderdale-lakes",
      name: "Lauderdale Lakes",
      cities: ["LAUDERDALE LAKES"],
      source: blockedSource({
        key: "opengov",
        url: "https://lauderdalelakesfl.portal.opengov.com/search",
        access: "unavailable",
        blockerType: "source-unavailable",
        boundary:
          "OpenGov search currently resolves to an inaccessible application landing surface.",
        implementationStatus: "source-unavailable",
      }),
    }),
    supportedJurisdiction({
      key: "lauderdale-by-the-sea",
      name: "Lauderdale-by-the-Sea",
      cities: ["LAUDERDALE-BY-THE-SEA", "LAUDERDALE BY THE SEA"],
      adapterKey: "citizenserve",
      adapterConfig: citizenserveConfig(
        "broward_lauderdale_by_the_sea_citizenserve_permits",
        117,
        ["lauderdale by the sea", "lauderdale-by-the-sea"],
      ),
      sources: [
        publicSource({
          key: "citizenserve-www2",
          url: "https://www2.citizenserve.com/Portal/PortalController?Action=showSearchPage&ctzPagePrefix=Portal_&installationID=117&original_contactID=0&original_iid=0",
          adapterKey: "citizenserve",
          boundary:
            "Installation 117 is shared; jurisdiction tokens are mandatory and the operator-approved www2 fallback exposes listing-only results.",
          contractor: "not-exposed",
          implementationStatus: "shared-installation-bounded",
        }),
      ],
    }),
    blockedJurisdiction({
      key: "lauderhill",
      name: "Lauderhill",
      cities: ["LAUDERHILL"],
      source: blockedSource({
        key: "egovplus",
        url: "https://www.lauderhill-fl.gov/departments/development-services",
        access: "blocked",
        blockerType: "source-unavailable",
        boundary:
          "Legacy anonymous eGovPLUS is HTTP-only and resets HTTPS connections; the runtime refuses insecure transport.",
        implementationStatus: "insecure-http-source-blocked",
      }),
    }),
    supportedJurisdiction({
      key: "lazy-lake",
      name: "Lazy Lake",
      cities: ["LAZY LAKE"],
      adapterKey: "bcs-posse",
      adapterConfig: {
        sourceSystem: "broward_lazy_lake_bcs_posse_permits",
        baseUrl:
          "https://dpepp.broward.org/BCS/Default.aspx?PossePresentation=ParcelSearchByAddress",
        minimumDelayMs: 1_500,
        maximumDetailRecords: 75,
        detailFingerprintVersion: "bcs-posse-v1",
      },
      sources: [
        publicSource({
          key: "delegated-bcs-posse",
          url: "https://dpepp.broward.org/BCS/Default.aspx?PossePresentation=ParcelSearchByAddress",
          adapterKey: "bcs-posse",
          boundary:
            "Building authority is delegated to Broward County and routed through the canonical BCS/POSSE adapter.",
          contractor: "public-detail",
        }),
      ],
    }),
    blockedJurisdiction({
      key: "lighthouse-point",
      name: "Lighthouse Point",
      cities: ["LIGHTHOUSE POINT"],
      adapterKey: "smartgov",
      adapterConfig: {
        sourceSystem: "broward_lighthouse_point_smartgov_permits",
        baseUrl:
          "https://ci-lighthousepoint-fl.smartgovcommunity.com/ApplicationPublic/ApplicationSearchAdvanced",
        searchUrl:
          "https://ci-lighthousepoint-fl.smartgovcommunity.com/ApplicationPublic/ApplicationSearchAdvanced",
        minimumDelayMs: 1_500,
        maximumSearchPages: 5,
        maximumDetailRecords: 50,
        detailFingerprintVersion: "smartgov-v1",
      },
      source: blockedSource({
        key: "smartgov",
        url: "https://ci-lighthousepoint-fl.smartgovcommunity.com/ApplicationPublic/ApplicationSearchAdvanced",
        access: "public",
        blockerType: "identity-unproven",
        adapterKey: "smartgov",
        adapterRouteKey: "primary",
        boundary:
          "Reusable anonymous parcel/pagination/detail adapter is registered; one positive live record is still required to certify detail identity.",
        implementationStatus: "adapter-routed-positive-detail-pending",
      }),
    }),
    blockedJurisdiction({
      key: "margate",
      name: "Margate",
      cities: ["MARGATE"],
      adapterKey: "click2gov",
      adapterConfig: {
        countyKey: "broward",
        countyName: "Broward",
        sourceSystem: "broward_margate_click2gov_permits",
        baseUrl:
          "https://marg-egov.aspgov.com/Click2GovBP/selectpermit.html",
        parcelFieldNames: [
          "parcel.parcelNumber",
          "parcel.parcelNumber2",
          "parcel.parcelNumber3",
        ],
        minimumDelayMs: 1_500,
        detailFingerprintVersion: "click2gov-v1",
      },
      source: blockedSource({
        key: "click2gov",
        url: "https://marg-egov.aspgov.com/Click2GovBP/selectpermit.html",
        access: "public",
        blockerType: "identity-unproven",
        adapterKey: "click2gov",
        adapterRouteKey: "primary",
        boundary:
          "Anonymous Click2Gov is reachable; Broward folio segmentation and parcel reconciliation are not yet certified.",
        implementationStatus: "adapter-routed-identity-blocked",
      }),
    }),
    supportedJurisdiction({
      key: "miramar",
      name: "Miramar",
      cities: ["MIRAMAR"],
      adapterKey: "tyler-civic-access",
      adapterConfig: tylerConfig(
        "broward_miramar_tyler_permits",
        "https://miramarfl-energovweb.tylerhost.net/apps/SelfService",
      ),
      sources: [
        publicSource({
          key: "tyler-civic-access",
          url: "https://miramarfl-energovweb.tylerhost.net/apps/SelfService",
          adapterKey: "tyler-civic-access",
          boundary:
            "Anonymous public-record search is separate from authenticated project management.",
          contractor: "public-detail",
          implementationStatus: "bounded-pilot-certified",
        }),
      ],
    }),
    blockedJurisdiction({
      key: "north-lauderdale",
      name: "North Lauderdale",
      cities: ["NORTH LAUDERDALE"],
      source: blockedSource({
        key: "tyler-login",
        url: "https://nlselfservice.nlauderdale.org/Energov_prod/SelfService",
        blockerType: "login",
        boundary:
          "Official Tyler page requires login; anonymous search is not certified.",
        implementationStatus: "login-required",
      }),
    }),
    supportedJurisdiction({
      key: "oakland-park",
      name: "Oakland Park",
      cities: ["OAKLAND PARK"],
      adapterKey: "tyler-civic-access",
      adapterConfig: tylerConfig(
        "broward_oakland_park_tyler_permits",
        "https://oaklandparkfl-energovweb.tylerhost.net/apps/SelfService",
      ),
      sources: [
        publicSource({
          key: "tyler-post-2019",
          url: "https://oaklandparkfl-energovweb.tylerhost.net/apps/SelfService",
          adapterKey: "tyler-civic-access",
          boundary: "Tyler records begin 2019-11-01.",
          contractor: "public-detail",
          implementationStatus: "bounded-pilot-certified",
        }),
        blockedSource({
          key: "pre-2019-records",
          url: "https://oaklandparkfl.gov/312/Permit-Access",
          access: "manual-only",
          blockerType: "custodian-only",
          boundary:
            "Permits before 2019-11-01 remain on documented legacy searches or the public-records route.",
          implementationStatus: "predecessor-gap",
          role: "records-information",
        }),
      ],
    }),
    blockedJurisdiction({
      key: "parkland",
      name: "Parkland",
      cities: ["PARKLAND"],
      source: blockedSource({
        key: "mygovernmentonline",
        url: "https://www.mgoconnect.org/cp/portal",
        blockerType: "login",
        boundary:
          "MyGovernmentOnline requires an account for record access.",
        implementationStatus: "account-required",
      }),
    }),
    blockedJurisdiction({
      key: "pembroke-park",
      name: "Pembroke Park",
      cities: ["PEMBROKE PARK"],
      source: blockedSource({
        key: "gov-easy",
        url: "https://www.tppfl.gov/194/Online-Permitting-System",
        blockerType: "captcha",
        boundary:
          "Gov-Easy record search requires CAPTCHA; no bypass is attempted.",
        implementationStatus: "captcha-required",
      }),
    }),
    {
      key: "sea-ranch-lakes",
      name: "Sea Ranch Lakes",
      routingCities: ["SEA RANCH LAKES"],
      status: "custodian-only",
      historicalRecords: false,
      adapterKey: null,
      adapterConfig: null,
      parcelSearchFormat: "source-specific",
      sources: [
        blockedSource({
          key: "custodian",
          url: "https://www.searanchlakes.com/",
          access: "manual-only",
          blockerType: "custodian-only",
          boundary: "No public historical search is documented.",
          implementationStatus: "no-public-history",
          role: "records-information",
        }),
      ],
      recordsRequest: recordsRequest("Sea Ranch Lakes"),
    },
    supportedJurisdiction({
      key: "southwest-ranches",
      name: "Southwest Ranches",
      cities: ["SOUTHWEST RANCHES"],
      adapterKey: "citizenserve",
      adapterConfig: citizenserveConfig(
        "broward_southwest_ranches_citizenserve_permits",
        117,
        ["southwest ranches"],
      ),
      sources: [
        blockedSource({
          key: "citizenserve-www6",
          url: "https://www6.citizenserve.com/Portal/PortalController?Action=showSearchPage&ctzPagePrefix=Portal_&installationID=117&original_contactID=0&original_iid=0",
          access: "unavailable",
          blockerType: "source-unavailable",
          adapterKey: "citizenserve",
          adapterRouteKey: "primary",
          boundary:
            "Vendor-routed primary host timed out during the bounded 2026-09-09 recovery.",
          implementationStatus: "primary-host-unavailable",
        }),
        publicSource({
          key: "citizenserve-www2",
          url: "https://www2.citizenserve.com/Portal/PortalController?Action=showSearchPage&ctzPagePrefix=Portal_&installationID=117&original_contactID=0&original_iid=0",
          adapterKey: "citizenserve",
          boundary:
            "Operator-approved listing-only fallback; Town does not directly link this host.",
          contractor: "not-exposed",
          implementationStatus: "operator-approved-fallback-certified",
        }),
      ],
    }),
    supportedJurisdiction({
      key: "sunrise",
      name: "Sunrise",
      cities: ["SUNRISE"],
      adapterKey: "tyler-civic-access",
      adapterConfig: tylerConfig(
        "broward_sunrise_tyler_permits",
        "https://energov.sunrisefl.gov/EnerGov_Prod/SelfService",
      ),
      sources: [
        publicSource({
          key: "tyler-civic-access",
          url: "https://energov.sunrisefl.gov/EnerGov_Prod/SelfService/SunriseFL%20Prod",
          adapterKey: "tyler-civic-access",
          boundary:
            "Anonymous Tyler public-record parcel search; migrated-history start is unverified.",
          contractor: "public-detail",
          implementationStatus: "bounded-pilot-certified",
        }),
      ],
    }),
    blockedJurisdiction({
      key: "tamarac",
      name: "Tamarac",
      cities: ["TAMARAC"],
      adapterKey: "click2gov",
      adapterConfig: {
        countyKey: "broward",
        countyName: "Broward",
        sourceSystem: "broward_tamarac_click2gov_permits",
        baseUrl:
          "https://e-gov.tamarac.org/Click2GovBP/selectpermit.html",
        parcelFieldNames: [
          "parcel.parcelNumber",
          "parcel.parcelNumber2",
          "parcel.parcelNumber3",
        ],
        minimumDelayMs: 1_500,
        detailFingerprintVersion: "click2gov-v1",
      },
      source: blockedSource({
        key: "click2gov",
        url: "https://e-gov.tamarac.org/Click2GovBP/selectpermit.html",
        access: "public",
        blockerType: "identity-unproven",
        adapterKey: "click2gov",
        adapterRouteKey: "primary",
        boundary:
          "Anonymous Click2Gov is reachable; Broward folio segmentation and parcel reconciliation are not yet certified.",
        implementationStatus: "adapter-routed-identity-blocked",
      }),
    }),
    supportedJurisdiction({
      key: "west-park",
      name: "West Park",
      cities: ["WEST PARK"],
      adapterKey: "citizenserve",
      adapterConfig: citizenserveConfig(
        "broward_west_park_citizenserve_permits",
        261,
        ["west park"],
      ),
      sources: [
        publicSource({
          key: "citizenserve-www2",
          url: "https://www2.citizenserve.com/Portal/PortalController?Action=showSearchPage&ctzPagePrefix=Portal_&installationID=261&original_contactID=0&original_iid=0",
          adapterKey: "citizenserve",
          boundary:
            "Citizenserve installation 261; www2 is the bounded listing fallback while primary-host stability remains unverified.",
          contractor: "not-exposed",
          implementationStatus: "listing-fallback-bounded",
        }),
      ],
    }),
    supportedJurisdiction({
      key: "weston",
      name: "Weston",
      cities: ["WESTON"],
      adapterKey: "accela",
      adapterConfig: accelaConfig(
        "broward_weston_accela_permits",
        "https://aca-prod.accela.com/weston/Cap/CapHome.aspx?TabName=Building&module=Building",
        "WESTON",
      ),
      sources: [
        publicSource({
          key: "accela",
          url: "https://aca-prod.accela.com/weston/Cap/CapHome.aspx?TabName=Building&module=Building",
          adapterKey: "accela",
          boundary:
            "Anonymous Accela Building parcel search; City incorporation boundary begins in 1997.",
          contractor: "public-detail",
        }),
      ],
    }),
    supportedJurisdiction({
      key: "wilton-manors",
      name: "Wilton Manors",
      cities: ["WILTON MANORS"],
      adapterKey: "citizenserve",
      adapterConfig: citizenserveConfig(
        "broward_wilton_manors_citizenserve_permits",
        125,
        ["wilton manors"],
      ),
      sources: [
        publicSource({
          key: "citizenserve-www2",
          url: "https://www2.citizenserve.com/Portal/PortalController?Action=showSearchPage&ctzPagePrefix=Portal_&installationID=125&original_contactID=0&original_iid=0",
          adapterKey: "citizenserve",
          boundary:
            "Citizenserve installation 125; files unavailable in public listing require the City records route.",
          contractor: "not-exposed",
          implementationStatus: "listing-fallback-bounded",
        }),
      ],
    }),
  ],
  publication: {
    bucket: "elephant-oracle-query-table",
    propertyQueryTableIpnsLabel: "oracle-query-table-broward",
    permitTableIpnsLabel: "oracle-permit-table-broward",
    coverageIpnsLabel: "oracle-dataset-coverage-broward",
  },
});
