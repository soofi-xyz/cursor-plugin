import { mkdir } from "node:fs/promises";

import { createPermitAdapter } from "./adapters/index.mjs";
import {
  normalizedPermitRecordSchema,
  parcelPermitStatusSchema,
  permitFailureSchema,
} from "./contracts.mjs";
import { classifyPermitError, PermitSourceError } from "./errors.mjs";
import {
  normalizeDuvalParcelIdentifier,
  routePermitJurisdiction,
} from "./normalization.mjs";
import {
  artifactPaths,
  atomicWriteJson,
  readJson,
} from "./storage.mjs";

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

function propertyInput(row) {
  return {
    propertyId: row.property_id ?? row.propertyId ?? null,
    parcelIdentifier:
      row.parcel_identifier ?? row.parcelIdentifier ?? null,
    city: row.address_city ?? row.city ?? null,
  };
}

function statusForFailure(classification) {
  if (classification === "blocked") return "blocked";
  if (classification === "unrouted") return "unrouted";
  return "failed";
}

async function readCompletedStatus(filePath) {
  try {
    return parcelPermitStatusSchema.parse(await readJson(filePath));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function processProperty({
  row,
  profile,
  outputDir,
  jobId,
  adapterOptions,
  resume,
  clock,
}) {
  const input = propertyInput(row);
  let parcelIdentifier;
  let jurisdiction;
  try {
    parcelIdentifier = normalizeDuvalParcelIdentifier(
      input.parcelIdentifier,
    );
    jurisdiction = routePermitJurisdiction(profile, input.city);
  } catch (error) {
    const classified = classifyPermitError(error);
    jurisdiction =
      routePermitJurisdiction(profile, input.city) ??
      profile.jurisdictions.find(
        (candidate) => candidate.defaultForUnmatchedCity,
      );
    parcelIdentifier =
      String(input.parcelIdentifier ?? "").trim() || "missing";
    const paths = artifactPaths(
      outputDir,
      jurisdiction.key,
      parcelIdentifier,
    );
    const failure = permitFailureSchema.parse({
      parcelIdentifier,
      propertyId: input.propertyId,
      jurisdictionKey: jurisdiction.key,
      classification: "unrouted",
      errorCode: classified.code,
      message: classified.message,
      attempts: 1,
      nextAttemptAt: null,
      observedAt: nowIso(clock),
    });
    const status = parcelPermitStatusSchema.parse({
      countyKey: profile.countyKey,
      jobId,
      parcelIdentifier,
      propertyId: input.propertyId,
      jurisdictionKey: jurisdiction.key,
      status: "unrouted",
      permitCount: 0,
      failureCount: 1,
      attempts: 1,
      completedAt: nowIso(clock),
    });
    await Promise.all([
      atomicWriteJson(paths.raw, { references: [], failures: [failure] }),
      atomicWriteJson(paths.extracted, { records: [] }),
      atomicWriteJson(paths.status, status),
    ]);
    return { status, records: [], failures: [failure], resumed: false };
  }

  const paths = artifactPaths(
    outputDir,
    jurisdiction.key,
    parcelIdentifier,
  );
  if (resume) {
    const completed = await readCompletedStatus(paths.status);
    if (completed) {
      const extracted = await readJson(paths.extracted);
      return {
        status: completed,
        records: (extracted.records ?? []).map((record) =>
          normalizedPermitRecordSchema.parse(record),
        ),
        failures: [],
        resumed: true,
      };
    }
  }

  if (jurisdiction.status !== "supported") {
    const classification =
      jurisdiction.status === "unavailable" ? "blocked" : jurisdiction.status;
    const error = new PermitSourceError(
      `${jurisdiction.name} permit source is ${jurisdiction.status}`,
      {
        classification,
        code:
          jurisdiction.status === "unavailable"
            ? "no_public_historical_search"
            : "source_not_harvestable",
      },
    );
    const failure = permitFailureSchema.parse({
      parcelIdentifier,
      propertyId: input.propertyId,
      jurisdictionKey: jurisdiction.key,
      classification: "blocked",
      errorCode: error.code,
      message: error.message,
      attempts: 1,
      nextAttemptAt: null,
      observedAt: nowIso(clock),
    });
    const status = parcelPermitStatusSchema.parse({
      countyKey: profile.countyKey,
      jobId,
      parcelIdentifier,
      propertyId: input.propertyId,
      jurisdictionKey: jurisdiction.key,
      status: "blocked",
      permitCount: 0,
      failureCount: 1,
      attempts: 1,
      completedAt: nowIso(clock),
    });
    await Promise.all([
      atomicWriteJson(paths.raw, {
        references: [],
        failures: [failure],
        sourceStatus: jurisdiction.status,
      }),
      atomicWriteJson(paths.extracted, { records: [] }),
      atomicWriteJson(paths.status, status),
    ]);
    return { status, records: [], failures: [failure], resumed: false };
  }

  const adapter = createPermitAdapter(jurisdiction, adapterOptions);
  const failures = [];
  const records = [];
  let references = [];
  try {
    references = [
      ...new Map(
        (await adapter.searchParcel(parcelIdentifier)).map(
          (reference) => [reference.sourceRecordId, reference],
        ),
      ).values(),
    ];
    const ids = new Set();
    for (const reference of references) {
      try {
        const record = await adapter.fetchPermitDetail(reference, {
          requestedParcelIdentifier: parcelIdentifier,
          requestedPropertyId: input.propertyId,
        });
        if (!ids.has(record.property_improvement_id)) {
          ids.add(record.property_improvement_id);
          records.push(normalizedPermitRecordSchema.parse(record));
        }
      } catch (error) {
        const classified = classifyPermitError(error);
        failures.push(
          permitFailureSchema.parse({
            parcelIdentifier,
            propertyId: input.propertyId,
            jurisdictionKey: jurisdiction.key,
            classification: classified.classification,
            errorCode: classified.code,
            message: classified.message,
            attempts: adapterOptions.maxAttempts ?? 3,
            nextAttemptAt: null,
            observedAt: nowIso(clock),
          }),
        );
      }
    }
  } catch (error) {
    const classified = classifyPermitError(error);
    failures.push(
      permitFailureSchema.parse({
        parcelIdentifier,
        propertyId: input.propertyId,
        jurisdictionKey: jurisdiction.key,
        classification: classified.classification,
        errorCode: classified.code,
        message: classified.message,
        attempts: adapterOptions.maxAttempts ?? 3,
        nextAttemptAt: null,
        observedAt: nowIso(clock),
      }),
    );
  }

  const terminalClassification = failures[0]?.classification;
  const status = parcelPermitStatusSchema.parse({
    countyKey: profile.countyKey,
    jobId,
    parcelIdentifier,
    propertyId: input.propertyId,
    jurisdictionKey: jurisdiction.key,
    status:
      failures.length === 0
        ? "done"
        : statusForFailure(terminalClassification),
    permitCount: records.length,
    failureCount: failures.length,
    attempts: adapterOptions.maxAttempts ?? 3,
    completedAt: nowIso(clock),
  });
  await Promise.all([
    atomicWriteJson(paths.raw, {
      references,
      sourcePayloads: records.map((record) => record.sourcePayload),
      failures,
    }),
    atomicWriteJson(paths.extracted, { records }),
    atomicWriteJson(paths.status, status),
  ]);
  return { status, records, failures, resumed: false };
}

async function mapConcurrent(values, concurrency, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, Math.max(values.length, 1)) },
      () => worker(),
    ),
  );
  return results;
}

export async function harvestPermitProperties({
  properties,
  profile,
  outputDir,
  jobId,
  concurrency = 1,
  resume = false,
  adapterOptions = {},
  clock = Date.now,
}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error("Permit harvest concurrency must be between 1 and 8");
  }
  await mkdir(outputDir, { recursive: true });
  const results = await mapConcurrent(properties, concurrency, (row) =>
    processProperty({
      row,
      profile,
      outputDir,
      jobId,
      adapterOptions,
      resume,
      clock,
    }),
  );
  const uniqueRecords = new Map();
  for (const result of results) {
    for (const record of result.records) {
      const existing = uniqueRecords.get(record.property_improvement_id);
      if (
        existing &&
        (existing.property_id !== record.property_id ||
          existing.parcel_identifier !== record.parcel_identifier)
      ) {
        throw new Error(
          `Permit ${record.property_improvement_id} linked to multiple properties`,
        );
      }
      uniqueRecords.set(record.property_improvement_id, record);
    }
  }
  const summary = {
    schemaVersion: "elephant.permit-harvest-summary.v1",
    countyKey: profile.countyKey,
    jobId,
    completedAt: nowIso(clock),
    propertyCount: properties.length,
    resumedCount: results.filter((result) => result.resumed).length,
    doneCount: results.filter((result) => result.status.status === "done")
      .length,
    blockedCount: results.filter(
      (result) => result.status.status === "blocked",
    ).length,
    failedCount: results.filter(
      (result) => result.status.status === "failed",
    ).length,
    unroutedCount: results.filter(
      (result) => result.status.status === "unrouted",
    ).length,
    permitCount: uniqueRecords.size,
    failureCount: results.reduce(
      (sum, result) => sum + result.failures.length,
      0,
    ),
  };
  await atomicWriteJson(`${outputDir}/harvest-summary.json`, summary);
  return { summary, results, records: [...uniqueRecords.values()] };
}

export async function probePermitSources({ profile, adapterOptions = {} }) {
  const results = [];
  for (const jurisdiction of profile.jurisdictions) {
    const adapter = createPermitAdapter(jurisdiction, adapterOptions);
    if (!adapter) {
      results.push({
        jurisdictionKey: jurisdiction.key,
        adapterKey: null,
        profileStatus: jurisdiction.status,
        probeStatus: "not_configured",
      });
      continue;
    }
    try {
      const probe = await adapter.probe();
      results.push({
        jurisdictionKey: jurisdiction.key,
        adapterKey: adapter.key,
        profileStatus: jurisdiction.status,
        probeStatus: probe.status,
      });
    } catch (error) {
      const classified = classifyPermitError(error);
      results.push({
        jurisdictionKey: jurisdiction.key,
        adapterKey: adapter.key,
        profileStatus: jurisdiction.status,
        probeStatus: classified.classification,
        errorCode: classified.code,
        message: classified.message,
      });
    }
  }
  return results;
}
