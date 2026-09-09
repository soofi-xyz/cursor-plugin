import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { browardPermitProfile } from "../src/counties/broward/permit-profile.mjs";
import {
  buildCitizenserveSearchUrl,
  parseCitizenservePermitDetailHtml,
  parseCitizenserveSearchResultsHtml,
} from "../src/permits/adapters/citizenserve.mjs";

const fixtures = new URL("./fixtures/citizenserve/", import.meta.url);
const [pageOneHtml, pageTwoHtml, contractorHtml, noContractorHtml] =
  await Promise.all(
    [
      "search-page-1.html",
      "search-page-2.html",
      "detail-contractor.html",
      "detail-no-contractor.html",
    ].map((name) => readFile(new URL(name, fixtures), "utf8")),
  );
const jurisdiction = browardPermitProfile.jurisdictions[0];
const request = {
  requestedParcelIdentifier: "504032160260",
  requestedPropertyId: null,
};

describe("Citizenserve/CAP Government adapter", () => {
  it("preserves source identity and shared-installation filtering", () => {
    const page = parseCitizenserveSearchResultsHtml(pageOneHtml, {
      jurisdiction,
      pageNumber: 1,
    });
    expect(page).toMatchObject({
      rangeStart: 1,
      rangeEnd: 2,
      reportedTotal: 4,
      excludedJurisdictionCount: 1,
      nextRange: { start: 2, end: 4 },
    });
    expect(page.references).toHaveLength(1);
    expect(page.references[0]).toMatchObject({
      sourceRecordId: "1401001",
      workOrderId: "70010001",
      permitNumber: "SWR20-000001",
    });
    expect(page.references[0].sourceUrl).toContain(
      "installationID=117",
    );
  });

  it("parses a later page without inventing another page", () => {
    const page = parseCitizenserveSearchResultsHtml(pageTwoHtml, {
      jurisdiction,
      pageNumber: 2,
    });
    expect(page.references.map((record) => record.permitNumber)).toEqual([
      "SWR20-000003",
    ]);
    expect(page.excludedJurisdictionCount).toBe(1);
    expect(page.nextRange).toBeNull();
  });

  it("normalizes explicit contractor business, license, qualifier, and role", () => {
    const reference = parseCitizenserveSearchResultsHtml(pageOneHtml, {
      jurisdiction,
      pageNumber: 1,
    }).references[0];
    const record = parseCitizenservePermitDetailHtml(contractorHtml, {
      jurisdiction,
      reference: { ...reference, searchPage: 1 },
      request,
      searchUrl: buildCitizenserveSearchUrl(jurisdiction),
    });
    expect(record).toMatchObject({
      source_system:
        "broward_southwest_ranches_citizenserve_permits",
      sourceRecordId: "1401001",
      parcel_identifier: "504032160260",
      permit_number: "SWR20-000001",
      contractors: [
        {
          businessName: "EXAMPLE ROOFING LLC",
          licenseNumber: "CCC0000000",
          qualifierName: "EXAMPLE QUALIFIER",
          sourceRole: "General Contractor",
        },
      ],
      sourcePayload: {
        contractorDisclosure: "source_reported",
        searchedParcelIdentifier: "504032160260",
      },
    });
  });

  it("records missing contractor data and ignores owner/applicant names", () => {
    const reference = parseCitizenserveSearchResultsHtml(pageTwoHtml, {
      jurisdiction,
      pageNumber: 2,
    }).references[0];
    const record = parseCitizenservePermitDetailHtml(
      noContractorHtml,
      {
        jurisdiction,
        reference: { ...reference, searchPage: 2 },
        request,
        searchUrl: buildCitizenserveSearchUrl(jurisdiction),
      },
    );
    expect(record.contractors).toEqual([]);
    expect(record.sourcePayload.contractorDisclosure).toBe("not_exposed");
    expect(JSON.stringify(record)).not.toMatch(/DO NOT INFER/);
  });

  it("fails closed on portal drift and cross-installation links", () => {
    expect(() =>
      parseCitizenserveSearchResultsHtml(
        pageOneHtml.replace("<th>Status</th>", "<th>State</th>"),
        { jurisdiction, pageNumber: 1 },
      ),
    ).toThrow("columns changed");
    expect(() =>
      parseCitizenserveSearchResultsHtml(
        pageOneHtml.replace("installationID=117", "installationID=999"),
        { jurisdiction, pageNumber: 1 },
      ),
    ).toThrow("left the configured public source");
  });
});
