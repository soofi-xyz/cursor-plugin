import { createHash } from "node:crypto";

import { z } from "zod";

const COUNTY_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const JURISDICTION_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const recordsRequestSchema = z
  .object({
    recipientOffice: z.string().min(1),
    systemScope: z.string().min(1),
    route: z.enum(["api-first", "records-first"]),
    requestUrl: z.string().url(),
  })
  .strict();

const sourceSurfaceSchema = z
  .object({
    key: z.string().regex(JURISDICTION_KEY_PATTERN),
    url: z.string().url(),
    role: z.enum([
      "historical-search",
      "daily-bulk-export",
      "current-intake",
      "records-information",
    ]),
    access: z.enum(["public", "blocked", "manual-only", "unavailable"]),
  })
  .strict()
  .superRefine((surface, context) => {
    if (new URL(surface.url).protocol !== "https:") {
      context.addIssue({
        code: "custom",
        path: ["url"],
        message: "Permit source URLs must use HTTPS",
      });
    }
  });

const adapterConfigSchema = z
  .object({
    baseUrl: z.string().url(),
    apiBaseUrl: z.string().url().nullable(),
        bulkLayerUrl: z.string().url().nullable().optional(),
        bulkPageSize: z.number().int().min(1).max(2000).nullable().optional(),
    municipalityId: z.string().min(1).nullable(),
    parcelFieldNames: z.array(z.string().min(1)),
    minimumDelayMs: z.number().int().min(250),
  })
  .strict()
  .superRefine((config, context) => {
    for (const key of ["baseUrl", "apiBaseUrl"]) {
      if (config[key] && new URL(config[key]).protocol !== "https:") {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "Permit adapter URLs must use HTTPS",
        });
      }
    }
  });

const jurisdictionSchema = z
  .object({
    key: z.string().regex(JURISDICTION_KEY_PATTERN),
    name: z.string().min(1),
    routingCities: z.array(z.string().min(1)),
    defaultForUnmatchedCity: z.boolean().default(false),
    status: z.enum(["supported", "blocked", "manual-only", "unavailable"]),
    historicalRecords: z.boolean(),
    adapterKey: z
      .enum(["jaxepics", "click2gov", "etrakit"])
      .nullable(),
    adapterConfig: adapterConfigSchema.nullable(),
    parcelSearchFormat: z.enum(["duval-re", "digits-only", "source-specific"]),
    sources: z.array(sourceSurfaceSchema).min(1),
    recordsRequest: recordsRequestSchema.nullable(),
  })
  .strict()
  .superRefine((jurisdiction, context) => {
    const historicalSource = jurisdiction.sources.some(
      (source) =>
        ["historical-search", "daily-bulk-export"].includes(source.role) &&
        source.access === "public",
    );
    if (
      jurisdiction.status === "supported" &&
      (!jurisdiction.historicalRecords ||
        jurisdiction.adapterKey === null ||
        jurisdiction.adapterConfig === null ||
        !historicalSource)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Supported permit jurisdictions require an adapter and a public historical-search source",
      });
    }
    if (
      ["blocked", "manual-only"].includes(jurisdiction.status) &&
      jurisdiction.recordsRequest === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["recordsRequest"],
        message:
          "Blocked and manual-only jurisdictions require a records-request route",
      });
    }
    if (
      (jurisdiction.adapterKey === null) !==
      (jurisdiction.adapterConfig === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["adapterConfig"],
        message:
          "Permit adapter key and adapter configuration must both be present or absent",
      });
    }
  });

export const permitProfileSchema = z
  .object({
    countyKey: z.string().regex(COUNTY_KEY_PATTERN),
    countyName: z.string().min(1),
    stateCode: z.string().length(2).regex(/^[A-Z]{2}$/),
    countyFips: z.string().regex(/^\d{5}$/),
    parcelIdentifierPattern: z.string().min(1),
    jurisdictions: z.array(jurisdictionSchema).min(1),
    publication: z
      .object({
        bucket: z.string().min(1),
        propertyQueryTableIpnsLabel: z.string().min(1),
        permitTableIpnsLabel: z.string().min(1),
        coverageIpnsLabel: z.string().min(1),
      })
      .strict(),
  })
  .strict()
  .superRefine((profile, context) => {
    const keys = profile.jurisdictions.map((jurisdiction) => jurisdiction.key);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        path: ["jurisdictions"],
        message: "Permit jurisdiction keys must be unique",
      });
    }
    const defaults = profile.jurisdictions.filter(
      (jurisdiction) => jurisdiction.defaultForUnmatchedCity,
    );
    if (defaults.length !== 1) {
      context.addIssue({
        code: "custom",
        path: ["jurisdictions"],
        message:
          "Permit profiles require exactly one default jurisdiction for unmatched cities",
      });
    }
    const aliases = profile.jurisdictions.flatMap((jurisdiction) =>
      jurisdiction.routingCities.map((city) => city.trim().toUpperCase()),
    );
    if (new Set(aliases).size !== aliases.length) {
      context.addIssue({
        code: "custom",
        path: ["jurisdictions"],
        message: "Permit routing city aliases must be unique",
      });
    }
  });

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

export function validatePermitProfile(value) {
  return deepFreeze(permitProfileSchema.parse(value));
}

export function permitProfileDigest(profile) {
  const validated = permitProfileSchema.parse(profile);
  return createHash("sha256")
    .update(`${JSON.stringify(canonicalize(validated))}\n`)
    .digest("hex");
}

export function createPermitProfileRegistry(profiles) {
  const byCounty = new Map();
  for (const input of profiles) {
    const profile = validatePermitProfile(input);
    if (byCounty.has(profile.countyKey)) {
      throw new Error(`Duplicate permit profile: ${profile.countyKey}`);
    }
    byCounty.set(profile.countyKey, profile);
  }
  const countyKeys = Object.freeze([...byCounty.keys()].sort());
  return Object.freeze({
    countyKeys,
    require(countyKey) {
      const profile = byCounty.get(countyKey);
      if (!profile) {
        throw new Error(
          `Unknown permit --county "${countyKey}". Known permit counties: ${countyKeys.join(", ")}`,
        );
      }
      return profile;
    },
  });
}
