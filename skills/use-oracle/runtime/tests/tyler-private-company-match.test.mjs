import { describe, expect, it } from "vitest";

import { matchTylerPrivateCompanies } from "../src/permits/private-company-match.mjs";

function identityKey(sourceSystem, sourceRecordKey) {
  return `${sourceSystem}\u0000${sourceRecordKey}`;
}

function sampleBundle() {
  const definitions = [
    ["pembroke-pines", "RL23-04374", "514005211940"],
    ["pembroke-pines", "RL23-04447", "514005211940"],
    ["sunrise", "C-MECH-009303-2026", "494026050080"],
    ["sunrise", "C-STRU-008439-2026", "494026050080"],
    ["sunrise", "C-STRU-005996-2026", "494026050080"],
    ["sunrise", "C-STRU-005992-2026", "494026050080"],
  ];
  const permits = definitions.map(
    ([jurisdictionKey, permit_number, parcel_identifier], index) => ({
      countyKey: "broward",
      jurisdictionKey,
      source_system:
        jurisdictionKey === "sunrise"
          ? "broward_sunrise_tyler_permits"
          : "broward_pembroke_pines_tyler_permits",
      sourceRecordId: `permit-${index + 1}`,
      permit_number,
      parcel_identifier,
    }),
  );
  const names = [
    "Exact Roofing LLC",
    "Twin Roofing LLC",
    "No Match Contractor LLC",
    "Existing Company LLC",
    "No Match Second LLC",
    "Exact Roofing LLC",
    "No Match Third LLC",
  ];
  const parentIndexes = [0, 1, 2, 3, 3, 4, 5];
  const contacts = names.map((rawName, index) => {
    const parent = permits[parentIndexes[index]];
    return {
      parentSourceSystem: parent.source_system,
      parentSourceRecordKey: parent.sourceRecordId,
      sourceSystem: parent.source_system,
      sourceRecordKey: `contact-${index + 1}`,
      contactRole: "Contractor",
      companyId: null,
      rawName,
      qualifierName: null,
      phone: null,
      email: null,
      licenseNumber: null,
      sourcePayload: {},
    };
  });
  return {
    manifest: { countyKey: "broward" },
    permits,
    contacts,
  };
}

class MemoryCompanyStore {
  constructor({ corruptReadBack = false } = {}) {
    this.corruptReadBack = corruptReadBack;
    this.readCount = 0;
    this.commits = 0;
    this.rollbacks = 0;
    const bundle = sampleBundle();
    this.permits = new Map(
      bundle.permits.map((record, index) => [
        identityKey(record.source_system, record.sourceRecordId),
        {
          propertyImprovementId: `improvement-${index + 1}`,
          contractorCompanyId:
            index === 3 ? "company-existing" : null,
          permitNumber: record.permit_number,
          parcelIdentifier: record.parcel_identifier,
          sourceSystem: record.source_system,
          sourceRecordKey: record.sourceRecordId,
        },
      ]),
    );
    this.contacts = new Map(
      bundle.contacts.map((contact, index) => {
        const parent = this.permits.get(
          identityKey(
            contact.parentSourceSystem,
            contact.parentSourceRecordKey,
          ),
        );
        return [
          identityKey(contact.sourceSystem, contact.sourceRecordKey),
          {
            permitContactId: `permit-contact-${index + 1}`,
            propertyImprovementId: parent.propertyImprovementId,
            companyId:
              index === 3 ? "company-existing" : null,
            rawName: contact.rawName,
            phone: contact.phone,
            licenseNumber: contact.licenseNumber,
            sourceSystem: contact.sourceSystem,
            sourceRecordKey: contact.sourceRecordKey,
          },
        ];
      }),
    );
    this.candidates = [
      {
        companyId: "company-exact",
        name: "Exact Roofing Inc.",
        sourceSystems: ["sunbiz"],
      },
      {
        companyId: "company-twin-a",
        name: "Twin Roofing Inc.",
        sourceSystems: ["sunbiz"],
      },
      {
        companyId: "company-twin-b",
        name: "Twin Roofing Company",
        sourceSystems: ["bbb"],
      },
      {
        companyId: "company-existing",
        name: "Previously Matched Company",
        sourceSystems: ["sunbiz"],
      },
    ];
  }

  async begin() {
    this.snapshot = {
      permits: structuredClone([...this.permits]),
      contacts: structuredClone([...this.contacts]),
    };
  }

  async commit() {
    this.commits += 1;
    this.snapshot = null;
  }

  async rollback() {
    this.rollbacks += 1;
    this.permits = new Map(this.snapshot.permits);
    this.contacts = new Map(this.snapshot.contacts);
    this.snapshot = null;
  }

  async validateSchema() {}

  async acquireLock() {}

  async readScope() {
    this.readCount += 1;
    const contacts = structuredClone([...this.contacts.values()]);
    if (this.corruptReadBack && this.readCount > 1) {
      contacts[0].companyId = "wrong-company";
    }
    return {
      permits: structuredClone([...this.permits.values()]),
      contacts,
    };
  }

  async findCandidateCompanies() {
    return this.candidates;
  }

  async linkContact(permitContactId, companyId) {
    const contact = [...this.contacts.values()].find(
      (row) => row.permitContactId === permitContactId,
    );
    if (!contact || contact.companyId !== null) {
      throw new Error("invalid contact update");
    }
    contact.companyId = companyId;
  }

  async linkPermit(propertyImprovementId, companyId) {
    const permit = [...this.permits.values()].find(
      (row) => row.propertyImprovementId === propertyImprovementId,
    );
    if (!permit || permit.contractorCompanyId !== null) {
      throw new Error("invalid permit update");
    }
    permit.contractorCompanyId = companyId;
  }
}

describe("Tyler private contractor company matching", () => {
  it("links a unique exact normalized company", async () => {
    const result = await matchTylerPrivateCompanies({
      bundle: sampleBundle(),
      store: new MemoryCompanyStore(),
    });
    expect(result.results[0]).toMatchObject({
      status: "accepted",
      action: "linked",
      companyId: "company-exact",
      method: "unique_exact_normalized_business_name",
      confidence: 0.8,
      companyName: "Exact Roofing Inc.",
    });
    expect(result.candidateCompanyCount).toBe(4);
    expect(result.candidateSourceCounts).toEqual({
      bbb: 1,
      sunbiz: 3,
    });
    expect(result).toMatchObject({
      linkedContactCount: 2,
      preservedContactCount: 1,
      linkedPermitCount: 2,
      preservedPermitCount: 1,
    });
  });

  it("leaves ambiguous and unmatched identities null", async () => {
    const result = await matchTylerPrivateCompanies({
      bundle: sampleBundle(),
      store: new MemoryCompanyStore(),
    });
    expect(result.results[1]).toMatchObject({
      status: "ambiguous",
      action: "ambiguous",
      companyId: null,
    });
    expect(result.results[2]).toMatchObject({
      status: "unmatched",
      action: "unmatched",
      companyId: null,
    });
  });

  it("preserves existing contact and permit company links", async () => {
    const store = new MemoryCompanyStore();
    const result = await matchTylerPrivateCompanies({
      bundle: sampleBundle(),
      store,
    });
    expect(result.results[3]).toMatchObject({
      action: "preserved_existing",
      companyId: "company-existing",
      companyName: "Previously Matched Company",
    });
    expect(
      store.permits.get(
        identityKey(
          "broward_sunrise_tyler_permits",
          "permit-4",
        ),
      ).contractorCompanyId,
    ).toBe("company-existing");
  });

  it("rolls back when company-link read-back differs", async () => {
    const store = new MemoryCompanyStore({ corruptReadBack: true });
    await expect(
      matchTylerPrivateCompanies({
        bundle: sampleBundle(),
        store,
      }),
    ).rejects.toThrow(/read-back mismatch/);
    expect(store.commits).toBe(0);
    expect(store.rollbacks).toBe(1);
    expect(
      store.contacts.get(
        identityKey(
          "broward_pembroke_pines_tyler_permits",
          "contact-1",
        ),
      ).companyId,
    ).toBeNull();
  });
});
