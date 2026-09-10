import { createPermitProfileRegistry } from "./permit-profile.mjs";
import { browardPermitProfile } from "./broward/permit-profile.mjs";
import { duvalPermitProfile } from "./duval/permit-profile.mjs";
import { hillsboroughPermitProfile } from "./hillsborough/permit-profile.mjs";

export const permitProfileRegistry = createPermitProfileRegistry([
  browardPermitProfile,
  duvalPermitProfile,
  hillsboroughPermitProfile,
]);

export function requirePermitProfile(countyKey) {
  return permitProfileRegistry.require(countyKey);
}
