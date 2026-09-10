import { createAccelaAdapter } from "./accela.mjs";
import { createArcgisFeatureServiceAdapter } from "./arcgis-feature-service.mjs";
import { createBcsPosseAdapter } from "./bcs-posse.mjs";
import { createClick2GovAdapter } from "./click2gov.mjs";
import { createCitizenserveAdapter } from "./citizenserve.mjs";
import { createCoconutCreekStatusAdapter } from "./coconut-creek-status.mjs";
import { createJaxEpicsAdapter } from "./jaxepics.mjs";
import { createSmartGovAdapter } from "./smartgov.mjs";
import { createTylerCivicAccessAdapter } from "./tyler-civic-access.mjs";
import { createTylerEsuiteAdapter } from "./tyler-esuite.mjs";

const adapterFactories = Object.freeze({
  accela: createAccelaAdapter,
  "arcgis-feature-service": createArcgisFeatureServiceAdapter,
  "bcs-posse": createBcsPosseAdapter,
  click2gov: createClick2GovAdapter,
  citizenserve: createCitizenserveAdapter,
  "coconut-creek-status": createCoconutCreekStatusAdapter,
  jaxepics: createJaxEpicsAdapter,
  smartgov: createSmartGovAdapter,
  "tyler-civic-access": createTylerCivicAccessAdapter,
  "tyler-esuite": createTylerEsuiteAdapter,
});

export function createPermitAdapter(jurisdiction, options = {}) {
  if (!jurisdiction.adapterKey) return null;
  const factory = adapterFactories[jurisdiction.adapterKey];
  if (!factory) {
    throw new Error(
      `Permit adapter "${jurisdiction.adapterKey}" is not implemented`,
    );
  }
  return factory(jurisdiction, options);
}

export function createPermitAdapterForSource(
  jurisdiction,
  source,
  options = {},
) {
  if (source.adapterRouteKey === null) return null;
  const routeKey = source.adapterRouteKey ?? "primary";
  if (routeKey === "primary") {
    if (source.adapterKey && source.adapterKey !== jurisdiction.adapterKey) {
      throw new Error(
        `Permit source "${source.key}" expects "${source.adapterKey}" but primary route uses "${jurisdiction.adapterKey}"`,
      );
    }
    return createPermitAdapter(jurisdiction, options);
  }
  const route = jurisdiction.adapterRoutes?.find(
    (candidate) => candidate.key === routeKey,
  );
  if (!route) {
    throw new Error(
      `Permit source "${source.key}" references unknown route "${routeKey}"`,
    );
  }
  if (source.adapterKey && source.adapterKey !== route.adapterKey) {
    throw new Error(
      `Permit source "${source.key}" adapter does not match route "${routeKey}"`,
    );
  }
  return createPermitAdapter(
    {
      ...jurisdiction,
      adapterKey: route.adapterKey,
      adapterConfig: route.adapterConfig,
    },
    options,
  );
}

export const implementedPermitAdapterKeys = Object.freeze(
  Object.keys(adapterFactories).sort(),
);
