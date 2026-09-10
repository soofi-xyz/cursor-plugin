import { describe, expect, it } from "vitest";

import { permitRepairCandidateSchema } from "../src/permits/backfill-inputs.mjs";
import {
  analyzeRoofingCohort,
  classifyRoofingPermit,
  clusterSupplementalPermits,
  deduplicateSourcePermits,
  evaluatePermitLifecycle,
  evaluateWorkEvidence,
  inferOldRoofControl,
} from "../src/investigations/roofing-cohort.mjs";

const SHA = "a".repeat(64);

function permit(overrides = {}) {
  return {
    recordType: "permit",
    propertyImprovementId: "permit-1",
    propertyId: "11111111-1111-1111-1111-111111111111",
    parcelIdentifier: "514111160001",
    countyKey: "broward",
    authority: "hollywood",
    jurisdictionKey: "hollywood",
    sourceKey: "accela-current",
    sourceSystem: "broward_hollywood_accela_permits",
    sourceRecordKey: "source-1",
    permitNumber: "BLD-1",
    status: "Issued",
    sourceStatus: null,
    recordStatus: null,
    permitType: "Roofing",
    workClass: "Re-roof",
    scope: "Remove and replace roof system",
    description: null,
    trade: "Roofing",
    action: null,
    workAddress: "1 Test Street",
    city: "Hollywood",
    masterPermitNumber: null,
    parentPermitNumber: null,
    dates: {
      application: "2025-09-01",
      opened: "2025-09-01",
      issued: "2025-09-10",
      finalInspection: null,
      completion: null,
      closed: null,
      expiration: null,
    },
    detailComplete: true,
    sourceArtifactUri: "private://permit-1",
    evidenceSha256: SHA,
    contacts: [],
    events: [],
    inspections: [],
    sourceProvenance: [],
    ...overrides,
  };
}

function identity(overrides = {}) {
  return {
    recordType: "license_identity",
    identityId: "dbpr-ccc1333102-active",
    licenseNumber: "CCC1333102",
    licenseClass: "CCC",
    holderName: "Zachary Exposito",
    qualifyingBusinessName: "Z Roofing & Waterproofing, Inc.",
    permitContactName: null,
    companyId: null,
    sunbizDocumentNumber: "P10000010379",
    relationshipType: "primary-qualifying-agent",
    effectiveFrom: "2021-04-16",
    effectiveThrough: null,
    primaryStatus: "Current",
    secondaryStatus: "Active",
    current: true,
    verified: true,
    evidence: [{ uri: "private://dbpr", sha256: SHA }],
    ...overrides,
  };
}

function contact(propertyImprovementId, overrides = {}) {
  return {
    recordType: "permit_contact",
    propertyImprovementId,
    sourceSystem: "broward_hollywood_accela_permits",
    sourceRecordKey: `contact-${propertyImprovementId}`,
    role: "Contractor",
    name: "Z Roofing & Waterproofing, Inc.",
    companyId: "22222222-2222-2222-2222-222222222222",
    companyName: "Z Roofing & Waterproofing, Inc.",
    licenseNumber: "CCC1333102",
    licenseType: "Certified Roofing Contractor",
    qualifierName: "Zachary Exposito",
    evidenceSha256: SHA,
    ...overrides,
  };
}

function property(overrides = {}) {
  return {
    recordType: "property",
    propertyId: "11111111-1111-1111-1111-111111111111",
    parcelIdentifier: "514111160001",
    authority: "hollywood",
    address: "1 Test Street",
    city: "Hollywood",
    usageType: "Residential",
    builtYear: 1990,
    sourceSystem: "broward_appraiser",
    sourceRecordKey: "property-1",
    coverage: {
      fromDate: "1988-01-01",
      throughDate: "2026-09-10",
      authorityComplete: true,
      predecessorComplete: true,
      sourceSystems: ["broward_hollywood_accela_permits"],
    },
    ...overrides,
  };
}

function manifest() {
  return {
    recordType: "manifest",
    schemaVersion: "elephant.roofing-cohort-input.v1",
    countyKey: "broward",
    generatedAt: "2026-09-10T12:00:00.000Z",
    asOfDate: "2026-09-10",
    sourceCatalogSha256: SHA,
    sourceProfileSha256: SHA,
    repositoryCommit: "b".repeat(40),
    privacy: "private",
  };
}

function source(overrides = {}) {
  return {
    recordType: "source_reconciliation",
    authority: "hollywood",
    sourceKey: "accela-current",
    sourceSystem: "broward_hollywood_accela_permits",
    access: "supported",
    predecessorComplete: true,
    reported: 1,
    received: 1,
    missing: 0,
    evidence: [],
    blockerCategory: null,
    blockerOwner: null,
    blockerFix: null,
    ...overrides,
  };
}

describe("deterministic roofing classification", () => {
  it("classifies replacement, nonreplacement, nonroof, and review scopes", () => {
    expect(classifyRoofingPermit(permit()).classification).toBe(
      "confirmed_replacement",
    );
    expect(
      classifyRoofingPermit(
        permit({
          workClass: "Roof repair",
          scope: "Repair roof flashing",
        }),
      ).classification,
    ).toBe("roofing_nonreplacement");
    expect(
      classifyRoofingPermit(
        permit({
          permitType: "Electrical",
          workClass: "Service",
          scope: "Replace panel",
          trade: "Electrical",
        }),
      ).classification,
    ).toBe("not_roofing");
    expect(
      classifyRoofingPermit(
        permit({
          permitType: "Roofing",
          workClass: null,
          scope: "Roof",
        }),
      ).classification,
    ).toBe("needs_review");
  });

  it("hard-excludes the Sunrise condensate-lines false positive", () => {
    const result = classifyRoofingPermit(
      permit({
        authority: "sunrise",
        permitNumber: "C-MECH-009303-2026",
        permitType: "Mechanical",
        workClass: "HVAC",
        scope: "Condensate lines in reroofing project context",
        trade: "Mechanical",
      }),
    );
    expect(result).toEqual({
      classification: "not_roofing",
      reasonCode: "sunrise_mechanical_condensate_lines",
      sourceField: "permit_number",
    });
  });

  it("does not infer roofing from new SFR or ancillary scope", () => {
    expect(
      classifyRoofingPermit(
        permit({
          permitType: "Building",
          workClass: "New SFR",
          scope: "New single-family residence with roof trusses",
          trade: "Building",
        }),
      ).classification,
    ).toBe("not_roofing");
  });
});

describe("work dates and source lifecycles", () => {
  it("includes both exact trailing-year boundaries", () => {
    const window = {
      fromDate: "2025-09-10",
      throughDate: "2026-09-10",
    };
    expect(
      evaluateWorkEvidence(
        permit({ dates: { ...permit().dates, issued: "2025-09-10" } }),
        window,
        "2026-09-10",
      ).state,
    ).toBe("confirmed");
    expect(
      evaluateWorkEvidence(
        permit({ dates: { ...permit().dates, issued: "2026-09-10" } }),
        window,
        "2026-09-10",
      ).state,
    ).toBe("confirmed");
  });

  it("rejects application-only, invalid, and future work dates", () => {
    const window = {
      fromDate: "2025-09-10",
      throughDate: "2026-09-10",
    };
    expect(
      evaluateWorkEvidence(
        permit({
          dates: {
            ...permit().dates,
            application: "2026-01-01",
            issued: null,
          },
        }),
        window,
        "2026-09-10",
      ).reasonCode,
    ).toBe("application_or_open_date_only");
    expect(
      evaluateWorkEvidence(
        permit({ dates: { ...permit().dates, issued: "not-a-date" } }),
        window,
        "2026-09-10",
      ).state,
    ).toBe("needs_review");
    expect(
      evaluateWorkEvidence(
        permit({ dates: { ...permit().dates, issued: "2026-09-11" } }),
        window,
        "2026-09-10",
      ).state,
    ).toBe("needs_review");
  });

  it.each([
    ["broward_sunrise_tyler_permits", "Issued"],
    ["broward_hollywood_accela_permits", "Open"],
    ["broward_fort_lauderdale_arcgis_permits", "Active"],
    ["broward_southwest_ranches_citizenserve_permits", "Pending"],
    [
      "broward_southwest_ranches_citizenserve_permits",
      "On hold due to missing paperwork",
    ],
    [
      "broward_southwest_ranches_citizenserve_permits",
      "Pending Zoning/Engineering Final",
    ],
  ])("maps %s status %s as open", (sourceSystem, status) => {
    expect(
      evaluatePermitLifecycle(
        permit({ sourceSystem, status }),
        "2026-09-10",
      ).state,
    ).toBe("open");
  });

  it("lets a terminal event supersede an open current status", () => {
    expect(
      evaluatePermitLifecycle(
        permit({
          events: [
            {
              eventType: "Finaled",
              eventStatus: "Completed",
              eventDate: "2026-01-02",
            },
          ],
        }),
        "2026-09-10",
      ),
    ).toMatchObject({
      state: "terminal",
      reasonCode: "superseding_terminal_event",
    });
  });
});

describe("source identity and project clustering", () => {
  it("deduplicates by source identity and reports conflicting duplicates", () => {
    const rows = deduplicateSourcePermits([
      permit(),
      permit(),
      permit({ permitNumber: "BLD-2" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      duplicateCount: 2,
      duplicateConflict: true,
    });
  });

  it("clusters supplemental rows and master/sub-permits", () => {
    const rows = [
      permit({ sourceRecordKey: "one", masterPermitNumber: "MASTER-1" }),
      permit({
        propertyImprovementId: "permit-2",
        sourceSystem: "broward_fort_lauderdale_arcgis_permits",
        sourceRecordKey: "two",
        permitNumber: "SUB-1",
        parentPermitNumber: "MASTER-1",
      }),
    ].map((row) => ({
      ...row,
      duplicateCount: 0,
      duplicateConflict: false,
      sourceProvenance: [],
    }));
    const projects = clusterSupplementalPermits(rows);
    expect(projects).toHaveLength(1);
    expect(projects[0].permitNumbers).toEqual(["BLD-1", "SUB-1"]);
  });

  it("preserves license time slices and refuses inactive expansion", () => {
    const projectPermit = permit();
    const records = [
      projectPermit,
      contact(projectPermit.propertyImprovementId),
      property(),
      identity({
        identityId: "dbpr-ccc1333102-inactive",
        effectiveFrom: "2024-12-31",
        secondaryStatus: "Inactive",
        current: true,
      }),
      source(),
    ];
    const result = analyzeRoofingCohort({
      manifest: manifest(),
      records,
    });
    expect(result.trailingProjects).toHaveLength(0);

    records[3] = identity({
      identityId: "dbpr-ccc1333102-active",
      effectiveFrom: "2021-04-16",
      effectiveThrough: "2026-09-10",
      current: true,
    });
    expect(
      analyzeRoofingCohort({ manifest: manifest(), records })
        .trailingProjects,
    ).toHaveLength(1);
  });

  it("reconciles distinct source surfaces sharing one source system", () => {
    const projectPermit = permit();
    const result = analyzeRoofingCohort({
      manifest: manifest(),
      records: [
        projectPermit,
        property(),
        source(),
        source({
          sourceKey: "legacy-source",
          access: "unavailable",
          reported: null,
          received: null,
          missing: null,
        }),
      ],
    });
    expect(result.reconciliation).toHaveLength(2);
    expect(
      result.reconciliation.find(
        (row) => row.sourceKey === "legacy-source",
      ),
    ).toMatchObject({
      access: "unavailable",
      received: null,
      normalized: null,
    });
  });
});

describe("old-roof inference and cohort output", () => {
  it("requires complete ten-year authority and predecessor coverage", () => {
    expect(
      inferOldRoofControl(
        property({
          coverage: {
            ...property().coverage,
            predecessorComplete: false,
          },
        }),
        [],
      ),
    ).toMatchObject({
      eligible: false,
      reasonCode: "incomplete_authority_or_predecessor_coverage",
    });
  });

  it("returns the required proven-window wording and authoritative age", () => {
    expect(inferOldRoofControl(property(), [])).toMatchObject({
      eligible: true,
      reasonCode:
        "no_open_or_closed_roofing_permit_found_in_proven_window",
      statement:
        "No open or closed roofing permit found in the proven window 2016-09-10 through 2026-09-10.",
      caveat:
        "This is a permit-history finding, not proof that the roof is definitely old.",
      ageBasis: {
        kind: "structure_built_year",
        year: 1990,
        minimumWholeYearsAsOfDate: 35,
      },
    });
  });

  it("excludes every roofing status and new construction in the window", () => {
    expect(inferOldRoofControl(property(), [permit()]).eligible).toBe(
      false,
    );
    expect(
      inferOldRoofControl(property(), [
        permit({
          status: "Complete",
          workClass: "Roof coating",
          scope: "Apply elastomeric roof coating",
          dates: {
            ...permit().dates,
            issued: "2020-01-02",
            completion: "2020-01-10",
          },
        }),
      ]).reasonCode,
    ).toBe("open_or_closed_roofing_permit_found_in_window");
    expect(
      inferOldRoofControl(property(), [
        permit({
          permitType: "Building",
          workClass: "New SFR",
          scope: "New single-family residence",
        }),
      ]).reasonCode,
    ).toBe("new_construction_in_window");
  });

  it("uses the newer effective year and requires it before 2016", () => {
    expect(
      inferOldRoofControl(
        property({ builtYear: 1950, effectiveYear: 2018 }),
        [],
      ),
    ).toMatchObject({
      eligible: false,
      reasonCode: "built_or_effective_year_not_older_than_ten_years",
    });
    expect(
      inferOldRoofControl(
        property({ builtYear: 1950, effectiveYear: 2002 }),
        [],
      ),
    ).toMatchObject({
      eligible: true,
      ageBasis: {
        kind: "structure_effective_year",
        year: 2002,
        minimumWholeYearsAsOfDate: 23,
      },
    });
  });

  it("fails closed on an undated roofing or construction permit", () => {
    expect(
      inferOldRoofControl(property(), [
        permit({
          status: "Complete",
          dates: {
            application: null,
            opened: null,
            issued: null,
            finalInspection: null,
            completion: null,
            closed: null,
            expiration: null,
          },
        }),
      ]),
    ).toMatchObject({
      eligible: false,
      reasonCode: "undated_roofing_or_construction_permit",
    });
  });

  it("emits strict repair candidates for supported missing detail only", () => {
    const missingDetail = permit({
      detailComplete: false,
      contacts: [],
    });
    const result = analyzeRoofingCohort({
      manifest: manifest(),
      records: [
        missingDetail,
        permit({
          propertyImprovementId: "permit-2",
          sourceRecordKey: "source-2",
          permitNumber: "BLD-2",
          detailComplete: false,
          contacts: [],
        }),
        property(),
        identity(),
        source({ reported: 2, received: 2 }),
      ],
    });
    expect(result.repairCandidates).toHaveLength(1);
    expect(() =>
      permitRepairCandidateSchema.parse(result.repairCandidates[0]),
    ).not.toThrow();

    const blocked = analyzeRoofingCohort({
      manifest: manifest(),
      records: [
        missingDetail,
        property(),
        identity(),
        source({ access: "blocked", received: null }),
      ],
    });
    expect(blocked.repairCandidates).toHaveLength(0);
    expect(blocked.reconciliation[0].received).toBeNull();
    expect(blocked.availability).toBe("supported_partial");
  });

  it("reports only seed folios present in a focused input", () => {
    const southwestPermit = permit({
      propertyId: "fe026ab5-6927-4dbb-b27a-c5f219ffa3c6",
      parcelIdentifier: "504032160260",
      authority: "southwest-ranches",
      jurisdictionKey: "southwest-ranches",
      sourceKey: "citizenserve-www2",
      sourceSystem: "broward_southwest_ranches_citizenserve_permits",
    });
    const result = analyzeRoofingCohort({
      manifest: manifest(),
      records: [
        southwestPermit,
        property({
          propertyId: southwestPermit.propertyId,
          parcelIdentifier: southwestPermit.parcelIdentifier,
          authority: southwestPermit.authority,
        }),
        source({
          authority: southwestPermit.authority,
          sourceKey: southwestPermit.sourceKey,
          sourceSystem: southwestPermit.sourceSystem,
        }),
      ],
    });
    expect(result.seedEvidence.map((seed) => seed.parcelIdentifier)).toEqual([
      "504032160260",
    ]);
    expect(result.seedEvidence[0].permits[0]).toMatchObject({
      status: "Issued",
      workClass: "Re-roof",
      scope: "Remove and replace roof system",
      dates: southwestPermit.dates,
    });
    expect(result.summary.seedClassificationCounts).toEqual({
      confirmed_replacement: 1,
      roofing_nonreplacement: 0,
      not_roofing: 0,
      needs_review: 0,
    });
  });
});
