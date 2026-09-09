import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { browardPermitProfile } from "../src/counties/broward/permit-profile.mjs";
import {
  normalizeAccelaPermitDetail,
  parseAccelaSearchPage,
} from "../src/permits/adapters/accela.mjs";
import {
  normalizeArcgisPermitFeature,
} from "../src/permits/adapters/arcgis-feature-service.mjs";
import {
  normalizeBcsPossePermitDetail,
  parseBcsPossePermitList,
} from "../src/permits/adapters/bcs-posse.mjs";
import {
  normalizeCoconutCreekPermitDetail,
  parseCoconutCreekSearchPage,
} from "../src/permits/adapters/coconut-creek-status.mjs";
import {
  normalizeSmartGovPermitDetail,
  parseSmartGovSearchPage,
} from "../src/permits/adapters/smartgov.mjs";
import {
  normalizeTylerEsuitePermitDetail,
  parseTylerEsuiteSearchPage,
} from "../src/permits/adapters/tyler-esuite.mjs";
import {
  createPermitAdapterForSource,
  implementedPermitAdapterKeys,
} from "../src/permits/adapters/index.mjs";
import {
  normalizeBrowardParcelIdentifier,
  routePermitJurisdiction,
} from "../src/permits/normalization.mjs";
import {
  assertPermitProfileReady,
  evaluatePermitProfileReadiness,
} from "../src/permits/readiness.mjs";
import { createPermitBackfillPlan } from "../src/permits/backfill-plan.mjs";

const fixtures = fileURLToPath(
  new URL("./fixtures/broward-permits/", import.meta.url),
);

async function fixture(name) {
  return readFile(`${fixtures}${name}`, "utf8");
}

function jurisdiction(key) {
  return browardPermitProfile.jurisdictions.find(
    (candidate) => candidate.key === key,
  );
}

describe("Broward permit rollout readiness", () => {
  it("routes every harvestable source through an implemented adapter", () => {
    const result = assertPermitProfileReady(browardPermitProfile);
    expect(result.jurisdictionCount).toBe(32);
    expect(result.sourceCount).toBe(37);
    expect(result.harvestableSourceCount).toBe(20);
    expect(result.statusCounts).toMatchObject({
      supported: 18,
      blocked: 13,
      "custodian-only": 1,
    });
    expect(
      result.sources
        .filter((source) => source.harvestable)
        .every(
          (source) =>
            source.adapterImplemented &&
            source.detailFingerprintVersion,
        ),
    ).toBe(true);
  });

  it("keeps every non-harvestable source as an explicit blocker", () => {
    const result = evaluatePermitProfileReadiness(browardPermitProfile);
    expect(result.ready).toBe(true);
    expect(result.blockedSourceCount).toBe(17);
    expect(
      browardPermitProfile.jurisdictions
        .flatMap((entry) => entry.sources)
        .filter(
          (source) =>
            source.access !== "public" ||
            source.enumerationStatus === "blocked",
        )
        .every((source) => source.blockerType),
    ).toBe(true);
  });

  it("resolves the Fort Lauderdale ArcGIS source route independently", () => {
    const entry = jurisdiction("fort-lauderdale");
    const source = entry.sources.find(
      (candidate) => candidate.key === "official-arcgis-bulk",
    );
    const adapter = createPermitAdapterForSource(entry, source, {
      client: { json: async () => ({ body: { count: 0 } }) },
    });
    expect(adapter).toHaveProperty("enumerate");
    expect(implementedPermitAdapterKeys).toContain("arcgis-feature-service");
  });

  it("fails closed when Broward Click2Gov folio segmentation is unproven", async () => {
    const entry = jurisdiction("pompano-beach");
    const source = entry.sources.find(
      (candidate) => candidate.key === "click2gov",
    );
    const adapter = createPermitAdapterForSource(entry, source);
    await expect(adapter.searchParcel("484236010010")).rejects.toMatchObject({
      code: "click2gov_parcel_segmentation_unproven",
      classification: "blocked",
    });
  });

  it("requires explicit Broward city routing and a valid folio", () => {
    expect(normalizeBrowardParcelIdentifier("5041-11-16-0200")).toBe(
      "504111160200",
    );
    expect(
      routePermitJurisdiction(browardPermitProfile, "Hollywood")?.key,
    ).toBe("hollywood");
    expect(
      routePermitJurisdiction(
        browardPermitProfile,
        "4800 W COPANS ROAD COCONUT CREEK",
      )?.key,
    ).toBe("coconut-creek");
    expect(
      routePermitJurisdiction(browardPermitProfile, "Unknown City"),
    ).toBeNull();
  });

  it("builds deterministic plan-only delta and repair tasks", () => {
    const delta = createPermitBackfillPlan(browardPermitProfile, {
      mode: "delta",
      fromDate: "2026-09-01",
      throughDate: "2026-09-09",
      propertiesPath: "inputs/broward-properties.parquet",
      manifestPath: null,
      jurisdictionKeys: ["fort-lauderdale"],
    });
    const repeated = createPermitBackfillPlan(browardPermitProfile, {
      mode: "delta",
      fromDate: "2026-09-01",
      throughDate: "2026-09-09",
      propertiesPath: "inputs/broward-properties.parquet",
      manifestPath: null,
      jurisdictionKeys: ["fort-lauderdale"],
    });
    expect(delta.planDigest).toBe(repeated.planDigest);
    expect(delta.tasks).toHaveLength(2);
    expect(delta.writePolicy).toContain("plan-only");

    const repair = createPermitBackfillPlan(browardPermitProfile, {
      mode: "repair",
      fromDate: null,
      throughDate: null,
      propertiesPath: null,
      manifestPath: "runs/broward/permit-artifact-manifest.json",
      jurisdictionKeys: ["hollywood"],
    });
    expect(repair.tasks).toHaveLength(1);
    expect(repair.tasks[0].input.repairWhen).toContain("stale");
  });
});

describe("Broward adapter fixtures", () => {
  it("reconciles and normalizes Accela contractor detail", async () => {
    const html = await fixture("accela.html");
    const page = parseAccelaSearchPage(html, {
      pageUrl:
        "https://aca-prod.accela.com/HOLLYWOOD/Cap/CapHome.aspx",
    });
    expect(page.reportedTotal).toBe(1);
    expect(page.references).toHaveLength(1);
    const entry = jurisdiction("hollywood");
    const record = normalizeAccelaPermitDetail(
      html,
      page.references[0],
      {
        jurisdiction: entry,
        config: entry.adapterConfig,
        requestedParcelIdentifier: "514111160200",
      },
    );
    expect(record.permit_number).toBe("BLD24-12345");
    expect(record.estimated_job_value).toBe(12500);
    expect(record.contractors[0]).toMatchObject({
      licenseNumber: "CBC1234567",
      sourceRole: "licensed professional",
    });
    expect(record.sourcePayload.detailFingerprintVersion).toBe(
      "accela-broward-v1",
    );
  });

  it("normalizes BCS stable identity, source folio, and contractor", async () => {
    const html = await fixture("bcs-posse.html");
    const list = parseBcsPossePermitList(
      html,
      "https://dpepp.broward.org/BCS/Default.aspx?PossePresentation=ParcelPermitList&PosseObjectId=123",
    );
    expect(list.references).toHaveLength(1);
    const entry = jurisdiction("unincorporated-broward");
    const record = normalizeBcsPossePermitDetail(
      html,
      list.references[0],
      {
        jurisdiction: entry,
        config: entry.adapterConfig,
        requestedParcelIdentifier: "504111160200",
      },
    );
    expect(record.sourceRecordId).toBe("permit:15703657");
    expect(record.contractors[0].businessName).toBe(
      "SAMPLE CONTRACTOR LLC",
    );
    expect(record.sourcePayload.sourceFolio).toBe("9318-01-3550");
  });

  it("normalizes parcel-linked ArcGIS features without owner fields", async () => {
    const feature = JSON.parse(await fixture("arcgis-feature.json"));
    const entry = jurisdiction("fort-lauderdale");
    const route = entry.adapterRoutes.find(
      (candidate) => candidate.key === "official-arcgis",
    );
    const record = normalizeArcgisPermitFeature(feature, {
      countyKey: "broward",
      countyName: "Broward",
      jurisdiction: entry,
      config: route.adapterConfig,
      requestedParcelIdentifier: "504200000420",
    });
    expect(record.permit_number).toBe("BLD-2026-0042");
    expect(record.isRoofPermit).toBe(true);
    expect(record.sourcePayload.detailFingerprintVersion).toBe(
      "fort-lauderdale-arcgis-v1",
    );
    expect(record.sourcePayload.attributes).not.toHaveProperty("OWNERNAME");
    expect(() =>
      normalizeArcgisPermitFeature(feature, {
        countyKey: "broward",
        countyName: "Broward",
        jurisdiction: entry,
        config: route.adapterConfig,
        requestedParcelIdentifier: "000000000000",
      }),
    ).toThrow("differs from requested parcel");
  });

  it("normalizes SmartGov identity, parcel, and contractor detail", async () => {
    const html = await fixture("smartgov.html");
    const page = parseSmartGovSearchPage(html, {
      pageUrl:
        "https://ci-lighthousepoint-fl.smartgovcommunity.com/ApplicationPublic/ApplicationSearchAdvanced",
    });
    expect(page.references).toHaveLength(1);
    const entry = jurisdiction("lighthouse-point");
    const record = normalizeSmartGovPermitDetail(
      html,
      page.references[0],
      {
        jurisdiction: entry,
        config: entry.adapterConfig,
        requestedParcelIdentifier: "484228AB0010",
      },
    );
    expect(record.permit_number).toBe("BLD26-0012");
    expect(record.contractors[0]).toMatchObject({
      businessName: "SAMPLE ROOFING LLC",
      licenseNumber: "CCC1234567",
    });
  });

  it("normalizes eSuite address results against detail parcel identity", async () => {
    const html = await fixture("tyler-esuite.html");
    const page = parseTylerEsuiteSearchPage(html, {
      pageUrl:
        "https://esuite.davie-fl.gov/eSuite.Permits/AdvancedSearchPage/AdvancedSearch.aspx",
    });
    expect(page.references).toHaveLength(1);
    const entry = jurisdiction("davie");
    const record = normalizeTylerEsuitePermitDetail(
      html,
      page.references[0],
      {
        jurisdiction: entry,
        config: entry.adapterConfig,
        requestedParcelIdentifier: "504129010010",
      },
    );
    expect(record.permit_number).toBe("2026-00004503");
    expect(record.estimated_job_value).toBe(300);
    expect(record.contractors[0].licenseNumber).toBe("EC13001234");
  });

  it("normalizes Coconut Creek contractors and inspections", async () => {
    const html = await fixture("coconut-creek-status.html");
    const page = parseCoconutCreekSearchPage(html, {
      pageUrl:
        "https://www3.coconutcreek.gov/sd/permit/permit_status_02.asp",
    });
    const entry = jurisdiction("coconut-creek");
    const record = normalizeCoconutCreekPermitDetail(
      {
        baseHtml: html,
        permitHtml: html,
        contractorHtml: html,
        inspectionHtml: html,
      },
      page.references[0],
      {
        jurisdiction: entry,
        config: entry.adapterConfig,
        requestedParcelIdentifier: "474136000080",
      },
    );
    expect(record.contractors[0].businessName).toBe(
      "SAMPLE MUNICIPAL CONTRACTOR",
    );
    expect(record.inspections[0]).toMatchObject({
      inspectionType: "FINAL ELECTRIC",
      inspectionDate: "2004-08-26",
    });
  });
});
