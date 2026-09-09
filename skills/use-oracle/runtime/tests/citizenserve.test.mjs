import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { browardPermitProfile } from "../src/counties/broward/permit-profile.mjs";
import {
  buildCitizenserveSearchUrl,
  buildCitizenserveSearchUrls,
  normalizeCitizenservePermitListing,
  parseCitizenservePermitDetailHtml,
  parseCitizenserveSearchResultsHtml,
  resolveCitizenserveSource,
  validateCitizenserveSearchPageHtml,
} from "../src/permits/adapters/citizenserve.mjs";

const fixtures = new URL("./fixtures/citizenserve/", import.meta.url);
const [
  pageOneHtml,
  pageTwoHtml,
  contractorHtml,
  noContractorHtml,
  listingOnlyHtml,
] =
  await Promise.all(
    [
      "search-page-1.html",
      "search-page-2.html",
      "detail-contractor.html",
      "detail-no-contractor.html",
      "search-listing-only.html",
    ].map((name) => readFile(new URL(name, fixtures), "utf8")),
  );
const jurisdiction = browardPermitProfile.jurisdictions.find(
  (candidate) => candidate.key === "southwest-ranches",
);
const request = {
  requestedParcelIdentifier: "504032160260",
  requestedPropertyId: null,
};

describe("Citizenserve/CAP Government adapter", () => {
  it("uses only the ordered configured Citizenserve hosts", async () => {
    expect(buildCitizenserveSearchUrls(jurisdiction)).toEqual([
      expect.stringContaining("https://www6.citizenserve.com/Portal/"),
      expect.stringContaining("https://www2.citizenserve.com/Portal/"),
    ]);
    const attempts = [];
    const selected = await resolveCitizenserveSource(
      jurisdiction,
      async ({ baseUrl, searchUrl }) => {
        attempts.push(baseUrl);
        if (baseUrl.includes("www6")) {
          const timeout = new Error("timed out");
          timeout.name = "TimeoutError";
          throw timeout;
        }
        return searchUrl;
      },
    );
    expect(attempts).toEqual([
      "https://www6.citizenserve.com/Portal",
      "https://www2.citizenserve.com/Portal",
    ]);
    expect(selected).toContain("https://www2.citizenserve.com/");
  });

  it("rejects arbitrary configured hosts", () => {
    const unsafe = {
      ...jurisdiction,
      adapterConfig: {
        ...jurisdiction.adapterConfig,
        fallbackBaseUrls: ["https://example.com/Portal"],
      },
    };
    expect(() => buildCitizenserveSearchUrls(unsafe)).toThrow(
      "not an allow-listed public portal host",
    );
  });

  it("validates installation identity and does not fall back on mismatch", async () => {
    const searchPage = (installationId) => `
      <input id="installationID" value="${installationId}">
      <main><h1 class="page-heading">Search</h1></main>
      <form id="frm_PortalSearch" action="PortalController">
        <input id="Action" value="DisplayCasesNPagging">
        <select id="filetype"><option value="Permit">Permits</option></select>
      </form>`;
    expect(
      validateCitizenserveSearchPageHtml(searchPage(117), {
        jurisdiction,
      }),
    ).toEqual({ installationId: 117 });
    const attempts = [];
    await expect(
      resolveCitizenserveSource(
        jurisdiction,
        async ({ baseUrl }) => {
          attempts.push(baseUrl);
          return validateCitizenserveSearchPageHtml(searchPage(999), {
            jurisdiction,
          });
        },
      ),
    ).rejects.toThrow("does not match the configured installation");
    expect(attempts).toEqual([
      "https://www6.citizenserve.com/Portal",
    ]);
  });

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

  it("preserves the responding fallback host for listing-only provenance", () => {
    const searchUrl = buildCitizenserveSearchUrl(
      jurisdiction,
      "https://www2.citizenserve.com/Portal",
    );
    const page = parseCitizenserveSearchResultsHtml(listingOnlyHtml, {
      jurisdiction,
      pageNumber: 1,
      sourceBaseUrl: "https://www2.citizenserve.com/Portal",
      searchUrl,
      expectedPermitNumber: "SWR20-000001",
    });
    const record = normalizeCitizenservePermitListing({
      jurisdiction,
      reference: {
        ...page.references[0],
        searchPage: 1,
        searchKind: "permit-number",
        searchValue: "SWR20-000001",
        folioSearchReportedTotal: 1,
        folioSearchPermitNumbers: ["SWR20-000001"],
      },
      request,
      searchUrl,
    });
    expect(record.sourceUrl).toContain(
      "https://www2.citizenserve.com/",
    );
    expect(record.sourcePayload).toMatchObject({
      sourceHost: "www2.citizenserve.com",
      sourceHostRole: "operator-approved-fallback",
      configuredPrimaryHost: "www6.citizenserve.com",
      installationId: 117,
      detailAvailability: "not_exposed",
      contractorDisclosure: "public_detail_not_exposed",
    });
    expect(record.contractors).toEqual([]);
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
    expect(() =>
      parseCitizenserveSearchResultsHtml(listingOnlyHtml, {
        jurisdiction: {
          ...jurisdiction,
          adapterConfig: {
            ...jurisdiction.adapterConfig,
            listingOnlyBaseUrls: [],
          },
        },
        pageNumber: 1,
      }),
    ).toThrow("no configured public detail link");
  });
});
