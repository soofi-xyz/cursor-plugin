import { createHash } from "node:crypto";

import { z } from "zod";

const COUNTY_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CATEGORY_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ZIP_PREFIX_PATTERN = /^\d{3,5}$/;

const parquetFieldSchema = z
  .object({
    type: z.enum([
      "BOOLEAN",
      "BYTE_ARRAY",
      "DOUBLE",
      "FLOAT",
      "INT32",
      "INT64",
      "INT96",
      "UTF8",
    ]),
    optional: z.boolean().optional(),
  })
  .strict();

const bbbCategorySchema = z
  .object({
    key: z.string().regex(CATEGORY_KEY_PATTERN),
    url: z.string().url(),
    reviewedPath: z.string().startsWith("/"),
  })
  .strict()
  .superRefine((category, context) => {
    const url = new URL(category.url);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "www.bbb.org" ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.pathname !== category.reviewedPath ||
      !url.pathname.includes("/category/")
    ) {
      context.addIssue({
        code: "custom",
        path: ["url"],
        message:
          "BBB category URL must be an exact reviewed www.bbb.org HTTPS category path without query or fragment",
      });
    }
  });

export const enrichmentProfileSchema = z
  .object({
    countyKey: z.string().regex(COUNTY_KEY_PATTERN),
    countyName: z.string().min(1),
    stateCode: z.string().length(2).regex(/^[A-Z]{2}$/),
    sunbiz: z
      .object({
        zipPrefixes: z.array(z.string().regex(ZIP_PREFIX_PATTERN)).min(1),
      })
      .strict(),
    bbb: z
      .object({
        categories: z.array(bbbCategorySchema).min(1),
      })
      .strict(),
    queryTable: z
      .object({
        schemaFields: z.record(z.string().min(1), parquetFieldSchema),
      })
      .strict(),
    publication: z
      .object({
        bucket: z.string().min(1),
        queryTableIpnsLabel: z.string().min(1),
        coverageIpnsLabel: z.string().min(1),
      })
      .strict(),
  })
  .strict()
  .superRefine((profile, context) => {
    if (new Set(profile.sunbiz.zipPrefixes).size !== profile.sunbiz.zipPrefixes.length) {
      context.addIssue({
        code: "custom",
        path: ["sunbiz", "zipPrefixes"],
        message: "Sunbiz ZIP prefixes must be unique",
      });
    }

    const categoryKeys = profile.bbb.categories.map((category) => category.key);
    if (new Set(categoryKeys).size !== categoryKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["bbb", "categories"],
        message: "BBB category keys must be unique",
      });
    }

    const categoryUrls = profile.bbb.categories.map((category) => category.url);
    if (new Set(categoryUrls).size !== categoryUrls.length) {
      context.addIssue({
        code: "custom",
        path: ["bbb", "categories"],
        message: "BBB category URLs must be unique",
      });
    }

    const requiredSchemaFields = {
      property_id: "UTF8",
      address_street: "UTF8",
      address_zip: "UTF8",
      has_permits: "BOOLEAN",
      has_sunbiz_tenant: "BOOLEAN",
      has_bbb_contractor: "BOOLEAN",
    };
    for (const [fieldName, fieldType] of Object.entries(requiredSchemaFields)) {
      if (profile.queryTable.schemaFields[fieldName]?.type !== fieldType) {
        context.addIssue({
          code: "custom",
          path: ["queryTable", "schemaFields", fieldName],
          message: `Query-table field ${fieldName} must use type ${fieldType}`,
        });
      }
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

export function enrichmentProfileDigest(profile) {
  const validated = enrichmentProfileSchema.parse(profile);
  const body = `${JSON.stringify(canonicalize(validated))}\n`;
  return createHash("sha256").update(body).digest("hex");
}

export function validateEnrichmentProfile(value) {
  return deepFreeze(enrichmentProfileSchema.parse(value));
}

export function createEnrichmentProfileRegistry(profiles) {
  const entries = profiles.map((profile) => validateEnrichmentProfile(profile));
  const byCounty = new Map();
  for (const profile of entries) {
    if (byCounty.has(profile.countyKey)) {
      throw new Error(`Duplicate enrichment profile: ${profile.countyKey}`);
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
          `Unknown enrichment --county "${countyKey}". Known enrichment counties: ${countyKeys.join(", ")}`,
        );
      }
      return profile;
    },
  });
}
