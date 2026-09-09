import { createClick2GovAdapter } from "./click2gov.mjs";
import { createJaxEpicsAdapter } from "./jaxepics.mjs";
import { createTylerCivicAccessAdapter } from "./tyler-civic-access.mjs";

const adapterFactories = Object.freeze({
  click2gov: createClick2GovAdapter,
  jaxepics: createJaxEpicsAdapter,
  "tyler-civic-access": createTylerCivicAccessAdapter,
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

export const implementedPermitAdapterKeys = Object.freeze(
  Object.keys(adapterFactories).sort(),
);
