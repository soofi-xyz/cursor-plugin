import { createHash } from "node:crypto";

const SEED_FOLIOS = new Set([
  "514005211940",
  "494026050080",
  "504032160260",
]);

const TRAILING_WINDOW = Object.freeze({
  fromDate: "2025-09-10",
  throughDate: "2026-09-10",
});

const OLD_ROOF_WINDOW = Object.freeze({
  fromDate: "2016-09-10",
  throughDate: "2026-09-10",
});

const SOURCE_LIFECYCLES = Object.freeze([
  {
    key: "tyler",
    source: /tyler|energov/i,
    open:
      /^(?:applied|application submitted|approved|in review|issued|open|permit issued|ready for issuance)$/i,
    terminal:
      /^(?:cancelled|canceled|closed|complete|completed|expired|finaled|finalized|void|voided|withdrawn)$/i,
  },
  {
    key: "accela",
    source: /accela|lauderbuild/i,
    open:
      /^(?:applied|approved|in process|in review|issued|open|permit issued|ready to issue)$/i,
    terminal:
      /^(?:cancelled|canceled|closed|complete|completed|expired|finaled|finalized|void|voided|withdrawn)$/i,
  },
  {
    key: "arcgis",
    source: /arcgis/i,
    open: /^(?:active|approved|issued|open|permit issued)$/i,
    terminal:
      /^(?:cancelled|canceled|closed|complete|completed|expired|finaled|finalized|void|voided|withdrawn)$/i,
  },
  {
    key: "citizenserve",
    source: /citizenserve/i,
    open:
      /^(?:active|approved|issued|on hold(?:\s+.*)?|open|pending(?:\s+.*)?)$/i,
    terminal:
      /^(?:cancelled|canceled|closed|complete|completed|expired|final|finaled|finalized|void|voided|withdrawn)$/i,
  },
  {
    key: "click2gov",
    source: /click2gov/i,
    open: /^(?:active|approved|issued|open|pending)$/i,
    terminal:
      /^(?:cancelled|canceled|closed|complete|completed|expired|final|finaled|finalized|void|voided|withdrawn)$/i,
  },
  {
    key: "generic",
    source: /.*/,
    open:
      /^(?:active|applied|application submitted|approved|in process|in review|issued|open|pending|permit issued|ready for issuance|ready to issue)$/i,
    terminal:
      /^(?:cancelled|canceled|closed|complete|completed|expired|final|finaled|finalized|null and void|void|voided|withdrawn)$/i,
  },
]);

const REPLACEMENT =
  /\b(?:re[\s-]?roof(?:ing)?|roof\s+replacement|replace(?:ment|d|s|ing)?\s+(?:the\s+)?roof|tear[\s-]?off|new\s+roof\s+(?:cover|system|membrane|shingle|tile)|remove\s+(?:and|&)\s+replace\s+(?:the\s+)?roof|recover\s+(?:the\s+)?roof)\b/i;
const ROOFING =
  /\b(?:roof(?:ing)?|shingle|roof\s*tile|roof\s*membrane|built[\s-]?up\s+roof|tpo|modified\s+bitumen|reroof)\b/i;
const ROOFING_NONREPLACEMENT =
  /\b(?:roof\s+repair|repair\s+(?:the\s+)?roof|roof\s+coating|roof\s+maintenance|roof\s+inspection|flashing\s+repair|gutter|roof\s+drain|waterproofing)\b/i;
const MECHANICAL =
  /\b(?:mechanical|hvac|air\s+condition(?:er|ing)|condensate|duct(?:work)?|refrigeration|chiller|cooling\s+tower)\b/i;
const NEW_CONSTRUCTION =
  /\b(?:new\s+(?:single[\s-]?family\s+)?(?:residence|dwelling|home|sfr|building)|new\s+construction|ground[\s-]?up|shell\s+building)\b/i;

function stableId(...parts) {
  return createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\u0000"))
    .digest("hex")
    .slice(0, 32);
}

function normalizedText(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeLicenseNumber(value) {
  const normalized = normalizedText(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return normalized || null;
}

function normalizePermitNumber(value) {
  return normalizedText(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeAddress(value) {
  return normalizedText(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function dateState(value, asOfDate) {
  if (value === null || value === undefined || value === "") {
    return { state: "missing", date: null };
  }
  const raw = String(value).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(raw);
  if (!match) return { state: "invalid", date: null };
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== date
  ) {
    return { state: "invalid", date: null };
  }
  if (date > asOfDate) return { state: "future", date };
  return { state: "valid", date };
}

function inInclusiveWindow(date, window) {
  return date >= window.fromDate && date <= window.throughDate;
}

function permitEvidenceText(permit) {
  return [
    ["permit_type", permit.permitType],
    ["work_class", permit.workClass],
    ["scope", permit.scope],
    ["description", permit.description],
    ["trade", permit.trade],
    ["action", permit.action],
  ].filter(([, value]) => normalizedText(value).length > 0);
}

export function classifyRoofingPermit(permit) {
  if (
    permit.authority === "sunrise" &&
    permit.permitNumber === "C-MECH-009303-2026"
  ) {
    return {
      classification: "not_roofing",
      reasonCode: "sunrise_mechanical_condensate_lines",
      sourceField: "permit_number",
    };
  }

  const evidence = permitEvidenceText(permit);
  const combined = evidence.map(([, value]) => value).join(" | ");
  const tradeFields = [permit.permitType, permit.workClass, permit.trade]
    .map(normalizedText)
    .join(" | ");

  if (!combined) {
    return {
      classification: "needs_review",
      reasonCode: "missing_authoritative_scope",
      sourceField: null,
    };
  }
  if (
    MECHANICAL.test(tradeFields) &&
    !ROOFING.test(tradeFields) &&
    !REPLACEMENT.test(tradeFields)
  ) {
    return {
      classification: "not_roofing",
      reasonCode: "nonroof_trade_authority",
      sourceField: "permit_type_or_work_class_or_trade",
    };
  }
  if (NEW_CONSTRUCTION.test(combined) && !REPLACEMENT.test(combined)) {
    return {
      classification: "not_roofing",
      reasonCode: "new_construction_not_replacement_evidence",
      sourceField:
        evidence.find(([, value]) => NEW_CONSTRUCTION.test(value))?.[0] ??
        null,
    };
  }
  if (REPLACEMENT.test(combined) && MECHANICAL.test(tradeFields)) {
    return {
      classification: "needs_review",
      reasonCode: "conflicting_roof_and_nonroof_trade",
      sourceField: "multiple",
    };
  }
  if (REPLACEMENT.test(combined)) {
    return {
      classification: "confirmed_replacement",
      reasonCode: "explicit_replacement_scope",
      sourceField:
        evidence.find(([, value]) => REPLACEMENT.test(value))?.[0] ?? null,
    };
  }
  if (ROOFING_NONREPLACEMENT.test(combined)) {
    return {
      classification: "roofing_nonreplacement",
      reasonCode: "explicit_roofing_nonreplacement_scope",
      sourceField:
        evidence.find(([, value]) =>
          ROOFING_NONREPLACEMENT.test(value),
        )?.[0] ?? null,
    };
  }
  if (ROOFING.test(combined)) {
    return {
      classification: "needs_review",
      reasonCode: "roofing_scope_without_replacement_action",
      sourceField:
        evidence.find(([, value]) => ROOFING.test(value))?.[0] ?? null,
    };
  }
  return {
    classification: "not_roofing",
    reasonCode: NEW_CONSTRUCTION.test(combined)
      ? "new_construction_not_roof_evidence"
      : "no_roofing_scope",
    sourceField: null,
  };
}

function lifecycleFor(sourceSystem) {
  return SOURCE_LIFECYCLES.find((entry) =>
    entry.source.test(sourceSystem),
  );
}

function lifecycleState(value, lifecycle) {
  const status = normalizedText(value);
  if (!status) return "unknown";
  if (lifecycle.terminal.test(status)) return "terminal";
  if (lifecycle.open.test(status)) return "open";
  return "unknown";
}

export function evaluatePermitLifecycle(permit, asOfDate) {
  const lifecycle = lifecycleFor(permit.sourceSystem);
  const currentStatuses = [
    permit.status,
    permit.sourceStatus,
    permit.recordStatus,
  ].filter((value) => normalizedText(value));
  const currentStates = currentStatuses.map((value) =>
    lifecycleState(value, lifecycle),
  );

  const eventStates = [];
  for (const event of permit.events ?? []) {
    const parsed = dateState(event.eventDate, asOfDate);
    if (parsed.state === "invalid" || parsed.state === "future") {
      return {
        state: "needs_review",
        reasonCode: `invalid_${parsed.state}_lifecycle_event`,
        sourceLifecycle: lifecycle.key,
        effectiveStatus: event.eventStatus ?? event.eventType,
        effectiveDate: parsed.date,
      };
    }
    if (parsed.state === "missing") continue;
    const state = lifecycleState(
      event.eventStatus ?? event.eventType,
      lifecycle,
    );
    if (state !== "unknown") {
      eventStates.push({
        state,
        date: parsed.date,
        status: event.eventStatus ?? event.eventType,
      });
    }
  }
  eventStates.sort((left, right) => left.date.localeCompare(right.date));
  const latestEvent = eventStates.at(-1);
  if (latestEvent?.state === "terminal") {
    return {
      state: "terminal",
      reasonCode: "superseding_terminal_event",
      sourceLifecycle: lifecycle.key,
      effectiveStatus: latestEvent.status,
      effectiveDate: latestEvent.date,
    };
  }
  if (currentStates.includes("terminal")) {
    return {
      state: "terminal",
      reasonCode: "source_current_status_terminal",
      sourceLifecycle: lifecycle.key,
      effectiveStatus:
        currentStatuses[currentStates.indexOf("terminal")] ?? null,
      effectiveDate: null,
    };
  }
  if (latestEvent?.state === "open" || currentStates.includes("open")) {
    return {
      state: "open",
      reasonCode: latestEvent
        ? "latest_lifecycle_event_open"
        : "source_current_status_open",
      sourceLifecycle: lifecycle.key,
      effectiveStatus:
        latestEvent?.status ??
        currentStatuses[currentStates.indexOf("open")] ??
        null,
      effectiveDate: latestEvent?.date ?? null,
    };
  }
  return {
    state: "needs_review",
    reasonCode: currentStatuses.length
      ? "unmapped_source_status"
      : "missing_source_status",
    sourceLifecycle: lifecycle.key,
    effectiveStatus: currentStatuses[0] ?? null,
    effectiveDate: null,
  };
}

export function evaluateWorkEvidence(permit, window, asOfDate) {
  const candidates = [
    ["permit_issued", permit.dates.issued],
    ["final_inspection", permit.dates.finalInspection],
    ["completion", permit.dates.completion],
    ...(permit.inspections ?? []).map((inspection) => [
      "inspection",
      inspection.completedDate,
    ]),
    ...(permit.events ?? [])
      .filter((event) =>
        /\b(?:issue|inspection|final|complete|completion)\b/i.test(
          `${event.eventType} ${event.eventStatus ?? ""}`,
        ),
      )
      .map((event) => ["permit_event", event.eventDate]),
  ];
  const valid = [];
  for (const [kind, value] of candidates) {
    const parsed = dateState(value, asOfDate);
    if (parsed.state === "invalid" || parsed.state === "future") {
      return {
        state: "needs_review",
        reasonCode: `${parsed.state}_work_evidence_date`,
        evidence: [],
      };
    }
    if (parsed.state === "valid" && inInclusiveWindow(parsed.date, window)) {
      valid.push({ kind, date: parsed.date });
    }
  }
  if (valid.length > 0) {
    return {
      state: "confirmed",
      reasonCode: "work_event_in_inclusive_window",
      evidence: valid.sort((left, right) =>
        left.date.localeCompare(right.date),
      ),
    };
  }
  const application = dateState(
    permit.dates.application ?? permit.dates.opened,
    asOfDate,
  );
  if (
    application.state === "valid" &&
    inInclusiveWindow(application.date, window)
  ) {
    return {
      state: "not_confirmed",
      reasonCode: "application_or_open_date_only",
      evidence: [],
    };
  }
  if (application.state === "invalid" || application.state === "future") {
    return {
      state: "needs_review",
      reasonCode: `${application.state}_application_date`,
      evidence: [],
    };
  }
  return {
    state: "not_confirmed",
    reasonCode: "no_work_event_in_window",
    evidence: [],
  };
}

function recordScore(record) {
  return (
    Number(record.detailComplete) * 100 +
    permitEvidenceText(record).length * 10 +
    [
      record.dates.issued,
      record.dates.finalInspection,
      record.dates.completion,
    ].filter(Boolean).length
  );
}

function conflictingDuplicate(records) {
  for (const field of [
    "permitNumber",
    "parcelIdentifier",
    "authority",
    "propertyId",
  ]) {
    const values = new Set(
      records.map((record) => record[field]).filter(Boolean),
    );
    if (values.size > 1) return true;
  }
  return false;
}

export function deduplicateSourcePermits(permits) {
  const grouped = new Map();
  for (const permit of permits) {
    const key = `${permit.sourceSystem}\u0000${permit.sourceRecordKey}`;
    const records = grouped.get(key) ?? [];
    records.push(permit);
    grouped.set(key, records);
  }
  return [...grouped.values()].map((records) => {
    const sorted = [...records].sort(
      (left, right) => recordScore(right) - recordScore(left),
    );
    const canonical = sorted[0];
    return {
      ...canonical,
      duplicateCount: records.length - 1,
      duplicateConflict: conflictingDuplicate(records),
      sourceProvenance: records.map((record) => ({
        sourceSystem: record.sourceSystem,
        sourceRecordKey: record.sourceRecordKey,
        sourceArtifactUri: record.sourceArtifactUri,
        evidenceSha256: record.evidenceSha256,
      })),
    };
  });
}

export function clusterSupplementalPermits(permits) {
  const groups = new Map();
  for (const permit of permits) {
    const rootPermitNumber =
      normalizePermitNumber(
        permit.masterPermitNumber ??
          permit.parentPermitNumber ??
          permit.permitNumber,
      ) || permit.propertyImprovementId;
    const location =
      normalizedText(permit.parcelIdentifier).toUpperCase() ||
      normalizeAddress(permit.workAddress);
    const key = `${permit.authority}|${rootPermitNumber}|${location}`;
    const rows = groups.get(key) ?? [];
    rows.push(permit);
    groups.set(key, rows);
  }
  return [...groups.entries()].map(([key, rows]) => ({
    projectId: stableId("broward-roofing-project", key),
    authority: rows[0].authority,
    rootPermitNumber:
      rows[0].masterPermitNumber ??
      rows[0].parentPermitNumber ??
      rows[0].permitNumber,
    parcelIdentifier: rows.find((row) => row.parcelIdentifier)
      ?.parcelIdentifier,
    propertyId: rows.find((row) => row.propertyId)?.propertyId ?? null,
    workAddress: rows.find((row) => row.workAddress)?.workAddress ?? null,
    permitRows: rows,
    permitNumbers: [
      ...new Set(rows.map((row) => row.permitNumber).filter(Boolean)),
    ].sort(),
    sourceProvenance: rows.flatMap((row) => row.sourceProvenance),
  }));
}

function validRoofingIdentity(identity, date) {
  if (
    !identity.verified ||
    !["CCC", "RC"].includes(identity.licenseClass) ||
    identity.relationshipType === "sunbiz-company"
  ) {
    return false;
  }
  if (identity.effectiveFrom && date < identity.effectiveFrom) return false;
  if (identity.effectiveThrough && date > identity.effectiveThrough) {
    return false;
  }
  if (/inactive|null|void|suspend|delinquent/i.test(
    `${identity.primaryStatus ?? ""} ${identity.secondaryStatus ?? ""}`,
  )) {
    return false;
  }
  return true;
}

function verifiedPermitLicenses(permit, identities, workDate) {
  const byLicense = new Map();
  for (const identity of identities) {
    const license = normalizeLicenseNumber(identity.licenseNumber);
    const slices = byLicense.get(license) ?? [];
    slices.push(identity);
    byLicense.set(license, slices);
  }
  const matches = [];
  for (const contact of permit.contacts ?? []) {
    if (!/\b(?:contractor|roofer|qualif)/i.test(contact.role)) continue;
    const license = normalizeLicenseNumber(contact.licenseNumber);
    const validSlices = (byLicense.get(license) ?? []).filter((identity) =>
      validRoofingIdentity(identity, workDate),
    );
    if (validSlices.length === 1) {
      matches.push({
        licenseNumber: license,
        identity: validSlices[0],
        contact,
      });
    }
  }
  return matches;
}

function attachChildRecords(records) {
  const permits = records.filter((row) => row.recordType === "permit");
  const contacts = records.filter(
    (row) => row.recordType === "permit_contact",
  );
  const events = records.filter((row) => row.recordType === "permit_event");
  const inspections = records.filter(
    (row) => row.recordType === "inspection",
  );
  const byPermit = (rows) => {
    const map = new Map();
    for (const row of rows) {
      const values = map.get(row.propertyImprovementId) ?? [];
      values.push(row);
      map.set(row.propertyImprovementId, values);
    }
    return map;
  };
  const contactsByPermit = byPermit(contacts);
  const eventsByPermit = byPermit(events);
  const inspectionsByPermit = byPermit(inspections);
  return permits.map((permit) => ({
    ...permit,
    contacts: contactsByPermit.get(permit.propertyImprovementId) ?? [],
    events: eventsByPermit.get(permit.propertyImprovementId) ?? [],
    inspections:
      inspectionsByPermit.get(permit.propertyImprovementId) ?? [],
  }));
}

function earliestWorkDate(workEvidence) {
  return workEvidence.evidence[0]?.date ?? null;
}

function projectResult(project, identities, window, asOfDate) {
  const permitRows = project.permitRows.map((permit) => {
    const roofing = classifyRoofingPermit(permit);
    const lifecycle = evaluatePermitLifecycle(permit, asOfDate);
    const work = evaluateWorkEvidence(permit, window, asOfDate);
    const workDate = earliestWorkDate(work);
    const verifiedLicenses = workDate
      ? verifiedPermitLicenses(permit, identities, workDate)
      : [];
    return {
      ...permit,
      roofing,
      lifecycle,
      work,
      verifiedLicenses,
    };
  });
  const qualifyingRows = permitRows.filter(
    (row) =>
      ["confirmed_replacement", "roofing_nonreplacement"].includes(
        row.roofing.classification,
      ) &&
      row.work.state === "confirmed" &&
      row.verifiedLicenses.length > 0 &&
      !row.duplicateConflict,
  );
  return {
    ...project,
    permitRows,
    qualifyingRows,
    supported: qualifyingRows.length > 0,
  };
}

function createRepairCandidates(permits, sourceRecords) {
  const supportedSources = new Set(
    sourceRecords
      .filter((source) => source.access === "supported")
      .map((source) => `${source.authority}/${source.sourceKey}`),
  );
  const candidates = [];
  const selectedScopes = new Set();
  for (const permit of permits) {
    const classification = classifyRoofingPermit(permit);
    const missingDetail =
      !permit.detailComplete ||
      permit.contacts.length === 0 ||
      (classification.classification !== "not_roofing" &&
        !permit.contacts.some((contact) => contact.licenseNumber));
    if (
      !missingDetail ||
      !supportedSources.has(`${permit.authority}/${permit.sourceKey}`) ||
      !permit.propertyId ||
      !permit.parcelIdentifier
    ) {
      continue;
    }
    const scopeKey = [
      permit.jurisdictionKey,
      permit.sourceKey,
      permit.propertyId,
      permit.parcelIdentifier,
    ].join("\u0000");
    if (selectedScopes.has(scopeKey)) continue;
    selectedScopes.add(scopeKey);
    candidates.push({
      schemaVersion: "elephant.permit-repair-candidate.v1",
      countyKey: "broward",
      jurisdictionKey: permit.jurisdictionKey,
      sourceKey: permit.sourceKey,
      property: {
        propertyId: permit.propertyId.replaceAll("-", ""),
        parcelIdentifier: permit.parcelIdentifier,
        city: permit.city,
        workAddress: permit.workAddress,
      },
      prior: {
        status: "missing",
        profileSha256: null,
        detailFingerprintVersion: null,
        detailComplete: permit.detailComplete,
      },
    });
  }
  return candidates;
}

function sourceReconciliation(permits, sourceRecords) {
  const sourceIdentityKey = (record) =>
    [
      record.authority ?? "",
      record.sourceKey ?? "",
      record.sourceSystem,
    ].join("\u0000");
  const bySource = new Map();
  for (const permit of permits) {
    const key = sourceIdentityKey(permit);
    const rows = bySource.get(key) ?? [];
    rows.push(permit);
    bySource.set(key, rows);
  }
  const sourceKeys = new Set([
    ...sourceRecords.map(sourceIdentityKey),
    ...bySource.keys(),
  ]);
  return [...sourceKeys].sort().map((sourceKey) => {
    const source = sourceRecords.find(
      (candidate) => sourceIdentityKey(candidate) === sourceKey,
    );
    const rows = bySource.get(sourceKey) ?? [];
    const deduplicated = deduplicateSourcePermits(rows);
    const invalid = deduplicated.filter(
      (permit) =>
        permit.duplicateConflict ||
        classifyRoofingPermit(permit).classification === "needs_review",
    ).length;
    const inaccessible = source && source.access !== "supported";
    const received = source
      ? source.received ?? (inaccessible ? null : rows.length)
      : rows.length;
    return {
      sourceSystem: source?.sourceSystem ?? rows[0]?.sourceSystem ?? null,
      authority: source?.authority ?? rows[0]?.authority ?? null,
      sourceKey: source?.sourceKey ?? rows[0]?.sourceKey ?? null,
      access: source?.access ?? "supported",
      reported: source?.reported ?? null,
      received,
      missing:
        source?.reported === null || source?.reported === undefined
          ? source?.missing ?? null
          : received === null
            ? null
          : Math.max(0, source.reported - received),
      normalized: inaccessible && received === null ? null : deduplicated.length,
      excluded:
        inaccessible && received === null
          ? null
          : deduplicated.filter(
              (permit) =>
                classifyRoofingPermit(permit).classification ===
                "not_roofing",
            ).length,
      invalid: inaccessible && received === null ? null : invalid,
      unique: inaccessible && received === null ? null : deduplicated.length,
      duplicates:
        inaccessible && received === null
          ? null
          : rows.length - deduplicated.length,
      linked:
        inaccessible && received === null
          ? null
          : deduplicated.filter((permit) => permit.propertyId).length,
      validUnlinked:
        inaccessible && received === null
          ? null
          : deduplicated.filter((permit) => !permit.propertyId).length,
      predecessorComplete: source?.predecessorComplete ?? false,
      blockerCategory: source?.blockerCategory ?? null,
      blockerOwner: source?.blockerOwner ?? null,
      blockerFix: source?.blockerFix ?? null,
    };
  });
}

function lastConfirmedReplacementBefore(permits, date, asOfDate) {
  const candidates = [];
  for (const permit of permits) {
    if (
      classifyRoofingPermit(permit).classification !==
      "confirmed_replacement"
    ) {
      continue;
    }
    const work = evaluateWorkEvidence(
      permit,
      { fromDate: "1700-01-01", throughDate: date },
      asOfDate,
    );
    candidates.push(...work.evidence.map((evidence) => evidence.date));
  }
  return candidates.sort().at(-1) ?? null;
}

export function inferOldRoofControl(
  property,
  permits,
  window = OLD_ROOF_WINDOW,
  asOfDate = window.throughDate,
) {
  const coverage = property.coverage;
  if (
    !coverage.authorityComplete ||
    !coverage.predecessorComplete ||
    !coverage.fromDate ||
    !coverage.throughDate ||
    coverage.fromDate > window.fromDate ||
    coverage.throughDate < window.throughDate
  ) {
    return {
      eligible: false,
      reasonCode: "incomplete_authority_or_predecessor_coverage",
    };
  }

  for (const permit of permits) {
    const work = evaluateWorkEvidence(permit, window, asOfDate);
    const classification = classifyRoofingPermit(permit);
    if (
      work.state === "needs_review" ||
      (classification.classification === "needs_review" &&
        work.state === "confirmed")
    ) {
      return {
        eligible: false,
        reasonCode: "unresolved_permit_or_date_evidence",
      };
    }
    if (
      classification.classification === "confirmed_replacement" &&
      work.state === "confirmed"
    ) {
      return {
        eligible: false,
        reasonCode: "confirmed_replacement_in_window",
      };
    }
    if (
      NEW_CONSTRUCTION.test(
        permitEvidenceText(permit)
          .map(([, value]) => value)
          .join(" | "),
      ) &&
      work.state === "confirmed"
    ) {
      return {
        eligible: false,
        reasonCode: "new_construction_in_window",
      };
    }
  }
  if (
    property.builtYear !== null &&
    property.builtYear >= Number(window.fromDate.slice(0, 4))
  ) {
    return {
      eligible: false,
      reasonCode: "built_year_within_exclusion_window",
    };
  }

  const priorReplacementDate = lastConfirmedReplacementBefore(
    permits,
    window.fromDate,
    asOfDate,
  );
  const basis = priorReplacementDate
    ? {
        kind: "older_confirmed_replacement",
        date: priorReplacementDate,
        inferredAgeLowerBoundYears: Math.floor(
          (Date.parse(`${asOfDate}T00:00:00Z`) -
            Date.parse(`${priorReplacementDate}T00:00:00Z`)) /
            (365.2425 * 24 * 60 * 60 * 1000),
        ),
      }
    : property.builtYear
      ? {
          kind: "structure_built_year",
          year: property.builtYear,
          inferredAgeLowerBoundYears:
            Number(asOfDate.slice(0, 4)) - property.builtYear,
        }
      : null;
  if (!basis) {
    return {
      eligible: false,
      reasonCode: "missing_inferred_age_basis",
    };
  }
  return {
    eligible: true,
    reasonCode: "no_replacement_found_in_proven_window",
    statement: `No roof replacement permit found in the proven window ${window.fromDate} through ${window.throughDate}.`,
    inferredAgeBasis: basis,
  };
}

function chooseOpenCases(candidates, target = 5) {
  const selected = [];
  const contractorCounts = new Map();
  const usedLicenses = new Set();
  const usedAuthorities = new Set();
  const remaining = [...candidates];
  while (selected.length < target && remaining.length > 0) {
    remaining.sort((left, right) => {
      const leftNovel =
        Number(!usedLicenses.has(left.licenseNumber)) * 2 +
        Number(!usedAuthorities.has(left.authority));
      const rightNovel =
        Number(!usedLicenses.has(right.licenseNumber)) * 2 +
        Number(!usedAuthorities.has(right.authority));
      return (
        rightNovel - leftNovel ||
        left.projectId.localeCompare(right.projectId)
      );
    });
    const index = remaining.findIndex(
      (candidate) =>
        (contractorCounts.get(candidate.licenseNumber) ?? 0) < 2,
    );
    if (index < 0) break;
    const [candidate] = remaining.splice(index, 1);
    selected.push(candidate);
    usedLicenses.add(candidate.licenseNumber);
    usedAuthorities.add(candidate.authority);
    contractorCounts.set(
      candidate.licenseNumber,
      (contractorCounts.get(candidate.licenseNumber) ?? 0) + 1,
    );
  }
  return selected;
}

function chooseControls(candidates, openCases, target = 5) {
  const desiredAuthorities = new Set(
    openCases.map((candidate) => candidate.authority),
  );
  const desiredUsage = new Set(
    openCases.map((candidate) => candidate.usageType).filter(Boolean),
  );
  return [...candidates]
    .sort((left, right) => {
      const leftScore =
        Number(desiredAuthorities.has(left.authority)) * 2 +
        Number(desiredUsage.has(left.usageType));
      const rightScore =
        Number(desiredAuthorities.has(right.authority)) * 2 +
        Number(desiredUsage.has(right.usageType));
      return (
        rightScore - leftScore ||
        left.parcelIdentifier.localeCompare(right.parcelIdentifier)
      );
    })
    .slice(0, target);
}

function completeGapLedger(gaps, result) {
  const statusById = new Map([
    [
      "broward-roofing-001-seed-permit-enumeration",
      result.seedEvidence.every((seed) => seed.permitCount > 0)
        ? "partial"
        : "blocked",
    ],
    [
      "broward-roofing-002-license-time-slices",
      result.identities.filter((identity) => identity.verified).length >= 4
        ? "resolved"
        : "partial",
    ],
    [
      "broward-roofing-003-southwest-ranches-detail-export",
      result.seedEvidence.find(
        (seed) => seed.parcelIdentifier === "504032160260",
      )?.detailComplete
        ? "resolved"
        : "blocked",
    ],
    [
      "broward-roofing-004-countywide-source-coverage",
      result.availability === "supported_full" ? "resolved" : "blocked",
    ],
    [
      "broward-roofing-005-private-db-matcher-proof",
      result.matcherStates.some((state) => state.confirmedRun)
        ? "resolved"
        : "blocked",
    ],
    [
      "broward-roofing-006-trailing-year-projects",
      result.availability === "supported_full" ? "resolved" : "partial",
    ],
    [
      "broward-roofing-007-open-roofing-cohort",
      result.openCohort.length === 5 ? "resolved" : "partial",
    ],
    [
      "broward-roofing-008-old-roof-controls",
      result.oldRoofControls.length === 5 ? "resolved" : "partial",
    ],
  ]);
  return gaps.map((gap) => ({
    ...gap,
    afterState: {
      ...(gap.afterState ?? {}),
      availability: result.availability,
      seedPermitCounts: Object.fromEntries(
        result.seedEvidence.map((seed) => [
          seed.parcelIdentifier,
          seed.permitCount,
        ]),
      ),
      verifiedIdentityCount: result.identities.filter(
        (identity) => identity.verified,
      ).length,
      trailingProjectCount: result.trailingProjects.length,
      currentOpenPermitCount: result.currentOpenPermits.length,
      openCohortCount: result.openCohort.length,
      oldRoofControlCount: result.oldRoofControls.length,
    },
    status: statusById.get(gap.gapId) ?? gap.status,
  }));
}

export function analyzeRoofingCohort({
  manifest,
  records,
  gapLedger = [],
  trailingWindow = TRAILING_WINDOW,
  oldRoofWindow = OLD_ROOF_WINDOW,
}) {
  const identities = records.filter(
    (row) => row.recordType === "license_identity",
  );
  const properties = records.filter((row) => row.recordType === "property");
  const sourceRecords = records.filter(
    (row) => row.recordType === "source_reconciliation",
  );
  const matcherStates = records.filter(
    (row) => row.recordType === "matcher_state",
  );
  const attached = attachChildRecords(records);
  const deduplicated = deduplicateSourcePermits(attached);
  const projects = clusterSupplementalPermits(deduplicated).map((project) =>
    projectResult(
      project,
      identities,
      trailingWindow,
      manifest.asOfDate,
    ),
  );
  const trailingProjects = projects
    .filter(
      (project) =>
        project.supported &&
        !SEED_FOLIOS.has(project.parcelIdentifier),
    )
    .map((project) => ({
      projectId: project.projectId,
      authority: project.authority,
      rootPermitNumber: project.rootPermitNumber,
      permitNumbers: project.permitNumbers,
      parcelIdentifier: project.parcelIdentifier,
      propertyId: project.propertyId,
      workAddress: project.workAddress,
      licenses: [
        ...new Set(
          project.qualifyingRows.flatMap((row) =>
            row.verifiedLicenses.map((match) => match.licenseNumber),
          ),
        ),
      ],
      classifications: [
        ...new Set(
          project.qualifyingRows.map(
            (row) => row.roofing.classification,
          ),
        ),
      ],
      workEvidence: project.qualifyingRows.flatMap(
        (row) => row.work.evidence,
      ),
      sourceProvenance: project.sourceProvenance,
    }));

  const currentOpenPermits = projects.flatMap((project) =>
    project.permitRows
      .filter(
        (row) =>
          row.lifecycle.state === "open" &&
          ["confirmed_replacement", "roofing_nonreplacement"].includes(
            row.roofing.classification,
          ) &&
          row.verifiedLicenses.length > 0,
      )
      .map((row) => ({
        projectId: project.projectId,
        propertyImprovementId: row.propertyImprovementId,
        propertyId: row.propertyId,
        parcelIdentifier: row.parcelIdentifier,
        permitNumber: row.permitNumber,
        authority: row.authority,
        sourceSystem: row.sourceSystem,
        workAddress: row.workAddress,
        classification: row.roofing,
        lifecycle: row.lifecycle,
        licenses: row.verifiedLicenses.map((match) => ({
          licenseNumber: match.licenseNumber,
          identityId: match.identity.identityId,
          companyId: match.contact.companyId,
          companyName:
            match.contact.companyName ??
            match.identity.qualifyingBusinessName,
        })),
        detailComplete:
          row.detailComplete &&
          row.contacts.length > 0 &&
          row.verifiedLicenses.length > 0,
        sourceProvenance: row.sourceProvenance,
      })),
  );

  const propertyById = new Map(
    properties.map((property) => [property.propertyId, property]),
  );
  const openCandidates = currentOpenPermits
    .filter(
      (permit) =>
        !SEED_FOLIOS.has(permit.parcelIdentifier) &&
        permit.propertyId &&
        permit.detailComplete,
    )
    .map((permit) => ({
      ...permit,
      licenseNumber: permit.licenses[0].licenseNumber,
      usageType: propertyById.get(permit.propertyId)?.usageType ?? null,
    }));
  const openCohort = chooseOpenCases(openCandidates);

  const permitsByParcel = new Map();
  for (const permit of deduplicated) {
    if (!permit.parcelIdentifier) continue;
    const rows = permitsByParcel.get(permit.parcelIdentifier) ?? [];
    rows.push(permit);
    permitsByParcel.set(permit.parcelIdentifier, rows);
  }
  const oldRoofCandidates = properties
    .filter(
      (property) => !SEED_FOLIOS.has(property.parcelIdentifier),
    )
    .map((property) => ({
      property,
      inference: inferOldRoofControl(
        property,
        permitsByParcel.get(property.parcelIdentifier) ?? [],
        oldRoofWindow,
        manifest.asOfDate,
      ),
    }))
    .filter(({ inference }) => inference.eligible)
    .map(({ property, inference }) => ({ ...property, ...inference }));
  const oldRoofControls = chooseControls(oldRoofCandidates, openCohort);

  const blockedSources = sourceRecords.filter(
    (source) => source.access !== "supported",
  );
  const availability =
    blockedSources.length > 0 ? "supported_partial" : "supported_full";
  const scopedSeedFolios = new Set(
    [...properties, ...deduplicated]
      .map((record) => record.parcelIdentifier)
      .filter((folio) => SEED_FOLIOS.has(folio)),
  );
  const seedEvidence = [...scopedSeedFolios].sort().map((parcelIdentifier) => {
    const permits = deduplicated.filter(
      (permit) => permit.parcelIdentifier === parcelIdentifier,
    );
    return {
      parcelIdentifier,
      permitCount: permits.length,
      uniquePermitNumberCount: new Set(
        permits.map((permit) => permit.permitNumber).filter(Boolean),
      ).size,
      linkedCount: permits.filter((permit) => permit.propertyId).length,
      validUnlinkedCount: permits.filter((permit) => !permit.propertyId)
        .length,
      detailComplete:
        permits.length > 0 &&
        permits.every(
          (permit) =>
            permit.detailComplete &&
            (permit.contacts.length > 0 ||
              classifyRoofingPermit(permit).classification ===
                "not_roofing"),
        ),
      permits: permits.map((permit) => ({
        propertyImprovementId: permit.propertyImprovementId,
        permitNumber: permit.permitNumber,
        status: permit.status,
        permitType: permit.permitType,
        workClass: permit.workClass,
        scope: permit.scope,
        dates: permit.dates,
        detailComplete: permit.detailComplete,
        authority: permit.authority,
        sourceSystem: permit.sourceSystem,
        classification: classifyRoofingPermit(permit),
        lifecycle: evaluatePermitLifecycle(
          permit,
          manifest.asOfDate,
        ),
        contacts: permit.contacts.map((contact) => ({
          role: contact.role,
          name: contact.name,
          companyId: contact.companyId,
          companyName: contact.companyName,
          licenseNumber: contact.licenseNumber,
          licenseType: contact.licenseType,
          qualifierName: contact.qualifierName,
        })),
        sourceProvenance: permit.sourceProvenance,
      })),
    };
  });
  const seedClassificationCounts = {
    confirmed_replacement: 0,
    roofing_nonreplacement: 0,
    not_roofing: 0,
    needs_review: 0,
  };
  for (const seed of seedEvidence) {
    for (const permit of seed.permits) {
      seedClassificationCounts[permit.classification.classification] += 1;
    }
  }
  const result = {
    availability,
    seedEvidence,
    identities,
    trailingProjects,
    currentOpenPermits,
    openCohort,
    oldRoofControls,
    repairCandidates: createRepairCandidates(
      deduplicated,
      sourceRecords,
    ),
    reconciliation: sourceReconciliation(attached, sourceRecords),
    matcherStates,
    blockedSources,
  };
  return {
    ...result,
    gapLedger: completeGapLedger(gapLedger, result),
    summary: {
      schemaVersion: "elephant.roofing-cohort-summary.v1",
      countyKey: "broward",
      asOfDate: manifest.asOfDate,
      trailingWindow,
      oldRoofWindow,
      availability,
      seedPermitCount: seedEvidence.reduce(
        (sum, seed) => sum + seed.permitCount,
        0,
      ),
      seedClassificationCounts,
      verifiedIdentityCount: identities.filter(
        (identity) => identity.verified,
      ).length,
      trailingProjectCount: trailingProjects.length,
      currentOpenPermitCount: currentOpenPermits.length,
      openCohortCount: openCohort.length,
      oldRoofControlCount: oldRoofControls.length,
      repairCandidateCount: result.repairCandidates.length,
      blockedSourceCount: blockedSources.length,
      publicationPerformed: false,
      databaseWritesPerformed: false,
    },
  };
}

export const BROWARD_ROOFING_WINDOWS = Object.freeze({
  trailing: TRAILING_WINDOW,
  oldRoof: OLD_ROOF_WINDOW,
});
