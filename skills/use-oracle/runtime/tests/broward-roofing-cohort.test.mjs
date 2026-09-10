import { describe, expect, it } from "vitest";

import { permitRepairCandidateSchema } from "../src/permits/backfill-inputs.mjs";
import { cohortInputRecordSchema } from "../src/investigations/roofing-cohort-schema.mjs";
import {
  inspectContractorAssignmentPayload,
  normalizeExportBrowardParcelIdentifier,
} from "../bin/broward-roofing-readonly-export.mjs";
import {
  analyzeRoofingCohort,
  classifyRoofingPermit,
  chooseControls,
  chooseOpenLeads,
  clusterSupplementalPermits,
  deduplicateSourcePermits,
  evaluateContractorAssignment,
  evaluateOpenRoofingLead,
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
    contractorAssignmentEvidence: {
      detailCaptured: true,
      contactCollectionComplete: true,
      sourcePayloadChecked: true,
      sourceFieldsWithheld: false,
      sourceFieldsUnavailable: false,
      observedContractorFields: ["sourcePayload.contractors"],
      assignedContractorFields: [],
      ownerBuilderFields: [],
      directContractorCompanyIdPresent: false,
    },
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

function manifest(overrides = {}) {
  return {
    recordType: "manifest",
    schemaVersion: "elephant.roofing-cohort-input.v5",
    countyKey: "broward",
    generatedAt: "2026-09-10T12:00:00.000Z",
    asOfDate: "2026-09-10",
    seedFolios: ["514005211940"],
    expansionLicenseNumbers: ["CCC1333102"],
    expansionCompanyNames: ["Z Roofing & Waterproofing, Inc."],
    sourceCatalogSha256: SHA,
    sourceProfileSha256: SHA,
    repositoryCommit: "b".repeat(40),
    privacy: "private",
    ...overrides,
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
          permitType: "Building",
          workClass: null,
          scope: "Roof",
          trade: null,
        }),
      ).classification,
    ).toBe("needs_review");
    expect(
      classifyRoofingPermit(
        permit({
          permitType: "Residential New Roof - Legacy",
          workClass: "Residential New Roof - Legacy",
          scope: "New tile roof",
          trade: null,
        }),
      ).classification,
    ).toBe("confirmed_roofing");
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

  it("rejects conflicting current open and terminal statuses", () => {
    expect(
      evaluatePermitLifecycle(
        permit({ status: "Issued", sourceStatus: "Closed" }),
        "2026-09-10",
      ),
    ).toMatchObject({
      state: "needs_review",
      reasonCode: "conflicting_current_statuses",
    });
    expect(
      evaluatePermitLifecycle(
        permit({ status: "Issued", sourceStatus: "Mystery Status" }),
        "2026-09-10",
      ),
    ).toMatchObject({
      state: "needs_review",
      reasonCode: "open_status_conflicts_with_unmapped_status",
    });
  });

  it("excludes expired permits and open statuses with completion dates", () => {
    expect(
      evaluatePermitLifecycle(
        permit({
          dates: { ...permit().dates, expiration: "2026-08-01" },
        }),
        "2026-09-10",
      ),
    ).toMatchObject({
      state: "terminal",
      reasonCode: "expired_by_date",
    });
    expect(
      evaluatePermitLifecycle(
        permit({
          dates: { ...permit().dates, completion: "2026-08-01" },
        }),
        "2026-09-10",
      ),
    ).toMatchObject({
      state: "needs_review",
      reasonCode: "open_status_conflicts_with_terminal_date",
    });
  });
});

describe("prospective open-roofing lead qualification", () => {
  it("normalizes only lossless Broward parcel formatting", () => {
    expect(
      normalizeExportBrowardParcelIdentifier(" 5041-11-16-0200 "),
    ).toEqual({
      state: "losslessly_normalized",
      normalized: "504111160200",
      reasonCode: null,
    });
    expect(
      normalizeExportBrowardParcelIdentifier("504111160200.0"),
    ).toMatchObject({
      state: "quarantined",
      normalized: null,
      reasonCode: "unsupported_broward_parcel_format",
    });
    expect(
      normalizeExportBrowardParcelIdentifier(null),
    ).toMatchObject({
      state: "quarantined",
      normalized: null,
      reasonCode: "missing_broward_parcel_identifier",
    });
    expect(() =>
      cohortInputRecordSchema.parse({
        recordType: "export_gap",
        schemaVersion: "elephant.roofing-cohort-export-gap.v1",
        gapType: "parcel_identifier_quarantine",
        excludedPermitCount: 1,
        excludedPropertyCount: 1,
        excludedChildRecordCount: 2,
        losslesslyNormalizedPermitCount: 3,
        losslesslyNormalizedPropertyCount: 3,
        verifiedSeedFolios: ["514005211940"],
        evidence: [
          {
            entityType: "property",
            sourceSystem: "broward_appraiser",
            sourceRecordKeySha256: SHA,
            rawParcelSha256: SHA,
            reasonCode: "unsupported_broward_parcel_format",
          },
        ],
      }),
    ).not.toThrow();
  });

  it("handles null contractor result arrays and fails closed", () => {
    const evidence = inspectContractorAssignmentPayload({
      source_payload: {
        permitDetail: {
          contacts: [],
          contractors: null,
          licensedProfessionals: null,
        },
      },
      more_details: null,
      source_artifact_uri: "private://realistic-db-row",
      contractor_company_id: null,
    });
    expect(evidence).toMatchObject({
      detailCaptured: true,
      contactCollectionComplete: true,
      sourcePayloadChecked: true,
      sourceFieldsUnavailable: true,
      assignedContractorFields: [],
      directContractorCompanyIdPresent: false,
    });
    expect(
      evaluateContractorAssignment(
        permit({
          detailComplete: true,
          contractorAssignmentEvidence: evidence,
        }),
      ),
    ).toMatchObject({
      classification: "contractor_unknown",
    });
  });

  it("confirms unassigned only from complete empty contractor evidence", () => {
    const result = evaluateContractorAssignment(permit());
    expect(result).toMatchObject({
      classification: "unassigned_confirmed",
      reasonCode: "complete_contractor_fields_present_and_empty",
      evidence: {
        contactRecordCount: 0,
        contractorRoleContactCount: 0,
        contractorCompanyContactCount: 0,
        roofingLicenseContactCount: 0,
        sourcePayloadChecked: true,
        contactCollectionComplete: true,
        assignedContractorFields: [],
      },
    });
  });

  it("classifies any contractor-role or license contact as assigned", () => {
    expect(
      evaluateContractorAssignment(
        permit({ contacts: [contact("permit-1")] }),
      ),
    ).toMatchObject({
      classification: "assigned",
      evidence: {
        contractorRoleContactCount: 1,
        roofingLicenseContactCount: 1,
      },
    });
  });

  it("classifies owner-builder evidence separately and excludes it", () => {
    expect(
      evaluateContractorAssignment(
        permit({
          contacts: [
            contact("permit-1", {
              role: "Owner-Builder",
              name: "Owner Builder",
              companyId: null,
              companyName: null,
              licenseNumber: null,
              licenseType: null,
              qualifierName: null,
            }),
          ],
        }),
      ),
    ).toMatchObject({
      classification: "owner_builder",
      reasonCode: "owner_builder_evidence_present",
    });
  });

  it("keeps missing detail as contractor_unknown", () => {
    expect(
      evaluateContractorAssignment(
        permit({
          detailComplete: false,
          contractorAssignmentEvidence: {
            ...permit().contractorAssignmentEvidence,
            detailCaptured: false,
            contactCollectionComplete: false,
            sourcePayloadChecked: false,
            observedContractorFields: [],
          },
        }),
      ),
    ).toMatchObject({
      classification: "contractor_unknown",
    });
  });

  it("keeps source-withheld contractor fields as contractor_unknown", () => {
    const result = evaluateContractorAssignment(
      permit({
        detailComplete: false,
        contractorAssignmentEvidence: {
          ...permit().contractorAssignmentEvidence,
          sourceFieldsWithheld: true,
        },
      }),
    );
    expect(result).toMatchObject({
      classification: "contractor_unknown",
    });
    expect(result.reasonCode).toMatch(/contractor_fields_withheld/);
  });

  it("emits a privacy-safe lead with no Z Roofing association", () => {
    const result = evaluateOpenRoofingLead(permit(), property());
    expect(result).toMatchObject({
      eligible: true,
      label: "recommended-unassigned-open-roofing-lead",
      assignedToZRoofing: false,
      recommendedForHandoff: true,
      contractorAssignment: {
        classification: "unassigned_confirmed",
        evidence: {
          contactRecordCount: 0,
          assignedContractorFields: [],
        },
      },
      sourceIdentityEvidence: { stable: true },
      propertyLinkEvidence: { linked: true },
    });
    expect(result).not.toHaveProperty("licenses");
    expect(result).not.toHaveProperty("licenseNumber");
  });

  it("selects unassigned leads independently of Z Roofing identities", () => {
    const unassigned = analyzeRoofingCohort({
      manifest: manifest(),
      records: [permit(), property(), identity(), source()],
    });
    expect(unassigned.trailingProjects).toHaveLength(0);
    expect(unassigned.openCohort).toHaveLength(1);
    expect(unassigned.openCohort[0]).toMatchObject({
      recommendedForHandoff: true,
      assignedToZRoofing: false,
    });

    const assigned = analyzeRoofingCohort({
      manifest: manifest(),
      records: [
        permit(),
        contact("permit-1"),
        property(),
        identity(),
        source(),
      ],
    });
    expect(assigned.openCohort).toHaveLength(0);
    expect(assigned.currentOpenPermits[0].contractorAssignment).toMatchObject({
      classification: "assigned",
    });
  });

  it("ranks residential relevant-jurisdiction leads before recency ties", () => {
    const residential = evaluateOpenRoofingLead(permit(), property());
    const commercial = {
      ...residential,
      sourceRecordKey: "commercial",
      authority: "sunrise",
      usageType: "Commercial",
      filingEvidence: {
        ...residential.filingEvidence,
        date: "2026-09-10",
      },
    };
    const relevantResidential = {
      ...residential,
      sourceRecordKey: "relevant-residential",
      authority: "hollywood",
    };
    expect(
      chooseOpenLeads(
        [commercial, relevantResidential],
        [{ authority: "hollywood" }],
        1,
      )[0].sourceRecordKey,
    ).toBe("relevant-residential");
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
    const projectPermit = permit({
      status: "Complete",
      dates: {
        ...permit().dates,
        completion: "2025-10-01",
        closed: "2025-10-01",
      },
    });
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
  it("prefers completion, final, and close dates over issue date", () => {
    const result = inferOldRoofControl(property(), [
      permit({
        status: "Complete",
        dates: {
          ...permit().dates,
          issued: "2015-12-01",
          completion: "2016-01-01",
          finalInspection: "2016-01-02",
          closed: "2016-01-03",
        },
      }),
    ]);
    expect(result).toMatchObject({
      eligible: true,
      label: "estimated",
      confidence: "high",
      estimatedInstallationAnchor: "2016-01-03",
      basis: {
        kind: "closed_replacement",
        dateKind: "close",
        issueDateFallback: false,
      },
    });
  });

  it("uses issue date only as a lower-confidence terminal fallback", () => {
    expect(
      inferOldRoofControl(property(), [
        permit({
          status: "Complete",
          dates: {
            ...permit().dates,
            issued: "2015-12-01",
            completion: null,
            finalInspection: null,
            closed: null,
          },
        }),
      ]),
    ).toMatchObject({
      eligible: true,
      confidence: "medium",
      estimatedInstallationAnchor: "2015-12-01",
      basis: { issueDateFallback: true },
    });
  });

  it("flags open replacement work without resetting estimated age", () => {
    expect(inferOldRoofControl(property(), [permit()])).toMatchObject({
      eligible: false,
      reasonCode: "active_replacement_pending_or_in_progress",
      activeReplacementPermits: [{ permitNumber: "BLD-1" }],
    });
  });

  it("does not reset estimated age for repair permits", () => {
    expect(
      inferOldRoofControl(property(), [
        permit({
          status: "Complete",
          workClass: "Roof repair",
          scope: "Repair roof flashing",
          dates: {
            ...permit().dates,
            issued: "2025-09-10",
            completion: "2025-09-11",
            closed: "2025-09-11",
          },
        }),
      ]),
    ).toMatchObject({
      eligible: true,
      confidence: "low",
      basis: { kind: "property_built_year", builtYear: 1990 },
    });
  });

  it("labels built-year inference as a low-confidence max-age estimate", () => {
    expect(inferOldRoofControl(property(), [])).toMatchObject({
      eligible: true,
      label: "estimated",
      confidence: "low",
      estimatedInstallationRange: {
        fromDate: "1990-01-01",
        throughDate: "1990-12-31",
      },
      basis: { kind: "property_built_year", builtYear: 1990 },
    });
  });

  it("lets the latest closed replacement supersede older anchors", () => {
    const oldReplacement = permit({
      sourceRecordKey: "old",
      permitNumber: "OLD-1",
      status: "Complete",
      dates: {
        ...permit().dates,
        issued: "2010-01-01",
        completion: "2010-02-01",
        closed: "2010-02-01",
      },
    });
    const laterReplacement = permit({
      sourceRecordKey: "later",
      permitNumber: "LATER-1",
      status: "Complete",
      dates: {
        ...permit().dates,
        issued: "2018-01-01",
        completion: "2018-02-01",
        closed: "2018-02-01",
      },
    });
    expect(
      inferOldRoofControl(property(), [
        oldReplacement,
        laterReplacement,
      ]),
    ).toMatchObject({
      eligible: false,
      reasonCode: "estimated_anchor_after_threshold",
      estimatedInstallationRange: { throughDate: "2018-02-01" },
    });
  });

  it("keeps incomplete source history eligible only as a caveated low estimate", () => {
    const result = inferOldRoofControl(
      property({
        coverage: {
          fromDate: null,
          throughDate: null,
          authorityComplete: false,
          predecessorComplete: false,
          sourceSystems: [],
        },
      }),
      [],
    );
    expect(result).toMatchObject({
      eligible: true,
      confidence: "low",
      availableHistoryWindow: {
        completeForThreshold: false,
      },
    });
    expect(result.caveat).toMatch(/not a verified roof age/i);
    expect(result.caveat).toMatch(/predecessor_history_incomplete/);
  });

  it("includes an authoritative anchor exactly on the threshold boundary", () => {
    expect(
      inferOldRoofControl(property(), [
        permit({
          status: "Complete",
          dates: {
            ...permit().dates,
            issued: "2016-09-01",
            completion: "2016-09-10",
            closed: "2016-09-10",
          },
        }),
      ]),
    ).toMatchObject({
      eligible: true,
      confidence: "high",
      estimatedInstallationAnchor: "2016-09-10",
    });
  });

  it("uses completed new construction as a medium original-roof anchor", () => {
    expect(
      inferOldRoofControl(property(), [
        permit({
          status: "Complete",
          permitType: "Building",
          workClass: "New SFR",
          scope: "New single-family residence",
          trade: "Building",
          dates: {
            ...permit().dates,
            issued: "2009-12-01",
            completion: "2010-06-01",
            closed: "2010-06-01",
          },
        }),
      ]),
    ).toMatchObject({
      eligible: true,
      confidence: "medium",
      basis: { kind: "new_construction" },
      estimatedInstallationAnchor: "2010-06-01",
    });
  });

  it("downgrades a future completion date to issue-date fallback", () => {
    const result = inferOldRoofControl(property(), [
      permit({
        status: "Complete",
        dates: {
          ...permit().dates,
          issued: "2015-12-01",
          completion: "2026-09-11",
          closed: null,
        },
      }),
    ]);
    expect(result).toMatchObject({
      eligible: true,
      confidence: "medium",
      basis: { issueDateFallback: true },
    });
    expect(result.caveat).toMatch(/completion_future/);
  });

  it("prefers high and medium controls before low estimates", () => {
    const candidates = [
      {
        parcelIdentifier: "514111160003",
        authority: "hollywood",
        usageType: "Residential",
        confidence: "low",
      },
      {
        parcelIdentifier: "514111160001",
        authority: "hollywood",
        usageType: "Residential",
        confidence: "high",
      },
      {
        parcelIdentifier: "514111160002",
        authority: "hollywood",
        usageType: "Residential",
        confidence: "medium",
      },
    ];
    expect(
      chooseControls(candidates, [], 2).map(
        (candidate) => candidate.confidence,
      ),
    ).toEqual(["high", "medium"]);
  });

  it("fills remaining ten-lead slots with qualified old-roof estimates", () => {
    const leadProperties = Array.from({ length: 3 }, (_, index) => {
      const suffix = String(index + 1).padStart(4, "0");
      return property({
        propertyId: `00000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`,
        parcelIdentifier: `51411116${suffix}`,
        sourceRecordKey: `lead-property-${index + 1}`,
      });
    });
    const leadPermits = leadProperties.map((leadProperty, index) =>
      permit({
        propertyImprovementId: `lead-permit-${index + 1}`,
        propertyId: leadProperty.propertyId,
        parcelIdentifier: leadProperty.parcelIdentifier,
        sourceRecordKey: `lead-source-${index + 1}`,
        permitNumber: `LEAD-${index + 1}`,
      }),
    );
    const oldProperties = Array.from({ length: 8 }, (_, index) => {
      const ordinal = index + 101;
      return property({
        propertyId: `00000000-0000-0000-0000-${String(ordinal).padStart(12, "0")}`,
        parcelIdentifier: `51411117${String(index + 1).padStart(4, "0")}`,
        sourceRecordKey: `old-property-${ordinal}`,
      });
    });
    const result = analyzeRoofingCohort({
      manifest: manifest(),
      records: [
        ...leadPermits,
        ...leadProperties,
        ...oldProperties,
        source(),
      ],
    });
    expect(result.openCohort).toHaveLength(3);
    expect(result.oldRoofControls).toHaveLength(7);
    expect(result.summary).toMatchObject({
      selectedLeadCount: 10,
      leadSampleTarget: 10,
      leadSampleShortfall: 0,
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
      manifest: manifest({
        seedFolios: [southwestPermit.parcelIdentifier],
      }),
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
      confirmed_roofing: 0,
      roofing_nonreplacement: 0,
      not_roofing: 0,
      needs_review: 0,
    });
  });
});
