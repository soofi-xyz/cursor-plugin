import { createHash } from "node:crypto";

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
  const authoritativeRoofingField = [
    ["permit_type", permit.permitType],
    ["work_class", permit.workClass],
    ["trade", permit.trade],
  ].find(([, value]) => ROOFING.test(normalizedText(value)));
  if (authoritativeRoofingField) {
    return {
      classification: "confirmed_roofing",
      reasonCode: "authoritative_roofing_type_or_work_class",
      sourceField: authoritativeRoofingField[0],
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
  const terminalDates = [
    permit.dates.finalInspection,
    permit.dates.completion,
    permit.dates.closed,
  ].map((value) => dateState(value, asOfDate));
  if (
    terminalDates.some(
      (candidate) =>
        candidate.state === "invalid" || candidate.state === "future",
    ) &&
    !currentStates.includes("terminal")
  ) {
    return {
      state: "needs_review",
      reasonCode: "invalid_or_future_terminal_date",
      sourceLifecycle: lifecycle.key,
      effectiveStatus: currentStatuses[0] ?? null,
      effectiveDate:
        terminalDates.find((candidate) => candidate.date)?.date ?? null,
    };
  }
  const completedDate = terminalDates
    .filter((candidate) => candidate.state === "valid")
    .map((candidate) => candidate.date)
    .sort()
    .at(-1);
  if (completedDate && currentStates.includes("open")) {
    return {
      state: "needs_review",
      reasonCode: "open_status_conflicts_with_terminal_date",
      sourceLifecycle: lifecycle.key,
      effectiveStatus: currentStatuses.join(" | "),
      effectiveDate: completedDate,
    };
  }
  if (completedDate) {
    return {
      state: "terminal",
      reasonCode: "terminal_completion_date",
      sourceLifecycle: lifecycle.key,
      effectiveStatus: currentStatuses[0] ?? null,
      effectiveDate: completedDate,
    };
  }
  if (
    currentStates.includes("open") &&
    currentStates.includes("terminal")
  ) {
    return {
      state: "needs_review",
      reasonCode: "conflicting_current_statuses",
      sourceLifecycle: lifecycle.key,
      effectiveStatus: currentStatuses.join(" | "),
      effectiveDate: null,
    };
  }
  if (
    currentStates.includes("open") &&
    currentStates.includes("unknown")
  ) {
    return {
      state: "needs_review",
      reasonCode: "open_status_conflicts_with_unmapped_status",
      sourceLifecycle: lifecycle.key,
      effectiveStatus: currentStatuses.join(" | "),
      effectiveDate: null,
    };
  }
  const expiration = dateState(permit.dates.expiration, asOfDate);
  if (expiration.state === "invalid") {
    return {
      state: "needs_review",
      reasonCode: "invalid_expiration_date",
      sourceLifecycle: lifecycle.key,
      effectiveStatus: currentStatuses[0] ?? null,
      effectiveDate: null,
    };
  }
  if (expiration.state === "valid") {
    return {
      state: "terminal",
      reasonCode: "expired_by_date",
      sourceLifecycle: lifecycle.key,
      effectiveStatus: "Expired",
      effectiveDate: expiration.date,
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
      [
        "confirmed_replacement",
        "confirmed_roofing",
        "roofing_nonreplacement",
      ].includes(
        row.roofing.classification,
      ) &&
      row.work.state === "confirmed" &&
      row.lifecycle.state === "terminal" &&
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
    const assignment = evaluateContractorAssignment(permit);
    const missingDetail =
      assignment.classification === "contractor_unknown" ||
      (classification.classification !== "not_roofing" &&
        permit.contacts.some((contact) =>
          /\b(?:contractor|roofer|qualif|licensed[\s-]?professional)\b/i.test(
            contact.role,
          ),
        ) &&
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
    const received = source ? source.received : rows.length;
    const unobserved = received === null;
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
      normalized: unobserved ? null : deduplicated.length,
      excluded:
        unobserved
          ? null
          : deduplicated.filter(
              (permit) =>
                classifyRoofingPermit(permit).classification ===
                "not_roofing",
            ).length,
      invalid: unobserved ? null : invalid,
      unique: unobserved ? null : deduplicated.length,
      duplicates:
        unobserved
          ? null
          : rows.length - deduplicated.length,
      linked:
        unobserved
          ? null
          : deduplicated.filter((permit) => permit.propertyId).length,
      validUnlinked:
        unobserved
          ? null
          : deduplicated.filter((permit) => !permit.propertyId).length,
      predecessorComplete: source?.predecessorComplete ?? false,
      blockerCategory: source?.blockerCategory ?? null,
      blockerOwner: source?.blockerOwner ?? null,
      blockerFix: source?.blockerFix ?? null,
    };
  });
}

const CONFIDENCE_RANK = Object.freeze({
  low: 1,
  medium: 2,
  high: 3,
});

function lowerConfidence(confidence) {
  if (confidence === "high") return "medium";
  return "low";
}

function ageYears(anchorDate, asOfDate) {
  return Math.floor(
    (Date.parse(`${asOfDate}T00:00:00Z`) -
      Date.parse(`${anchorDate}T00:00:00Z`)) /
      (365.2425 * 24 * 60 * 60 * 1000),
  );
}

function datedAnchorCandidates(permit, asOfDate) {
  const raw = [
    ["completion", permit.dates.completion],
    ["final_inspection", permit.dates.finalInspection],
    ["close", permit.dates.closed],
    ...(permit.inspections ?? [])
      .filter((inspection) =>
        /\b(?:final|complete|approved|pass)\b/i.test(
          `${inspection.inspectionType ?? ""} ${inspection.status ?? ""} ${inspection.result ?? ""}`,
        ),
      )
      .map((inspection) => [
        "final_inspection_event",
        inspection.completedDate,
      ]),
    ...(permit.events ?? [])
      .filter((event) =>
        /\b(?:final|complete|close)\b/i.test(
          `${event.eventType ?? ""} ${event.eventStatus ?? ""}`,
        ),
      )
      .map((event) => ["terminal_permit_event", event.eventDate]),
  ];
  const valid = [];
  const dateGaps = [];
  for (const [kind, value] of raw) {
    const parsed = dateState(value, asOfDate);
    if (parsed.state === "valid") valid.push({ kind, date: parsed.date });
    if (parsed.state === "invalid" || parsed.state === "future") {
      dateGaps.push(`${kind}_${parsed.state}`);
    }
  }
  return {
    valid: valid.sort((left, right) => left.date.localeCompare(right.date)),
    dateGaps,
  };
}

function terminalPermitAnchor(permit, asOfDate, kind) {
  const lifecycle = evaluatePermitLifecycle(permit, asOfDate);
  if (lifecycle.state !== "terminal") {
    return { anchor: null, lifecycle, unresolved: lifecycle.state !== "open" };
  }
  const { valid, dateGaps } = datedAnchorCandidates(permit, asOfDate);
  if (valid.length > 0) {
    const earliest = valid[0].date;
    const latest = valid.at(-1).date;
    const conflict =
      Date.parse(`${latest}T00:00:00Z`) -
        Date.parse(`${earliest}T00:00:00Z`) >
      90 * 24 * 60 * 60 * 1000;
    return {
      lifecycle,
      unresolved: false,
      anchor: {
        date: latest,
        range: { fromDate: earliest, throughDate: latest },
        confidence:
          kind === "closed_replacement" && !conflict && dateGaps.length === 0
            ? "high"
            : kind === "new_construction"
              ? "medium"
              : "medium",
        basis: {
          kind,
          permitNumber: permit.permitNumber,
          sourceSystem: permit.sourceSystem,
          dateKind: valid.at(-1).kind,
          issueDateFallback: false,
        },
        gaps: [
          ...dateGaps,
          ...(conflict ? ["conflicting_terminal_dates"] : []),
        ],
      },
    };
  }
  const issue = dateState(permit.dates.issued, asOfDate);
  if (issue.state === "valid") {
    return {
      lifecycle,
      unresolved: false,
      anchor: {
        date: issue.date,
        range: { fromDate: issue.date, throughDate: issue.date },
        confidence: kind === "closed_replacement" ? "medium" : "low",
        basis: {
          kind,
          permitNumber: permit.permitNumber,
          sourceSystem: permit.sourceSystem,
          dateKind: "issue",
          issueDateFallback: true,
        },
        gaps: [...dateGaps, "missing_terminal_completion_date"],
      },
    };
  }
  return {
    anchor: null,
    lifecycle,
    unresolved: true,
    gaps: [
      ...dateGaps,
      `issue_date_${issue.state}`,
      "missing_installation_anchor",
    ],
  };
}

function availableHistory(property, window, asOfDate) {
  const coverage = property.coverage;
  const gaps = [];
  if (!coverage.authorityComplete) gaps.push("authority_history_incomplete");
  if (!coverage.predecessorComplete) {
    gaps.push("predecessor_history_incomplete");
  }
  if (!coverage.fromDate || coverage.fromDate > window.fromDate) {
    gaps.push("history_start_incomplete");
  }
  if (!coverage.throughDate || coverage.throughDate < asOfDate) {
    gaps.push("history_end_incomplete");
  }
  return {
    fromDate: coverage.fromDate,
    throughDate: coverage.throughDate,
    authorityComplete: coverage.authorityComplete,
    predecessorComplete: coverage.predecessorComplete,
    sourceSystems: coverage.sourceSystems,
    completeForThreshold: gaps.length === 0,
    gaps,
  };
}

export function inferOldRoofControl(
  property,
  permits,
  window = OLD_ROOF_WINDOW,
  asOfDate = window.throughDate,
) {
  const history = availableHistory(property, window, asOfDate);
  const closedReplacementAnchors = [];
  const originalRoofAnchors = [];
  const unresolvedReplacementPermits = [];
  const activeReplacementPermits = [];
  for (const permit of permits) {
    const classification = classifyRoofingPermit(permit);
    const lifecycle = evaluatePermitLifecycle(permit, asOfDate);
    if (
      classification.classification === "confirmed_replacement" &&
      lifecycle.state === "open"
    ) {
      activeReplacementPermits.push({
        permitNumber: permit.permitNumber,
        sourceSystem: permit.sourceSystem,
        lifecycle,
      });
      continue;
    }
    if (
      classification.classification === "confirmed_replacement"
    ) {
      const result = terminalPermitAnchor(
        permit,
        asOfDate,
        "closed_replacement",
      );
      if (result.anchor) closedReplacementAnchors.push(result.anchor);
      else unresolvedReplacementPermits.push(permit.permitNumber);
      continue;
    }
    if (
      NEW_CONSTRUCTION.test(
        permitEvidenceText(permit)
          .map(([, value]) => value)
          .join(" | "),
      )
    ) {
      const result = terminalPermitAnchor(
        permit,
        asOfDate,
        "new_construction",
      );
      if (result.anchor) originalRoofAnchors.push(result.anchor);
    }
  }
  if (activeReplacementPermits.length > 0) {
    return {
      eligible: false,
      reasonCode: "active_replacement_pending_or_in_progress",
      activeReplacementPermits,
    };
  }
  if (unresolvedReplacementPermits.length > 0) {
    return {
      eligible: false,
      reasonCode: "unresolved_replacement_timing",
      unresolvedReplacementPermits,
    };
  }
  const permitAnchors = [
    ...closedReplacementAnchors,
    ...originalRoofAnchors,
  ].sort((left, right) => left.date.localeCompare(right.date));
  let anchor = permitAnchors.at(-1) ?? null;
  if (!anchor && property.builtYear !== null) {
    anchor = {
      date: `${property.builtYear}-12-31`,
      range: {
        fromDate: `${property.builtYear}-01-01`,
        throughDate: `${property.builtYear}-12-31`,
      },
      confidence: "low",
      basis: {
        kind: "property_built_year",
        builtYear: property.builtYear,
        issueDateFallback: false,
      },
      gaps: ["original_roof_not_proven"],
    };
  }
  if (!anchor) {
    return { eligible: false, reasonCode: "missing_estimated_age_basis" };
  }
  const confidence = history.completeForThreshold
    ? anchor.confidence
    : lowerConfidence(anchor.confidence);
  const gaps = [...new Set([...anchor.gaps, ...history.gaps])];
  if (anchor.range.throughDate > window.fromDate) {
    return {
      eligible: false,
      reasonCode: "estimated_anchor_after_threshold",
      label: "estimated",
      confidence,
      basis: anchor.basis,
      estimatedInstallationRange: anchor.range,
      availableHistoryWindow: history,
      caveat:
        "Estimated roof age only; permit and property evidence does not verify the roof installation date.",
    };
  }
  return {
    eligible: true,
    reasonCode: "estimated_anchor_at_or_before_threshold",
    label: "estimated",
    confidence,
    basis: anchor.basis,
    estimatedInstallationAnchor: anchor.date,
    estimatedInstallationRange: anchor.range,
    estimatedAgeYears: {
      minimum: ageYears(anchor.range.throughDate, asOfDate),
      maximum: ageYears(anchor.range.fromDate, asOfDate),
    },
    availableHistoryWindow: history,
    caveat: [
      "Estimated roof age only; this is not a verified roof age.",
      anchor.basis.kind === "property_built_year"
        ? "The built year is a maximum-age hypothesis and does not prove the original roof remains."
        : "The installation anchor is inferred from the best available terminal permit date.",
      gaps.length
        ? `Confidence is limited by: ${gaps.join(", ")}.`
        : "Available permit history is complete for the stated threshold window.",
    ].join(" "),
    confidenceRank: CONFIDENCE_RANK[confidence],
    activeReplacementPermits: [],
  };
}

const OWNER_BUILDER = /\bowner[\s-]?builder\b/i;
const CONTRACTOR_ROLE =
  /\b(?:contractor|roofer|qualif|licensed[\s-]?professional)\b/i;

export function evaluateContractorAssignment(permit) {
  const coverage = permit.contractorAssignmentEvidence ?? {
    detailCaptured: false,
    contactCollectionComplete: false,
    sourcePayloadChecked: false,
    sourceFieldsWithheld: false,
    observedContractorFields: [],
    assignedContractorFields: [],
    ownerBuilderFields: [],
    directContractorCompanyIdPresent: false,
  };
  const contacts = permit.contacts ?? [];
  const ownerBuilderContacts = contacts.filter((contact) =>
    OWNER_BUILDER.test(
      `${contact.role ?? ""} ${contact.name ?? ""} ${contact.companyName ?? ""}`,
    ),
  );
  const contractorRoleContacts = contacts.filter((contact) =>
    CONTRACTOR_ROLE.test(contact.role ?? ""),
  );
  const licensedContacts = contacts.filter(
    (contact) =>
      normalizedText(contact.licenseNumber) ||
      normalizedText(contact.licenseType),
  );
  const contractorCompanyContacts = contractorRoleContacts.filter(
    (contact) =>
      normalizedText(contact.companyId) ||
      normalizedText(contact.companyName) ||
      normalizedText(contact.name),
  );
  const contractorCompanyIdContacts = contractorRoleContacts.filter(
    (contact) => normalizedText(contact.companyId),
  );
  const licensedProfessionalContacts = contacts.filter((contact) =>
    /\blicensed[\s-]?professional\b/i.test(contact.role ?? ""),
  );
  const qualifierContacts = contacts.filter((contact) =>
    normalizedText(contact.qualifierName),
  );
  const evidence = {
    detailCaptured: coverage.detailCaptured,
    contactCollectionComplete: coverage.contactCollectionComplete,
    sourcePayloadChecked: coverage.sourcePayloadChecked,
    sourceFieldsWithheld: coverage.sourceFieldsWithheld,
    observedContractorFields: coverage.observedContractorFields,
    assignedContractorFields: coverage.assignedContractorFields,
    ownerBuilderFields: coverage.ownerBuilderFields,
    directContractorCompanyIdPresent:
      coverage.directContractorCompanyIdPresent,
    contactRecordCount: contacts.length,
    contractorRoleContactCount: contractorRoleContacts.length,
    contractorCompanyContactCount: contractorCompanyContacts.length,
    contractorCompanyIdContactCount: contractorCompanyIdContacts.length,
    roofingLicenseContactCount: licensedContacts.length,
    licensedProfessionalContactCount:
      licensedProfessionalContacts.length,
    qualifierContactCount: qualifierContacts.length,
  };
  if (
    ownerBuilderContacts.length > 0 ||
    coverage.ownerBuilderFields.length > 0
  ) {
    return {
      classification: "owner_builder",
      reasonCode: "owner_builder_evidence_present",
      evidence,
    };
  }
  if (
    contractorRoleContacts.length > 0 ||
    licensedContacts.length > 0 ||
    qualifierContacts.length > 0 ||
    coverage.directContractorCompanyIdPresent ||
    coverage.assignedContractorFields.length > 0
  ) {
    return {
      classification: "assigned",
      reasonCode: "contractor_assignment_evidence_present",
      evidence,
    };
  }
  const unknownReasons = [
    ...(!permit.detailComplete ? ["permit_detail_incomplete"] : []),
    ...(!coverage.detailCaptured ? ["detail_not_captured"] : []),
    ...(!coverage.contactCollectionComplete
      ? ["contact_collection_incomplete"]
      : []),
    ...(!coverage.sourcePayloadChecked
      ? ["source_payload_not_checked"]
      : []),
    ...(coverage.sourceFieldsWithheld
      ? ["contractor_fields_withheld"]
      : []),
    ...(coverage.observedContractorFields.length === 0
      ? ["contractor_fields_unavailable"]
      : []),
  ];
  if (unknownReasons.length > 0) {
    return {
      classification: "contractor_unknown",
      reasonCode: unknownReasons.join(","),
      evidence,
    };
  }
  return {
    classification: "unassigned_confirmed",
    reasonCode: "complete_contractor_fields_present_and_empty",
    evidence,
  };
}

function leadFilingEvidence(permit, window, asOfDate) {
  const candidates = [
    ["issued", permit.dates.issued],
    ["opened", permit.dates.opened],
    ["application", permit.dates.application],
  ];
  const valid = [];
  for (const [kind, value] of candidates) {
    const parsed = dateState(value, asOfDate);
    if (parsed.state === "invalid" || parsed.state === "future") {
      return {
        state: "needs_review",
        reasonCode: `${kind}_${parsed.state}`,
        date: parsed.date,
      };
    }
    if (
      parsed.state === "valid" &&
      inInclusiveWindow(parsed.date, window)
    ) {
      valid.push({ kind, date: parsed.date });
    }
  }
  valid.sort((left, right) => left.date.localeCompare(right.date));
  const latest = valid.at(-1);
  return latest
    ? { state: "confirmed", reasonCode: "filing_date_in_window", ...latest }
    : {
        state: "not_confirmed",
        reasonCode: "no_filing_date_in_window",
        date: null,
      };
}

export function evaluateOpenRoofingLead(
  permit,
  property,
  window = TRAILING_WINDOW,
  asOfDate = window.throughDate,
) {
  const roofing = classifyRoofingPermit(permit);
  const lifecycle = evaluatePermitLifecycle(permit, asOfDate);
  const filing = leadFilingEvidence(permit, window, asOfDate);
  const contractorAssignment = evaluateContractorAssignment(permit);
  const stableSourceIdentity = Boolean(
    normalizedText(permit.sourceSystem) &&
      normalizedText(permit.sourceRecordKey) &&
      permit.evidenceSha256 &&
      !permit.duplicateConflict,
  );
  const linkedProperty = Boolean(
    permit.propertyId &&
      property?.propertyId === permit.propertyId &&
      property.parcelIdentifier === permit.parcelIdentifier,
  );
  const privacySafeLocation = Boolean(
    permit.parcelIdentifier && permit.workAddress,
  );
  let reasonCode = "recommended_unassigned_open_roofing_lead";
  if (
    !["confirmed_replacement", "confirmed_roofing"].includes(
      roofing.classification,
    )
  ) {
    reasonCode = "not_confirmed_roofing";
  } else if (lifecycle.state !== "open") {
    reasonCode =
      lifecycle.state === "needs_review"
        ? "conflicting_or_unknown_status"
        : "not_currently_open";
  } else if (filing.state !== "confirmed") {
    reasonCode =
      filing.state === "needs_review"
        ? "conflicting_or_invalid_filing_date"
        : "filing_date_outside_window";
  } else if (!linkedProperty) {
    reasonCode = "property_not_linked";
  } else if (!stableSourceIdentity) {
    reasonCode = "unstable_source_identity";
  } else if (!privacySafeLocation) {
    reasonCode = "missing_privacy_safe_location";
  } else if (
    contractorAssignment.classification !== "unassigned_confirmed"
  ) {
    reasonCode = contractorAssignment.classification;
  }
  const eligible =
    reasonCode === "recommended_unassigned_open_roofing_lead";
  return {
    eligible,
    reasonCode,
    label: eligible
      ? "recommended-unassigned-open-roofing-lead"
      : "open-roofing-lead-review",
    propertyImprovementId: permit.propertyImprovementId,
    propertyId: permit.propertyId,
    parcelIdentifier: permit.parcelIdentifier,
    permitNumber: permit.permitNumber,
    authority: permit.authority,
    sourceSystem: permit.sourceSystem,
    sourceRecordKey: permit.sourceRecordKey,
    workAddress: permit.workAddress,
    usageType: property?.usageType ?? null,
    roofingEvidence: roofing,
    lifecycleEvidence: lifecycle,
    filingEvidence: filing,
    contractorAssignment,
    sourceIdentityEvidence: {
      stable: stableSourceIdentity,
      evidenceSha256: permit.evidenceSha256,
      provenance: permit.sourceProvenance,
    },
    propertyLinkEvidence: {
      linked: linkedProperty,
      propertyId: property?.propertyId ?? null,
      parcelIdentifier: property?.parcelIdentifier ?? null,
    },
    recommendedForHandoff: eligible,
    assignedToZRoofing: false,
  };
}

export function chooseOpenLeads(
  candidates,
  historicalProjects = [],
  target = 5,
) {
  const historicalAuthorities = new Set(
    historicalProjects.map((project) => project.authority),
  );
  const score = (candidate) =>
    Number(/\bresidential\b/i.test(candidate.usageType ?? "")) * 4 +
    Number(
      candidate.roofingEvidence.classification ===
        "confirmed_replacement",
    ) *
      2 +
    Number(historicalAuthorities.has(candidate.authority));
  return [...candidates]
    .sort(
      (left, right) =>
        score(right) - score(left) ||
        right.filingEvidence.date.localeCompare(left.filingEvidence.date) ||
        left.sourceRecordKey.localeCompare(right.sourceRecordKey),
    )
    .slice(0, target);
}

export function chooseControls(candidates, openCases, target = 5) {
  const desiredAuthorities = new Set(
    openCases.map((candidate) => candidate.authority),
  );
  const desiredUsage = new Set(
    openCases.map((candidate) => candidate.usageType).filter(Boolean),
  );
  return [...candidates]
    .sort((left, right) => {
      const confidenceDifference =
        CONFIDENCE_RANK[right.confidence] -
        CONFIDENCE_RANK[left.confidence];
      const leftScore =
        Number(desiredAuthorities.has(left.authority)) * 2 +
        Number(desiredUsage.has(left.usageType));
      const rightScore =
        Number(desiredAuthorities.has(right.authority)) * 2 +
        Number(desiredUsage.has(right.usageType));
      return (
        confidenceDifference ||
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
      recommendedOpenLeadCount: result.openCohort.length,
      openLeadDefinition:
        "confirmed currently open roofing permit with linked property and complete evidence that no contractor is assigned",
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
  const seedFolios = new Set(manifest.seedFolios);
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
        !seedFolios.has(project.parcelIdentifier),
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
      evidencePurpose:
        "completed-historical-contractor-capability-profile",
    }));

  const propertyById = new Map(
    properties.map((property) => [property.propertyId, property]),
  );
  const currentOpenPermits = deduplicated
    .filter((permit) => !seedFolios.has(permit.parcelIdentifier))
    .map((permit) =>
      evaluateOpenRoofingLead(
        permit,
        propertyById.get(permit.propertyId),
        trailingWindow,
        manifest.asOfDate,
      ),
    )
    .filter(
      (permit) =>
        ["confirmed_replacement", "confirmed_roofing"].includes(
          permit.roofingEvidence.classification,
        ) && permit.lifecycleEvidence.state === "open",
    );
  const openCohort = chooseOpenLeads(
    currentOpenPermits.filter((permit) => permit.eligible),
    trailingProjects,
  );

  const permitsByParcel = new Map();
  for (const permit of deduplicated) {
    if (!permit.parcelIdentifier) continue;
    const rows = permitsByParcel.get(permit.parcelIdentifier) ?? [];
    rows.push(permit);
    permitsByParcel.set(permit.parcelIdentifier, rows);
  }
  const oldRoofCandidates = properties
    .filter(
      (property) => !seedFolios.has(property.parcelIdentifier),
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
  const contractorAssignmentCounts = {
    unassigned_confirmed: currentOpenPermits.filter(
      (permit) =>
        permit.contractorAssignment.classification ===
        "unassigned_confirmed",
    ).length,
    assigned: currentOpenPermits.filter(
      (permit) => permit.contractorAssignment.classification === "assigned",
    ).length,
    owner_builder: currentOpenPermits.filter(
      (permit) =>
        permit.contractorAssignment.classification === "owner_builder",
    ).length,
    contractor_unknown: currentOpenPermits.filter(
      (permit) =>
        permit.contractorAssignment.classification ===
        "contractor_unknown",
    ).length,
  };
  const oldRoofControlConfidenceCounts = {
    high: oldRoofControls.filter((control) => control.confidence === "high")
      .length,
    medium: oldRoofControls.filter(
      (control) => control.confidence === "medium",
    ).length,
    low: oldRoofControls.filter((control) => control.confidence === "low")
      .length,
  };

  const blockedSources = sourceRecords.filter(
    (source) => source.access !== "supported",
  );
  const availability =
    blockedSources.length > 0 ? "supported_partial" : "supported_full";
  const scopedSeedFolios = new Set(
    [...properties, ...deduplicated]
      .map((record) => record.parcelIdentifier)
      .filter((folio) => seedFolios.has(folio)),
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
    confirmed_roofing: 0,
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
      schemaVersion: "elephant.roofing-cohort-summary.v2",
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
      recommendedOpenLeadCount: openCohort.length,
      openLeadDefinition:
        "confirmed currently open roofing permit with linked property and complete evidence that no contractor is assigned",
      contractorAssignmentCounts,
      oldRoofControlCount: oldRoofControls.length,
      oldRoofControlConfidenceCounts,
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
