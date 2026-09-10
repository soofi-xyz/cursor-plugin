export const ROOF_AGE_RULE_VERSION = "elephant.roof-age.v1";

export const ROOF_DATE_SOURCES = Object.freeze({
  PARCEL: "parcel",
  CONSTRUCTION_YEAR: "derived-from-construction-year",
  PERMIT: "permit",
});

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const YEAR_PATTERN = /^\d{4}$/;

function cleanText(value) {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

function normalizeDate(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    return Number.isNaN(value.valueOf())
      ? null
      : value.toISOString().slice(0, 10);
  }
  const text = cleanText(value);
  if (text === null) return null;
  if (YEAR_PATTERN.test(text)) return `${text}-01-01`;
  if (ISO_DATE_PATTERN.test(text)) {
    const date = new Date(`${text}T00:00:00.000Z`);
    return Number.isNaN(date.valueOf()) ||
      date.toISOString().slice(0, 10) !== text
      ? null
      : text;
  }
  const date = new Date(text);
  return Number.isNaN(date.valueOf())
    ? null
    : date.toISOString().slice(0, 10);
}

export function normalizeAsOfDate(value) {
  const normalized = normalizeDate(value);
  if (normalized === null) {
    throw new Error("Roof-age asOfDate must be a valid date");
  }
  return normalized;
}

function normalizeBuiltYear(value, asOfDate) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  if (!YEAR_PATTERN.test(text)) return null;
  const year = Number(text);
  const maximumYear = Number(asOfDate.slice(0, 4));
  return year >= 1700 && year <= maximumYear ? year : null;
}

function normalizeAge(value) {
  if (value === null || value === undefined || value === "") return null;
  const age = Number(value);
  return Number.isInteger(age) && age >= 0 && age <= 500 ? age : null;
}

export function calculateRoofAgeYears(roofDate, asOfDate) {
  const normalizedRoofDate = normalizeDate(roofDate);
  const normalizedAsOfDate = normalizeAsOfDate(asOfDate);
  if (
    normalizedRoofDate === null ||
    normalizedRoofDate > normalizedAsOfDate
  ) {
    return null;
  }
  const roof = new Date(`${normalizedRoofDate}T00:00:00.000Z`);
  const asOf = new Date(`${normalizedAsOfDate}T00:00:00.000Z`);
  let years = asOf.getUTCFullYear() - roof.getUTCFullYear();
  if (
    asOf.getUTCMonth() < roof.getUTCMonth() ||
    (asOf.getUTCMonth() === roof.getUTCMonth() &&
      asOf.getUTCDate() < roof.getUTCDate())
  ) {
    years -= 1;
  }
  return Math.max(0, years);
}

function normalizeSource(value) {
  const source = cleanText(value);
  return Object.values(ROOF_DATE_SOURCES).includes(source) ? source : null;
}

function normalizeLineage(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return [];
  }
  return Array.isArray(value.history)
    ? value.history.filter(
        (event) =>
          event !== null &&
          typeof event === "object" &&
          !Array.isArray(event),
      )
    : [];
}

function appendLineage(history, event) {
  const serialized = JSON.stringify(event);
  return history.some((candidate) => JSON.stringify(candidate) === serialized)
    ? history
    : [...history, event];
}

function lineageObject({ asOfDate, history }) {
  return {
    schemaVersion: ROOF_AGE_RULE_VERSION,
    asOfDate,
    current: history.at(-1) ?? null,
    history,
  };
}

function parcelState({
  explicitRoofDate,
  explicitRoofAgeYears,
  builtYear,
  explicitSource,
  existingLineage,
  asOfDate,
  sourceSystem,
  sourceRecordKey,
}) {
  const explicitDate = normalizeDate(explicitRoofDate);
  const explicitAge = normalizeAge(explicitRoofAgeYears);
  const constructionYear = normalizeBuiltYear(builtYear, asOfDate);
  const constructionDate =
    constructionYear === null ? null : `${constructionYear}-01-01`;
  const normalizedExplicitSource = normalizeSource(explicitSource);
  const inferredConstructionDefault =
    explicitDate !== null &&
    constructionDate !== null &&
    explicitDate === constructionDate &&
    (normalizedExplicitSource === null ||
      normalizedExplicitSource === ROOF_DATE_SOURCES.CONSTRUCTION_YEAR);
  const history = normalizeLineage(existingLineage);

  if (explicitDate !== null && !inferredConstructionDefault) {
    const source = normalizedExplicitSource ?? ROOF_DATE_SOURCES.PARCEL;
    const current = history.at(-1);
    if (
      current?.source === source &&
      current?.roofDate === explicitDate
    ) {
      return {
        roofDate: explicitDate,
        roofAgeYears:
          explicitAge ?? calculateRoofAgeYears(explicitDate, asOfDate),
        roofDateSource: source,
        roofDateLineage: lineageObject({ asOfDate, history }),
      };
    }
    const event = {
      source,
      roofDate: explicitDate,
      datePrecision: YEAR_PATTERN.test(String(explicitRoofDate).trim())
        ? "year"
        : "day",
      reason: "parcel-explicit",
      ...(cleanText(sourceSystem) === null
        ? {}
        : { sourceSystem: cleanText(sourceSystem) }),
      ...(cleanText(sourceRecordKey) === null
        ? {}
        : { sourceRecordKey: cleanText(sourceRecordKey) }),
    };
    const nextHistory = appendLineage(history, event);
    return {
      roofDate: explicitDate,
      roofAgeYears:
        explicitAge ?? calculateRoofAgeYears(explicitDate, asOfDate),
      roofDateSource: event.source,
      roofDateLineage: lineageObject({ asOfDate, history: nextHistory }),
    };
  }

  if (explicitAge !== null && explicitDate === null) {
    const current = history.at(-1);
    if (
      current?.source === ROOF_DATE_SOURCES.PARCEL &&
      current?.roofDate === null &&
      current?.roofAgeYears === explicitAge
    ) {
      return {
        roofDate: null,
        roofAgeYears: explicitAge,
        roofDateSource: ROOF_DATE_SOURCES.PARCEL,
        roofDateLineage: lineageObject({ asOfDate, history }),
      };
    }
    const event = {
      source: ROOF_DATE_SOURCES.PARCEL,
      roofDate: null,
      roofAgeYears: explicitAge,
      datePrecision: null,
      reason: "parcel-explicit-age",
      ...(cleanText(sourceSystem) === null
        ? {}
        : { sourceSystem: cleanText(sourceSystem) }),
      ...(cleanText(sourceRecordKey) === null
        ? {}
        : { sourceRecordKey: cleanText(sourceRecordKey) }),
    };
    const nextHistory = appendLineage(history, event);
    return {
      roofDate: null,
      roofAgeYears: explicitAge,
      roofDateSource: ROOF_DATE_SOURCES.PARCEL,
      roofDateLineage: lineageObject({ asOfDate, history: nextHistory }),
    };
  }

  if (constructionDate === null) return null;
  const event = {
    source: ROOF_DATE_SOURCES.CONSTRUCTION_YEAR,
    roofDate: constructionDate,
    datePrecision: "year",
    reason: "construction-year-default",
    constructionYear,
    ...(cleanText(sourceSystem) === null
      ? {}
      : { sourceSystem: cleanText(sourceSystem) }),
    ...(cleanText(sourceRecordKey) === null
      ? {}
      : { sourceRecordKey: cleanText(sourceRecordKey) }),
  };
  const nextHistory = appendLineage(history, event);
  return {
    roofDate: constructionDate,
    roofAgeYears: calculateRoofAgeYears(constructionDate, asOfDate),
    roofDateSource: ROOF_DATE_SOURCES.CONSTRUCTION_YEAR,
    roofDateLineage: lineageObject({ asOfDate, history: nextHistory }),
  };
}

function policyForPermit(permit, policy) {
  const sourceSystem = cleanText(permit.source_system);
  return policy?.sources?.find(
    (source) => source.sourceSystem === sourceSystem,
  ) ?? null;
}

function containsConfiguredTerm(text, terms) {
  const normalized = String(text ?? "").toLocaleLowerCase("en-US");
  return terms.some((term) =>
    normalized.includes(String(term).toLocaleLowerCase("en-US")),
  );
}

function qualifyingPermit(permit, { propertyId, builtDate, asOfDate, policy }) {
  if (
    cleanText(propertyId) === null ||
    cleanText(permit.property_id) !== cleanText(propertyId)
  ) {
    return null;
  }
  const sourcePolicy = policyForPermit(permit, policy);
  if (sourcePolicy === null) return null;
  const status = cleanText(permit.improvement_status);
  if (status === null || !sourcePolicy.terminalStatuses.includes(status)) {
    return null;
  }
  const improvementType = cleanText(permit.improvement_type);
  if (
    improvementType === null ||
    !sourcePolicy.roofPermitTypes.includes(improvementType)
  ) {
    return null;
  }
  const evidence = [
    permit.improvement_action,
    permit.project_description,
    permit.description,
  ]
    .map((value) => cleanText(value))
    .filter(Boolean)
    .join(" ");
  if (containsConfiguredTerm(evidence, sourcePolicy.excludedTerms)) {
    return null;
  }
  if (
    sourcePolicy.allowPermitTypeOnly !== true &&
    !containsConfiguredTerm(evidence, sourcePolicy.replacementTerms)
  ) {
    return null;
  }
  const dateCandidates = [
    ["completion_date", permit.completion_date],
    ["permit_close_date", permit.permit_close_date],
    ["final_inspection_date", permit.final_inspection_date],
  ];
  const [dateField, rawDate] =
    dateCandidates.find(([, value]) => cleanText(value) !== null) ?? [];
  const eventDate = normalizeDate(rawDate);
  if (
    eventDate === null ||
    eventDate > asOfDate ||
    (builtDate !== null && eventDate < builtDate)
  ) {
    return null;
  }
  return {
    permit,
    eventDate,
    dateField,
  };
}

export function selectQualifyingRoofPermit({
  permits,
  propertyId,
  builtYear,
  asOfDate,
  permitPolicy,
}) {
  const normalizedAsOfDate = normalizeAsOfDate(asOfDate);
  const constructionYear = normalizeBuiltYear(
    builtYear,
    normalizedAsOfDate,
  );
  const builtDate =
    constructionYear === null ? null : `${constructionYear}-01-01`;
  return (
    permits
      .map((permit) =>
        qualifyingPermit(permit, {
          propertyId,
          builtDate,
          asOfDate: normalizedAsOfDate,
          policy: permitPolicy,
        }),
      )
      .filter(Boolean)
      .sort(
        (left, right) =>
          right.eventDate.localeCompare(left.eventDate) ||
          String(right.permit.property_improvement_id ?? "").localeCompare(
            String(left.permit.property_improvement_id ?? ""),
          ),
      )[0] ?? null
  );
}

function applyPermitOverlay({
  baseState,
  permits,
  propertyId,
  builtYear,
  asOfDate,
  policy,
}) {
  const candidate = selectQualifyingRoofPermit({
    permits,
    propertyId,
    builtYear,
    asOfDate,
    permitPolicy: policy,
  });
  if (candidate === null) return baseState;
  const event = {
    source: ROOF_DATE_SOURCES.PERMIT,
    roofDate: candidate.eventDate,
    datePrecision: "day",
    reason: "closed-roof-replacement-or-upgrade",
    dateField: candidate.dateField,
    permitId: cleanText(candidate.permit.property_improvement_id),
    permitNumber: cleanText(candidate.permit.permit_number),
    sourceSystem: cleanText(candidate.permit.source_system),
    sourceRecordKey: cleanText(candidate.permit.sourceRecordId),
  };
  const history = appendLineage(
    normalizeLineage(baseState?.roofDateLineage),
    event,
  );
  return {
    roofDate: candidate.eventDate,
    roofAgeYears: calculateRoofAgeYears(candidate.eventDate, asOfDate),
    roofDateSource: ROOF_DATE_SOURCES.PERMIT,
    roofDateLineage: lineageObject({ asOfDate, history }),
  };
}

export function resolveRoofAge({
  propertyId,
  explicitRoofDate,
  explicitRoofAgeYears,
  builtYear,
  explicitSource,
  existingLineage,
  permits = [],
  permitPolicy = null,
  sourceSystem = null,
  sourceRecordKey = null,
  asOfDate,
}) {
  const normalizedAsOfDate = normalizeAsOfDate(asOfDate);
  const baseState = parcelState({
    explicitRoofDate,
    explicitRoofAgeYears,
    builtYear,
    explicitSource,
    existingLineage,
    asOfDate: normalizedAsOfDate,
    sourceSystem,
    sourceRecordKey,
  });
  return applyPermitOverlay({
    baseState,
    permits,
    propertyId,
    builtYear,
    asOfDate: normalizedAsOfDate,
    policy: permitPolicy,
  });
}
