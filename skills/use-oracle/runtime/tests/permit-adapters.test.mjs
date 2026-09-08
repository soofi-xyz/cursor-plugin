import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  normalizeBsaPermit,
  parseBsaPermitDetailHtml,
} from "../src/permits/adapters/bsa.mjs";
import {
  normalizeClick2GovPermit,
  parseClick2GovDetailHtml,
  parseClick2GovPermitNumber,
} from "../src/permits/adapters/click2gov.mjs";
import {
  normalizeJaxEpicsPermit,
  parseJaxEpicsSearchResponse,
} from "../src/permits/adapters/jaxepics.mjs";
import { normalizeJaxPermitMapFeature } from "../src/permits/adapters/jaxepics-map.mjs";
import {
  normalizeDuvalParcelIdentifier,
  routePermitJurisdiction,
} from "../src/permits/normalization.mjs";
import { duvalPermitProfile } from "../src/counties/duval/permit-profile.mjs";

const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/permits/duval",
);
const propertyId = "a".repeat(32);

describe("permit adapter fixtures", () => {
  it("normalizes the bounded JaxEPICS API detail fixture", async () => {
    const payload = JSON.parse(
      await readFile(
        path.join(fixtureRoot, "jaxepics/permit-detail.json"),
        "utf8",
      ),
    );
    const record = normalizeJaxEpicsPermit(payload, {
      requestedParcelIdentifier: "044280-0505",
      requestedPropertyId: propertyId,
    });
    expect(record).toMatchObject({
      property_id: propertyId,
      parcel_identifier: "044280-0505",
      permit_number: "M-89-22897.004",
      completion_date: "1991-04-10",
      estimated_job_value: 0,
      fee: 14,
      jurisdictionKey: "jacksonville",
    });
    expect(record.contractors[0].businessName).toBe(
      "Superior Stone & Fireplace Inc",
    );
    expect(record.inspections).toHaveLength(2);
  });

  it("extracts accessible JaxEPICS search references only", () => {
    expect(
      parseJaxEpicsSearchResponse(
        {
          values: [
            {
              title: "M-89-22897.004",
              key: "1173080",
              link: "/Permit/View/296cd5",
              obj: { PermitType: "Mechanical Permit" },
            },
            {
              title: "hidden",
              link: "/Permit/9",
              CanDoOperation: [false],
            },
          ],
        },
        "https://jaxepicsapi.coj.net/api/",
      ),
    ).toEqual([
      expect.objectContaining({
        sourceRecordId: "1173080",
        permitNumber: "M-89-22897.004",
      }),
    ]);
  });

  it("normalizes the official Jacksonville BID bulk layer", async () => {
    const payload = JSON.parse(
      await readFile(
        path.join(
          fixtureRoot,
          "jaxepics-map/permit-page.json",
        ),
        "utf8",
      ),
    );
    const record = normalizeJaxPermitMapFeature(payload.features[0], {
      requestedParcelIdentifier: "164634-0000",
      requestedPropertyId: propertyId,
    });
    expect(record).toMatchObject({
      property_id: propertyId,
      parcel_identifier: "164634-0000",
      permit_number: "E-95-24104.000",
      improvement_type: "Electrical Permit",
      improvement_status: "Finalized",
      permit_issue_date: "1995-05-25",
      completion_date: "1995-05-30",
      source_system: "duval_jaxepics_bid_map",
    });
    expect(record.contractors).toEqual([
      {
        businessName: "Snyder Co.",
        licenseNumber: null,
        qualifierName: null,
        phone: null,
        email: null,
      },
    ]);
  });

  it("parses and normalizes the bounded BS&A detail fixture", async () => {
    const html = await readFile(
      path.join(fixtureRoot, "bsa/permit-detail.html"),
      "utf8",
    );
    const sourceUrl =
      "https://bsaonline.com/CD_RecordDetails/Permit?permitId=54715&uid=3261";
    const parsed = parseBsaPermitDetailHtml(html, { sourceUrl });
    const record = normalizeBsaPermit(parsed, {
      requestedParcelIdentifier: "171190-0000",
      requestedPropertyId: propertyId,
      sourceUrl,
    });
    expect(record).toMatchObject({
      permit_number: "RES21-0037",
      parcel_identifier: "171190-0000",
      completion_date: "2021-05-06",
      final_inspection_date: "2021-05-06",
      jurisdictionKey: "atlantic-beach",
    });
    expect(record.relatedRecords).toEqual(["ERES21-0063"]);
  });

  it("parses reusable Click2Gov status-detail fields", () => {
    const html = `
      <h1>Status Detail</h1>
      <div><label>Application Number:</label><span class="form-control-static">24-1234</span></div>
      <div><label>Parcel ID:</label><span class="form-control-static">177777-0000</span></div>
      <div><label>Application Type:</label><span class="form-control-static">Residential Roof</span></div>
      <div><label>Application Status:</label><span class="form-control-static">Finaled</span></div>
      <div><label>Application Date:</label><span class="form-control-static">1/2/2024</span></div>
      <div><label>Final Date:</label><span class="form-control-static">2/3/2024</span></div>
      <div><label>General Contractor:</label><span class="form-control-static">Example Roofing LLC CCC1234567</span></div>
    `;
    const parsed = parseClick2GovDetailHtml(html, "24-1234");
    const record = normalizeClick2GovPermit(parsed, {
      requestedParcelIdentifier: "177777-0000",
      requestedPropertyId: propertyId,
      sourceUrl:
        "https://jakb-egov.aspgov.com/Click2GovBP/selectpermit.html",
    });
    expect(parseClick2GovPermitNumber("JB-24-001234")).toEqual({
      appYear: "24",
      appNumber: "1234",
    });
    expect(record).toMatchObject({
      completion_date: "2024-02-03",
      isRoofPermit: true,
      jurisdictionKey: "jacksonville-beach",
    });
    expect(record.contractors[0].licenseNumber).toBe("CCC1234567");
  });
});

describe("Duval permit routing and parcel normalization", () => {
  it("preserves RE identifiers as text and rejects malformed values", () => {
    expect(normalizeDuvalParcelIdentifier("0442800505R")).toBe(
      "044280-0505",
    );
    expect(() => normalizeDuvalParcelIdentifier("123")).toThrow(
      /Invalid Duval RE number/,
    );
  });

  it("routes beach cities before the consolidated default", () => {
    expect(
      routePermitJurisdiction(
        duvalPermitProfile,
        "Atlantic Beach",
      ).key,
    ).toBe("atlantic-beach");
    expect(
      routePermitJurisdiction(duvalPermitProfile, "Somewhere Else").key,
    ).toBe("jacksonville");
  });
});
