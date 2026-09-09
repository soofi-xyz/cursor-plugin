import { createHash } from "node:crypto";

import { z } from "zod";

const COUNTY_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const JURISDICTION_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const PERMIT_ADAPTER_KEYS = Object.freeze([
  "accela",
  "arcgis-feature-service",
  "bcs-posse",
  "citizenserve",
  "click2gov",
  "coconut-creek-status",
  "jaxepics",
  "smartgov",
  "tyler-civic-access",
  "tyler-esuite",
]);
const permitAdapterKeySchema = z.enum(PERMIT_ADAPTER_KEYS);

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
    historicalBoundary: z.string().min(1).optional(),
    contractorDetailCapability: z
      .enum(["public-detail", "not-exposed", "unknown"])
      .optional(),
    adapterKey: permitAdapterKeySchema.nullable().optional(),
    adapterRouteKey: z
      .string()
      .regex(JURISDICTION_KEY_PATTERN)
      .nullable()
      .optional(),
    implementationStatus: z.string().min(1).optional(),
    historyStartDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    predecessorBoundary: z.string().min(1).optional(),
    enumerationStatus: z
      .enum(["certified", "bounded-only", "blocked", "unknown"])
      .optional(),
    reportedCount: z.number().int().nonnegative().nullable().optional(),
    anonymousAccess: z.boolean().optional(),
    blockerType: z
      .enum([
        "captcha",
        "login",
        "api-authorization",
        "custodian-only",
        "source-unavailable",
        "identity-unproven",
        "adapter-unavailable",
      ])
      .optional(),
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
    baseUrl: z.string().url().optional(),
    fallbackBaseUrls: z.array(z.string().url()).max(5).optional(),
    listingOnlyBaseUrls: z.array(z.string().url()).max(5).optional(),
    pinConfiguredHost: z.boolean().optional(),
    apiBaseUrl: z.string().url().nullable().optional(),
    bulkLayerUrl: z.string().url().nullable().optional(),
    bulkPageSize: z.number().int().min(1).max(2000).nullable().optional(),
    agencyCode: z.string().min(1).optional(),
    module: z.string().min(1).optional(),
    contentFrameName: z.string().min(1).nullable().optional(),
    layerUrl: z.string().url().optional(),
    objectIdField: z.string().min(1).optional(),
    parcelField: z.string().min(1).nullable().optional(),
    fieldMap: z.record(z.string(), z.string()).optional(),
    maximumResultRecords: z.number().int().min(1).max(10000).optional(),
    detailFingerprintVersion: z
      .string()
      .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/)
      .optional(),
    historyBoundary: z.string().min(1).optional(),
    searchUrl: z.string().url().optional(),
    listingOnly: z.boolean().optional(),
    municipalityId: z.string().min(1).nullable().optional(),
    parcelFieldNames: z.array(z.string().min(1)).optional(),
    parcelSegmentLengths: z.array(z.number().int().positive()).optional(),
    minimumDelayMs: z.number().int().min(250).optional(),
    countyKey: z.string().regex(COUNTY_KEY_PATTERN).optional(),
    countyName: z.string().min(1).optional(),
    sourceSystem: z
      .string()
      .regex(/^[a-z0-9_]+_permits$/)
      .optional(),
    expectedTenantId: z.string().min(1).optional(),
    expectedTenantName: z.string().min(1).optional(),
    maximumSearchPages: z.number().int().min(1).max(20).optional(),
    maximumContactPages: z.number().int().min(1).max(10).optional(),
    maximumDetailRecords: z.number().int().min(1).max(100).optional(),
    installationId: z.number().int().positive().optional(),
    jurisdictionTokens: z.array(z.string().min(1)).optional(),
    contractorDetailCapability: z
      .enum(["public-detail", "not-exposed", "unknown"])
      .optional(),
  })
  .strict()
  .superRefine((config, context) => {
    const configuredUrls = [
      config.baseUrl,
      config.apiBaseUrl,
      config.layerUrl,
      config.searchUrl,
      ...(config.fallbackBaseUrls ?? []),
      ...(config.listingOnlyBaseUrls ?? []),
    ].filter(Boolean);
    for (const configuredUrl of configuredUrls) {
      if (new URL(configuredUrl).protocol !== "https:") {
        context.addIssue({
          code: "custom",
          path: ["baseUrl"],
          message: "Permit adapter URLs must use HTTPS",
        });
      }
    }
    const sourceUrls = [
      config.baseUrl,
      ...(config.fallbackBaseUrls ?? []),
    ].filter(Boolean);
    for (const listingOnlyUrl of config.listingOnlyBaseUrls ?? []) {
      if (!sourceUrls.includes(listingOnlyUrl)) {
        context.addIssue({
          code: "custom",
          path: ["listingOnlyBaseUrls"],
          message:
            "Listing-only adapter URLs must also be configured source URLs",
        });
      }
    }
    if (
      (config.expectedTenantId === undefined) !==
      (config.expectedTenantName === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["expectedTenantName"],
        message:
          "Tyler tenant ID and tenant name must be configured together",
      });
    }
  });

const adapterRouteSchema = z
  .object({
    key: z.string().regex(JURISDICTION_KEY_PATTERN),
    adapterKey: permitAdapterKeySchema,
    adapterConfig: adapterConfigSchema,
  })
  .strict();

const jurisdictionSchema = z
  .object({
    key: z.string().regex(JURISDICTION_KEY_PATTERN),
    name: z.string().min(1),
    routingCities: z.array(z.string().min(1)),
    defaultForUnmatchedCity: z.boolean().default(false),
    status: z.enum([
      "supported",
      "blocked",
      "manual-only",
      "unavailable",
      "delegated",
      "custodian-only",
    ]),
    historicalRecords: z.boolean(),
    adapterKey: permitAdapterKeySchema.nullable(),
    adapterConfig: adapterConfigSchema.nullable(),
    adapterRoutes: z.array(adapterRouteSchema).default([]),
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
      [
        "blocked",
        "manual-only",
        "delegated",
        "custodian-only",
      ].includes(jurisdiction.status) &&
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
    const routeKeys = new Set(["primary"]);
    for (const route of jurisdiction.adapterRoutes) {
      if (routeKeys.has(route.key)) {
        context.addIssue({
          code: "custom",
          path: ["adapterRoutes"],
          message: `Duplicate permit adapter route "${route.key}"`,
        });
      }
      routeKeys.add(route.key);
    }
    for (const [index, source] of jurisdiction.sources.entries()) {
      if (
        source.adapterRouteKey &&
        !routeKeys.has(source.adapterRouteKey)
      ) {
        context.addIssue({
          code: "custom",
          path: ["sources", index, "adapterRouteKey"],
          message: `Unknown permit adapter route "${source.adapterRouteKey}"`,
        });
      }
    }
  });

export const permitProfileSchema = z
  .object({
    countyKey: z.string().regex(COUNTY_KEY_PATTERN),
    countyName: z.string().min(1),
    stateCode: z.string().length(2).regex(/^[A-Z]{2}$/),
    countyFips: z.string().regex(/^\d{5}$/),
    parcelIdentifierPattern: z.string().min(1),
    parcelIdentifierFormat: z
      .enum(["duval-re", "broward-folio"])
      .default("duval-re"),
    defaultRoutingPolicy: z
      .enum(["fallback", "explicit-only"])
      .default("fallback"),
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
