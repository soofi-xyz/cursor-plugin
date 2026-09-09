const shared = Object.freeze({
  countyKey: "broward",
  countyName: "Broward",
  expectedTenantId: "1",
  maximumSearchPages: 10,
  maximumContactPages: 5,
  minimumDelayMs: 1500,
  municipalityId: null,
  parcelFieldNames: Object.freeze([]),
});

export const browardTylerJurisdictions = Object.freeze({
  "pembroke-pines": Object.freeze({
    key: "pembroke-pines",
    name: "Pembroke Pines",
    adapterKey: "tyler-civic-access",
    adapterConfig: Object.freeze({
      ...shared,
      baseUrl:
        "https://pembrokepinesfl-energovweb.tylerhost.net/apps/selfservice",
      apiBaseUrl:
        "https://pembrokepinesfl-energovweb.tylerhost.net/apps/selfservice",
      sourceSystem: "broward_pembroke_pines_tyler_permits",
      expectedTenantName: "EnerGovProd",
    }),
  }),
  sunrise: Object.freeze({
    key: "sunrise",
    name: "Sunrise",
    adapterKey: "tyler-civic-access",
    adapterConfig: Object.freeze({
      ...shared,
      baseUrl:
        "https://energov.sunrisefl.gov/EnerGov_Prod/SelfService/SunriseFL%20Prod",
      apiBaseUrl:
        "https://energov.sunrisefl.gov/EnerGov_Prod/SelfService",
      sourceSystem: "broward_sunrise_tyler_permits",
      expectedTenantName: "SunriseFL Prod",
    }),
  }),
});

export function requireBrowardTylerJurisdiction(jurisdictionKey) {
  const jurisdiction = browardTylerJurisdictions[jurisdictionKey];
  if (!jurisdiction) {
    throw new Error(
      `Unknown Broward Tyler jurisdiction "${jurisdictionKey}". Known jurisdictions: ${Object.keys(
        browardTylerJurisdictions,
      ).join(", ")}`,
    );
  }
  return jurisdiction;
}
