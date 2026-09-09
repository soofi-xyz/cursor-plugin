import { createHash } from "node:crypto";

import { z } from "zod";

import { permitProfileDigest } from "../counties/permit-profile.mjs";
import { assertPermitProfileReady } from "./readiness.mjs";

export const PERMIT_BACKFILL_PLAN_VERSION =
  "elephant.permit-backfill-plan.v1";

const optionsSchema = z
  .object({
    mode: z.enum(["delta", "repair"]),
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    throughDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    propertiesPath: z.string().min(1).nullable(),
    manifestPath: z.string().min(1).nullable(),
    jurisdictionKeys: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .superRefine((options, context) => {
    if (options.mode === "delta" && !options.fromDate) {
      context.addIssue({
        code: "custom",
        path: ["fromDate"],
        message: "Delta plans require fromDate",
      });
    }
    if (options.mode === "delta" && !options.propertiesPath) {
      context.addIssue({
        code: "custom",
        path: ["propertiesPath"],
        message: "Delta plans require a property input path",
      });
    }
    if (options.mode === "repair" && !options.manifestPath) {
      context.addIssue({
        code: "custom",
        path: ["manifestPath"],
        message: "Repair plans require an artifact manifest path",
      });
    }
  });

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function adapterRoute(jurisdiction, source) {
  if (source.adapterRouteKey === null) return null;
  if (!source.adapterRouteKey || source.adapterRouteKey === "primary") {
    return {
      key: "primary",
      adapterKey: jurisdiction.adapterKey,
      adapterConfig: jurisdiction.adapterConfig,
    };
  }
  return jurisdiction.adapterRoutes.find(
    (route) => route.key === source.adapterRouteKey,
  );
}

export function createPermitBackfillPlan(profile, rawOptions) {
  const options = optionsSchema.parse(rawOptions);
  const readiness = assertPermitProfileReady(profile);
  const selected = new Set(options.jurisdictionKeys);
  const unknown = [...selected].filter(
    (key) =>
      !profile.jurisdictions.some(
        (jurisdiction) => jurisdiction.key === key,
      ),
  );
  if (unknown.length) {
    throw new Error(`Unknown permit jurisdictions: ${unknown.join(", ")}`);
  }

  const tasks = profile.jurisdictions
    .filter(
      (jurisdiction) =>
        jurisdiction.status === "supported" &&
        (selected.size === 0 || selected.has(jurisdiction.key)),
    )
    .flatMap((jurisdiction) =>
      jurisdiction.sources
        .filter(
          (source) =>
            source.access === "public" &&
            ["certified", "bounded-only"].includes(
              source.enumerationStatus,
            ),
        )
        .map((source) => {
          const route = adapterRoute(jurisdiction, source);
          const fingerprintVersion =
            route.adapterConfig.detailFingerprintVersion;
          const identity = [
            profile.countyKey,
            jurisdiction.key,
            source.key,
            options.mode,
            options.fromDate ?? "",
            options.throughDate ?? "",
            fingerprintVersion,
          ].join(":");
          return {
            taskId: hash(identity).slice(0, 32),
            idempotencyKey: hash(`permit-backfill:${identity}`),
            jurisdictionKey: jurisdiction.key,
            sourceKey: source.key,
            adapterRouteKey: route.key,
            adapterKey: route.adapterKey,
            strategy:
              source.role === "daily-bulk-export" ||
              route.adapterKey === "arcgis-feature-service"
                ? "bounded-source-enumeration"
                : "property-first",
            detailFingerprintVersion: fingerprintVersion,
            input:
              options.mode === "delta"
                ? {
                    propertiesPath: options.propertiesPath,
                    fromDate: options.fromDate,
                    throughDate: options.throughDate,
                  }
                : {
                    manifestPath: options.manifestPath,
                    repairWhen:
                      "missing, failed, or stale detail fingerprint only",
                  },
          };
        }),
    )
    .sort((left, right) =>
      `${left.jurisdictionKey}/${left.sourceKey}`.localeCompare(
        `${right.jurisdictionKey}/${right.sourceKey}`,
      ),
    );

  return {
    schemaVersion: PERMIT_BACKFILL_PLAN_VERSION,
    countyKey: profile.countyKey,
    profileDigest: permitProfileDigest(profile),
    mode: options.mode,
    writePolicy:
      "plan-only; execution and database writes require a separate approved operator action",
    readiness: {
      jurisdictionCount: readiness.jurisdictionCount,
      harvestableSourceCount: readiness.harvestableSourceCount,
    },
    tasks,
    planDigest: hash(JSON.stringify(tasks)),
  };
}
