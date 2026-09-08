import { createEnrichmentProfileRegistry } from "./enrichment-profile.mjs";
import { duvalEnrichmentProfile } from "./duval/enrichment-profile.mjs";

export const enrichmentProfileRegistry = createEnrichmentProfileRegistry([
  duvalEnrichmentProfile,
]);

export function requireEnrichmentProfile(countyKey) {
  return enrichmentProfileRegistry.require(countyKey);
}
