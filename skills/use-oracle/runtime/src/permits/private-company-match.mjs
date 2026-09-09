import {
  createContractorCompanyIndex,
  matchContractorToCompany,
  normalizeLicense,
  normalizePermitContractorIdentity,
  normalizePhone,
} from "../enrichment/query-table-bbb.mjs";
import { assertBrowardTylerSampleBundle } from "./private-db-load.mjs";

function identityKey(sourceSystem, sourceRecordKey) {
  return `${sourceSystem}\u0000${sourceRecordKey}`;
}

function validateScope(bundle, scope) {
  const permits = new Map(
    scope.permits.map((row) => [
      identityKey(row.sourceSystem, row.sourceRecordKey),
      row,
    ]),
  );
  if (permits.size !== bundle.permits.length) {
    throw new Error("Tyler company-match permit scope is incomplete");
  }
  for (const record of bundle.permits) {
    const row = permits.get(
      identityKey(record.source_system, record.sourceRecordId),
    );
    if (
      !row ||
      row.permitNumber !== record.permit_number ||
      row.parcelIdentifier !== record.parcel_identifier
    ) {
      throw new Error(
        `Tyler company-match permit mismatch: ${record.permit_number}`,
      );
    }
  }
  const contacts = new Map(
    scope.contacts.map((row) => [
      identityKey(row.sourceSystem, row.sourceRecordKey),
      row,
    ]),
  );
  if (contacts.size !== bundle.contacts.length) {
    throw new Error("Tyler company-match contractor scope is incomplete");
  }
  for (const contact of bundle.contacts) {
    const row = contacts.get(
      identityKey(contact.sourceSystem, contact.sourceRecordKey),
    );
    const parent = permits.get(
      identityKey(
        contact.parentSourceSystem,
        contact.parentSourceRecordKey,
      ),
    );
    if (
      !row ||
      !parent ||
      row.propertyImprovementId !== parent.propertyImprovementId ||
      row.rawName !== contact.rawName ||
      row.phone !== contact.phone ||
      row.licenseNumber !== contact.licenseNumber
    ) {
      throw new Error(
        `Tyler company-match contractor mismatch: ${contact.rawName}`,
      );
    }
  }
  return { permits, contacts };
}

function candidateProvenance(companies) {
  const sourceCounts = {};
  for (const company of companies) {
    for (const sourceSystem of company.sourceSystems ?? []) {
      sourceCounts[sourceSystem] = (sourceCounts[sourceSystem] ?? 0) + 1;
    }
  }
  return Object.fromEntries(
    Object.entries(sourceCounts).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

export async function matchTylerPrivateCompanies({ bundle, store }) {
  assertBrowardTylerSampleBundle(bundle);
  let transactionStarted = false;
  try {
    await store.begin();
    transactionStarted = true;
    await store.validateSchema({
      needsLicense: bundle.contacts.some(
        (contact) => normalizeLicense(contact.licenseNumber) !== null,
      ),
      needsPhone: bundle.contacts.some(
        (contact) => normalizePhone(contact.phone) !== null,
      ),
    });
    await store.acquireLock();
    const initialScope = await store.readScope(bundle, { lock: true });
    const { permits, contacts } = validateScope(bundle, initialScope);
    const existingCompanyIds = [
      ...new Set(
        [
          ...initialScope.contacts.map((row) => row.companyId),
          ...initialScope.permits.map(
            (row) => row.contractorCompanyId,
          ),
        ].filter(Boolean),
      ),
    ];
    const candidates = await store.findCandidateCompanies(
      bundle.contacts,
      existingCompanyIds,
    );
    const companyIndex = createContractorCompanyIndex(candidates);
    const companiesById = new Map(
      candidates.map((company) => [company.companyId, company]),
    );
    const finalContactCompanyIds = new Map();
    const results = [];
    for (const artifactContact of bundle.contacts) {
      const key = identityKey(
        artifactContact.sourceSystem,
        artifactContact.sourceRecordKey,
      );
      const current = contacts.get(key);
      const match = matchContractorToCompany(
        {
          businessName: artifactContact.rawName,
          licenseNumber: artifactContact.licenseNumber,
          phone: artifactContact.phone,
        },
        companyIndex,
      );
      let companyId = current.companyId;
      let action;
      if (companyId !== null) {
        action = "preserved_existing";
      } else if (match.status === "accepted") {
        companyId = match.companyId;
        await store.linkContact(current.permitContactId, companyId);
        action = "linked";
      } else {
        action = match.status;
      }
      finalContactCompanyIds.set(key, companyId);
      results.push({
        contractor: artifactContact.rawName,
        permitNumber: permits.get(
          identityKey(
            artifactContact.parentSourceSystem,
            artifactContact.parentSourceRecordKey,
          ),
        ).permitNumber,
        status: match.status,
        action,
        companyId,
        companyName: companiesById.get(companyId)?.name ?? null,
        method: match.method ?? null,
        confidence: match.confidence ?? 0,
      });
    }
    const finalPermitCompanyIds = new Map();
    const permitActions = new Map();
    for (const artifactPermit of bundle.permits) {
      const permitKey = identityKey(
        artifactPermit.source_system,
        artifactPermit.sourceRecordId,
      );
      const permit = permits.get(permitKey);
      const permitContacts = bundle.contacts.filter(
        (contact) =>
          contact.parentSourceSystem === artifactPermit.source_system &&
          contact.parentSourceRecordKey === artifactPermit.sourceRecordId,
      );
      const linkedIds = new Set(
        permitContacts
          .map((contact) =>
            finalContactCompanyIds.get(
              identityKey(contact.sourceSystem, contact.sourceRecordKey),
            ),
          )
          .filter(Boolean),
      );
      const allContactsLinked =
        permitContacts.length > 0 &&
        permitContacts.every(
          (contact) =>
            finalContactCompanyIds.get(
              identityKey(contact.sourceSystem, contact.sourceRecordKey),
            ) != null,
        );
      const derivedCompanyId =
        allContactsLinked && linkedIds.size === 1
          ? [...linkedIds][0]
          : null;
      let companyId = permit.contractorCompanyId;
      if (companyId === null && derivedCompanyId !== null) {
        await store.linkPermit(
          permit.propertyImprovementId,
          derivedCompanyId,
        );
        companyId = derivedCompanyId;
        permitActions.set(permitKey, "linked");
      } else if (companyId !== null) {
        permitActions.set(permitKey, "preserved_existing");
      } else {
        permitActions.set(permitKey, "unlinked");
      }
      finalPermitCompanyIds.set(permitKey, companyId);
    }
    const readBack = await store.readScope(bundle, { lock: false });
    const verified = validateScope(bundle, readBack);
    for (const [key, expectedCompanyId] of finalContactCompanyIds) {
      if (verified.contacts.get(key).companyId !== expectedCompanyId) {
        throw new Error("Contractor company-link read-back mismatch");
      }
    }
    for (const [key, expectedCompanyId] of finalPermitCompanyIds) {
      if (
        verified.permits.get(key).contractorCompanyId !==
        expectedCompanyId
      ) {
        throw new Error("Permit company-link read-back mismatch");
      }
    }
    await store.commit();
    transactionStarted = false;
    return {
      permitCount: bundle.permits.length,
      contractorCount: bundle.contacts.length,
      candidateCompanyCount: candidates.length,
      candidateSourceCounts: candidateProvenance(candidates),
      linkedContactCount: results.filter(
        (result) => result.action === "linked",
      ).length,
      preservedContactCount: results.filter(
        (result) => result.action === "preserved_existing",
      ).length,
      linkedPermitCount: [...permitActions.values()].filter(
        (action) => action === "linked",
      ).length,
      preservedPermitCount: [...permitActions.values()].filter(
        (action) => action === "preserved_existing",
      ).length,
      results,
    };
  } catch (error) {
    if (transactionStarted) await store.rollback();
    throw error;
  }
}

const BASE_REQUIRED_COLUMNS = Object.freeze({
  companies: Object.freeze([
    "company_id",
    "name",
    "normalized_name",
    "source_system",
  ]),
  property_improvements: Object.freeze([
    "property_improvement_id",
    "contractor_company_id",
    "permit_number",
    "parcel_identifier",
    "source_system",
    "source_record_key",
  ]),
  permit_contacts: Object.freeze([
    "permit_contact_id",
    "property_improvement_id",
    "company_id",
    "raw_name",
    "phone",
    "license_number",
    "source_system",
    "source_record_key",
  ]),
});

function mapPermit(row) {
  return {
    propertyImprovementId: row.property_improvement_id,
    contractorCompanyId: row.contractor_company_id,
    permitNumber: row.permit_number,
    parcelIdentifier: row.parcel_identifier,
    sourceSystem: row.source_system,
    sourceRecordKey: row.source_record_key,
  };
}

function mapContact(row) {
  return {
    permitContactId: row.permit_contact_id,
    propertyImprovementId: row.property_improvement_id,
    companyId: row.company_id,
    rawName: row.raw_name,
    phone: row.phone,
    licenseNumber: row.license_number,
    sourceSystem: row.source_system,
    sourceRecordKey: row.source_record_key,
  };
}

function filterIdentities(rows, artifacts, mapper) {
  const keys = new Set(
    artifacts.map((artifact) =>
      identityKey(artifact.sourceSystem, artifact.sourceRecordKey),
    ),
  );
  return rows
    .map(mapper)
    .filter((row) =>
      keys.has(identityKey(row.sourceSystem, row.sourceRecordKey)),
    );
}

export function createPostgresTylerCompanyMatchStore(client) {
  return {
    begin: () => client.query("BEGIN"),
    commit: () => client.query("COMMIT"),
    rollback: () => client.query("ROLLBACK"),
    acquireLock: () =>
      client.query("SELECT pg_advisory_xact_lock($1, $2)", [12011, 8]),
    async validateSchema({ needsLicense, needsPhone }) {
      const required = Object.fromEntries(
        Object.entries(BASE_REQUIRED_COLUMNS).map(([table, columns]) => [
          table,
          [...columns],
        ]),
      );
      if (needsLicense) {
        required.business_reputation_profiles = [
          "business_reputation_profile_id",
          "company_id",
        ];
        required.business_reputation_licenses = [
          "business_reputation_profile_id",
          "license_number",
        ];
      }
      if (needsPhone) {
        required.business_reputation_profiles ??= [
          "business_reputation_profile_id",
          "company_id",
        ];
        required.business_reputation_profiles.push("phone");
      }
      const response = await client.query(
        `/* tyler-company-match:validate-columns */
         SELECT table_name, column_name
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = ANY($1::text[])`,
        [Object.keys(required)],
      );
      const actual = new Set(
        response.rows.map(
          (row) => `${row.table_name}.${row.column_name}`,
        ),
      );
      for (const [table, columns] of Object.entries(required)) {
        for (const column of columns) {
          if (!actual.has(`${table}.${column}`)) {
            throw new Error(
              `Target schema lacks ${table}.${column}`,
            );
          }
        }
      }
      const foreignKeys = await client.query(
        `/* tyler-company-match:validate-foreign-keys */
         SELECT tc.table_name, kcu.column_name,
           ccu.table_name AS foreign_table_name,
           ccu.column_name AS foreign_column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.constraint_schema = kcu.constraint_schema
         JOIN information_schema.constraint_column_usage ccu
           ON tc.constraint_name = ccu.constraint_name
          AND tc.constraint_schema = ccu.constraint_schema
         WHERE tc.constraint_schema = 'public'
           AND tc.constraint_type = 'FOREIGN KEY'
           AND tc.table_name = ANY($1::text[])`,
        [["property_improvements", "permit_contacts"]],
      );
      for (const [table, column] of [
        ["property_improvements", "contractor_company_id"],
        ["permit_contacts", "company_id"],
      ]) {
        if (
          !foreignKeys.rows.some(
            (row) =>
              row.table_name === table &&
              row.column_name === column &&
              row.foreign_table_name === "companies" &&
              row.foreign_column_name === "company_id",
          )
        ) {
          throw new Error(
            `Target schema lacks ${table}.${column} company foreign key`,
          );
        }
      }
    },
    async readScope(bundle, { lock }) {
      const permitArtifacts = bundle.permits.map((record) => ({
        sourceSystem: record.source_system,
        sourceRecordKey: record.sourceRecordId,
      }));
      const contactArtifacts = bundle.contacts.map((contact) => ({
        sourceSystem: contact.sourceSystem,
        sourceRecordKey: contact.sourceRecordKey,
      }));
      const permitSystems = [
        ...new Set(
          permitArtifacts.map((artifact) => artifact.sourceSystem),
        ),
      ];
      const permitKeys = permitArtifacts.map(
        (artifact) => artifact.sourceRecordKey,
      );
      const permitResponse = await client.query(
        `/* tyler-company-match:read-permits */
         SELECT property_improvement_id, contractor_company_id,
           permit_number, parcel_identifier, source_system,
           source_record_key
         FROM public.property_improvements
         WHERE source_system = ANY($1::text[])
           AND source_record_key = ANY($2::text[])
         ${lock ? "FOR UPDATE" : ""}`,
        [permitSystems, permitKeys],
      );
      const contactSystems = [
        ...new Set(
          contactArtifacts.map((artifact) => artifact.sourceSystem),
        ),
      ];
      const contactKeys = contactArtifacts.map(
        (artifact) => artifact.sourceRecordKey,
      );
      const contactResponse = await client.query(
        `/* tyler-company-match:read-contacts */
         SELECT permit_contact_id, property_improvement_id, company_id,
           raw_name, phone, license_number, source_system,
           source_record_key
         FROM public.permit_contacts
         WHERE source_system = ANY($1::text[])
           AND source_record_key = ANY($2::text[])
         ${lock ? "FOR UPDATE" : ""}`,
        [contactSystems, contactKeys],
      );
      return {
        permits: filterIdentities(
          permitResponse.rows,
          permitArtifacts,
          mapPermit,
        ),
        contacts: filterIdentities(
          contactResponse.rows,
          contactArtifacts,
          mapContact,
        ),
      };
    },
    async findCandidateCompanies(contacts, existingCompanyIds = []) {
      const identities = contacts.map((contact) =>
        normalizePermitContractorIdentity({
          businessName: contact.rawName,
          licenseNumber: contact.licenseNumber,
          phone: contact.phone,
        }),
      );
      const strictNames = [
        ...new Set(
          identities.map((identity) => identity.strictName).filter(Boolean),
        ),
      ];
      const namePrefixes = strictNames.map((name) => `${name}%`);
      const rows = [];
      if (existingCompanyIds.length > 0) {
        const response = await client.query(
          `/* tyler-company-match:existing-companies */
           SELECT company_id, name, normalized_name, source_system,
             NULL::text AS matched_license,
             NULL::text AS matched_phone
           FROM public.companies
           WHERE company_id = ANY($1::uuid[])`,
          [existingCompanyIds],
        );
        if (response.rows.length !== existingCompanyIds.length) {
          throw new Error(
            "An existing company link does not resolve to companies",
          );
        }
        rows.push(...response.rows);
      }
      if (strictNames.length > 0) {
        const response = await client.query(
          `/* tyler-company-match:name-candidates */
           SELECT company_id, name, normalized_name, source_system,
             NULL::text AS matched_license,
             NULL::text AS matched_phone
           FROM public.companies
           WHERE normalized_name = ANY($1::text[])
              OR TRIM(REGEXP_REPLACE(
                   UPPER(REPLACE(COALESCE(name, ''), '&', ' AND ')),
                   '[^A-Z0-9]+', ' ', 'g'
                 )) LIKE ANY($2::text[])`,
          [strictNames, namePrefixes],
        );
        rows.push(...response.rows);
      }
      const licenses = [
        ...new Set(
          identities.map((identity) => identity.license).filter(Boolean),
        ),
      ];
      if (licenses.length > 0) {
        const response = await client.query(
          `/* tyler-company-match:license-candidates */
           SELECT c.company_id, c.name, c.normalized_name,
             c.source_system, l.license_number AS matched_license,
             NULL::text AS matched_phone
           FROM public.business_reputation_licenses l
           JOIN public.business_reputation_profiles p
             ON p.business_reputation_profile_id =
                l.business_reputation_profile_id
           JOIN public.companies c ON c.company_id = p.company_id
           WHERE REGEXP_REPLACE(
             UPPER(COALESCE(l.license_number, '')),
             '[^A-Z0-9]+', '', 'g'
           ) = ANY($1::text[])`,
          [licenses],
        );
        rows.push(...response.rows);
      }
      const phones = [
        ...new Set(
          identities.map((identity) => identity.phone).filter(Boolean),
        ),
      ];
      if (phones.length > 0) {
        const response = await client.query(
          `/* tyler-company-match:phone-candidates */
           SELECT c.company_id, c.name, c.normalized_name,
             c.source_system, NULL::text AS matched_license,
             p.phone AS matched_phone
           FROM public.business_reputation_profiles p
           JOIN public.companies c ON c.company_id = p.company_id
           WHERE RIGHT(
             REGEXP_REPLACE(COALESCE(p.phone, ''), '\\D', '', 'g'),
             10
           ) = ANY($1::text[])`,
          [phones],
        );
        rows.push(...response.rows);
      }
      const companies = new Map();
      for (const row of rows) {
        let company = companies.get(row.company_id);
        if (!company) {
          company = {
            companyId: row.company_id,
            name: row.name,
            names: new Set(),
            licenses: new Set(),
            phones: new Set(),
            sourceSystems: new Set(),
          };
          companies.set(row.company_id, company);
        }
        if (row.normalized_name) company.names.add(row.normalized_name);
        if (row.matched_license) company.licenses.add(row.matched_license);
        if (row.matched_phone) company.phones.add(row.matched_phone);
        if (row.source_system) company.sourceSystems.add(row.source_system);
      }
      return [...companies.values()].map((company) => ({
        ...company,
        names: [...company.names],
        licenses: [...company.licenses],
        phones: [...company.phones],
        sourceSystems: [...company.sourceSystems],
      }));
    },
    async linkContact(permitContactId, companyId) {
      const response = await client.query(
        `/* tyler-company-match:link-contact */
         UPDATE public.permit_contacts
         SET company_id = $2
         WHERE permit_contact_id = $1
           AND company_id IS NULL
         RETURNING permit_contact_id`,
        [permitContactId, companyId],
      );
      if (response.rows.length !== 1) {
        throw new Error("Contractor company link was not applied exactly once");
      }
    },
    async linkPermit(propertyImprovementId, companyId) {
      const response = await client.query(
        `/* tyler-company-match:link-permit */
         UPDATE public.property_improvements
         SET contractor_company_id = $2
         WHERE property_improvement_id = $1
           AND contractor_company_id IS NULL
         RETURNING property_improvement_id`,
        [propertyImprovementId, companyId],
      );
      if (response.rows.length !== 1) {
        throw new Error("Permit company link was not applied exactly once");
      }
    },
  };
}
