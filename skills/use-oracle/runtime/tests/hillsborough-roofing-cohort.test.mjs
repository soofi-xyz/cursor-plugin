import { describe, expect, it } from "vitest";

import { hillsboroughPermitProfile } from "../src/counties/hillsborough/permit-profile.mjs";
import {
  normalizeAccelaPermitDetail,
  parseAccelaSearchPage,
} from "../src/permits/adapters/accela.mjs";
import {
  normalizePermitParcelIdentifier,
  routePermitJurisdiction,
} from "../src/permits/normalization.mjs";
import { evaluatePermitProfileReadiness } from "../src/permits/readiness.mjs";
import {
  analyzeRoofingCohort,
  evaluatePermitLifecycle,
} from "../src/investigations/roofing-cohort.mjs";

const SHA = "a".repeat(64);

function permit(overrides = {}) {
  return {
    recordType: "permit",
    propertyImprovementId: "permit-seed-roof",
    propertyId: null,
    parcelIdentifier: "1949120000",
    countyKey: "hillsborough",
    authority: "tampa",
    jurisdictionKey: "tampa",
    sourceKey: "accela-current",
    sourceSystem: "hillsborough_city_of_tampa_accela_permits",
    sourceRecordKey: "BTR-18-0479078",
    permitNumber: "BTR-18-0479078",
    status: "Complete",
    sourceStatus: null,
    recordStatus: null,
    permitType: "Residential Roof Trade Permit",
    workClass: "Roof coating",
    scope:
      "Installation of elastomeric roof coating on flat roof membrane surfaces",
    description: null,
    trade: "Roofing",
    action: null,
    workAddress: "58 Bahama Cir",
    city: "Tampa",
    masterPermitNumber: null,
    parentPermitNumber: null,
    dates: {
      application: null,
      opened: null,
      issued: "2018-02-16",
      finalInspection: "2018-04-05",
      completion: "2018-04-05",
      closed: "2018-04-05",
      expiration: "2018-10-09",
    },
    detailComplete: true,
    sourceArtifactUri: "private://hillsborough/BTR-18-0479078",
    evidenceSha256: SHA,
    contacts: [],
    events: [],
    inspections: [],
    sourceProvenance: [],
    ...overrides,
  };
}

describe("Hillsborough permit source profile", () => {
  it("routes Tampa explicitly and keeps other authorities blocked", () => {
    expect(
      normalizePermitParcelIdentifier(
        hillsboroughPermitProfile,
        "194912.0000",
      ),
    ).toBe("1949120000");
    expect(
      routePermitJurisdiction(hillsboroughPermitProfile, "Tampa")?.key,
    ).toBe("tampa");
    expect(
      routePermitJurisdiction(hillsboroughPermitProfile, "Plant City"),
    ).toBeNull();

    const readiness = evaluatePermitProfileReadiness(
      hillsboroughPermitProfile,
    );
    expect(readiness.ready).toBe(true);
    expect(readiness.harvestableSourceCount).toBe(1);
    expect(readiness.blockedSourceCount).toBe(1);
  });

  it("parses Tampa totals, source status, license, and workflow dates", () => {
    const html = `
      <span class="ACA_SmLabel">Showing 1-10 of 13</span>
      <table><tr>
        <td></td><td>11/20/2024</td>
        <td><a href="/TAMPA/Cap/CapDetail.aspx?capID1=18CAP&capID2=00000&capID3=0070X">
          <span id="row_lblPermitNumber1">BTR-18-0479078</span>
        </a></td>
        <td><span id="row_lblType">Residential Roof Trade Permit</span></td>
        <td><span id="row_lblAddress">58 Bahama Cir T 33606</span></td>
        <td><span id="row_lblStatus">Complete</span></td>
      </tr></table>
      <span id="ctl00_PlaceHolderMain_lblPermitNumber">BTR-18-0479078</span>
      <span id="ctl00_PlaceHolderMain_lblPermitType">Residential Roof Trade Permit</span>
      <span id="ctl00_PlaceHolderMain_lblRecordStatus">Complete</span>
      <span id="ctl00_PlaceHolderMain_lblExpirtionDate">10/09/2018</span>
      <table id="tbl_worklocation"><tr><td>
        58 Bahama Cir<br>FOLIO: 194912.0000<br>STRAP: 182925509000006001211A
      </td></tr></table>
      <div><h1><span id="detail_label_license">Licensed Professional:</span></h1>
        <span><table id="tbl_licensedps"><tbody><tr><td></td><td>
          KEVIN E KNIGHT private@example.test<br>
          PINNACLE SERVICES OF PINELLAS INC<br>
          6840 ULMERTON RD<br>
          LARGO, FL, 33771<br>
          Home Phone:8136052509Mobile Phone:8136052509Roofing Contractor 81360525098136052509 CCC051565<br>
        </td></tr></tbody></table></span>
      </div>
      <div><h1><span id="detail_label_project">Project Description:</span></h1>
        <span>Installation of elastomeric roof coating</span>
      </div>
      <div id="divProcessingTable"><table><tbody>
        <tr><td></td><td>Issuance</td></tr>
        <tr id="issued"><td></td><td>Marked as Issued on 02/16/2018 by STAFF</td></tr>
        <tr><td></td><td>Closure</td></tr>
        <tr id="closed"><td></td><td>Marked as Complete on 04/05/2018 by STAFF</td></tr>
      </tbody></table></div>`;

    const search = parseAccelaSearchPage(html, {
      pageUrl:
        "https://aca-prod.accela.com/TAMPA/Cap/CapHome.aspx",
    });
    expect(search.reportedTotal).toBe(13);
    expect(search.references[0]).toMatchObject({
      recordNumber: "BTR-18-0479078",
      recordType: "Residential Roof Trade Permit",
      address: "58 Bahama Cir T 33606",
      status: "Complete",
    });

    const tampa = hillsboroughPermitProfile.jurisdictions[0];
    const detail = normalizeAccelaPermitDetail(
      html,
      search.references[0],
      {
        countyKey: "hillsborough",
        countyName: "Hillsborough",
        jurisdiction: tampa,
        config: tampa.adapterConfig,
        requestedParcelIdentifier: "1949120000",
      },
    );
    expect(detail).toMatchObject({
      permit_issue_date: "2018-02-16",
      permit_close_date: "2018-04-05",
      expiration_date: "2018-10-09",
      contractors: [
        {
          businessName: "PINNACLE SERVICES OF PINELLAS INC",
          licenseNumber: "CCC051565",
          qualifierName: "KEVIN E KNIGHT",
          sourceRole: "Roofing Contractor",
          phone: null,
          email: null,
        },
      ],
    });
    expect(JSON.stringify(detail)).not.toMatch(
      /private@example|applicant|owner|8136052509/i,
    );
  });
});

describe("Hillsborough roofing evidence", () => {
  it("maps Tampa terminal statuses and elapsed expiration fail closed", () => {
    expect(
      evaluatePermitLifecycle(permit(), "2026-09-10").state,
    ).toBe("terminal");
    expect(
      evaluatePermitLifecycle(
        permit({
          status: "About to Expire",
          dates: {
            ...permit().dates,
            closed: null,
            completion: null,
            finalInspection: null,
            expiration: "2025-05-26",
          },
        }),
        "2026-09-10",
      ),
    ).toMatchObject({
      state: "terminal",
      reasonCode: "source_expiration_date_elapsed",
    });
  });

  it("classifies only the Hillsborough seed and returns no padded cohort", () => {
    const manifest = {
      recordType: "manifest",
      schemaVersion: "elephant.roofing-cohort-input.v1",
      countyKey: "hillsborough",
      generatedAt: "2026-09-10T12:00:00.000Z",
      asOfDate: "2026-09-10",
      sourceCatalogSha256: SHA,
      sourceProfileSha256: SHA,
      repositoryCommit: "b".repeat(40),
      privacy: "private",
    };
    const result = analyzeRoofingCohort({
      manifest,
      records: [
        permit(),
        {
          recordType: "property",
          propertyId: null,
          parcelIdentifier: "1949120000",
          authority: "tampa",
          address: "58 Bahama Cir",
          city: "Tampa",
          usageType: "0100",
          builtYear: null,
          sourceSystem: "hillsborough_appraiser",
          sourceRecordKey: "182925509000006001211A",
          coverage: {
            fromDate: null,
            throughDate: null,
            authorityComplete: false,
            predecessorComplete: false,
            sourceSystems: [],
          },
        },
        {
          recordType: "source_reconciliation",
          authority: "tampa",
          sourceKey: "accela-current",
          sourceSystem: "hillsborough_city_of_tampa_accela_permits",
          access: "supported",
          predecessorComplete: false,
          reported: 13,
          received: 10,
          missing: 3,
          evidence: [],
          blockerCategory: "expired-source-session",
          blockerOwner: "City of Tampa Accela",
          blockerFix: "Load the private query database export.",
        },
      ],
    });

    expect(result.summary).toMatchObject({
      countyKey: "hillsborough",
      seedPermitCount: 1,
      seedClassificationCounts: {
        confirmed_replacement: 0,
        roofing_nonreplacement: 1,
        not_roofing: 0,
        needs_review: 0,
      },
      openCohortCount: 0,
      oldRoofControlCount: 0,
    });
    expect(result.seedEvidence[0].parcelIdentifier).toBe("1949120000");
    expect(result.openCohort).toEqual([]);
    expect(result.oldRoofControls).toEqual([]);
  });
});
