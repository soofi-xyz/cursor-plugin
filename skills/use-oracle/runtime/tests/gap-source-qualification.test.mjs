import { describe, expect, it } from "vitest";

import {
  assertNoPlaceholderEnrichment,
  buildDurableBlocker,
  deriveHoaFlag,
  normalizeFolio,
  ownerOccupiedFromHomestead,
  selectLatestApprovedAvm,
} from "../src/gaps/source-qualification.mjs";

describe("Duval reusable source qualification", () => {
  it("normalizes Duval folios and maps AV_HMSTD without address heuristics", () => {
    expect(normalizeFolio("164634-0000")).toBe("164634-0000");
    expect(normalizeFolio("1646340000R")).toBe("164634-0000");
    expect(normalizeFolio("bad")).toBeNull();
    expect(ownerOccupiedFromHomestead("25,000")).toBe(true);
    expect(ownerOccupiedFromHomestead("0")).toBe(false);
    expect(ownerOccupiedFromHomestead("")).toBeNull();
    expect(ownerOccupiedFromHomestead("-1")).toBeNull();
  });

  it("keeps HOA tri-state unless parcel membership is authoritative and complete", () => {
    expect(
      deriveHoaFlag({
        authoritative: true,
        complete: true,
        effective: true,
        publicationPermitted: true,
        linkMethod: "parcel_identifier",
        membership: true,
      }),
    ).toBe(true);
    expect(
      deriveHoaFlag({
        authoritative: true,
        complete: true,
        effective: true,
        publicationPermitted: true,
        authoritativeNegative: true,
        linkMethod: "parcel_identifier",
        membership: false,
      }),
    ).toBe(false);
    expect(
      deriveHoaFlag({
        authoritative: true,
        complete: false,
        linkMethod: "subdivision_name",
        membership: true,
      }),
    ).toBeNull();
    expect(
      deriveHoaFlag({
        authoritative: true,
        complete: true,
        effective: true,
        publicationPermitted: true,
        linkMethod: "cdd_boundary",
        membership: true,
      }),
    ).toBeNull();
  });

  it("selects the latest approved positive AVM instead of MAX(value)", () => {
    const selected = selectLatestApprovedAvm([
      {
        approved: true,
        current_avm_value: 900_000,
        valuation_date: "2026-01-01",
        valuation_method_type: "vendor-model",
        publication_permitted: true,
        immutable_source_provenance: "sha256:old-feed",
      },
      {
        approved: true,
        current_avm_value: 500_000,
        valuation_date: "2026-08-01",
        valuation_method_type: "vendor-model",
        publication_permitted: true,
        immutable_source_provenance: "sha256:new-feed",
      },
      {
        approved: false,
        current_avm_value: 2_000_000,
        valuation_date: "2026-09-01",
      },
    ]);
    expect(selected.current_avm_value).toBe(500_000);
  });

  it("emits durable blockers and rejects a market-value source marker", () => {
    expect(
      buildDurableBlocker({
        county: "duval",
        field: "avm_value",
        owner: "Oracle Data Partnerships",
        attemptedSources: ["vendor registry"],
        missingRequirement: "vendor contract",
        evidence: ["no credential registered"],
        nextAction: "contract a vendor",
        observedAt: "2026-09-08T04:45:00Z",
      }).status,
    ).toBe("blocked");
    expect(() =>
      assertNoPlaceholderEnrichment({
        avm_value: 100,
        avm_value_source: "appraisal_market_value",
      }),
    ).toThrow(/must not copy/);
  });
});
