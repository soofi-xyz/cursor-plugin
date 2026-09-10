# Consolidated property JSON shape

`getOracleProperty` returns the **consolidated property JSON** stored on IPFS — one document per
property merging appraisal, permits, Sunbiz, and BBB enrichment. Exact nesting follows Elephant
lexicon / transform output; field names align with the normalized
[`elephant-query-db`](../../use-elephant-query-db/reference/schema-and-queries.md) schema where
loaded.

Always **inspect live JSON** when paths differ; treat this as a navigation guide.

## Top-level structure (typical)

```jsonc
{
  "appraisal": { /* parcel + property + valuations + structures … */ },
  "permits": [ /* property improvements / permit records */ ],
  // Enrichment blocks may appear as arrays or nested objects — common themes:
  "companies": [ /* Sunbiz-linked companies */ ],
  "businessRegistrations": [ /* Sunbiz registrations */ ],
  "businessReputationProfiles": [ /* BBB profiles */ ],
  "contractorQualityScores": [ /* derived contractor scores */ ]
}
```

Tests in elephant-mcp use minimal shapes such as `{ appraisal: { value: 123000 }, permits: [] }`.
Production documents are much larger.

## Appraisal / property (site address)

Maps to `parcels`, `properties`, `addresses`, `unnormalizedAddresses` in query-db.

| Concept | Typical paths / fields |
|---------|------------------------|
| Parcel ID | `appraisal.parcelIdentifier` or nested `parcels[].parcelIdentifier` |
| Property type / use | `propertyType`, `propertyUsageType`, `zoning`, `subdivision` |
| Site address (normalized) | `addresses` — `streetName`, `cityName`, `municipalityName`, `postalCode`, `stateCode` |
| Site address (raw) | `unnormalizedAddresses` — `fullAddress`, `latitude`, `longitude` |
| Address identity (`address:v1`) | Query table: `elephant_uuid`, `elephant_token`. Consolidated JSON: `address.elephantUuid`, `address.elephantToken`. SHA-256 token + UUIDv5 of country/state/ZIP5/street/unit. Not `normalizedAddressHash`. |
| Normalized key / hash | `addresses.normalizedAddressKey`, `addresses.normalizedAddressHash` |
| Owner | `ownerships`, `people`, `companies` under appraisal subtree |

## Permits

Maps to `property_improvements`, `permit_search_view`, `inspections`, etc.

| Concept | Typical paths / fields |
|---------|------------------------|
| Permit list | `permits[]` or nested under `propertyImprovements` |
| Permit address (raw) | `unnormalizedAddress` on permit / improvement records |
| Description / type | `description`, `permitType`, `status` fields on permit objects |
| Linked parcel | `parcelIdentifier` on permit records |

Use for address-mismatch checks against appraisal site address.

## BBB contractor reputation

Maps to `business_reputation_profiles`, `business_reputation_categories`,
`contractor_quality_scores`.

| Concept | Typical paths / fields |
|---------|------------------------|
| Business name | `name`, `legalName`, `normalizedName` |
| BBB rating | `bbbRating` (letter grades A+ … F, NR) |
| Numeric score | `ratingScore`, `reviewAverageRating` |
| Category | `businessReputationCategories[]` — `categoryName`, `categoryCode`, `isPrimary` |
| Complaints | `complaintCount`, `closedComplaintsPastThreeYears` |
| Contractor quality | `contractorQualityScores[]` — derived score fields when harvest ran |

**Electric contractor filter:** `categoryName` matching `/electric/i`.

**Sub-par filter:** `bbbRating` in `C`, `D`, `F`, `NR` or low `ratingScore` / contractor score.

## Sunbiz (companies / registrations)

Maps to `companies`, `business_registrations`, `business_registration_addresses`.

| Concept | Typical paths / fields |
|---------|------------------------|
| Legal name | `legalName`, `companyName` on `companies` |
| Document number | `documentNumber` on registrations |
| NAICS / activity | fields in `sourcePayload` or typed columns on registration |
| Registration address | `businessRegistrationAddresses` — compare to site address for mismatches |

**Nail salon filter:** legal name / description contains `nail`; NAICS `812113` when present.

## Geo (from geo tools, not consolidated JSON)

`findPropertiesInArea` and `sumPropertyValueInArea` read a **separate derived geo index** —
not geometry inside the consolidated file. Entries include parcel/property identifiers and
`current_avm_value` for summation.

## Schema discovery

When consolidated JSON uses unfamiliar keys, use lexicon tools:

1. `listClassesByDataGroup` with group `County` (or user-specified group)
2. `listPropertiesByClassName` for the relevant class
3. `getPropertySchema` for authoritative JSON Schema
