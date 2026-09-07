import { createPermitProfileRegistry } from "./permit-profile.mjs";
import { duvalPermitProfile } from "./duval/permit-profile.mjs";

export const permitProfileRegistry = createPermitProfileRegistry([
  duvalPermitProfile,
]);

export function requirePermitProfile(countyKey) {
  return permitProfileRegistry.require(countyKey);
}
