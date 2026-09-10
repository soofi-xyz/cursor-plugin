import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import {
  browardTylerJurisdictions,
  requireBrowardTylerJurisdiction,
} from "../src/counties/broward/tyler-jurisdictions.mjs";
import { validatePermitProfile } from "../src/counties/permit-profile.mjs";
import {
  createContractorCompanyIndex,
  matchContractorToCompany,
} from "../src/enrichment/query-table-bbb.mjs";
import {
  createPermitAdapter,
  implementedPermitAdapterKeys,
} from "../src/permits/adapters/index.mjs";
import {
  buildTylerApiUrl,
  buildTylerParcelSearchRequest,
  normalizeTylerPermitDetail,
  parseTylerSearchResponse,
  validateTylerTenantHeaders,
} from "../src/permits/adapters/tyler-civic-access.mjs";
import {
  prepareTylerPrivateLoad,
  readTylerPrivateLoadBundle,
  writeTylerPrivateCapture,
} from "../src/permits/private-load.mjs";

const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/permits/broward/tyler",
);
const tenantHeaders = {
  tenantid: "1",
  tenantname: "EnerGovProd",
  "tyler-tenanturl": "pembroke-pines",
  "tyler-tenant-culture": "en-US",
};
let pembrokeFixture;
let sunriseFixture;

beforeAll(async () => {
  [pembrokeFixture, sunriseFixture] = await Promise.all([
    readFile(
      path.join(fixtureRoot, "pembroke-pines-detail.json"),
      "utf8",
    ).then(JSON.parse),
    readFile(path.join(fixtureRoot, "sunrise-detail.json"), "utf8").then(
      JSON.parse,
    ),
  ]);
});

describe("Tyler Civic Access tenant configuration", () => {
  it("registers one adapter for both Tyler route variants", () => {
    const pembroke = requireBrowardTylerJurisdiction("pembroke-pines");
    const sunrise = requireBrowardTylerJurisdiction("sunrise");
    expect(implementedPermitAdapterKeys).toContain("tyler-civic-access");
    expect(createPermitAdapter(pembroke).key).toBe("tyler-civic-access");
    expect(createPermitAdapter(sunrise).key).toBe("tyler-civic-access");
    expect(
      buildTylerApiUrl(pembroke, "api/energov/permits/permitdetail"),
    ).toBe(
      "https://pembrokepinesfl-energovweb.tylerhost.net/apps/selfservice/api/energov/permits/permitdetail",
    );
    expect(
      buildTylerApiUrl(sunrise, "api/energov/permits/permitdetail"),
    ).toBe(
      "https://energov.sunrisefl.gov/EnerGov_Prod/SelfService/api/energov/permits/permitdetail",
    );
    expect(
      validatePermitProfile({
        countyKey: "broward",
        countyName: "Broward",
        stateCode: "FL",
        countyFips: "12011",
        parcelIdentifierPattern: "^\\d{12}$",
        jurisdictions: [
          {
            ...pembroke,
            routingCities: ["PEMBROKE PINES"],
            defaultForUnmatchedCity: true,
            status: "supported",
            historicalRecords: true,
            parcelSearchFormat: "digits-only",
            sources: [
              {
                key: "tyler-public-search",
                url: pembroke.adapterConfig.baseUrl,
                role: "historical-search",
                access: "public",
              },
            ],
            recordsRequest: null,
          },
        ],
        publication: {
          bucket: "test-bucket",
          propertyQueryTableIpnsLabel: "test-property",
          permitTableIpnsLabel: "test-permit",
          coverageIpnsLabel: "test-coverage",
        },
      }).jurisdictions[0].adapterKey,
    ).toBe("tyler-civic-access");
  });

  it("requires the configured public tenant identity", () => {
    const pembroke = browardTylerJurisdictions["pembroke-pines"];
    expect(validateTylerTenantHeaders(pembroke, tenantHeaders)).toEqual(
      tenantHeaders,
    );
    expect(() =>
      validateTylerTenantHeaders(pembroke, {
        ...tenantHeaders,
        tenantname: "Wrong Tenant",
      }),
    ).toThrow(/unexpected Tyler tenant/);
  });

  it("builds a permit-only parcel request without changing the UI template", () => {
    const template = {
      Keyword: "bootstrap",
      SearchModule: 1,
      PermitCriteria: { ParcelNumber: null },
    };
    const request = buildTylerParcelSearchRequest(
      template,
      "5140-0521-1940",
      2,
    );
    expect(request).toMatchObject({
      Keyword: "",
      ExactMatch: true,
      SearchModule: 2,
      FilterModule: 0,
      PageNumber: 2,
      PageSize: 10,
      PermitCriteria: {
        ParcelNumber: "514005211940",
        PageNumber: 2,
        PageSize: 10,
      },
    });
    expect(template).toEqual({
      Keyword: "bootstrap",
      SearchModule: 1,
      PermitCriteria: { ParcelNumber: null },
    });
  });
});

describe("Tyler Civic Access detail normalization", () => {
  it("extracts Pembroke Pines merged contractor and qualifier identity", () => {
    const record = normalizeTylerPermitDetail(pembrokeFixture, {
      jurisdiction: browardTylerJurisdictions["pembroke-pines"],
      reference: pembrokeFixture.reference,
      requestedParcelIdentifier: "514005211940",
      requestedPropertyId: null,
    });
    expect(record).toMatchObject({
      countyKey: "broward",
      jurisdictionKey: "pembroke-pines",
      source_system: "broward_pembroke_pines_tyler_permits",
      permit_number: "RL23-04374",
      parcel_identifier: "514005211940",
      permit_issue_date: "2023-10-05",
      isRoofPermit: true,
    });
    expect(record.contractors).toEqual([
      {
        businessName: "Example Roofing & Waterproofing LLC",
        licenseNumber: null,
        qualifierName: "QUALIFIER JANE",
        phone: null,
        email: null,
      },
    ]);
  });

  it("extracts Sunrise alternate contractor and address fields", () => {
    const record = normalizeTylerPermitDetail(sunriseFixture, {
      jurisdiction: browardTylerJurisdictions.sunrise,
      reference: sunriseFixture.reference,
      requestedParcelIdentifier: "494026050080",
      requestedPropertyId: "a".repeat(32),
    });
    expect(record).toMatchObject({
      jurisdictionKey: "sunrise",
      source_system: "broward_sunrise_tyler_permits",
      permit_number: "C-MECH-009303-2026",
      parcel_identifier: "494026050080",
      property_id: "a".repeat(32),
      workAddress: "200 SAMPLE BOULEVARD SUNRISE, FL 33323",
      isRoofPermit: true,
    });
    expect(record.contractors).toEqual([
      {
        businessName: "Example Renovations AC LLC",
        licenseNumber: "CAC1234567",
        qualifierName: "JANE QUALIFIER",
        phone: "(954) 555-0100",
        email: "permits@example.invalid",
      },
    ]);
  });

  it("fails closed on permit, record, URL, and parcel mismatches", () => {
    const context = {
      jurisdiction: browardTylerJurisdictions["pembroke-pines"],
      reference: pembrokeFixture.reference,
      requestedParcelIdentifier: "514005211940",
      requestedPropertyId: null,
    };
    expect(() =>
      normalizeTylerPermitDetail(
        {
          ...pembrokeFixture,
          detailPayload: {
            ...pembrokeFixture.detailPayload,
            Result: {
              ...pembrokeFixture.detailPayload.Result,
              PermitNumber: "OTHER",
            },
          },
        },
        context,
      ),
    ).toThrow(/differs from search permit/);
    expect(() =>
      normalizeTylerPermitDetail(
        {
          ...pembrokeFixture,
          detailPayload: {
            ...pembrokeFixture.detailPayload,
            Result: {
              ...pembrokeFixture.detailPayload.Result,
              PermitId: "99999999-2222-4333-8444-555555555555",
            },
          },
        },
        context,
      ),
    ).toThrow(/different source record/);
    expect(() =>
      normalizeTylerPermitDetail(pembrokeFixture, {
        ...context,
        reference: {
          ...context.reference,
          sourceUrl: "https://example.invalid/permit/1",
        },
      }),
    ).toThrow(/left the configured tenant/);
    expect(() =>
      normalizeTylerPermitDetail(
        {
          ...pembrokeFixture,
          detailPayload: {
            ...pembrokeFixture.detailPayload,
            Result: {
              ...pembrokeFixture.detailPayload.Result,
              MainParcelNumber: "999999999999",
            },
          },
        },
        context,
      ),
    ).toThrow(/did not preserve requested parcel/);
  });

  it("requires exact search and parcel evidence", () => {
    const payload = {
      Success: true,
      Result: {
        TotalFound: 1,
        TotalPages: 1,
        EntityResults: [pembrokeFixture.reference.sourcePayload],
      },
    };
    expect(
      parseTylerSearchResponse(payload, {
        jurisdiction: browardTylerJurisdictions["pembroke-pines"],
        requestedParcelIdentifier: "514005211940",
        exactPermitNumber: "RL23-04374",
      }).references[0],
    ).toMatchObject({
      sourceRecordId: pembrokeFixture.reference.sourceRecordId,
      permitNumber: "RL23-04374",
      parcelIdentifier: "514005211940",
    });
    expect(() =>
      parseTylerSearchResponse(
        {
          ...payload,
          Result: {
            ...payload.Result,
            EntityResults: [
              {
                ...pembrokeFixture.reference.sourcePayload,
                MainParcel: "999999999999",
              },
            ],
          },
        },
        {
          jurisdiction: browardTylerJurisdictions["pembroke-pines"],
          requestedParcelIdentifier: "514005211940",
          exactPermitNumber: "RL23-04374",
        },
      ),
    ).toThrow(/expected 514005211940/);
  });
});

describe("contractor-to-company matching", () => {
  const companyIndex = createContractorCompanyIndex([
    {
      companyId: "company-license",
      name: "Registered License Holder LLC",
      licenses: ["CAC1234567"],
    },
    { companyId: "company-exact", name: "Exact Roofing LLC" },
    { companyId: "company-twin-1", name: "Twin Roofing LLC" },
    { companyId: "company-twin-2", name: "Twin Roofing Inc." },
  ]);

  it("accepts deterministic evidence in license-first order", () => {
    expect(
      matchContractorToCompany(
        {
          businessName: "Different Display Name",
          licenseNumber: "cac-1234567",
          phone: null,
        },
        companyIndex,
      ),
    ).toEqual({
      status: "accepted",
      companyId: "company-license",
      method: "exact_state_license",
      confidence: 1,
    });
    expect(
      matchContractorToCompany(
        { businessName: "Exact Roofing, Inc." },
        companyIndex,
      ),
    ).toEqual({
      status: "accepted",
      companyId: "company-exact",
      method: "unique_exact_normalized_business_name",
      confidence: 0.8,
    });
  });

  it("preserves ambiguous and unmatched identities without a company link", () => {
    const ambiguous = matchContractorToCompany(
      { businessName: "Twin Roofing Company" },
      companyIndex,
    );
    expect(ambiguous).toMatchObject({
      status: "ambiguous",
      method: "jaro_winkler_cleaned_business_name",
      candidate: { companyId: expect.any(String) },
      runnerUp: { companyId: expect.any(String) },
    });
    expect(ambiguous).not.toHaveProperty("companyId");
    expect(
      matchContractorToCompany(
        { businessName: "No Matching Contractor LLC" },
        companyIndex,
      ),
    ).toMatchObject({ status: "unmatched" });
  });
});

describe("Tyler private load handoff", () => {
  it("prepares idempotent permit and contractor artifacts", async () => {
    const temporaryDir = await mkdtemp(
      path.join(os.tmpdir(), "tyler-private-load-"),
    );
    try {
      const captures = [
        {
          fileName: "pembroke.json",
          jurisdictionKey: "pembroke-pines",
          parcelIdentifier: "514005211940",
          record: normalizeTylerPermitDetail(pembrokeFixture, {
            jurisdiction:
              browardTylerJurisdictions["pembroke-pines"],
            reference: pembrokeFixture.reference,
            requestedParcelIdentifier: "514005211940",
            requestedPropertyId: null,
          }),
        },
        {
          fileName: "sunrise.json",
          jurisdictionKey: "sunrise",
          parcelIdentifier: "494026050080",
          record: normalizeTylerPermitDetail(sunriseFixture, {
            jurisdiction: browardTylerJurisdictions.sunrise,
            reference: sunriseFixture.reference,
            requestedParcelIdentifier: "494026050080",
            requestedPropertyId: null,
          }),
        },
      ];
      for (const capture of captures) {
        await writeTylerPrivateCapture(
          path.join(temporaryDir, capture.fileName),
          {
            schemaVersion: "elephant.tyler-private-capture.v1",
            countyKey: "broward",
            jurisdictionKey: capture.jurisdictionKey,
            parcelIdentifier: capture.parcelIdentifier,
            records: [capture.record],
          },
        );
      }
      const options = {
        capturePaths: captures.map((capture) =>
          path.join(temporaryDir, capture.fileName),
        ),
        outputDir: path.join(temporaryDir, "load"),
      };
      const first = await prepareTylerPrivateLoad(options);
      const second = await prepareTylerPrivateLoad(options);
      expect(first).toEqual(second);
      expect(first).toMatchObject({
        permitCount: 2,
        contractorCount: 2,
        parcelIdentifiers: ["494026050080", "514005211940"],
      });
      const loadBundle = await readTylerPrivateLoadBundle(
        options.outputDir,
      );
      expect(loadBundle.permits).toHaveLength(2);
      expect(loadBundle.contacts).toHaveLength(2);
      const contactRows = (
        await readFile(
          path.join(options.outputDir, "permit-contacts.private.jsonl"),
          "utf8",
        )
      )
        .trim()
        .split("\n")
        .map(JSON.parse);
      expect(contactRows).toHaveLength(2);
      expect(contactRows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            contactRole: "Contractor",
            companyId: null,
            rawName: "Example Roofing & Waterproofing LLC",
          }),
          expect.objectContaining({
            contactRole: "Contractor",
            companyId: null,
            rawName: "Example Renovations AC LLC",
            licenseNumber: "CAC1234567",
          }),
        ]),
      );
    } finally {
      await rm(temporaryDir, { recursive: true, force: true });
    }
  });
});
