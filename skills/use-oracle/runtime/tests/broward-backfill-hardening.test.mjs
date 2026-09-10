import {
  copyFile,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { browardPermitProfile } from "../src/counties/broward/permit-profile.mjs";
import { permitProfileDigest } from "../src/counties/permit-profile.mjs";
import {
  createArcgisFeatureServiceAdapter,
} from "../src/permits/adapters/arcgis-feature-service.mjs";
import {
  executePermitBackfillPlan,
  resumableReceiptDecision,
} from "../src/permits/backfill-executor.mjs";
import {
  PERMIT_CHECKPOINTS_VERSION,
  PERMIT_REPAIR_CANDIDATE_VERSION,
} from "../src/permits/backfill-inputs.mjs";
import {
  createPermitBackfillPlan,
  harvestablePermitSources,
  validatePermitBackfillPlan,
} from "../src/permits/backfill-plan.mjs";
import { DurablePermitBackfillState } from "../src/permits/backfill-state.mjs";

const temporaryDirectories = [];
const profileSha256 = permitProfileDigest(browardPermitProfile);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
  );
});

async function temporaryDirectory() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "broward-backfill-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

async function writeJsonl(filePath, rows) {
  await writeFile(
    filePath,
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
}

function property(index = 1, city = "Hollywood") {
  return {
    property_id: index.toString(16).padStart(32, "0"),
    parcel_identifier: `51411116${String(index).padStart(4, "0")}`,
    address_city: city,
    address_full: `${index} TEST STREET`,
  };
}

function checkpoint(definition, throughDate = "2026-09-08") {
  return {
    jurisdictionKey: definition.jurisdictionKey,
    sourceKey: definition.sourceKey,
    status: "complete",
    throughDate,
    profileSha256,
    detailFingerprintVersion:
      definition.detailFingerprintVersion,
    executionFingerprint: "a".repeat(64),
  };
}

async function deltaInputs(directory, definitions, rows = [property()]) {
  const propertiesPath = path.join(directory, "properties.jsonl");
  const checkpointsPath = path.join(directory, "checkpoints.json");
  await writeJsonl(propertiesPath, rows);
  await writeFile(
    checkpointsPath,
    `${JSON.stringify({
      schemaVersion: PERMIT_CHECKPOINTS_VERSION,
      countyKey: "broward",
      generatedAt: "2026-09-09T00:00:00.000Z",
      sources: definitions.map((definition) => checkpoint(definition)),
    })}\n`,
  );
  return { propertiesPath, checkpointsPath };
}

async function createDeltaPlan(directory, jurisdictionKeys = []) {
  const definitions = harvestablePermitSources(
    browardPermitProfile,
    jurisdictionKeys,
  );
  const inputs = await deltaInputs(directory, definitions);
  const plan = await createPermitBackfillPlan(browardPermitProfile, {
    mode: "delta",
    throughDate: "2026-09-09",
    initialFromDate: null,
    propertiesPath: inputs.propertiesPath,
    manifestPath: null,
    checkpointsPath: inputs.checkpointsPath,
    jurisdictionKeys,
  });
  return { plan, ...inputs };
}

function repairCandidate({
  index,
  status,
  detailFingerprintVersion = "accela-broward-v1",
  detailComplete = true,
  candidateProfileSha256 = profileSha256,
}) {
  return {
    schemaVersion: PERMIT_REPAIR_CANDIDATE_VERSION,
    countyKey: "broward",
    jurisdictionKey: "hollywood",
    sourceKey: "accela-current",
    property: {
      propertyId: index.toString(16).padStart(32, "0"),
      parcelIdentifier: `51411116${String(index).padStart(4, "0")}`,
      city: "Hollywood",
      workAddress: `${index} TEST STREET`,
    },
    prior: {
      status,
      profileSha256: candidateProfileSha256,
      detailFingerprintVersion,
      detailComplete,
    },
  };
}

describe("content-bound Broward backfill planning", () => {
  it("requires readable schema-valid inputs and rejects plan tampering", async () => {
    const directory = await temporaryDirectory();
    const definitions = harvestablePermitSources(
      browardPermitProfile,
      ["hollywood"],
    );
    const checkpointsPath = path.join(directory, "checkpoints.json");
    await writeFile(
      checkpointsPath,
      `${JSON.stringify({
        schemaVersion: PERMIT_CHECKPOINTS_VERSION,
        countyKey: "broward",
        generatedAt: "2026-09-09T00:00:00.000Z",
        sources: definitions.map((definition) => checkpoint(definition)),
      })}\n`,
    );
    await expect(
      createPermitBackfillPlan(browardPermitProfile, {
        mode: "delta",
        throughDate: "2026-09-09",
        initialFromDate: null,
        propertiesPath: path.join(directory, "missing.jsonl"),
        manifestPath: null,
        checkpointsPath,
        jurisdictionKeys: ["hollywood"],
      }),
    ).rejects.toThrow("readable regular file");

    const invalidPath = path.join(directory, "invalid.jsonl");
    await writeJsonl(invalidPath, [{ property_id: "a".repeat(32) }]);
    await expect(
      createPermitBackfillPlan(browardPermitProfile, {
        mode: "delta",
        throughDate: "2026-09-09",
        initialFromDate: null,
        propertiesPath: invalidPath,
        manifestPath: null,
        checkpointsPath,
        jurisdictionKeys: ["hollywood"],
      }),
    ).rejects.toThrow("parcel_identifier");

    const valid = await createDeltaPlan(directory, ["hollywood"]);
    expect(() =>
      validatePermitBackfillPlan({
        ...valid.plan,
        throughDate: "2026-09-10",
      }),
    ).toThrow("digest mismatch");
  });

  it("binds path-independent content digests into stable fingerprints", async () => {
    const left = await temporaryDirectory();
    const right = await temporaryDirectory();
    const first = await createDeltaPlan(left, ["fort-lauderdale"]);
    const propertiesCopy = path.join(right, "renamed-input.jsonl");
    const checkpointsCopy = path.join(right, "renamed-checkpoints.json");
    await Promise.all([
      copyFile(first.propertiesPath, propertiesCopy),
      copyFile(first.checkpointsPath, checkpointsCopy),
    ]);
    const repeated = await createPermitBackfillPlan(
      browardPermitProfile,
      {
        mode: "delta",
        throughDate: "2026-09-09",
        initialFromDate: null,
        propertiesPath: propertiesCopy,
        manifestPath: null,
        checkpointsPath: checkpointsCopy,
        jurisdictionKeys: ["fort-lauderdale"],
      },
    );
    expect(repeated.planDigest).toBe(first.plan.planDigest);
    expect(repeated.tasks.map((task) => task.executionFingerprint)).toEqual(
      first.plan.tasks.map((task) => task.executionFingerprint),
    );
    expect(JSON.stringify(repeated)).not.toContain(propertiesCopy);
  });

  it("derives one-day-overlap deltas and gates initial backfills", async () => {
    const directory = await temporaryDirectory();
    const definition = harvestablePermitSources(
      browardPermitProfile,
      ["hollywood"],
    );
    const inputs = await deltaInputs(directory, []);
    const initial = await createPermitBackfillPlan(
      browardPermitProfile,
      {
        mode: "delta",
        throughDate: "2026-09-09",
        initialFromDate: "2026-01-01",
        propertiesPath: inputs.propertiesPath,
        manifestPath: null,
        checkpointsPath: inputs.checkpointsPath,
        jurisdictionKeys: ["hollywood"],
      },
    );
    expect(initial.tasks[0]).toMatchObject({
      runClass: "initial-bounded-backfill",
      window: {
        fromDate: "2026-01-01",
        throughDate: "2026-09-09",
        checkpointThroughDate: null,
      },
    });
    expect(initial.approval.initialBackfillApprovalRequired).toBe(true);
    await expect(
      executePermitBackfillPlan({
        rawPlan: initial,
        approvedPlanDigest: initial.planDigest,
        profile: browardPermitProfile,
        propertiesPath: inputs.propertiesPath,
        checkpointsPath: inputs.checkpointsPath,
        state: {},
      }),
    ).rejects.toThrow("--approve-initial-backfill");

    const checkpointed = await deltaInputs(directory, definition);
    const delta = await createPermitBackfillPlan(
      browardPermitProfile,
      {
        mode: "delta",
        throughDate: "2026-09-09",
        initialFromDate: null,
        propertiesPath: checkpointed.propertiesPath,
        manifestPath: null,
        checkpointsPath: checkpointed.checkpointsPath,
        jurisdictionKeys: ["hollywood"],
      },
    );
    expect(delta.tasks[0]).toMatchObject({
      runClass: "delta",
      window: {
        fromDate: "2026-09-07",
        throughDate: "2026-09-09",
        checkpointThroughDate: "2026-09-08",
      },
    });
  });

  it("rejects input bytes changed after plan approval", async () => {
    const directory = await temporaryDirectory();
    const { plan, propertiesPath, checkpointsPath } =
      await createDeltaPlan(directory, ["hollywood"]);
    await writeFile(propertiesPath, `${JSON.stringify(property(2))}\n`);
    const state = new DurablePermitBackfillState({
      outputDir: path.join(directory, "run"),
      ownerId: "tamper-test",
    });
    await state.acquire();
    try {
      await expect(
        executePermitBackfillPlan({
          rawPlan: plan,
          approvedPlanDigest: plan.planDigest,
          profile: browardPermitProfile,
          propertiesPath,
          checkpointsPath,
          state,
        }),
      ).rejects.toThrow("does not match the plan digest");
    } finally {
      await state.release();
    }
  });

  it("selects failed and stale repair candidates but preserves blockers", async () => {
    const directory = await temporaryDirectory();
    const manifestPath = path.join(directory, "repair.jsonl");
    await writeJsonl(manifestPath, [
      repairCandidate({ index: 1, status: "done" }),
      repairCandidate({ index: 2, status: "failed" }),
      repairCandidate({ index: 3, status: "blocked" }),
      repairCandidate({
        index: 4,
        status: "done",
        detailComplete: false,
      }),
      repairCandidate({
        index: 5,
        status: "done",
        detailFingerprintVersion: "accela-broward-v0",
      }),
    ]);
    const plan = await createPermitBackfillPlan(
      browardPermitProfile,
      {
        mode: "repair",
        throughDate: null,
        initialFromDate: null,
        propertiesPath: null,
        manifestPath,
        checkpointsPath: null,
        jurisdictionKeys: ["hollywood"],
      },
    );
    expect(plan.tasks[0].repairSelection).toMatchObject({
      candidateCount: 3,
      reasons: {
        failed: 1,
        "summary-only": 1,
        "stale-detail-fingerprint": 1,
      },
    });
  });

  it("executes only candidates selected from the approved repair manifest", async () => {
    const directory = await temporaryDirectory();
    const manifestPath = path.join(directory, "repair.jsonl");
    await writeJsonl(manifestPath, [
      repairCandidate({ index: 1, status: "done" }),
      repairCandidate({ index: 2, status: "failed" }),
      repairCandidate({ index: 3, status: "blocked" }),
    ]);
    const plan = await createPermitBackfillPlan(
      browardPermitProfile,
      {
        mode: "repair",
        throughDate: null,
        initialFromDate: null,
        propertiesPath: null,
        manifestPath,
        checkpointsPath: null,
        jurisdictionKeys: ["hollywood"],
      },
    );
    const state = new DurablePermitBackfillState({
      outputDir: path.join(directory, "run"),
      ownerId: "repair-test",
    });
    await state.acquire();
    const selected = [];
    try {
      const summary = await executePermitBackfillPlan({
        rawPlan: plan,
        approvedPlanDigest: plan.planDigest,
        profile: browardPermitProfile,
        manifestPath,
        state,
        adapterFactory: () => ({
          async searchParcel(parcelIdentifier) {
            selected.push(parcelIdentifier);
            return [];
          },
          async fetchPermitDetail() {
            throw new Error("No references expected");
          },
        }),
      });
      expect(summary.status).toBe("complete");
      expect(selected).toEqual(["514111160002"]);
    } finally {
      await state.release();
    }
  });
});

describe("durable resume and source routing", () => {
  it("resumes only matching complete work and retries failed or stale detail", () => {
    const expected = {
      completionFingerprint: "completion",
      sourceFingerprint: "source",
      requireDetailCompletion: true,
    };
    expect(
      resumableReceiptDecision(
        {
          status: "done",
          completionFingerprint: "completion",
          sourceFingerprint: "source",
          detailComplete: true,
        },
        expected,
      ),
    ).toBe("completed");
    expect(
      resumableReceiptDecision(
        {
          status: "failed",
          completionFingerprint: "completion",
          sourceFingerprint: "source",
          detailComplete: false,
        },
        expected,
      ),
    ).toBe("retry");
    expect(
      resumableReceiptDecision(
        {
          status: "done",
          completionFingerprint: "completion",
          sourceFingerprint: "source",
          detailComplete: false,
        },
        expected,
      ),
    ).toBe("retry");
    expect(
      resumableReceiptDecision(
        {
          status: "blocked",
          completionFingerprint: "old",
          sourceFingerprint: "source",
          detailComplete: false,
        },
        expected,
      ),
    ).toBe("blocked");
  });

  it("routes all 20 automatable sources and excludes all 17 blockers", async () => {
    const directory = await temporaryDirectory();
    const { plan, propertiesPath, checkpointsPath } =
      await createDeltaPlan(directory);
    const state = new DurablePermitBackfillState({
      outputDir: path.join(directory, "run"),
      ownerId: "route-test",
    });
    await state.acquire();
    const routed = [];
    const consumedWindows = [];
    try {
      const summary = await executePermitBackfillPlan({
        rawPlan: plan,
        approvedPlanDigest: plan.planDigest,
        profile: browardPermitProfile,
        propertiesPath,
        checkpointsPath,
        state,
        adapterFactory(jurisdiction, source) {
          routed.push(`${jurisdiction.key}/${source.key}`);
          if (source.adapterKey === "arcgis-feature-service") {
            return {
              async enumerateAll() {
                return {
                  status: "complete",
                  sourceCount: 0,
                  receivedCount: 0,
                  pageCount: 0,
                  resumedPageCount: 0,
                  snapshotSha256: "b".repeat(64),
                  where: "1=1",
                };
              },
            };
          }
          return {
            async searchParcel(_parcelIdentifier, request) {
              consumedWindows.push({
                jurisdictionKey: jurisdiction.key,
                fromDate: request.fromDate,
                throughDate: request.throughDate,
              });
              return [];
            },
            async fetchPermitDetail() {
              throw new Error("No references expected");
            },
          };
        },
      });
      expect(routed).toHaveLength(20);
      expect(new Set(routed).size).toBe(20);
      expect(summary.excludedBlockedSourceCount).toBe(17);
      expect(
        routed.some((value) => value.endsWith("/official-arcgis-bulk")),
      ).toBe(true);
      expect(
        routed.some((value) => value.endsWith("/hced-arcgis-bulk")),
      ).toBe(true);
      expect(consumedWindows).toContainEqual({
        jurisdictionKey: "hollywood",
        fromDate: "2026-09-07",
        throughDate: "2026-09-09",
      });
      const blocked = new Set(
        plan.excludedSources.map(
          (source) =>
            `${source.jurisdictionKey}/${source.sourceKey}`,
        ),
      );
      expect(routed.every((value) => !blocked.has(value))).toBe(true);
    } finally {
      await state.release();
    }
  });

  it("retries a failed receipt on an idempotent rerun", async () => {
    const directory = await temporaryDirectory();
    const { plan, propertiesPath, checkpointsPath } =
      await createDeltaPlan(directory, ["hollywood"]);
    const state = new DurablePermitBackfillState({
      outputDir: path.join(directory, "run"),
      ownerId: "retry-test",
    });
    await state.acquire();
    let attempts = 0;
    const adapterFactory = () => ({
      async searchParcel() {
        attempts += 1;
        if (attempts === 1) throw new Error("transient timeout");
        return [];
      },
      async fetchPermitDetail() {
        throw new Error("No references expected");
      },
    });
    try {
      const failed = await executePermitBackfillPlan({
        rawPlan: plan,
        approvedPlanDigest: plan.planDigest,
        profile: browardPermitProfile,
        propertiesPath,
        checkpointsPath,
        state,
        adapterFactory,
      });
      expect(failed.status).toBe("failed");
      const completed = await executePermitBackfillPlan({
        rawPlan: plan,
        approvedPlanDigest: plan.planDigest,
        profile: browardPermitProfile,
        propertiesPath,
        checkpointsPath,
        state,
        adapterFactory,
      });
      expect(completed.status).toBe("complete");
      expect(attempts).toBe(2);
    } finally {
      await state.release();
    }
  });

  it("fences expired writers and deduplicates stable permit IDs", async () => {
    const directory = await temporaryDirectory();
    let now = Date.parse("2026-09-09T00:00:00.000Z");
    const first = new DurablePermitBackfillState({
      outputDir: directory,
      ownerId: "writer-one",
      leaseMs: 1_000,
      clock: () => now,
    });
    await first.acquire();
    now += 1_001;
    const second = new DurablePermitBackfillState({
      outputDir: directory,
      ownerId: "writer-two",
      leaseMs: 1_000,
      clock: () => now,
    });
    const takeover = await second.acquire();
    expect(takeover.fencingToken).toBe(2);
    await expect(
      first.commitArtifact("stale.json", { unsafe: true }),
    ).rejects.toThrow("stale or expired");

    const record = {
      property_improvement_id: "c".repeat(32),
      countyKey: "broward",
      jurisdictionKey: "hollywood",
      sourceRecordId: "BLD-1",
    };
    expect(
      (await second.commitRecord(record, "d".repeat(64))).duplicate,
    ).toBe(false);
    expect(
      (await second.commitRecord(record, "d".repeat(64))).duplicate,
    ).toBe(true);
    expect(await second.recordCount()).toBe(1);
    await second.release();
  });
});

function fortLauderdaleArcgis(ids, { drift = false, shortPage = false } = {}) {
  const jurisdiction = browardPermitProfile.jurisdictions.find(
    (candidate) => candidate.key === "fort-lauderdale",
  );
  const route = jurisdiction.adapterRoutes.find(
    (candidate) => candidate.key === "official-arcgis",
  );
  let idSnapshotCalls = 0;
  let activePages = 0;
  let maxActivePages = 0;
  const client = {
    async json(urlValue) {
      const url = new URL(urlValue);
      if (url.searchParams.get("returnCountOnly") === "true") {
        return { body: { count: ids.length } };
      }
      if (url.searchParams.get("returnIdsOnly") === "true") {
        idSnapshotCalls += 1;
        const objectIds =
          drift && idSnapshotCalls > 1
            ? [...ids.slice(0, -1), ids.at(-1) + 1]
            : ids;
        return { body: { objectIds } };
      }
      const requested = url.searchParams
        .get("objectIds")
        .split(",")
        .map(Number);
      activePages += 1;
      maxActivePages = Math.max(maxActivePages, activePages);
      await new Promise((resolve) => setTimeout(resolve, 1));
      activePages -= 1;
      const pageIds = shortPage ? requested.slice(0, -1) : requested;
      return {
        body: {
          exceededTransferLimit: false,
          features: pageIds.map((objectId) => ({
            attributes: {
              OBJECTID: objectId,
              PERMITID: `BLD-${objectId}`,
              PERMITTYPE: "BUILDING",
              PERMITSTAT: "ISSUED",
              PERMITDESC: "TEST",
              FULLADDR: `${objectId} TEST STREET`,
              PARCELID: "504200000420",
              APPROVEDT: Date.parse("2026-09-08T00:00:00.000Z"),
            },
          })),
        },
      };
    },
  };
  return {
    adapter: createArcgisFeatureServiceAdapter(
      {
        ...jurisdiction,
        adapterKey: route.adapterKey,
        adapterConfig: route.adapterConfig,
      },
      { client },
    ),
    maxActivePages: () => maxActivePages,
  };
}

describe("ArcGIS complete enumeration", () => {
  it("paginates beyond 2,000 with bounded concurrency and reconciliation", async () => {
    const ids = Array.from({ length: 2_505 }, (_, index) => index + 1);
    const fixture = fortLauderdaleArcgis(ids);
    const pages = [];
    const result = await fixture.adapter.enumerateAll({
      fromDate: "2026-09-01",
      throughDate: "2026-09-09",
      pageConcurrency: 2,
      onPage: async (page) => pages.push(page),
    });
    expect(result).toMatchObject({
      status: "complete",
      sourceCount: 2_505,
      receivedCount: 2_505,
      pageCount: 3,
    });
    expect(pages.map((page) => page.receivedCount)).toEqual([
      1_000, 1_000, 505,
    ]);
    expect(fixture.maxActivePages()).toBeLessThanOrEqual(2);
    expect(result.where).toContain("APPROVEDT >= DATE '2026-09-01'");
  });

  it("resumes matching page checkpoints without duplicating pages", async () => {
    const ids = Array.from({ length: 2_005 }, (_, index) => index + 1);
    const fixture = fortLauderdaleArcgis(ids);
    const processed = [];
    const result = await fixture.adapter.enumerateAll({
      pageConcurrency: 1,
      loadPageCheckpoint: async (page) =>
        page.pageKey === "page-000001"
          ? {
              status: "complete",
              snapshotSha256: page.snapshotSha256,
              objectIdsSha256: page.objectIdsSha256,
              receivedCount: 1_000,
            }
          : null,
      onPage: async (page) => processed.push(page.pageKey),
    });
    expect(result.resumedPageCount).toBe(1);
    expect(result.receivedCount).toBe(2_005);
    expect(processed).toEqual(["page-000002", "page-000003"]);
  });

  it("fails closed on source drift or page reconciliation loss", async () => {
    const ids = Array.from({ length: 2_005 }, (_, index) => index + 1);
    await expect(
      fortLauderdaleArcgis(ids, { drift: true }).adapter.enumerateAll(),
    ).rejects.toMatchObject({ code: "arcgis_source_drift" });
    await expect(
      fortLauderdaleArcgis(ids, {
        shortPage: true,
      }).adapter.enumerateAll(),
    ).rejects.toMatchObject({
      code: "arcgis_page_reconciliation_failed",
    });
  });
});
