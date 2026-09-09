import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";

import { ParquetSchema, ParquetWriter } from "@dsnp/parquetjs";

import { toParquetRecord } from "../core/query-table.mjs";
import { normalizeJaxPermitMapFeature } from "../permits/adapters/jaxepics-map.mjs";
import { normalizeDuvalParcelIdentifier } from "../permits/normalization.mjs";

const require = createRequire(import.meta.url);
const { ParquetReader } = require("@dsnp/parquetjs");

const LEGAL_SUFFIXES = new Set([
  "CO",
  "COMPANY",
  "CORP",
  "CORPORATION",
  "INC",
  "INCORPORATED",
  "LLC",
  "LLP",
  "LP",
  "LTD",
  "LIMITED",
  "PA",
  "PC",
  "PLLC",
]);
const LOOSE_TRADE_WORDS = new Set([
  "AIR",
  "CONTRACTING",
  "CONTRACTOR",
  "CONTRACTORS",
  "ELECTRIC",
  "ELECTRICAL",
  "HEATING",
  "ROOFING",
  "SERVICE",
  "SERVICES",
]);
const REJECTED_ALTERNATE_NAME_TEXT =
  /(?:additional|business categor|contact information|copyright|department of business|licens(?:e|ing)|phone number|privacy policy|social media|terms of use|website|www\.|https?:|@)/i;
const LICENSE_TEXT_PATTERN =
  /license number of\s+([A-Z0-9][A-Z0-9-]{3,30})/gi;

function normalizedWords(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export function normalizeBusinessName(value, { loose = false } = {}) {
  const words = normalizedWords(value);
  while (words.length > 1 && LEGAL_SUFFIXES.has(words.at(-1))) words.pop();
  const filtered = loose
    ? words.filter((word) => !LOOSE_TRADE_WORDS.has(word))
    : words;
  return filtered.join(" ");
}

export function normalizePhone(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length === 10 ? digits : null;
}

export function normalizeLicense(value) {
  const normalized = String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return normalized.length >= 4 ? normalized : null;
}

export function jaroWinkler(leftValue, rightValue) {
  const left = String(leftValue ?? "");
  const right = String(rightValue ?? "");
  if (left === right) return 1;
  if (!left || !right) return 0;
  const matchDistance = Math.max(Math.floor(Math.max(left.length, right.length) / 2) - 1, 0);
  const leftMatches = Array(left.length).fill(false);
  const rightMatches = Array(right.length).fill(false);
  let matches = 0;
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const start = Math.max(0, leftIndex - matchDistance);
    const end = Math.min(leftIndex + matchDistance + 1, right.length);
    for (let rightIndex = start; rightIndex < end; rightIndex += 1) {
      if (rightMatches[rightIndex] || left[leftIndex] !== right[rightIndex]) {
        continue;
      }
      leftMatches[leftIndex] = true;
      rightMatches[rightIndex] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;
  const matchedLeft = [];
  const matchedRight = [];
  for (let index = 0; index < left.length; index += 1) {
    if (leftMatches[index]) matchedLeft.push(left[index]);
  }
  for (let index = 0; index < right.length; index += 1) {
    if (rightMatches[index]) matchedRight.push(right[index]);
  }
  let transpositions = 0;
  for (let index = 0; index < matchedLeft.length; index += 1) {
    if (matchedLeft[index] !== matchedRight[index]) transpositions += 1;
  }
  const jaro =
    (matches / left.length +
      matches / right.length +
      (matches - transpositions / 2) / matches) /
    3;
  let prefixLength = 0;
  while (
    prefixLength < 4 &&
    prefixLength < left.length &&
    prefixLength < right.length &&
    left[prefixLength] === right[prefixLength]
  ) {
    prefixLength += 1;
  }
  return jaro + prefixLength * 0.1 * (1 - jaro);
}

function acceptedAlternateName(value) {
  const name =
    typeof value === "string"
      ? value
      : typeof value?.name === "string"
        ? value.name
        : "";
  const words = normalizedWords(name);
  return (
    name.length > 1 &&
    name.length <= 160 &&
    words.length >= 2 &&
    words.length <= 16 &&
    !REJECTED_ALTERNATE_NAME_TEXT.test(name)
  )
    ? name
    : null;
}

function licenseNumbersFromProfile(profile) {
  const values = new Set();
  for (const license of profile.licenses ?? []) {
    const text =
      typeof license === "string" ? license : String(license?.rawText ?? "");
    for (const match of text.matchAll(LICENSE_TEXT_PATTERN)) {
      const value = normalizeLicense(match[1]);
      if (value) values.add(value);
    }
  }
  return values;
}

function bbbBusinessId(profile) {
  if (profile.providerBbbId && profile.providerBusinessId) {
    return `${profile.providerBbbId}:${profile.providerBusinessId}`;
  }
  const value =
    profile.providerBusinessId ??
    profile.providerProfileId ??
    profile.profileUrl;
  if (value === null || value === undefined || String(value).trim() === "") {
    throw new Error("BBB profile has no stable business identity");
  }
  return String(value);
}

async function readJsonLines(filePath) {
  const body = await readFile(filePath, "utf8");
  return body
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function buildContractorIdentityIndex(businesses, profiles = []) {
  const strictNameIndex = new Map();
  const phoneIndex = new Map();
  const licenseIndex = new Map();
  const addIndex = (index, key, id) => {
    const ids = index.get(key) ?? new Set();
    ids.add(id);
    index.set(key, ids);
  };
  for (const business of businesses.values()) {
    for (const name of business.strictNames) {
      addIndex(strictNameIndex, name, business.id);
    }
    for (const phone of business.phones) addIndex(phoneIndex, phone, business.id);
    for (const license of business.licenses) {
      addIndex(licenseIndex, license, business.id);
    }
  }
  return {
    profiles,
    businesses,
    strictNameIndex,
    phoneIndex,
    licenseIndex,
  };
}

export async function loadBbbBusinessIndex(bbbProfilesPath) {
  const profiles = await readJsonLines(bbbProfilesPath);
  const businesses = new Map();
  for (const profile of profiles) {
    const id = bbbBusinessId(profile);
    const business = businesses.get(id) ?? {
      id,
      names: new Set(),
      strictNames: new Set(),
      looseNames: new Set(),
      phones: new Set(),
      licenses: new Set(),
      profileIds: new Set(),
      profileUrls: new Set(),
    };
    const names = [
      profile.name,
      profile.legalName,
      ...(profile.alternateNames ?? []).map(acceptedAlternateName),
    ].filter(Boolean);
    for (const name of names) {
      const strictName = normalizeBusinessName(name);
      const looseName = normalizeBusinessName(name, { loose: true });
      if (!strictName) continue;
      business.names.add(String(name));
      business.strictNames.add(strictName);
      if (looseName) business.looseNames.add(looseName);
    }
    const phone = normalizePhone(profile.phone);
    if (phone) business.phones.add(phone);
    for (const license of licenseNumbersFromProfile(profile)) {
      business.licenses.add(license);
    }
    if (profile.providerProfileId) {
      business.profileIds.add(String(profile.providerProfileId));
    }
    if (profile.profileUrl) business.profileUrls.add(String(profile.profileUrl));
    businesses.set(id, business);
  }
  return buildContractorIdentityIndex(businesses, profiles);
}

function arrayValues(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) || value instanceof Set ? [...value] : [value];
}

export function createContractorCompanyIndex(companies) {
  const businesses = new Map();
  for (const company of companies) {
    const id = String(company.companyId ?? company.id ?? "").trim();
    if (!id) throw new Error("Contractor company index requires companyId");
    if (businesses.has(id)) {
      throw new Error(`Duplicate contractor company identity: ${id}`);
    }
    const names = [
      company.name,
      company.legalName,
      ...arrayValues(company.names),
      ...arrayValues(company.alternateNames),
    ].filter(Boolean);
    const strictNames = new Set(
      names.map((name) => normalizeBusinessName(name)).filter(Boolean),
    );
    const looseNames = new Set(
      names
        .map((name) => normalizeBusinessName(name, { loose: true }))
        .filter(Boolean),
    );
    const phones = new Set(
      [company.phone, ...arrayValues(company.phones)]
        .map(normalizePhone)
        .filter(Boolean),
    );
    const licenses = new Set(
      [company.licenseNumber, ...arrayValues(company.licenses)]
        .map((license) =>
          normalizeLicense(
            typeof license === "string"
              ? license
              : license?.licenseNumber ?? license?.number,
          ),
        )
        .filter(Boolean),
    );
    businesses.set(id, {
      id,
      names: new Set(names.map(String)),
      strictNames,
      looseNames,
      phones,
      licenses,
      profileIds: new Set(),
      profileUrls: new Set(),
    });
  }
  return buildContractorIdentityIndex(businesses);
}

export function normalizePermitContractorIdentity(attributes) {
  const businessName = String(
    attributes.businessName ??
      attributes.CompanyName ??
      attributes.BusinessName ??
      attributes.ContractorName ??
      "",
  ).trim();
  const license = normalizeLicense(
    attributes.license ??
      attributes.licenseNumber ??
      attributes.LicenseNumber ??
      attributes.ContractorLicenseNumber ??
      attributes.QALicenseNumber,
  );
  const phone = normalizePhone(
    attributes.phone ??
      attributes.CompanyPhone ??
      attributes.ContractorPhone ??
      attributes.Phone,
  );
  const stableSourceId =
    attributes.sourceCompanyId ??
    attributes.companyId ??
    attributes.CompanyID ??
    attributes.ContractorID ??
    attributes.QALicenseID ??
    null;
  return {
    businessName,
    strictName: normalizeBusinessName(businessName),
    looseName: normalizeBusinessName(businessName, { loose: true }),
    license,
    phone,
    sourceCompanyId:
      stableSourceId === null || stableSourceId === undefined
        ? null
        : String(stableSourceId),
  };
}

function uniqueIndexMatch(index, value) {
  if (!value) return null;
  const ids = index.get(value);
  return ids?.size === 1 ? [...ids][0] : null;
}

export function matchPermitContractor(
  contractor,
  bbbIndex,
  { fuzzyThreshold = 0.9, fuzzyMargin = 0.05 } = {},
) {
  const licenseMatch = uniqueIndexMatch(
    bbbIndex.licenseIndex,
    contractor.license,
  );
  if (licenseMatch) {
    return {
      status: "accepted",
      bbbBusinessId: licenseMatch,
      method: "exact_state_license",
      confidence: 1,
    };
  }
  const phoneMatch = uniqueIndexMatch(bbbIndex.phoneIndex, contractor.phone);
  if (phoneMatch) {
    return {
      status: "accepted",
      bbbBusinessId: phoneMatch,
      method: "exact_standardized_phone",
      confidence: 0.95,
    };
  }
  const exactNameMatch = uniqueIndexMatch(
    bbbIndex.strictNameIndex,
    contractor.strictName,
  );
  if (exactNameMatch) {
    return {
      status: "accepted",
      bbbBusinessId: exactNameMatch,
      method: "unique_exact_normalized_business_name",
      confidence: 0.8,
    };
  }
  if (!contractor.looseName) return { status: "unmatched" };

  const ranked = [];
  for (const business of bbbIndex.businesses.values()) {
    let score = 0;
    let matchedName = null;
    for (const candidate of business.looseNames) {
      const candidateScore = jaroWinkler(contractor.looseName, candidate);
      if (candidateScore > score) {
        score = candidateScore;
        matchedName = candidate;
      }
    }
    if (score >= fuzzyThreshold) {
      ranked.push({ bbbBusinessId: business.id, matchedName, score });
    }
  }
  ranked.sort((left, right) => right.score - left.score);
  if (ranked.length === 0) return { status: "unmatched" };
  const top = ranked[0];
  const runnerUp = ranked[1];
  return {
    status:
      runnerUp && top.score - runnerUp.score < fuzzyMargin
        ? "ambiguous"
        : "review",
    method: "jaro_winkler_cleaned_business_name",
    confidence: 0.8,
    candidate: top,
    runnerUp: runnerUp ?? null,
  };
}

export function matchContractorToCompany(
  contractor,
  companyIndex,
  options = {},
) {
  const match = matchPermitContractor(
    normalizePermitContractorIdentity(contractor),
    companyIndex,
    options,
  );
  if (match.status === "accepted") {
    const { bbbBusinessId, ...rest } = match;
    return { ...rest, companyId: bbbBusinessId };
  }
  const remapCandidate = (candidate) => {
    if (!candidate) return candidate;
    const { bbbBusinessId, ...rest } = candidate;
    return { ...rest, companyId: bbbBusinessId };
  };
  return {
    ...match,
    candidate: remapCandidate(match.candidate),
    runnerUp: remapCandidate(match.runnerUp),
  };
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function fileIntegrity(filePath) {
  const fileStat = await stat(filePath);
  return { bytes: fileStat.size, sha256: await sha256File(filePath) };
}

async function writeJsonLine(stream, value) {
  if (!stream.write(`${JSON.stringify(value)}\n`)) {
    await new Promise((resolve) => stream.once("drain", resolve));
  }
}

async function closeStream(stream) {
  await new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}

async function buildPropertyIndex(inputParquet, normalizeParcelIdentifier) {
  const byParcel = new Map();
  const reader = await ParquetReader.openFile(inputParquet);
  let rowCount = 0;
  try {
    const cursor = reader.getCursor([
      "property_id",
      "parcel_identifier",
      "has_permits",
    ]);
    let row = await cursor.next();
    while (row) {
      rowCount += 1;
      const propertyId = String(row.property_id ?? "");
      if (!/^[a-f0-9]{32}$/.test(propertyId) && !/^property-\d+$/.test(propertyId)) {
        throw new Error(`Invalid property_id in BBB linker: ${propertyId}`);
      }
      let parcel;
      try {
        parcel = normalizeParcelIdentifier(row.parcel_identifier);
      } catch {
        row = await cursor.next();
        continue;
      }
      const existing = byParcel.get(parcel);
      if (existing && existing.propertyId !== propertyId) {
        throw new Error(`Parcel ${parcel} maps to multiple property IDs`);
      }
      byParcel.set(parcel, {
        propertyId,
        hasPermits: row.has_permits === true,
      });
      row = await cursor.next();
    }
  } finally {
    await reader.close();
  }
  return { byParcel, rowCount };
}

async function forEachPermitFeature(permitSourcePath, callback) {
  const compressed = permitSourcePath.endsWith(".gz");
  const input = createReadStream(permitSourcePath);
  const body = compressed ? input.pipe(createGunzip()) : input;
  const lines = createInterface({ input: body, crlfDelay: Number.POSITIVE_INFINITY });
  let featureCount = 0;
  for await (const line of lines) {
    if (!line.trim()) continue;
    const envelope = JSON.parse(line);
    const features = Array.isArray(envelope.features)
      ? envelope.features
      : envelope.type === "Feature"
        ? [envelope]
        : [];
    for (const feature of features) {
      featureCount += 1;
      await callback(feature, featureCount);
    }
  }
  return featureCount;
}

function upsertBbbCoverage(coverage, bbbDataset) {
  const datasets = [...(coverage.datasets ?? [])];
  const index = datasets.findIndex((dataset) => dataset?.source === "bbb");
  if (index < 0) throw new Error("BBB linker requires existing BBB coverage");
  datasets[index] = bbbDataset;
  return { ...coverage, datasets };
}

export const duvalBbbPermitSourceAdapter = Object.freeze({
  key: "duval-jaxepics-bid-map",
  artifactPath: "private/jaxepics-bid-map.jsonl.gz",
  normalizeParcelIdentifier: normalizeDuvalParcelIdentifier,
  validateFeature(feature, { parcelIdentifier, propertyId }) {
    return normalizeJaxPermitMapFeature(feature, {
      requestedParcelIdentifier: parcelIdentifier,
      requestedPropertyId: propertyId,
    });
  },
  parseFeature(feature) {
    const attributes = feature?.attributes ?? feature ?? {};
    return {
      attributes,
      parcelIdentifier: attributes.RE,
      sourceRecordId:
        attributes.RecordID === null || attributes.RecordID === undefined
          ? null
          : String(attributes.RecordID),
      permitNumber: attributes.FullPermitNumber ?? null,
    };
  },
});

export async function linkBbbContractorsToProperties({
  countyKey,
  permitSourceAdapter,
  expectedCategoryKeys = [],
  schemaFields,
  inputParquet,
  outputParquet,
  inputCoverage,
  outputCoverage,
  bbbProfilesPath,
  bbbReconciliationManifestPath = null,
  permitSourcePath,
  permitArtifactManifestPath = null,
  linksPath,
  candidatesPath,
  manifestPath = `${outputParquet}.bbb-linkage-manifest.json`,
  exportedAt = new Date().toISOString(),
  fuzzyThreshold = 0.9,
  fuzzyMargin = 0.05,
  progress = () => {},
}) {
  if (
    !permitSourceAdapter?.key ||
    !permitSourceAdapter?.artifactPath ||
    typeof permitSourceAdapter?.normalizeParcelIdentifier !== "function" ||
    typeof permitSourceAdapter?.parseFeature !== "function" ||
    typeof permitSourceAdapter?.validateFeature !== "function"
  ) {
    throw new Error("BBB linker requires a permit-source adapter");
  }
  if (schemaFields?.has_bbb_contractor?.type !== "BOOLEAN") {
    throw new Error("BBB linker requires has_bbb_contractor in the query schema");
  }
  if (path.resolve(inputParquet) === path.resolve(outputParquet)) {
    throw new Error("BBB linker requires a distinct output Parquet path");
  }
  const [bbbIndex, propertyIndex] = await Promise.all([
    loadBbbBusinessIndex(bbbProfilesPath),
    buildPropertyIndex(
      inputParquet,
      permitSourceAdapter.normalizeParcelIdentifier,
    ),
  ]);
  const [bbbIntegrity, permitIntegrity] = await Promise.all([
    fileIntegrity(bbbProfilesPath),
    fileIntegrity(permitSourcePath),
  ]);
  let expectedPermitFeatureCount = null;
  if (bbbReconciliationManifestPath) {
    const reconciliation = JSON.parse(
      await readFile(bbbReconciliationManifestPath, "utf8"),
    );
    const reconciledCategoryKeys = (reconciliation.categories ?? [])
      .map((category) => category?.categoryKey)
      .filter(Boolean)
      .sort();
    const reviewedCategoryKeys = [...expectedCategoryKeys].sort();
    if (
      reconciliation.schemaVersion !== "elephant.bbb-reconciliation.v1" ||
      reconciliation.county !== countyKey ||
      reconciliation.sourceAccessStatus !== "accessible" ||
      reconciliation.sourceAccessComplete !== true ||
      reconciliation.uniqueProfileCount !== bbbIndex.profiles.length ||
      reconciliation.profilesBytes !== bbbIntegrity.bytes ||
      reconciliation.profilesSha256 !== bbbIntegrity.sha256 ||
      reviewedCategoryKeys.length !== reconciledCategoryKeys.length ||
      reviewedCategoryKeys.some(
        (categoryKey, index) =>
          categoryKey !== reconciledCategoryKeys[index],
      )
    ) {
      throw new Error("BBB linkage input failed reconciliation-manifest verification");
    }
  }
  if (permitArtifactManifestPath) {
    const permitManifest = JSON.parse(
      await readFile(permitArtifactManifestPath, "utf8"),
    );
    const sourceReceipt = permitManifest.artifacts?.find(
      (artifact) => artifact?.path === permitSourceAdapter.artifactPath,
    );
    if (
      permitManifest.schemaVersion !== "elephant.permit-artifact-manifest.v1" ||
      permitManifest.countyKey !== countyKey ||
      !sourceReceipt ||
      sourceReceipt.privacy !== "private" ||
      sourceReceipt.bytes !== permitIntegrity.bytes ||
      sourceReceipt.sha256 !== permitIntegrity.sha256 ||
      !Number.isSafeInteger(sourceReceipt.rowCount)
    ) {
      throw new Error("BBB linkage input failed permit-manifest verification");
    }
    expectedPermitFeatureCount = sourceReceipt.rowCount;
  }
  const coverage = JSON.parse(await readFile(inputCoverage, "utf8"));
  if (coverage.county !== countyKey) {
    throw new Error(`BBB coverage county mismatch: ${coverage.county ?? "missing"}`);
  }
  const existingBbb = coverage.datasets?.find(
    (dataset) => dataset?.source === "bbb",
  );
  const existingPermits = coverage.datasets?.find(
    (dataset) => dataset?.source === "permits",
  );
  if (!existingPermits) {
    throw new Error("BBB linker requires permit dataset coverage");
  }
  await Promise.all([
    mkdir(path.dirname(outputParquet), { recursive: true }),
    mkdir(path.dirname(outputCoverage), { recursive: true }),
    mkdir(path.dirname(linksPath), { recursive: true }),
    mkdir(path.dirname(candidatesPath), { recursive: true }),
  ]);

  const linkedPropertyIds = new Set();
  const linkedBbbBusinessIds = new Set();
  const linkedBbbProfileIds = new Set();
  const contractorMatches = new Map();
  const contractorCandidates = new Map();
  const matchCache = new Map();
  const seenPermitIds = new Set();
  const links = createWriteStream(linksPath, { encoding: "utf8" });
  let linkedPermitCount = 0;
  let permitsWithoutProperty = 0;
  let permitsOnIneligibleProperty = 0;
  let permitsWithoutContractor = 0;
  let invalidParcelCount = 0;
  let malformedPermitCount = 0;
  let duplicatePermitCount = 0;

  const permitFeatureCount = await forEachPermitFeature(
    permitSourcePath,
    async (feature, featureCount) => {
      if (featureCount % 100_000 === 0) {
        progress({
          permitFeatureCount: featureCount,
          linkedPermitCount,
          linkedPropertyCount: linkedPropertyIds.size,
          acceptedContractorMatchCount: contractorMatches.size,
          reviewCandidateCount: contractorCandidates.size,
          permitsOnIneligibleProperty,
        });
      }
      const sourcePermit = permitSourceAdapter.parseFeature(feature);
      const attributes = sourcePermit.attributes;
      let parcelIdentifier;
      try {
        parcelIdentifier = permitSourceAdapter.normalizeParcelIdentifier(
          sourcePermit.parcelIdentifier,
        );
      } catch {
        invalidParcelCount += 1;
        return;
      }
      const property = propertyIndex.byParcel.get(parcelIdentifier);
      if (property && !property.hasPermits) {
        permitsOnIneligibleProperty += 1;
        return;
      }
      let normalizedPermit;
      try {
        normalizedPermit = permitSourceAdapter.validateFeature(feature, {
          parcelIdentifier,
          propertyId: property?.propertyId ?? null,
        });
      } catch {
        malformedPermitCount += 1;
        return;
      }
      if (seenPermitIds.has(normalizedPermit.property_improvement_id)) {
        duplicatePermitCount += 1;
        return;
      }
      seenPermitIds.add(normalizedPermit.property_improvement_id);
      if (!property) {
        permitsWithoutProperty += 1;
        return;
      }
      const propertyId = property.propertyId;
      const contractor = normalizePermitContractorIdentity(attributes);
      if (!contractor.businessName || !contractor.strictName) {
        permitsWithoutContractor += 1;
        return;
      }
      const cacheKey = [
        contractor.sourceCompanyId ?? "",
        contractor.strictName,
        contractor.license ?? "",
        contractor.phone ?? "",
      ].join("\u0000");
      let match = matchCache.get(cacheKey);
      if (!match) {
        match = matchPermitContractor(contractor, bbbIndex, {
          fuzzyThreshold,
          fuzzyMargin,
        });
        matchCache.set(cacheKey, match);
        if (match.status === "accepted") {
          const business = bbbIndex.businesses.get(match.bbbBusinessId);
          contractorMatches.set(cacheKey, {
            sourceCompanyId: contractor.sourceCompanyId,
            businessName: contractor.businessName,
            bbbBusinessId: match.bbbBusinessId,
            bbbBusinessName: [...(business?.names ?? [])][0] ?? null,
            method: match.method,
            confidence: match.confidence,
            permitCount: 0,
            propertyIds: new Set(),
          });
        } else if (match.status === "review" || match.status === "ambiguous") {
          contractorCandidates.set(cacheKey, {
            status: match.status,
            sourceCompanyId: contractor.sourceCompanyId,
            businessName: contractor.businessName,
            method: match.method,
            confidence: match.confidence,
            candidate: match.candidate,
            runnerUp: match.runnerUp,
            permitCount: 0,
          });
        }
      }
      if (match.status !== "accepted") {
        const candidate = contractorCandidates.get(cacheKey);
        if (candidate) candidate.permitCount += 1;
        return;
      }
      const business = bbbIndex.businesses.get(match.bbbBusinessId);
      linkedPropertyIds.add(propertyId);
      linkedBbbBusinessIds.add(match.bbbBusinessId);
      for (const profileId of business?.profileIds ?? []) {
        linkedBbbProfileIds.add(profileId);
      }
      linkedPermitCount += 1;
      const contractorMatch = contractorMatches.get(cacheKey);
      contractorMatch.permitCount += 1;
      contractorMatch.propertyIds.add(propertyId);
      await writeJsonLine(links, {
        schemaVersion: "elephant.bbb-property-link.v1",
        county: countyKey,
        property_id: propertyId,
        parcel_identifier: parcelIdentifier,
        permit_source_record_id: sourcePermit.sourceRecordId,
        permit_number: sourcePermit.permitNumber,
        permit_company_id: contractor.sourceCompanyId,
        permit_contractor_name: contractor.businessName,
        bbb_business_id: match.bbbBusinessId,
        bbb_business_name: [...(business?.names ?? [])][0] ?? null,
        bbb_profile_ids: [...(business?.profileIds ?? [])].sort(),
        match_method: match.method,
        confidence: match.confidence,
      });
    },
  );
  await closeStream(links);
  if (
    expectedPermitFeatureCount !== null &&
    permitFeatureCount !== expectedPermitFeatureCount
  ) {
    throw new Error(
      `BBB linker expected ${expectedPermitFeatureCount} permit features, received ${permitFeatureCount}`,
    );
  }
  const excludedPermitCount =
    invalidParcelCount +
    permitsOnIneligibleProperty +
    malformedPermitCount +
    duplicatePermitCount;
  const publishedPermitCount = permitFeatureCount - excludedPermitCount;
  const propertyLinkedPermitCount =
    publishedPermitCount - permitsWithoutProperty;
  if (
    existingPermits.expected_count !== permitFeatureCount ||
    existingPermits.ingested_count !== publishedPermitCount ||
    existingPermits.linked_property_count !== propertyLinkedPermitCount ||
    existingPermits.valid_unlinked_permit_count !== permitsWithoutProperty ||
    existingPermits.excluded_source_record_count !== excludedPermitCount
  ) {
    throw new Error("BBB linker failed permit-publication reconciliation");
  }

  const candidateBody = [...contractorCandidates.values()]
    .sort((left, right) => right.permitCount - left.permitCount)
    .map((candidate) => JSON.stringify({
      schemaVersion: "elephant.bbb-contractor-link-candidate.v1",
      ...candidate,
    }))
    .join("\n");
  await writeFile(
    candidatesPath,
    candidateBody ? `${candidateBody}\n` : "",
    "utf8",
  );

  const reader = await ParquetReader.openFile(inputParquet);
  const writer = await ParquetWriter.openFile(
    new ParquetSchema(structuredClone(schemaFields)),
    outputParquet,
  );
  let outputRowCount = 0;
  try {
    const cursor = reader.getCursor();
    let row = await cursor.next();
    while (row) {
      await writer.appendRow(
        toParquetRecord({
          ...row,
          has_bbb_contractor: linkedPropertyIds.has(String(row.property_id)),
        }),
      );
      outputRowCount += 1;
      row = await cursor.next();
    }
  } finally {
    await Promise.all([reader.close(), writer.close()]);
  }
  if (outputRowCount !== propertyIndex.rowCount) {
    throw new Error(
      `BBB property rewrite expected ${propertyIndex.rowCount} rows, wrote ${outputRowCount}`,
    );
  }

  const matchMethodCounts = {};
  for (const match of contractorMatches.values()) {
    const counts = matchMethodCounts[match.method] ?? {
      contractor_identity_count: 0,
      permit_count: 0,
    };
    counts.contractor_identity_count += 1;
    counts.permit_count += match.permitCount;
    matchMethodCounts[match.method] = counts;
  }
  const ambiguousCandidateCount = [...contractorCandidates.values()].filter(
    (candidate) => candidate.status === "ambiguous",
  ).length;
  const updatedCoverage = upsertBbbCoverage(
    { ...coverage, exportedAt },
    {
      ...existingBbb,
      last_loaded_at: exportedAt,
      linked_property_count: linkedPropertyIds.size,
      linked_permit_count: linkedPermitCount,
      matched_permit_count: linkedPermitCount,
      linked_business_count: linkedBbbBusinessIds.size,
      total_business_count: bbbIndex.businesses.size,
      provider_business_count: bbbIndex.businesses.size,
      linked_provider_business_count: linkedBbbBusinessIds.size,
      valid_unlinked_provider_business_count:
        bbbIndex.businesses.size - linkedBbbBusinessIds.size,
      linked_profile_count: linkedBbbProfileIds.size,
      valid_unlinked_count:
        bbbIndex.profiles.length - linkedBbbProfileIds.size,
      property_linkage_status: "linked_via_permit_contractor",
      linkage_complete_within_scope: true,
      review_candidate_count: contractorCandidates.size,
      ambiguous_candidate_count: ambiguousCandidateCount,
      match_method_counts: matchMethodCounts,
      match_policy:
        "license_then_phone_then_unique_exact_normalized_business_name",
      linkage_temporal_basis:
        "current_bbb_snapshot_to_historical_permit_contractor_identity",
      asserts_bbb_status_at_permit_time: false,
      permit_source_sha256: permitIntegrity.sha256,
      contractor_evidence_privacy: "private",
    },
  );
  await writeFile(
    outputCoverage,
    `${JSON.stringify(updatedCoverage, null, 2)}\n`,
    "utf8",
  );

  const acceptedContractorMatches = [...contractorMatches.values()].map(
    (match) => ({
      ...match,
      linkedPropertyCount: match.propertyIds.size,
      propertyIds: undefined,
    }),
  );
  const [
    inputIntegrity,
    outputIntegrity,
    linksIntegrity,
    candidatesIntegrity,
  ] = await Promise.all([
    fileIntegrity(inputParquet),
    fileIntegrity(outputParquet),
    fileIntegrity(linksPath),
    fileIntegrity(candidatesPath),
  ]);
  const summary = {
    schemaVersion: "elephant.bbb-property-linkage.v1",
    county: countyKey,
    linkedAt: exportedAt,
    semantics:
      "has_bbb_contractor means a contractor identity on a linked permit matches a business in the current BBB snapshot; it does not assert BBB status at permit time",
    inputPropertyCount: propertyIndex.rowCount,
    outputPropertyCount: outputRowCount,
    permitFeatureCount,
    publishedPermitCount,
    propertyLinkedPermitCount,
    excludedPermitCount,
    permitsWithoutProperty,
    permitsOnIneligibleProperty,
    permitsWithoutContractor,
    invalidParcelCount,
    malformedPermitCount,
    duplicatePermitCount,
    bbbProfileCount: bbbIndex.profiles.length,
    bbbBusinessCount: bbbIndex.businesses.size,
    linkedBbbBusinessCount: linkedBbbBusinessIds.size,
    linkedBbbProfileCount: linkedBbbProfileIds.size,
    linkedPermitCount,
    linkedPropertyCount: linkedPropertyIds.size,
    acceptedContractorMatchCount: acceptedContractorMatches.length,
    reviewCandidateCount: contractorCandidates.size,
    ambiguousCandidateCount,
    acceptedContractorMatches,
    matchMethodCounts,
    matchPolicy: {
      cascade: [
        "exact_state_license",
        "exact_standardized_phone",
        "unique_exact_normalized_business_name",
      ],
      fuzzyCandidatesOnly: true,
      fuzzyThreshold,
      fuzzyMargin,
    },
    sourceVerification: {
      permitSourceAdapter: permitSourceAdapter.key,
      reviewedCategoryKeys: [...expectedCategoryKeys].sort(),
      bbbReconciliationManifestVerified:
        bbbReconciliationManifestPath !== null,
      permitArtifactManifestVerified:
        permitArtifactManifestPath !== null,
      expectedPermitFeatureCount,
    },
    artifacts: {
      inputParquet: inputIntegrity,
      outputParquet: outputIntegrity,
      bbbProfiles: bbbIntegrity,
      permitSource: permitIntegrity,
      links: linksIntegrity,
      candidates: candidatesIntegrity,
    },
  };
  await writeFile(manifestPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return { summary, coverage: updatedCoverage };
}
