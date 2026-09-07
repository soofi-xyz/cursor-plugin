import { describe, expect, it } from "vitest";

import {
  createPermitProfileRegistry,
  permitProfileDigest,
  validatePermitProfile,
} from "../src/counties/permit-profile.mjs";
import { duvalPermitProfile } from "../src/counties/duval/permit-profile.mjs";
import { requirePermitProfile } from "../src/counties/permit-profiles.mjs";
import {
  PERMIT_RECORD_SCHEMA_VERSION,
  createStablePermitId,
  normalizedPermitRecordSchema,
  permitTableSchemaFields,
  toPermitTableRow,
} from "../src/permits/contracts.mjs";

describe("permit profiles", () => {
  it("registers Duval separately from the enrichment profile", () => {
    const profile = requirePermitProfile("duval");
    expect(profile).toStrictEqual(duvalPermitProfile);
    expect(profile.jurisdictions).toHaveLength(5);
    expect(profile.jurisdictions.filter((item) => item.status === "supported"))
      .toHaveLength(1);
    expect(
      profile.jurisdictions
        .filter((item) => item.status === "supported")
        .map((item) => item.key),
    ).toEqual(["jacksonville"]);
    expect(
      profile.jurisdictions
        .filter((item) => item.status === "blocked")
        .map((item) => item.key),
    ).toEqual(["jacksonville-beach"]);
    expect(
      profile.jurisdictions
        .filter((item) => item.status === "manual-only")
        .map((item) => item.key),
    ).toEqual(["atlantic-beach"]);
    expect(
      profile.jurisdictions.find((item) => item.key === "atlantic-beach"),
    ).toMatchObject({
      adapterKey: null,
      adapterConfig: null,
      recordsRequest: { route: "records-first" },
    });
    expect(
      profile.jurisdictions
        .filter((item) => item.status === "unavailable")
        .map((item) => item.key),
    ).toEqual(["neptune-beach", "baldwin"]);
    expect(profile.publication.permitTableIpnsLabel).toBe(
      "oracle-permit-table-duval",
    );
    expect(permitProfileDigest(profile)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a supported jurisdiction without a public history adapter", () => {
    const invalid = structuredClone(duvalPermitProfile);
    invalid.jurisdictions[0].status = "supported";
    invalid.jurisdictions[0].sources[0].access = "public";
    invalid.jurisdictions[0].adapterKey = null;
    invalid.jurisdictions[0].adapterConfig = null;
    expect(() => validatePermitProfile(invalid)).toThrow(
      /Supported permit jurisdictions require an adapter/,
    );
  });

  it("rejects duplicate county registrations", () => {
    expect(() =>
      createPermitProfileRegistry([duvalPermitProfile, duvalPermitProfile]),
    ).toThrow(/Duplicate permit profile/);
  });
});

describe("normalized permit contracts", () => {
  const propertyId = "f".repeat(32);
  const sourceRecordId = "JAX-2026-00001";
  const improvementId = createStablePermitId({
    countyKey: "duval",
    jurisdictionKey: "jacksonville",
    sourceRecordId,
  });
  const record = {
    schemaVersion: PERMIT_RECORD_SCHEMA_VERSION,
    property_improvement_id: improvementId,
    property_id: propertyId,
    parcel_identifier: "096925-0000",
    permit_number: sourceRecordId,
    improvement_type: "ROOF",
    improvement_status: "ISSUED",
    improvement_action: "REPLACE",
    permit_issue_date: "2026-01-02",
    application_received_date: "2025-12-20",
    final_inspection_date: null,
    permit_close_date: null,
    completion_date: null,
    expiration_date: null,
    opened_date: "2025-12-20",
    source_system: "duval_jaxepics",
    county_name: "Duval",
    project_description: "Residential re-roof",
    description: "Replace shingle roof",
    estimated_job_value: 12500,
    fee: 250,
    countyKey: "duval",
    jurisdictionKey: "jacksonville",
    sourceRecordId,
    sourceUrl: "https://jaxepics.coj.net/Permit/JAX-2026-00001",
    requestedParcelIdentifier: "096925-0000",
    requestedPropertyId: propertyId,
    workAddress: "100 Main St",
    isRoofPermit: true,
    contractors: [
      {
        businessName: "Example Roofing LLC",
        licenseNumber: "CCC000000",
        qualifierName: null,
        phone: null,
        email: null,
      },
    ],
    inspections: [],
    relatedRecords: [],
    sourcePayload: { sourceStatus: "Issued" },
  };

  it("uses the canonical 20-column public permit schema", () => {
    expect(Object.keys(permitTableSchemaFields)).toHaveLength(20);
    expect(Object.keys(toPermitTableRow(record))).toEqual(
      Object.keys(permitTableSchemaFields),
    );
  });

  it("binds linkage to the requested parcel and property", () => {
    expect(normalizedPermitRecordSchema.parse(record).property_id).toBe(
      propertyId,
    );
    expect(() =>
      normalizedPermitRecordSchema.parse({
        ...record,
        parcel_identifier: "000000-0000",
      }),
    ).toThrow(/explicitly requested parcel/);
  });

  it("creates deterministic stable permit identifiers", () => {
    expect(improvementId).toMatch(/^[a-f0-9]{32}$/);
    expect(
      createStablePermitId({
        countyKey: "duval",
        jurisdictionKey: "jacksonville",
        sourceRecordId,
      }),
    ).toBe(improvementId);
  });
});
