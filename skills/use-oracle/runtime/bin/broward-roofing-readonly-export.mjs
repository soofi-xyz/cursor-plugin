#!/usr/bin/env node

import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";

import pg from "pg";

import { browardPermitProfile } from "../src/counties/broward/permit-profile.mjs";
import { routePermitJurisdiction } from "../src/permits/normalization.mjs";
import {
  cohortInputRecordSchema,
  ROOFING_COHORT_INPUT_VERSION,
} from "../src/investigations/roofing-cohort-schema.mjs";

function usage() {
  return [
    "Export an exact, read-only private Broward evidence slice for offline analysis.",
    "",
    "  broward-roofing-readonly-export --database-url-env DATABASE_URL",
    "    --identity-evidence <official-identity-records.jsonl>",
    "    --output <new-private-evidence.jsonl>",
    "    --catalog-sha256 <sha256> --profile-sha256 <sha256>",
    "    --repository-commit <40-char-sha> [--as-of 2026-09-10]",
    "    --folio 504032160260 [--folio ...]",
    "    [--license CCC1234567 ...]",
    '    [--company-name "Exact Legal Company Name" ...]',
    "",
    "The database transaction is READ ONLY. The export excludes owners, applicants,",
    "contractor phone numbers, and contractor email addresses.",
    "It also exports independent Broward open-roofing candidates filed in",
    "2025-09-10..2026-09-10; contractor assignment is evaluated separately.",
  ].join("\n");
}

function parseArguments(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const allowed = new Set([
    "--database-url-env",
    "--identity-evidence",
    "--output",
    "--catalog-sha256",
    "--profile-sha256",
    "--repository-commit",
    "--as-of",
    "--folio",
    "--license",
    "--company-name",
  ]);
  const values = new Map();
  const folios = [];
  const licenses = [];
  const companyNames = [];
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!allowed.has(key)) throw new Error(`Unknown option "${key}"`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${key}`);
    }
    if (key === "--folio") {
      const folio = value.trim().toUpperCase();
      if (!/^[A-Z0-9]{12}$/.test(folio)) {
        throw new Error(`Invalid folio "${value}"`);
      }
      folios.push(folio);
    } else if (key === "--license") licenses.push(normalizeLicense(value));
    else if (key === "--company-name") {
      const companyName = value.trim();
      if (!companyName) throw new Error("--company-name cannot be blank");
      companyNames.push(companyName);
    }
    else values.set(key, value);
    index += 1;
  }
  for (const key of [
    "--database-url-env",
    "--identity-evidence",
    "--output",
    "--catalog-sha256",
    "--profile-sha256",
    "--repository-commit",
  ]) {
    if (!values.has(key)) throw new Error(`${key} is required`);
  }
  if (folios.length === 0) {
    throw new Error("At least one --folio seed is required");
  }
  return {
    help: false,
    databaseUrlEnv: values.get("--database-url-env"),
    identityEvidencePath: values.get("--identity-evidence"),
    outputPath: values.get("--output"),
    catalogSha256: values.get("--catalog-sha256"),
    profileSha256: values.get("--profile-sha256"),
    repositoryCommit: values.get("--repository-commit"),
    asOfDate: values.get("--as-of") ?? "2026-09-10",
    folios: [...new Set(folios)],
    licenses,
    companyNames: [...new Set(companyNames)],
  };
}

function normalizeLicense(value) {
  const license = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (!/^(?:CCC|RC)\d+$/.test(license)) {
    throw new Error(`Not a roofing credential: ${value}`);
  }
  return license;
}

function normalizeCompanyName(value) {
  const companyName = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (!companyName) throw new Error("Company name cannot normalize to blank");
  return companyName;
}

function isoDate(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function sha256(value) {
  return createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
}

const LEAD_WINDOW_START = "2025-09-10";
const CONTRACTOR_FIELD =
  /contractor|roofer|license|qualifier|licensed[\s_-]?professional|owner[\s_-]?builder/i;
const CONTACT_COLLECTION =
  /^(?:contacts?|contractors?|licensed[\s_-]?professionals?)$/i;
const OWNER_BUILDER_VALUE = /\bowner[\s-]?builder\b/i;
const CONTRACTOR_ROLE_VALUE =
  /\b(?:contractor|roofer|qualif|licensed[\s-]?professional)\b/i;
const WITHHELD_VALUE =
  /\b(?:not\s+published|unavailable|withheld|redacted)\b/i;

function meaningfulAssignmentValue(value) {
  if (value === null || value === undefined || value === "") return false;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function inspectContractorAssignmentPayload(row) {
  const observed = new Set();
  const assigned = new Set();
  const ownerBuilder = new Set();
  let contactCollectionComplete = false;
  let sourceFieldsWithheld = false;
  const inspect = (value, path = []) => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        inspect(value[index], [...path, String(index)]);
      }
      return;
    }
    if (typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const childPath = [...path, key];
      const fieldPath = childPath.join(".");
      if (CONTACT_COLLECTION.test(key)) {
        observed.add(fieldPath);
        if (Array.isArray(child)) contactCollectionComplete = true;
        if (/contractors?|licensed/i.test(key) && child.length > 0) {
          assigned.add(fieldPath);
        }
      }
      if (CONTRACTOR_FIELD.test(key)) {
        observed.add(fieldPath);
        if (
          typeof child === "string" &&
          WITHHELD_VALUE.test(child)
        ) {
          sourceFieldsWithheld = true;
        } else if (
          meaningfulAssignmentValue(child) &&
          OWNER_BUILDER_VALUE.test(`${key} ${String(child)}`)
        ) {
          ownerBuilder.add(fieldPath);
        } else if (meaningfulAssignmentValue(child)) {
          assigned.add(fieldPath);
        }
      }
      if (
        /^(?:role|contactType|type)$/i.test(key) &&
        typeof child === "string" &&
        CONTRACTOR_ROLE_VALUE.test(child)
      ) {
        observed.add(fieldPath);
        assigned.add(fieldPath);
      }
      if (
        typeof child === "string" &&
        OWNER_BUILDER_VALUE.test(child) &&
        /contact|contractor|builder/i.test(fieldPath)
      ) {
        observed.add(fieldPath);
        ownerBuilder.add(fieldPath);
      }
      inspect(child, childPath);
    }
  };
  inspect(row.source_payload, ["sourcePayload"]);
  inspect(row.more_details, ["moreDetails"]);
  const sourcePayloadChecked =
    row.source_payload !== null || row.more_details !== null;
  const detailCaptured = Boolean(
    row.source_artifact_uri || sourcePayloadChecked,
  );
  return {
    detailCaptured,
    contactCollectionComplete,
    sourcePayloadChecked,
    sourceFieldsWithheld,
    observedContractorFields: [...observed].sort(),
    assignedContractorFields: [...assigned].sort(),
    ownerBuilderFields: [...ownerBuilder].sort(),
    directContractorCompanyIdPresent: Boolean(
      row.contractor_company_id,
    ),
  };
}

function sourceMaps() {
  const map = new Map();
  for (const jurisdiction of browardPermitProfile.jurisdictions) {
    const routes = new Map(
      (jurisdiction.adapterRoutes ?? []).map((route) => [route.key, route]),
    );
    for (const source of jurisdiction.sources) {
      const route = routes.get(source.adapterRouteKey);
      const sourceSystem =
        route?.adapterConfig?.sourceSystem ??
        jurisdiction.adapterConfig?.sourceSystem ??
        `broward_${jurisdiction.key.replaceAll("-", "_")}_${source.key.replaceAll("-", "_")}`;
      map.set(sourceSystem, {
        authority: jurisdiction.key,
        jurisdictionKey: jurisdiction.key,
        sourceKey: source.key,
        sourceSystem,
        access:
          source.enumerationStatus === "blocked"
            ? jurisdiction.status === "custodian-only"
              ? "custodian-only"
              : source.access === "unavailable"
                ? "unavailable"
                : source.access === "manual-only"
                  ? "manual-only"
                  : "blocked"
            : "supported",
        predecessorComplete: !/predecessor|legacy/i.test(
          `${source.key} ${source.historicalBoundary}`,
        ),
      });
    }
  }
  return map;
}

const SOURCE_MAP = sourceMaps();

function sourceIdentity(sourceSystem, city = null) {
  const configured = SOURCE_MAP.get(sourceSystem);
  if (configured) return configured;
  const routed = routePermitJurisdiction(browardPermitProfile, city);
  const authority =
    routed?.key ??
    Object.keys({
      sunrise: true,
      "pembroke-pines": true,
      "southwest-ranches": true,
      "fort-lauderdale": true,
    }).find((key) =>
      sourceSystem.includes(key.replaceAll("-", "_")),
    ) ??
    "unincorporated-broward";
  return {
    authority,
    jurisdictionKey: authority,
    sourceKey: "private-query-db",
    sourceSystem,
    access: "supported",
    predecessorComplete: false,
  };
}

async function requireAbsent(filePath) {
  try {
    await access(filePath);
    throw new Error(`Output already exists: ${filePath}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function parseIdentityEvidence(bytes) {
  return bytes
    .toString("utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        const parsed = cohortInputRecordSchema.parse(JSON.parse(line));
        if (parsed.recordType !== "license_identity") {
          throw new Error("recordType must be license_identity");
        }
        return parsed;
      } catch (error) {
        throw new Error(
          `Identity evidence line ${index + 1}: ${error.message}`,
        );
      }
    });
}

const REQUIRED_COLUMNS = Object.freeze({
  addresses: ["address_id", "city_name", "unnormalized_address"],
  companies: ["company_id", "name"],
  inspections: [
    "property_improvement_id",
    "inspection_type",
    "inspection_status",
    "result",
    "completed_date",
    "source_system",
    "source_record_key",
    "source_record_hash",
  ],
  permit_contacts: [
    "property_improvement_id",
    "contact_role",
    "raw_name",
    "company_id",
    "license_number",
    "license_type",
    "source_payload",
    "source_system",
    "source_record_key",
    "source_record_hash",
  ],
  permit_events: [
    "property_improvement_id",
    "event_type",
    "event_status",
    "event_date",
    "source_system",
    "source_record_key",
    "source_record_hash",
  ],
  properties: [
    "property_id",
    "address_id",
    "parcel_identifier",
    "property_usage_type",
    "property_structure_built_year",
    "source_system",
    "source_record_key",
  ],
  property_improvements: [
    "property_improvement_id",
    "property_id",
    "contractor_company_id",
    "parcel_identifier",
    "permit_number",
    "improvement_type",
    "improvement_status",
    "improvement_action",
    "application_received_date",
    "permit_issue_date",
    "final_inspection_date",
    "permit_close_date",
    "completion_date",
    "source_status",
    "record_status",
    "opened_date",
    "expiration_date",
    "work_location",
    "project_description",
    "description",
    "more_details",
    "source_payload",
    "source_system",
    "source_record_key",
    "source_record_hash",
    "source_artifact_uri",
  ],
});

async function assertSchema(client) {
  const tableNames = Object.keys(REQUIRED_COLUMNS);
  const result = await client.query(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])`,
    [tableNames],
  );
  const actual = new Set(
    result.rows.map((row) => `${row.table_name}.${row.column_name}`),
  );
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    for (const column of columns) {
      if (!actual.has(`${table}.${column}`)) {
        throw new Error(`Private query DB lacks ${table}.${column}`);
      }
    }
  }
}

const SELECTED_PERMITS_CTE = `
  WITH selected_permits AS (
    SELECT DISTINCT pi.property_improvement_id
      FROM public.property_improvements pi
      LEFT JOIN public.permit_contacts pc
        ON pc.property_improvement_id = pi.property_improvement_id
      LEFT JOIN public.companies c ON c.company_id = pc.company_id
     WHERE pi.parcel_identifier = ANY($1::text[])
        OR REGEXP_REPLACE(
             UPPER(COALESCE(pc.license_number, '')),
             '[^A-Z0-9]+', '', 'g'
           ) = ANY($2::text[])
        OR REGEXP_REPLACE(
             UPPER(COALESCE(c.name, '')),
             '[^A-Z0-9]+', '', 'g'
           ) = ANY($3::text[])
        OR (
             pi.source_system LIKE 'broward\\_%' ESCAPE '\\'
         AND GREATEST(
               pi.permit_issue_date,
               pi.opened_date,
               pi.application_received_date
             )::date BETWEEN $4::date AND $5::date
         AND CONCAT_WS(
               ' ',
               pi.improvement_status,
               pi.source_status,
               pi.record_status
             ) ~* '\\m(active|applied|application submitted|approved|in process|in review|issued|on hold|open|pending|permit issued|ready for issuance|ready to issue)\\M'
         AND CONCAT_WS(
               ' ',
               pi.improvement_type,
               pi.improvement_action,
               pi.project_description,
               pi.description,
               pi.more_details::text,
               pi.source_payload::text
             ) ~* '(roof|shingle|tile|membrane|bitumen)'
           )
  )`;

function selectedPermitParameters(
  folios,
  licenses,
  companyNames,
  asOfDate,
) {
  return [
    folios,
    licenses,
    companyNames.map(normalizeCompanyName),
    LEAD_WINDOW_START,
    asOfDate,
  ];
}

async function readPermits(
  client,
  folios,
  licenses,
  companyNames,
  asOfDate,
) {
  const result = await client.query(
    `${SELECTED_PERMITS_CTE}
     SELECT pi.*, a.city_name, a.unnormalized_address,
            count(pc.permit_contact_id)::int AS contact_count
       FROM selected_permits sp
       JOIN public.property_improvements pi
         ON pi.property_improvement_id = sp.property_improvement_id
       LEFT JOIN public.addresses a ON a.address_id = pi.address_id
       LEFT JOIN public.permit_contacts pc
         ON pc.property_improvement_id = pi.property_improvement_id
      GROUP BY pi.property_improvement_id, a.city_name, a.unnormalized_address
      ORDER BY pi.source_system, pi.source_record_key`,
    selectedPermitParameters(folios, licenses, companyNames, asOfDate),
  );
  return result.rows.map((row) => {
    const source = sourceIdentity(row.source_system, row.city_name);
    const evidenceSha256 =
      /^[a-f0-9]{64}$/.test(row.source_record_hash ?? "")
        ? row.source_record_hash
        : sha256(row);
    const contractorAssignmentEvidence =
      inspectContractorAssignmentPayload(row);
    return cohortInputRecordSchema.parse({
      recordType: "permit",
      propertyImprovementId: row.property_improvement_id,
      propertyId: row.property_id,
      parcelIdentifier: row.parcel_identifier,
      countyKey: "broward",
      authority: source.authority,
      jurisdictionKey: source.jurisdictionKey,
      sourceKey: source.sourceKey,
      sourceSystem: row.source_system,
      sourceRecordKey: row.source_record_key,
      permitNumber: row.permit_number,
      status: row.improvement_status,
      sourceStatus: row.source_status,
      recordStatus: row.record_status,
      permitType: row.improvement_type,
      workClass:
        row.more_details?.workClass ??
        row.source_payload?.workClass ??
        row.source_payload?.WorkClass ??
        null,
      scope:
        row.more_details?.scope ??
        row.source_payload?.scope ??
        row.source_payload?.Scope ??
        null,
      description: row.project_description ?? row.description,
      trade:
        row.more_details?.trade ??
        row.source_payload?.trade ??
        row.source_payload?.Trade ??
        null,
      action: row.improvement_action,
      workAddress: row.work_location ?? row.unnormalized_address,
      city: row.city_name,
      masterPermitNumber:
        row.source_payload?.masterPermitNumber ??
        row.source_payload?.MasterPermitNumber ??
        null,
      parentPermitNumber:
        row.source_payload?.parentPermitNumber ??
        row.source_payload?.ParentPermitNumber ??
        null,
      dates: {
        application: isoDate(row.application_received_date),
        opened: isoDate(row.opened_date),
        issued: isoDate(row.permit_issue_date),
        finalInspection: isoDate(row.final_inspection_date),
        completion: isoDate(row.completion_date),
        closed: isoDate(row.permit_close_date),
        expiration: isoDate(row.expiration_date),
      },
      detailComplete:
        contractorAssignmentEvidence.detailCaptured &&
        contractorAssignmentEvidence.contactCollectionComplete &&
        !contractorAssignmentEvidence.sourceFieldsWithheld,
      contractorAssignmentEvidence,
      sourceArtifactUri: row.source_artifact_uri,
      evidenceSha256,
    });
  });
}

async function readContacts(
  client,
  folios,
  licenses,
  companyNames,
  asOfDate,
) {
  const result = await client.query(
    `${SELECTED_PERMITS_CTE}
     SELECT pc.property_improvement_id, pc.contact_role, pc.raw_name,
            pc.company_id, c.name AS company_name, pc.license_number,
            pc.license_type, pc.source_payload, pc.source_system,
            pc.source_record_key, pc.source_record_hash
       FROM selected_permits sp
       JOIN public.permit_contacts pc
         ON pc.property_improvement_id = sp.property_improvement_id
       LEFT JOIN public.companies c ON c.company_id = pc.company_id
      ORDER BY pc.source_system, pc.source_record_key`,
    selectedPermitParameters(folios, licenses, companyNames, asOfDate),
  );
  return result.rows.map((row) =>
    cohortInputRecordSchema.parse({
      recordType: "permit_contact",
      propertyImprovementId: row.property_improvement_id,
      sourceSystem: row.source_system,
      sourceRecordKey: row.source_record_key,
      role: row.contact_role,
      name: row.raw_name,
      companyId: row.company_id,
      companyName: row.company_name,
      licenseNumber: row.license_number,
      licenseType: row.license_type,
      qualifierName:
        row.source_payload?.qualifierName ??
        row.source_payload?.qualifier ??
        null,
      evidenceSha256: /^[a-f0-9]{64}$/.test(
        row.source_record_hash ?? "",
      )
        ? row.source_record_hash
        : sha256(row),
    }),
  );
}

async function readEvents(
  client,
  folios,
  licenses,
  companyNames,
  asOfDate,
) {
  const result = await client.query(
    `${SELECTED_PERMITS_CTE}
     SELECT pe.property_improvement_id, pe.event_type, pe.event_status,
            pe.event_date, pe.source_system, pe.source_record_key,
            pe.source_record_hash
       FROM selected_permits sp
       JOIN public.permit_events pe
         ON pe.property_improvement_id = sp.property_improvement_id
      ORDER BY pe.source_system, pe.source_record_key`,
    selectedPermitParameters(folios, licenses, companyNames, asOfDate),
  );
  return result.rows.map((row) =>
    cohortInputRecordSchema.parse({
      recordType: "permit_event",
      propertyImprovementId: row.property_improvement_id,
      sourceSystem: row.source_system,
      sourceRecordKey: row.source_record_key,
      eventType: row.event_type,
      eventStatus: row.event_status,
      eventDate:
        row.event_date instanceof Date
          ? row.event_date.toISOString()
          : row.event_date,
      evidenceSha256: /^[a-f0-9]{64}$/.test(
        row.source_record_hash ?? "",
      )
        ? row.source_record_hash
        : sha256(row),
    }),
  );
}

async function readInspections(
  client,
  folios,
  licenses,
  companyNames,
  asOfDate,
) {
  const result = await client.query(
    `${SELECTED_PERMITS_CTE}
     SELECT i.property_improvement_id, i.inspection_type,
            i.inspection_status, i.result, i.completed_date,
            i.source_system, i.source_record_key, i.source_record_hash
       FROM selected_permits sp
       JOIN public.inspections i
         ON i.property_improvement_id = sp.property_improvement_id
      ORDER BY i.source_system, i.source_record_key`,
    selectedPermitParameters(folios, licenses, companyNames, asOfDate),
  );
  return result.rows.map((row) =>
    cohortInputRecordSchema.parse({
      recordType: "inspection",
      propertyImprovementId: row.property_improvement_id,
      sourceSystem: row.source_system,
      sourceRecordKey: row.source_record_key,
      inspectionType: row.inspection_type,
      status: row.inspection_status,
      result: row.result,
      completedDate: isoDate(row.completed_date),
      evidenceSha256: /^[a-f0-9]{64}$/.test(
        row.source_record_hash ?? "",
      )
        ? row.source_record_hash
        : sha256(row),
    }),
  );
}

async function readProperties(client, permits, folios) {
  const propertyIds = [
    ...new Set(permits.map((permit) => permit.propertyId).filter(Boolean)),
  ];
  const result = await client.query(
    `SELECT p.property_id, p.parcel_identifier, p.property_usage_type,
            p.property_structure_built_year, p.source_system,
            p.source_record_key, a.city_name, a.unnormalized_address
       FROM public.properties p
       LEFT JOIN public.addresses a ON a.address_id = p.address_id
      WHERE p.parcel_identifier = ANY($1::text[])
         OR p.property_id = ANY($2::uuid[])
      ORDER BY p.parcel_identifier`,
    [folios, propertyIds],
  );
  return result.rows.map((row) => {
    const authority =
      routePermitJurisdiction(browardPermitProfile, row.city_name)?.key ??
      null;
    return cohortInputRecordSchema.parse({
      recordType: "property",
      propertyId: row.property_id,
      parcelIdentifier: row.parcel_identifier,
      authority,
      address: row.unnormalized_address,
      city: row.city_name,
      usageType: row.property_usage_type,
      builtYear: row.property_structure_built_year,
      sourceSystem: row.source_system,
      sourceRecordKey: row.source_record_key,
      coverage: {
        fromDate: null,
        throughDate: null,
        authorityComplete: false,
        predecessorComplete: false,
        sourceSystems: [],
      },
    });
  });
}

async function readMatcherState(client, permits) {
  const ids = permits.map((permit) => permit.propertyImprovementId);
  const result = await client.query(
    `SELECT count(DISTINCT pi.property_improvement_id)::int AS permits,
            count(DISTINCT pc.permit_contact_id)::int AS contacts,
            count(DISTINCT pi.property_improvement_id)
              FILTER (WHERE pi.contractor_company_id IS NOT NULL)::int
              AS permit_company_linked,
            count(DISTINCT pc.permit_contact_id)
              FILTER (WHERE pc.company_id IS NOT NULL)::int
              AS contact_company_linked,
            count(DISTINCT pc.permit_contact_id)
              FILTER (WHERE pc.company_id IS NULL)::int
              AS contact_company_unlinked
       FROM public.property_improvements pi
       LEFT JOIN public.permit_contacts pc
         ON pc.property_improvement_id = pi.property_improvement_id
      WHERE pi.property_improvement_id = ANY($1::uuid[])`,
    [ids],
  );
  const row = result.rows[0];
  return cohortInputRecordSchema.parse({
    recordType: "matcher_state",
    scope:
      "seed-folios-exact-roofing-license-projects-and-independent-open-roofing-leads",
    permits: row.permits,
    contacts: row.contacts,
    permitCompanyLinked: row.permit_company_linked,
    contactCompanyLinked: row.contact_company_linked,
    contactCompanyUnlinked: row.contact_company_unlinked,
    confirmedRun:
      row.contact_company_linked > 0 || row.permit_company_linked > 0,
    evidence: [],
  });
}

function sourceReconciliationRecords(permits, catalogSha256) {
  const counts = new Map();
  for (const permit of permits) {
    counts.set(
      permit.sourceSystem,
      (counts.get(permit.sourceSystem) ?? 0) + 1,
    );
  }
  return [...SOURCE_MAP.values()].map((source) =>
    cohortInputRecordSchema.parse({
      recordType: "source_reconciliation",
      authority: source.authority,
      sourceKey: source.sourceKey,
      sourceSystem: source.sourceSystem,
      access: source.access,
      predecessorComplete: source.predecessorComplete,
      reported: null,
      received:
        source.access === "supported" && counts.has(source.sourceSystem)
          ? counts.get(source.sourceSystem)
          : null,
      missing: null,
      evidence: [
        {
          uri: "repo://skills/use-oracle/runtime/docs/broward-sources.yaml",
          sha256: catalogSha256,
          observedAt: null,
        },
      ],
      blockerCategory:
        source.access === "supported" ? null : source.access,
      blockerOwner:
        source.access === "supported"
          ? null
          : `${source.authority} building records custodian`,
      blockerFix:
        source.access === "supported"
          ? null
          : "Obtain the source-bounded native export identified in broward-sources.yaml and reconcile it before countywide proof.",
    }),
  );
}

async function run(args) {
  await requireAbsent(args.outputPath);
  const databaseUrl = process.env[args.databaseUrlEnv]?.trim();
  if (!databaseUrl) {
    throw new Error(
      `Database URL environment variable ${args.databaseUrlEnv} is not set`,
    );
  }
  if (!/^postgres(?:ql)?:\/\//i.test(databaseUrl)) {
    throw new Error(`${args.databaseUrlEnv} is not a PostgreSQL URL`);
  }
  const identityBytes = await readFile(args.identityEvidencePath);
  const identities = parseIdentityEvidence(identityBytes);
  const client = new pg.Client({
    connectionString: databaseUrl,
    application_name: "broward-roofing-readonly-export",
    options:
      "-c default_transaction_read_only=on -c statement_timeout=120000",
  });
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await assertSchema(client);
    const [permits, contacts, events, inspections] = await Promise.all([
      readPermits(
        client,
        args.folios,
        args.licenses,
        args.companyNames,
        args.asOfDate,
      ),
      readContacts(
        client,
        args.folios,
        args.licenses,
        args.companyNames,
        args.asOfDate,
      ),
      readEvents(
        client,
        args.folios,
        args.licenses,
        args.companyNames,
        args.asOfDate,
      ),
      readInspections(
        client,
        args.folios,
        args.licenses,
        args.companyNames,
        args.asOfDate,
      ),
    ]);
    const [properties, matcherState] = await Promise.all([
      readProperties(client, permits, args.folios),
      readMatcherState(client, permits),
    ]);
    await client.query("COMMIT");
    const manifest = cohortInputRecordSchema.parse({
      recordType: "manifest",
      schemaVersion: ROOFING_COHORT_INPUT_VERSION,
      countyKey: "broward",
      generatedAt: new Date().toISOString(),
      asOfDate: args.asOfDate,
      seedFolios: args.folios,
      expansionLicenseNumbers: args.licenses,
      expansionCompanyNames: args.companyNames,
      sourceCatalogSha256: args.catalogSha256,
      sourceProfileSha256: args.profileSha256,
      repositoryCommit: args.repositoryCommit,
      privacy: "private",
    });
    const records = [
      manifest,
      ...properties,
      ...permits,
      ...contacts,
      ...events,
      ...inspections,
      ...identities,
      ...sourceReconciliationRecords(permits, args.catalogSha256),
      matcherState,
    ];
    await writeFile(
      args.outputPath,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      { flag: "wx", mode: 0o600 },
    );
    process.stdout.write(
      `${JSON.stringify({
        event: "broward_roofing_readonly_export_complete",
        outputPath: args.outputPath,
        sha256: sha256(
          `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
        ),
        propertyCount: properties.length,
        permitCount: permits.length,
        contactCount: contacts.length,
        eventCount: events.length,
        inspectionCount: inspections.length,
        identityCount: identities.length,
        databaseWritesPerformed: false,
        excludedPrivateFields: [
          "owner",
          "applicant",
          "contractor_phone",
          "contractor_email",
        ],
      })}\n`,
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

try {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) process.stdout.write(`${usage()}\n`);
  else await run(args);
} catch (error) {
  process.stderr.write(`${error.message}\n\n${usage()}\n`);
  process.exitCode = 1;
}
