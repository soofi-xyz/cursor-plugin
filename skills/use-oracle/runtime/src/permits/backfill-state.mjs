import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { sha256Json } from "./backfill-inputs.mjs";

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWriteJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
  await rename(temporaryPath, filePath);
}

function safeSegment(value, label) {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)
  ) {
    throw new Error(`${label} contains unsafe path characters`);
  }
  return value;
}

export class DurablePermitBackfillState {
  constructor({
    outputDir,
    ownerId,
    leaseMs = 120_000,
    guardStaleMs = 30_000,
    clock = Date.now,
  }) {
    this.outputDir = outputDir;
    this.ownerId = safeSegment(ownerId, "Lease owner");
    this.leaseMs = leaseMs;
    this.guardStaleMs = guardStaleMs;
    this.clock = clock;
    this.controlDir = path.join(outputDir, "_control");
    this.guardDir = path.join(this.controlDir, "lease-guard");
    this.leasePath = path.join(this.controlDir, "lease.json");
    this.fencingToken = null;
  }

  async withGuard(operation) {
    await mkdir(this.controlDir, { recursive: true });
    let guardOwned = false;
    for (let attempt = 0; attempt < 3 && !guardOwned; attempt += 1) {
      try {
        await mkdir(this.guardDir);
        guardOwned = true;
        await writeFile(
          path.join(this.guardDir, "owner.json"),
          `${JSON.stringify({
            ownerId: this.ownerId,
            acquiredAt: new Date(this.clock()).toISOString(),
          })}\n`,
          "utf8",
        );
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const details = await stat(this.guardDir).catch(() => null);
        if (
          details &&
          Date.now() - details.mtimeMs <= this.guardStaleMs
        ) {
          throw new Error("Permit backfill lease guard is held by another writer");
        }
        const stalePath = `${this.guardDir}.stale-${randomUUID()}`;
        try {
          await rename(this.guardDir, stalePath);
          await rm(stalePath, { recursive: true, force: true });
        } catch (renameError) {
          if (!["ENOENT", "EEXIST"].includes(renameError?.code)) {
            throw renameError;
          }
        }
      }
    }
    if (!guardOwned) {
      throw new Error("Could not acquire permit backfill lease guard");
    }
    try {
      return await operation();
    } finally {
      await rm(this.guardDir, { recursive: true, force: true });
    }
  }

  async acquire() {
    return this.withGuard(async () => {
      const now = this.clock();
      const existing = await readJsonIfExists(this.leasePath);
      if (
        existing?.ownerId &&
        existing.ownerId !== this.ownerId &&
        Date.parse(existing.expiresAt) > now
      ) {
        throw new Error(
          `Permit backfill lease is held by ${existing.ownerId} until ${existing.expiresAt}`,
        );
      }
      const fencingToken = (existing?.fencingToken ?? 0) + 1;
      const lease = {
        schemaVersion: "elephant.permit-backfill-lease.v1",
        ownerId: this.ownerId,
        fencingToken,
        acquiredAt: new Date(now).toISOString(),
        expiresAt: new Date(now + this.leaseMs).toISOString(),
        releasedAt: null,
      };
      await atomicWriteJson(this.leasePath, lease);
      this.fencingToken = fencingToken;
      return lease;
    });
  }

  async assertLeaseInsideGuard() {
    if (!Number.isInteger(this.fencingToken)) {
      throw new Error("Permit backfill writer has not acquired a lease");
    }
    const lease = await readJsonIfExists(this.leasePath);
    const now = this.clock();
    if (
      lease?.ownerId !== this.ownerId ||
      lease?.fencingToken !== this.fencingToken ||
      Date.parse(lease.expiresAt) <= now
    ) {
      throw new Error("Permit backfill fencing token is stale or expired");
    }
    return lease;
  }

  async fencedCommit(operation, { renew = true } = {}) {
    return this.withGuard(async () => {
      const lease = await this.assertLeaseInsideGuard();
      const result = await operation(lease);
      if (renew) {
        await atomicWriteJson(this.leasePath, {
          ...lease,
          expiresAt: new Date(this.clock() + this.leaseMs).toISOString(),
        });
      }
      return result;
    });
  }

  async renew() {
    return this.fencedCommit((lease) => lease);
  }

  async release() {
    if (!Number.isInteger(this.fencingToken)) return;
    await this.withGuard(async () => {
      const lease = await this.assertLeaseInsideGuard();
      await atomicWriteJson(this.leasePath, {
        ...lease,
        ownerId: null,
        expiresAt: new Date(this.clock()).toISOString(),
        releasedAt: new Date(this.clock()).toISOString(),
      });
    });
    this.fencingToken = null;
  }

  async bindPlan(plan) {
    return this.fencedCommit(async () => {
      const filePath = path.join(this.controlDir, "approved-plan.json");
      const existing = await readJsonIfExists(filePath);
      if (existing && existing.planDigest !== plan.planDigest) {
        throw new Error(
          "Output directory is already bound to a different approved plan",
        );
      }
      if (!existing) await atomicWriteJson(filePath, plan);
      return existing ?? plan;
    });
  }

  workPath(taskId, candidateKey) {
    return path.join(
      this.outputDir,
      "_ledger",
      "work",
      safeSegment(taskId, "Task ID"),
      `${sha256Json(candidateKey).slice(0, 40)}.json`,
    );
  }

  async readWork(taskId, candidateKey) {
    return readJsonIfExists(this.workPath(taskId, candidateKey));
  }

  async commitWork(taskId, candidateKey, receipt) {
    return this.fencedCommit(async (lease) => {
      const value = {
        schemaVersion: "elephant.permit-backfill-work-receipt.v1",
        taskId,
        candidateKey,
        fencingToken: lease.fencingToken,
        ...receipt,
      };
      await atomicWriteJson(this.workPath(taskId, candidateKey), value);
      return value;
    });
  }

  async commitRecord(record, executionFingerprint) {
    return (await this.commitRecords([record], executionFingerprint))[0];
  }

  async commitRecords(records, executionFingerprint) {
    return this.fencedCommit(async (lease) => {
      const results = [];
      for (const record of records) {
        const recordId = safeSegment(
          record.property_improvement_id,
          "Stable permit ID",
        );
        const filePath = path.join(
          this.outputDir,
          "_ledger",
          "records",
          `${recordId}.json`,
        );
        const existing = await readJsonIfExists(filePath);
        if (
          existing &&
          (existing.record.countyKey !== record.countyKey ||
            existing.record.jurisdictionKey !== record.jurisdictionKey ||
            existing.record.sourceRecordId !== record.sourceRecordId)
        ) {
          throw new Error(
            `Stable permit ID collision for ${record.property_improvement_id}`,
          );
        }
        const recordSha256 = sha256Json(record);
        if (
          existing?.recordSha256 === recordSha256 &&
          existing?.executionFingerprint === executionFingerprint
        ) {
          results.push({ receipt: existing, duplicate: true });
          continue;
        }
        const receipt = {
          schemaVersion: "elephant.permit-backfill-record-receipt.v1",
          stablePermitId: record.property_improvement_id,
          recordSha256,
          executionFingerprint,
          fencingToken: lease.fencingToken,
          record,
        };
        await atomicWriteJson(filePath, receipt);
        results.push({ receipt, duplicate: Boolean(existing) });
      }
      return results;
    });
  }

  checkpointPath(taskId, pageKey) {
    return path.join(
      this.outputDir,
      "_checkpoints",
      safeSegment(taskId, "Task ID"),
      `${safeSegment(pageKey, "Checkpoint key")}.json`,
    );
  }

  async readCheckpoint(taskId, pageKey) {
    return readJsonIfExists(this.checkpointPath(taskId, pageKey));
  }

  async commitCheckpoint(taskId, pageKey, checkpoint) {
    return this.fencedCommit(async (lease) => {
      const value = {
        schemaVersion: "elephant.permit-backfill-checkpoint.v1",
        taskId,
        pageKey,
        fencingToken: lease.fencingToken,
        ...checkpoint,
      };
      await atomicWriteJson(this.checkpointPath(taskId, pageKey), value);
      return value;
    });
  }

  async commitSummary(summary) {
    return this.fencedCommit(async (lease) => {
      const value = { ...summary, fencingToken: lease.fencingToken };
      await atomicWriteJson(
        path.join(this.outputDir, "backfill-summary.json"),
        value,
      );
      return value;
    });
  }

  async commitArtifact(relativePath, value) {
    if (
      typeof relativePath !== "string" ||
      path.isAbsolute(relativePath) ||
      relativePath.split(/[\\/]/).includes("..")
    ) {
      throw new Error("Backfill artifact path must stay inside the output directory");
    }
    return this.fencedCommit(async () => {
      await atomicWriteJson(path.join(this.outputDir, relativePath), value);
      return value;
    });
  }

  async recordCount() {
    try {
      return (
        await readdir(path.join(this.outputDir, "_ledger", "records"))
      ).filter((name) => name.endsWith(".json")).length;
    } catch (error) {
      if (error?.code === "ENOENT") return 0;
      throw error;
    }
  }
}
