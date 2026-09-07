import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

export const SUNBIZ_EXTRACT_SCHEMA_VERSION = "elephant.sunbiz-corporate-zip-extract.v1";

const STATUS_LABELS = new Map([
  ["A", "ACTIVE"],
  ["I", "INACTIVE"],
]);

const FILING_TYPE_LABELS = new Map([
  ["DOMP", "Domestic Profit"],
  ["DOMNP", "Domestic Non-Profit"],
  ["FORP", "Foreign Profit"],
  ["FORNP", "Foreign Non-Profit"],
  ["DOMLP", "Domestic Limited Partnership"],
  ["FORLP", "Foreign Limited Partnership"],
  ["FLAL", "Florida Limited Liability Company"],
  ["FORL", "Foreign Limited Liability Company"],
  ["NPREG", "Non-Profit Registration"],
  ["TRUST", "Declaration of Trust"],
  ["AGENT", "Designation of Registered Agent"],
]);

const CORPORATE_FIELDS = [
  ["documentNumber", 1, 12],
  ["entityName", 13, 192],
  ["statusCode", 205, 1],
  ["filingTypeCode", 206, 15],
  ["address1", 221, 42],
  ["address2", 263, 42],
  ["city", 305, 28],
  ["state", 333, 2],
  ["zip", 335, 10],
  ["country", 345, 2],
  ["mailAddress1", 347, 42],
  ["mailAddress2", 389, 42],
  ["mailCity", 431, 28],
  ["mailState", 459, 2],
  ["mailZip", 461, 10],
  ["mailCountry", 471, 2],
  ["filedDate", 473, 8],
  ["feiNumber", 481, 14],
  ["moreThanSixOfficersFlag", 495, 1],
  ["lastTransactionDate", 496, 8],
  ["stateCountry", 504, 2],
  ["reportYear1", 506, 4],
  ["reportDate1", 511, 8],
  ["reportYear2", 519, 4],
  ["reportDate2", 524, 8],
  ["reportYear3", 532, 4],
  ["reportDate3", 537, 8],
  ["registeredAgentName", 545, 42],
  ["registeredAgentType", 587, 1],
  ["registeredAgentAddress", 588, 42],
  ["registeredAgentCity", 630, 28],
  ["registeredAgentState", 658, 2],
  ["registeredAgentZip", 660, 9],
];

const OFFICER_FIELDS = [
  [669, 673, 674, 716, 758, 786, 788],
  [797, 801, 802, 844, 886, 914, 916],
  [925, 929, 930, 972, 1014, 1042, 1044],
  [1053, 1057, 1058, 1100, 1142, 1170, 1172],
  [1181, 1185, 1186, 1228, 1270, 1298, 1300],
  [1309, 1313, 1314, 1356, 1398, 1426, 1428],
];

function cleanText(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : null;
}

function readFixedField(line, start, length) {
  return line.slice(start - 1, start - 1 + length).trim();
}

function parseDate(value) {
  if (!/^\d{8}$/.test(value)) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

export function normalizeSunbizAddress(value) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/\bSTREET\b/g, "ST")
    .replace(/\bAVENUE\b/g, "AVE")
    .replace(/\bDRIVE\b/g, "DR")
    .replace(/\bROAD\b/g, "RD")
    .replace(/\bBOULEVARD\b/g, "BLVD")
    .replace(/\bPARKWAY\b/g, "PKWY")
    .replace(/\bLANE\b/g, "LN")
    .replace(/\bCOURT\b/g, "CT")
    .replace(/\bPLACE\b/g, "PL")
    .replace(/\bNORTH\b/g, "N")
    .replace(/\bSOUTH\b/g, "S")
    .replace(/\bEAST\b/g, "E")
    .replace(/\bWEST\b/g, "W")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildAddress({ line1, line2 = null, city, state, zip, country = null }) {
  const singleLine = [line1, line2, city, state, zip, country]
    .map(cleanText)
    .filter(Boolean)
    .join(" ");
  return {
    line1: cleanText(line1),
    line2: cleanText(line2),
    city: cleanText(city),
    state: cleanText(state),
    zip: cleanText(zip),
    country: cleanText(country),
    singleLine,
    normalized: normalizeSunbizAddress(singleLine),
  };
}

export function parseCorporateDataRecord(line) {
  const fields = {};
  for (const [key, start, length] of CORPORATE_FIELDS) {
    fields[key] = readFixedField(line, start, length);
  }
  const documentNumber = fields.documentNumber.trim();
  if (documentNumber.length === 0) return null;

  const officers = OFFICER_FIELDS.flatMap(
    ([titleStart, typeStart, nameStart, addressStart, cityStart, stateStart, zipStart], index) => {
      const officer = {
        ordinal: index + 1,
        title: cleanText(readFixedField(line, titleStart, 4)),
        type: cleanText(readFixedField(line, typeStart, 1)),
        name: cleanText(readFixedField(line, nameStart, 42)),
        address: buildAddress({
          line1: readFixedField(line, addressStart, 42),
          city: readFixedField(line, cityStart, 28),
          state: readFixedField(line, stateStart, 2),
          zip: readFixedField(line, zipStart, 9),
        }),
      };
      return officer.title || officer.type || officer.name || officer.address.singleLine
        ? [officer]
        : [];
    },
  );
  const statusCode = cleanText(fields.statusCode);
  const filingTypeCode = cleanText(fields.filingTypeCode);

  return {
    schemaVersion: "elephant.sunbiz-corporate-record.v1",
    source: "florida-sunbiz-corporate-bulk",
    documentNumber,
    entityName: cleanText(fields.entityName),
    statusCode,
    status: statusCode ? (STATUS_LABELS.get(statusCode) ?? statusCode) : null,
    filingTypeCode,
    filingType: filingTypeCode
      ? (FILING_TYPE_LABELS.get(filingTypeCode) ?? filingTypeCode)
      : null,
    principalAddress: buildAddress({
      line1: fields.address1,
      line2: fields.address2,
      city: fields.city,
      state: fields.state,
      zip: fields.zip,
      country: fields.country,
    }),
    mailingAddress: buildAddress({
      line1: fields.mailAddress1,
      line2: fields.mailAddress2,
      city: fields.mailCity,
      state: fields.mailState,
      zip: fields.mailZip,
      country: fields.mailCountry,
    }),
    filedDate: parseDate(fields.filedDate),
    feiNumber: cleanText(fields.feiNumber),
    moreThanSixOfficers: fields.moreThanSixOfficersFlag.toUpperCase() === "Y",
    lastTransactionDate: parseDate(fields.lastTransactionDate),
    stateCountry: cleanText(fields.stateCountry),
    annualReports: [1, 2, 3].map((index) => ({
      year: cleanText(fields[`reportYear${index}`]),
      date: parseDate(fields[`reportDate${index}`]),
    })),
    registeredAgent: {
      name: cleanText(fields.registeredAgentName),
      type: cleanText(fields.registeredAgentType),
      address: buildAddress({
        line1: fields.registeredAgentAddress,
        city: fields.registeredAgentCity,
        state: fields.registeredAgentState,
        zip: fields.registeredAgentZip,
      }),
    },
    officers,
    rawRecordLength: line.length,
  };
}

export function normalizeZipPrefixes(zipPrefixes) {
  if (!Array.isArray(zipPrefixes)) {
    throw new Error("zipPrefixes is required");
  }
  const normalized = [
    ...new Set(
      zipPrefixes
        .map((value) => String(value).replace(/\D+/g, "").slice(0, 5))
        .filter(Boolean),
    ),
  ];
  if (normalized.length === 0) {
    throw new Error("At least one ZIP prefix is required");
  }
  return normalized;
}

function addressZipMatch(address, zipPrefixes) {
  const zip = String(address.zip ?? "").replace(/\D+/g, "");
  const matchedZipPrefix = zipPrefixes.find((prefix) => zip.startsWith(prefix));
  return matchedZipPrefix ? { zip, matchedZipPrefix } : null;
}

export function findZipMatchedAddresses(record, zipPrefixes) {
  if (record === null) return [];
  const normalizedPrefixes = normalizeZipPrefixes(zipPrefixes);
  const matches = [];
  const add = (role, address, officer = null) => {
    const zipMatch = addressZipMatch(address, normalizedPrefixes);
    if (!zipMatch) return;
    matches.push({
      role,
      ...zipMatch,
      officerOrdinal: officer?.ordinal ?? null,
      officerTitle: officer?.title ?? null,
      officerName:
        officer?.name ??
        (role === "registeredAgentAddress" ? record.registeredAgent.name : null),
      address,
    });
  };
  add("principalAddress", record.principalAddress);
  add("mailingAddress", record.mailingAddress);
  add("registeredAgentAddress", record.registeredAgent.address);
  for (const officer of record.officers) {
    add("officerAddress", officer.address, officer);
  }
  return matches;
}

async function existingOutputEntries(outputDir) {
  try {
    return await readdir(outputDir);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

export async function filterSunbizDirectory({
  countyKey,
  sourceDir,
  outputDir,
  zipPrefixes,
  chunkRecordLimit = 5_000,
  maxRecords = null,
  maxSourceRecords = null,
  jobId,
  quarter,
}) {
  if (
    typeof countyKey !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(countyKey)
  ) {
    throw new Error("filterSunbizDirectory requires a valid countyKey");
  }
  const existing = await existingOutputEntries(outputDir);
  if (existing.length > 0) {
    throw new Error(`Sunbiz output directory is not empty: ${outputDir}`);
  }
  if (!Number.isInteger(chunkRecordLimit) || chunkRecordLimit <= 0) {
    throw new Error("chunkRecordLimit must be a positive integer");
  }
  if (maxRecords !== null && (!Number.isInteger(maxRecords) || maxRecords <= 0)) {
    throw new Error("maxRecords must be null or a positive integer");
  }
  if (
    maxSourceRecords !== null &&
    (!Number.isInteger(maxSourceRecords) || maxSourceRecords <= 0)
  ) {
    throw new Error("maxSourceRecords must be null or a positive integer");
  }

  const sourceFiles = (await readdir(sourceDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^cordata.*\.txt$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (sourceFiles.length === 0) {
    throw new Error(`No cordata*.txt files found in ${sourceDir}`);
  }

  const prefixes = normalizeZipPrefixes(zipPrefixes);
  const chunksDir = path.join(outputDir, "chunks");
  await mkdir(chunksDir, { recursive: true });
  const chunks = [];
  const sourceReceipts = [];
  let pending = [];
  let sourceRecordsRead = 0;
  let invalidRecordCount = 0;
  let matchedRecordCount = 0;
  let stoppedAfterMaxRecords = false;

  async function flushChunk() {
    if (pending.length === 0) return;
    const relativePath = `chunks/part-${String(chunks.length).padStart(5, "0")}.jsonl`;
    const body = pending.map((record) => JSON.stringify(record)).join("\n") + "\n";
    await writeFile(path.join(outputDir, relativePath), body, "utf8");
    chunks.push({
      relativePath,
      recordCount: pending.length,
      bytes: Buffer.byteLength(body),
      sha256: createHash("sha256").update(body).digest("hex"),
    });
    pending = [];
  }

  for (const sourceFileName of sourceFiles) {
    if (stoppedAfterMaxRecords) break;
    const sourcePath = path.join(sourceDir, sourceFileName);
    const sourceHash = createHash("sha256");
    const input = createReadStream(sourcePath, { encoding: "utf8" });
    input.on("data", (chunk) => sourceHash.update(chunk));
    const reader = createInterface({ input, crlfDelay: Infinity });
    let sourceLineNumber = 0;
    for await (const line of reader) {
      if (
        (maxRecords !== null && matchedRecordCount >= maxRecords) ||
        (maxSourceRecords !== null && sourceRecordsRead >= maxSourceRecords)
      ) {
        stoppedAfterMaxRecords = true;
        reader.close();
        input.destroy();
        break;
      }
      sourceLineNumber += 1;
      sourceRecordsRead += 1;
      const entity = parseCorporateDataRecord(line);
      if (entity === null) {
        invalidRecordCount += 1;
        continue;
      }
      const matchedAddresses = findZipMatchedAddresses(entity, prefixes);
      if (matchedAddresses.length === 0) continue;
      matchedRecordCount += 1;
      pending.push({ sourceFileName, sourceLineNumber, entity, matchedAddresses });
      if (pending.length >= chunkRecordLimit) await flushChunk();
    }
    const fileStat = await stat(sourcePath);
    sourceReceipts.push({
      sourceFileName,
      bytes: fileStat.size,
      sha256: stoppedAfterMaxRecords ? null : sourceHash.digest("hex"),
      fullyScanned: !stoppedAfterMaxRecords,
    });
  }
  await flushChunk();

  const manifest = {
    schemaVersion: SUNBIZ_EXTRACT_SCHEMA_VERSION,
    jobId,
    county: countyKey,
    quarter,
    source: "florida-sunbiz-corporate-bulk",
    retrievedAt: new Date().toISOString(),
    zipPrefixes: prefixes,
    sourceRecordsRead,
    invalidRecordCount,
    matchedRecordCount,
    chunkRecordLimit,
    maxRecords,
    maxSourceRecords,
    completeSourceScan: !stoppedAfterMaxRecords,
    sourceFiles: sourceReceipts,
    chunks,
  };
  await writeFile(
    path.join(outputDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}

function shortHash(parts) {
  return createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 24);
}

function splitZip(zip) {
  const digits = String(zip ?? "").replace(/\D+/g, "");
  return {
    postalCode: digits.length >= 5 ? digits.slice(0, 5) : null,
    plusFour: digits.length >= 9 ? digits.slice(5, 9) : null,
  };
}

function addressIdentifier(address) {
  return `sunbiz:address:${shortHash([
    address.normalized,
    address.state ?? "",
    address.zip ?? "",
    address.country ?? "",
  ])}`;
}

function toAddressRecord(address) {
  if (!address?.singleLine) return null;
  const { postalCode, plusFour } = splitZip(address.zip);
  return {
    source_http_request: {
      method: "GET",
      url: "https://dos.fl.gov/sunbiz/other-services/data-downloads/",
    },
    request_identifier: addressIdentifier(address),
    unnormalized_address: address.singleLine,
    city_name: address.city ? normalizeSunbizAddress(address.city) : null,
    state_code: address.state?.toUpperCase() ?? null,
    postal_code: postalCode,
    plus_four_postal_code: plusFour,
    country_code: address.country?.toUpperCase() ?? null,
  };
}

function compactRecord(record) {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== null && value !== undefined),
  );
}

export function transformSunbizRecord(record) {
  const entity = record.entity;
  if (
    !entity ||
    typeof entity.documentNumber !== "string" ||
    entity.documentNumber.length === 0 ||
    !Array.isArray(record.matchedAddresses)
  ) {
    throw new Error("Invalid Sunbiz extract record");
  }
  const documentNumber = entity.documentNumber;
  const companyId = `sunbiz:${documentNumber}:company`;
  const registrationId = `sunbiz:${documentNumber}:business_registration`;
  const annualReports = entity.annualReports ?? [];
  const classes = {
    company: [
      {
        source_http_request: {
          method: "GET",
          url: "https://dos.fl.gov/sunbiz/other-services/data-downloads/",
        },
        request_identifier: companyId,
        name: entity.entityName ?? documentNumber,
      },
    ],
    business_registration: [
      compactRecord({
        request_identifier: registrationId,
        source_system: "SUNBIZ",
        source_file_name: record.sourceFileName,
        source_line_number: record.sourceLineNumber,
        document_number: documentNumber,
        entity_name: entity.entityName,
        status_code: entity.statusCode,
        status: entity.status,
        filing_type_code: entity.filingTypeCode,
        filing_type: entity.filingType,
        filed_date: entity.filedDate,
        fei_number: entity.feiNumber,
        last_transaction_date: entity.lastTransactionDate,
        state_country: entity.stateCountry,
        annual_report_1_year: annualReports[0]?.year ?? null,
        annual_report_1_date: annualReports[0]?.date ?? null,
        annual_report_2_year: annualReports[1]?.year ?? null,
        annual_report_2_date: annualReports[1]?.date ?? null,
        annual_report_3_year: annualReports[2]?.year ?? null,
        annual_report_3_date: annualReports[2]?.date ?? null,
        more_than_six_officers: entity.moreThanSixOfficers,
        raw_record_length: entity.rawRecordLength,
        matched_address_roles: [
          ...new Set(record.matchedAddresses.map((match) => match.role)),
        ].sort(),
        matched_zip_prefixes: [
          ...new Set(
            record.matchedAddresses.map((match) => match.matchedZipPrefix),
          ),
        ].sort(),
      }),
    ],
    business_registration_address: [],
    business_registration_party: [],
    address: [],
  };
  const relationships = {
    company_has_business_registration: [
      {
        relationship_type: "company_has_business_registration",
        from: { type: "company", request_identifier: companyId },
        to: { type: "business_registration", request_identifier: registrationId },
      },
    ],
    business_registration_has_address: [],
    business_registration_address_has_address: [],
    business_registration_has_party: [],
    business_registration_party_has_address: [],
  };

  const addRelationship = (type, fromType, fromId, toType, toId) => {
    relationships[type].push({
      relationship_type: type,
      from: { type: fromType, request_identifier: fromId },
      to: { type: toType, request_identifier: toId },
    });
  };
  const addAddress = (address) => {
    const value = toAddressRecord(address);
    if (value) classes.address.push(value);
    return value;
  };
  const addRegistrationAddress = (sourceRole, addressRole, address) => {
    const addressRecord = addAddress(address);
    if (!addressRecord) return;
    const bridgeId = `${registrationId}:address:${addressRole.toLowerCase()}`;
    classes.business_registration_address.push({
      request_identifier: bridgeId,
      source_system: "SUNBIZ",
      document_number: documentNumber,
      address_role: addressRole,
      matched_zip_prefixes: [
        ...new Set(
          record.matchedAddresses
            .filter((match) => match.role === sourceRole)
            .map((match) => match.matchedZipPrefix),
        ),
      ].sort(),
    });
    addRelationship(
      "business_registration_has_address",
      "business_registration",
      registrationId,
      "business_registration_address",
      bridgeId,
    );
    addRelationship(
      "business_registration_address_has_address",
      "business_registration_address",
      bridgeId,
      "address",
      addressRecord.request_identifier,
    );
  };
  addRegistrationAddress("principalAddress", "PRINCIPAL", entity.principalAddress);
  addRegistrationAddress("mailingAddress", "MAILING", entity.mailingAddress);

  const addParty = ({ role, name, type, title, ordinal, address, matchedRole }) => {
    if (!name) return;
    const partyId = `${registrationId}:party:${role.toLowerCase()}:${shortHash([
      name,
      type ?? "",
      title ?? "",
      ordinal ?? "",
    ])}`;
    classes.business_registration_party.push(
      compactRecord({
        request_identifier: partyId,
        source_system: "SUNBIZ",
        document_number: documentNumber,
        party_role: role,
        name,
        party_type_code: type,
        title,
        officer_ordinal: ordinal,
        matched_zip_prefixes: [
          ...new Set(
            record.matchedAddresses
              .filter(
                (match) =>
                  match.role === matchedRole &&
                  (ordinal === null || match.officerOrdinal === ordinal),
              )
              .map((match) => match.matchedZipPrefix),
          ),
        ].sort(),
      }),
    );
    addRelationship(
      "business_registration_has_party",
      "business_registration",
      registrationId,
      "business_registration_party",
      partyId,
    );
    const addressRecord = addAddress(address);
    if (addressRecord) {
      addRelationship(
        "business_registration_party_has_address",
        "business_registration_party",
        partyId,
        "address",
        addressRecord.request_identifier,
      );
    }
  };
  addParty({
    role: "REGISTERED_AGENT",
    name: entity.registeredAgent?.name ?? null,
    type: entity.registeredAgent?.type ?? null,
    title: null,
    ordinal: null,
    address: entity.registeredAgent?.address,
    matchedRole: "registeredAgentAddress",
  });
  for (const officer of entity.officers ?? []) {
    addParty({
      role: "OFFICER",
      name: officer.name,
      type: officer.type,
      title: officer.title,
      ordinal: officer.ordinal,
      address: officer.address,
      matchedRole: "officerAddress",
    });
  }
  return { classes, relationships };
}

function createBufferedWriter({ outputDir, dataset, partRecordLimit }) {
  let partIndex = 0;
  let records = [];
  const receipts = [];
  return {
    async write(record) {
      records.push(record);
      if (records.length >= partRecordLimit) await this.flush();
    },
    async flush() {
      if (records.length === 0) return;
      const relativePath = `${dataset}/part-${String(partIndex).padStart(5, "0")}.jsonl`;
      const body = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
      await mkdir(path.dirname(path.join(outputDir, relativePath)), {
        recursive: true,
      });
      await writeFile(path.join(outputDir, relativePath), body, "utf8");
      receipts.push({
        dataset,
        partIndex,
        recordCount: records.length,
        relativePath,
        bytes: Buffer.byteLength(body),
        sha256: createHash("sha256").update(body).digest("hex"),
      });
      partIndex += 1;
      records = [];
    },
    async close() {
      await this.flush();
      return receipts;
    },
  };
}

export async function transformSunbizExtract({
  inputDir,
  outputDir,
  partRecordLimit = 5_000,
  allowIncomplete = false,
}) {
  const existing = await existingOutputEntries(outputDir);
  if (existing.length > 0) {
    throw new Error(`Sunbiz transform output directory is not empty: ${outputDir}`);
  }
  const extractManifest = JSON.parse(
    await readFile(path.join(inputDir, "manifest.json"), "utf8"),
  );
  if (extractManifest.schemaVersion !== SUNBIZ_EXTRACT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported Sunbiz extract schema: ${extractManifest.schemaVersion ?? "missing"}`,
    );
  }
  if (!extractManifest.completeSourceScan && !allowIncomplete) {
    throw new Error("Refusing to transform an incomplete Sunbiz source scan");
  }

  const datasetNames = [
    "classes/company",
    "classes/business_registration",
    "classes/business_registration_address",
    "classes/business_registration_party",
    "classes/address",
    "relationships/company_has_business_registration",
    "relationships/business_registration_has_address",
    "relationships/business_registration_address_has_address",
    "relationships/business_registration_has_party",
    "relationships/business_registration_party_has_address",
  ];
  const writers = Object.fromEntries(
    datasetNames.map((dataset) => [
      dataset,
      createBufferedWriter({ outputDir, dataset, partRecordLimit }),
    ]),
  );
  const seen = new Set();
  const counters = {
    sourceRecordCount: 0,
    transformedRecordCount: 0,
    invalidRecordCount: 0,
    companyCount: 0,
    businessRegistrationCount: 0,
    businessRegistrationAddressCount: 0,
    businessRegistrationPartyCount: 0,
    addressCount: 0,
    relationshipCount: 0,
  };

  const writeUnique = async (dataset, identity, value) => {
    const key = `${dataset}:${identity}`;
    if (seen.has(key)) return;
    seen.add(key);
    await writers[dataset].write(value);
    if (dataset === "classes/company") counters.companyCount += 1;
    else if (dataset === "classes/business_registration")
      counters.businessRegistrationCount += 1;
    else if (dataset === "classes/business_registration_address")
      counters.businessRegistrationAddressCount += 1;
    else if (dataset === "classes/business_registration_party")
      counters.businessRegistrationPartyCount += 1;
    else if (dataset === "classes/address") counters.addressCount += 1;
    else counters.relationshipCount += 1;
  };

  let reconciledChunkRecordCount = 0;
  for (const chunk of extractManifest.chunks) {
    const body = await readFile(path.join(inputDir, chunk.relativePath), "utf8");
    const digest = createHash("sha256").update(body).digest("hex");
    if (digest !== chunk.sha256) {
      throw new Error(`Sunbiz chunk digest mismatch: ${chunk.relativePath}`);
    }
    const lines = body.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length !== chunk.recordCount) {
      throw new Error(
        `Sunbiz chunk record-count mismatch for ${chunk.relativePath}: ${lines.length} vs ${chunk.recordCount}`,
      );
    }
    reconciledChunkRecordCount += lines.length;
    for (const line of lines) {
      if (!line.trim()) continue;
      counters.sourceRecordCount += 1;
      try {
        const bundle = transformSunbizRecord(JSON.parse(line));
        for (const [className, records] of Object.entries(bundle.classes)) {
          for (const record of records) {
            await writeUnique(
              `classes/${className}`,
              record.request_identifier,
              record,
            );
          }
        }
        for (const [relationshipType, records] of Object.entries(
          bundle.relationships,
        )) {
          for (const record of records) {
            await writeUnique(
              `relationships/${relationshipType}`,
              shortHash([
                relationshipType,
                record.from.request_identifier,
                record.to.request_identifier,
              ]),
              record,
            );
          }
        }
        counters.transformedRecordCount += 1;
      } catch {
        counters.invalidRecordCount += 1;
      }
    }
  }
  if (reconciledChunkRecordCount !== extractManifest.matchedRecordCount) {
    throw new Error(
      `Sunbiz manifest reconciliation failed: ${reconciledChunkRecordCount} chunk rows vs ${extractManifest.matchedRecordCount} matched rows`,
    );
  }

  const outputParts = (
    await Promise.all(Object.values(writers).map((writer) => writer.close()))
  ).flat();
  const summary = {
    schemaVersion: "elephant.sunbiz-lexicon-transform.v1",
    transformedAt: new Date().toISOString(),
    sourceManifest: "manifest.json",
    county: extractManifest.county,
    quarter: extractManifest.quarter,
    complete:
      extractManifest.completeSourceScan &&
      counters.invalidRecordCount === 0 &&
      counters.transformedRecordCount === counters.sourceRecordCount,
    counters,
    outputParts,
  };
  await writeFile(
    path.join(outputDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );
  if (!summary.complete && !allowIncomplete) {
    throw new Error(
      `Sunbiz transform did not reconcile: ${counters.transformedRecordCount}/${counters.sourceRecordCount} transformed, ${counters.invalidRecordCount} invalid`,
    );
  }
  return summary;
}
