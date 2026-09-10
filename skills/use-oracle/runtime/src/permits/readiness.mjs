import { implementedPermitAdapterKeys } from "./adapters/index.mjs";

function resolvedAdapterKey(jurisdiction, source) {
  if (source.adapterRouteKey === null) return null;
  const routeKey = source.adapterRouteKey ?? "primary";
  if (routeKey === "primary") return jurisdiction.adapterKey;
  return (
    jurisdiction.adapterRoutes.find((route) => route.key === routeKey)
      ?.adapterKey ?? null
  );
}

function resolvedAdapterConfig(jurisdiction, source) {
  if (source.adapterRouteKey === null) return null;
  const routeKey = source.adapterRouteKey ?? "primary";
  if (routeKey === "primary") return jurisdiction.adapterConfig;
  return (
    jurisdiction.adapterRoutes.find((route) => route.key === routeKey)
      ?.adapterConfig ?? null
  );
}

export function evaluatePermitProfileReadiness(profile) {
  const implemented = new Set(implementedPermitAdapterKeys);
  const issues = [];
  const sources = [];

  for (const jurisdiction of profile.jurisdictions) {
    for (const source of jurisdiction.sources) {
      const adapterKey = resolvedAdapterKey(jurisdiction, source);
      const adapterConfig = resolvedAdapterConfig(jurisdiction, source);
      const harvestable =
        source.access === "public" &&
        ["certified", "bounded-only"].includes(
          source.enumerationStatus ?? "unknown",
        );
      const blocked =
        source.access !== "public" ||
        source.enumerationStatus === "blocked";

      if (harvestable && !adapterKey) {
        issues.push({
          jurisdictionKey: jurisdiction.key,
          sourceKey: source.key,
          code: "automatable_source_missing_route",
        });
      } else if (harvestable && !implemented.has(adapterKey)) {
        issues.push({
          jurisdictionKey: jurisdiction.key,
          sourceKey: source.key,
          code: "automatable_source_adapter_unimplemented",
          adapterKey,
        });
      }
      if (
        source.adapterKey &&
        adapterKey &&
        source.adapterKey !== adapterKey
      ) {
        issues.push({
          jurisdictionKey: jurisdiction.key,
          sourceKey: source.key,
          code: "source_adapter_route_mismatch",
          adapterKey,
        });
      }
      if (
        harvestable &&
        !adapterConfig?.detailFingerprintVersion
      ) {
        issues.push({
          jurisdictionKey: jurisdiction.key,
          sourceKey: source.key,
          code: "detail_fingerprint_version_missing",
          adapterKey,
        });
      }
      if (blocked && !source.blockerType) {
        issues.push({
          jurisdictionKey: jurisdiction.key,
          sourceKey: source.key,
          code: "blocked_source_missing_blocker_type",
        });
      }

      sources.push({
        jurisdictionKey: jurisdiction.key,
        sourceKey: source.key,
        access: source.access,
        harvestable,
        blocked,
        adapterKey,
        adapterImplemented: Boolean(adapterKey && implemented.has(adapterKey)),
        detailFingerprintVersion:
          adapterConfig?.detailFingerprintVersion ?? null,
      });
    }
  }

  const statusCounts = Object.fromEntries(
    [
      "supported",
      "blocked",
      "manual-only",
      "unavailable",
      "delegated",
      "custodian-only",
    ].map((status) => [
      status,
      profile.jurisdictions.filter(
        (jurisdiction) => jurisdiction.status === status,
      ).length,
    ]),
  );

  return {
    ready: issues.length === 0,
    jurisdictionCount: profile.jurisdictions.length,
    sourceCount: sources.length,
    routedSourceCount: sources.filter((source) => source.adapterKey).length,
    harvestableSourceCount: sources.filter((source) => source.harvestable)
      .length,
    blockedSourceCount: sources.filter((source) => source.blocked).length,
    statusCounts,
    sources,
    issues,
  };
}

export function assertPermitProfileReady(profile) {
  const result = evaluatePermitProfileReadiness(profile);
  if (!result.ready) {
    throw new Error(
      `Permit profile readiness failed: ${result.issues
        .map(
          (issue) =>
            `${issue.jurisdictionKey}/${issue.sourceKey}:${issue.code}`,
        )
        .join(", ")}`,
    );
  }
  return result;
}
