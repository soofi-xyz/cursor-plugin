import { createHash } from "node:crypto";

const REQUIRED_COLUMNS = Object.freeze({
  properties: Object.freeze({
    property_id: "uuid",
    parcel_id: "uuid",
    parcel_identifier: "text",
    source_system: "text",
  }),
  property_improvements: Object.freeze({
    property_improvement_id: "uuid",
    property_id: "uuid",
    parcel_id: "uuid",
    contractor_company_id: "uuid",
    request_identifier: "text",
    permit_number: "text",
    improvement_type: "text",
    improvement_status: "text",
    improvement_action: "text",
    application_received_date: "date",
    permit_issue_date: "date",
    permit_close_date: "date",
    fee: "numeric",
    estimated_job_value: "numeric",
    schema_version: "text",
    source: "text",
    source_url: "text",
    record_type: "text",
    source_status: "text",
    record_status: "text",
    opened_date: "date",
    expiration_date: "date",
    work_location: "text",
    parcel_identifier: "text",
    property_match_method: "text",
    property_match_confidence: "text",
    description: "text",
    more_details: "jsonb",
    source_payload: "jsonb",
    source_system: "text",
    source_record_key: "text",
    source_record_hash: "text",
    source_artifact_uri: "text",
  }),
  permit_contacts: Object.freeze({
    permit_contact_id: "uuid",
    property_improvement_id: "uuid",
    contact_role: "text",
    company_id: "uuid",
    raw_name: "text",
    phone: "text",
    email: "text",
    license_number: "text",
    source_payload: "jsonb",
    source_system: "text",
    source_record_key: "text",
    source_record_hash: "text",
    source_artifact_uri: "text",
  }),
});

const REQUIRED_NOT_NULL = new Set([
  "property_improvements.property_improvement_id",
  "property_improvements.source_system",
  "property_improvements.source_record_key",
  "permit_contacts.permit_contact_id",
  "permit_contacts.property_improvement_id",
  "permit_contacts.contact_role",
  "permit_contacts.source_system",
  "permit_contacts.source_record_key",
]);

const EXPECTED_SAMPLE_PERMITS = new Map([
  [
    "RL23-04374",
    {
      jurisdictionKey: "pembroke-pines",
      parcelIdentifier: "514005211940",
    },
  ],
  [
    "RL23-04447",
    {
      jurisdictionKey: "pembroke-pines",
      parcelIdentifier: "514005211940",
    },
  ],
  [
    "C-MECH-009303-2026",
    {
      jurisdictionKey: "sunrise",
      parcelIdentifier: "494026050080",
    },
  ],
  [
    "C-STRU-008439-2026",
    {
      jurisdictionKey: "sunrise",
      parcelIdentifier: "494026050080",
    },
  ],
  [
    "C-STRU-005996-2026",
    {
      jurisdictionKey: "sunrise",
      parcelIdentifier: "494026050080",
    },
  ],
  [
    "C-STRU-005992-2026",
    {
      jurisdictionKey: "sunrise",
      parcelIdentifier: "494026050080",
    },
  ],
]);

export const PRIVATE_LOAD_SQL = Object.freeze({
  upsertPermit: `/* tyler-private:upsert-permit */
    INSERT INTO public.property_improvements (
      property_id, parcel_id, contractor_company_id, request_identifier,
      permit_number, improvement_type, improvement_status,
      improvement_action, application_received_date, permit_issue_date,
      permit_close_date, fee, estimated_job_value, schema_version, source,
      source_url, record_type, source_status, record_status, opened_date,
      expiration_date, work_location, parcel_identifier,
      property_match_method, property_match_confidence, description,
      more_details, source_payload, source_system, source_record_key,
      source_record_hash, source_artifact_uri
    ) VALUES (
      $1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
      $17,$18,$19,$20,$21,$22,'exact_folio','exact',$23,$24::jsonb,
      $25::jsonb,$26,$27,$28,$29
    )
    ON CONFLICT (source_system, source_record_key) DO UPDATE SET
      property_id=EXCLUDED.property_id,
      parcel_id=EXCLUDED.parcel_id,
      request_identifier=EXCLUDED.request_identifier,
      permit_number=EXCLUDED.permit_number,
      improvement_type=EXCLUDED.improvement_type,
      improvement_status=EXCLUDED.improvement_status,
      improvement_action=EXCLUDED.improvement_action,
      application_received_date=EXCLUDED.application_received_date,
      permit_issue_date=EXCLUDED.permit_issue_date,
      permit_close_date=EXCLUDED.permit_close_date,
      fee=EXCLUDED.fee,
      estimated_job_value=EXCLUDED.estimated_job_value,
      schema_version=EXCLUDED.schema_version,
      source=EXCLUDED.source,
      source_url=EXCLUDED.source_url,
      record_type=EXCLUDED.record_type,
      source_status=EXCLUDED.source_status,
      record_status=EXCLUDED.record_status,
      opened_date=EXCLUDED.opened_date,
      expiration_date=EXCLUDED.expiration_date,
      work_location=EXCLUDED.work_location,
      parcel_identifier=EXCLUDED.parcel_identifier,
      property_match_method=EXCLUDED.property_match_method,
      property_match_confidence=EXCLUDED.property_match_confidence,
      description=EXCLUDED.description,
      more_details=EXCLUDED.more_details,
      source_payload=EXCLUDED.source_payload,
      source_record_hash=EXCLUDED.source_record_hash,
      source_artifact_uri=EXCLUDED.source_artifact_uri
    RETURNING property_improvement_id, property_id, parcel_id,
      parcel_identifier, permit_number, source_system, source_record_key`,
  upsertContact: `/* tyler-private:upsert-contact */
    INSERT INTO public.permit_contacts (
      property_improvement_id, contact_role, company_id, raw_name, phone,
      email, license_number, source_payload, source_system,
      source_record_key, source_record_hash, source_artifact_uri
    ) VALUES (
      $1,$2,NULL,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11
    )
    ON CONFLICT (source_system, source_record_key) DO UPDATE SET
      property_improvement_id=EXCLUDED.property_improvement_id,
      contact_role=EXCLUDED.contact_role,
      raw_name=EXCLUDED.raw_name,
      phone=EXCLUDED.phone,
      email=EXCLUDED.email,
      license_number=EXCLUDED.license_number,
      source_payload=EXCLUDED.source_payload,
      source_record_hash=EXCLUDED.source_record_hash,
      source_artifact_uri=EXCLUDED.source_artifact_uri
    RETURNING permit_contact_id, property_improvement_id, company_id,
      contact_role, raw_name, phone, email, license_number, source_system,
      source_record_key`,
});

function stableHash(value) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function identityKey(sourceSystem, sourceRecordKey) {
  return `${sourceSystem}\u0000${sourceRecordKey}`;
}

function assertExactRows(expectedRows, actualRows, label) {
  const expected = new Map(
    expectedRows.map((row) => [
      identityKey(row.sourceSystem, row.sourceRecordKey),
      row,
    ]),
  );
  if (actualRows.length !== expected.size) {
    throw new Error(
      `${label} read-back count mismatch: expected ${expected.size}, received ${actualRows.length}`,
    );
  }
  for (const actual of actualRows) {
    const key = identityKey(
      actual.sourceSystem,
      actual.sourceRecordKey,
    );
    const expectedRow = expected.get(key);
    if (!expectedRow) {
      throw new Error(`${label} read-back returned an unexpected identity`);
    }
    expectedRow.assert(actual);
  }
}

export function resolvePrivateDatabaseUrl({
  environmentName,
  environment = process.env,
}) {
  if (!environmentName?.trim()) {
    throw new Error(
      "An explicit --database-url-env environment variable name is required",
    );
  }
  const value = environment[environmentName]?.trim();
  if (!value) {
    throw new Error(
      `Database URL environment variable ${environmentName} is not set`,
    );
  }
  if (!/^postgres(?:ql)?:\/\//i.test(value)) {
    throw new Error(
      `Database URL environment variable ${environmentName} is not PostgreSQL`,
    );
  }
  return value;
}

function validateExistingPermits(existingRows, records, parents) {
  const expected = new Map(
    records.map((record) => [
      identityKey(record.source_system, record.sourceRecordId),
      { record, parent: parents.get(record.parcel_identifier) },
    ]),
  );
  for (const row of existingRows) {
    const match = expected.get(
      identityKey(row.sourceSystem, row.sourceRecordKey),
    );
    if (
      !match ||
      row.propertyId !== match.parent.propertyId ||
      row.parcelId !== match.parent.parcelId ||
      row.parcelIdentifier !== match.record.parcel_identifier ||
      row.permitNumber !== match.record.permit_number
    ) {
      throw new Error(
        `Existing permit identity conflicts with ${row.sourceSystem}/${row.sourceRecordKey}`,
      );
    }
  }
}

function validateExistingContacts(existingRows, contacts, permitIds) {
  const expected = new Map(
    contacts.map((contact) => [
      identityKey(contact.sourceSystem, contact.sourceRecordKey),
      permitIds.get(
        identityKey(
          contact.parentSourceSystem,
          contact.parentSourceRecordKey,
        ),
      ),
    ]),
  );
  for (const row of existingRows) {
    const expectedParent = expected.get(
      identityKey(row.sourceSystem, row.sourceRecordKey),
    );
    if (!expectedParent || row.propertyImprovementId !== expectedParent) {
      throw new Error(
        `Existing contractor identity conflicts with ${row.sourceSystem}/${row.sourceRecordKey}`,
      );
    }
  }
}

export async function verifyTylerPrivateLoad({ bundle, store }) {
  const permitExpectations = bundle.permits.map((record) => ({
    sourceSystem: record.source_system,
    sourceRecordKey: record.sourceRecordId,
    assert(row) {
      if (
        row.parcelIdentifier !== record.parcel_identifier ||
        row.permitNumber !== record.permit_number
      ) {
        throw new Error(
          `Permit read-back identity mismatch for ${record.permit_number}`,
        );
      }
    },
  }));
  const contactExpectations = bundle.contacts.map((contact) => ({
    sourceSystem: contact.sourceSystem,
    sourceRecordKey: contact.sourceRecordKey,
    assert(row) {
      if (
        row.contactRole !== "Contractor" ||
        row.rawName !== contact.rawName ||
        row.phone !== contact.phone ||
        row.email !== contact.email ||
        row.licenseNumber !== contact.licenseNumber
      ) {
        throw new Error(
          `Contractor read-back mismatch for ${contact.rawName}`,
        );
      }
    },
  }));
  const [permitRows, contactRows] = await Promise.all([
    store.readPermits(permitExpectations),
    store.readContacts(contactExpectations),
  ]);
  assertExactRows(permitExpectations, permitRows, "Permit");
  assertExactRows(contactExpectations, contactRows, "Contractor");
  return {
    permitCount: permitRows.length,
    contractorCount: contactRows.length,
  };
}

export function assertBrowardTylerSampleBundle(bundle) {
  if (
    bundle.manifest.countyKey !== "broward" ||
    bundle.permits.length !== EXPECTED_SAMPLE_PERMITS.size ||
    new Set(
      bundle.permits.map((record) => record.permit_number),
    ).size !== EXPECTED_SAMPLE_PERMITS.size ||
    bundle.permits.some((record) => {
      const expected = EXPECTED_SAMPLE_PERMITS.get(
        record.permit_number,
      );
      return (
        !expected ||
        record.jurisdictionKey !== expected.jurisdictionKey ||
        record.parcel_identifier !== expected.parcelIdentifier
      );
    })
  ) {
    throw new Error(
      "Loader accepts only the six-record bounded Broward Tyler bundle",
    );
  }
}

export async function loadTylerPrivateDatabase({ bundle, store }) {
  assertBrowardTylerSampleBundle(bundle);
  let transactionStarted = false;
  try {
    await store.begin();
    transactionStarted = true;
    await store.validateSchema();
    await store.acquireLock();
    const parcelIdentifiers = [
      ...new Set(
        bundle.permits.map((record) => record.parcel_identifier),
      ),
    ];
    const parentRows = await store.resolveParents(parcelIdentifiers);
    const parents = new Map();
    for (const row of parentRows) {
      if (parents.has(row.parcelIdentifier)) {
        throw new Error(
          `Multiple Broward appraisal parents for ${row.parcelIdentifier}`,
        );
      }
      parents.set(row.parcelIdentifier, row);
    }
    for (const parcelIdentifier of parcelIdentifiers) {
      const parent = parents.get(parcelIdentifier);
      if (!parent?.propertyId || !parent.parcelId) {
        throw new Error(
          `No complete Broward appraisal parent for ${parcelIdentifier}`,
        );
      }
    }
    const permitIdentities = bundle.permits.map((record) => ({
      sourceSystem: record.source_system,
      sourceRecordKey: record.sourceRecordId,
    }));
    validateExistingPermits(
      await store.findPermits(permitIdentities),
      bundle.permits,
      parents,
    );
    const permitIds = new Map();
    for (const record of bundle.permits) {
      const row = await store.upsertPermit(
        record,
        parents.get(record.parcel_identifier),
      );
      permitIds.set(
        identityKey(record.source_system, record.sourceRecordId),
        row.propertyImprovementId,
      );
    }
    const contactIdentities = bundle.contacts.map((contact) => ({
      sourceSystem: contact.sourceSystem,
      sourceRecordKey: contact.sourceRecordKey,
    }));
    validateExistingContacts(
      await store.findContacts(contactIdentities),
      bundle.contacts,
      permitIds,
    );
    for (const contact of bundle.contacts) {
      const parentId = permitIds.get(
        identityKey(
          contact.parentSourceSystem,
          contact.parentSourceRecordKey,
        ),
      );
      if (!parentId) {
        throw new Error(
          `Contractor ${contact.sourceRecordKey} has no loaded permit parent`,
        );
      }
      await store.upsertContact(contact, parentId);
    }
    const readBack = await verifyTylerPrivateLoad({ bundle, store });
    await store.commit();
    transactionStarted = false;
    return {
      ...readBack,
      linkedPropertyCount: parents.size,
    };
  } catch (error) {
    if (transactionStarted) await store.rollback();
    throw error;
  }
}

function toCamelPermitRow(row) {
  return {
    propertyImprovementId: row.property_improvement_id,
    propertyId: row.property_id,
    parcelId: row.parcel_id,
    parcelIdentifier: row.parcel_identifier,
    permitNumber: row.permit_number,
    sourceSystem: row.source_system,
    sourceRecordKey: row.source_record_key,
  };
}

function toCamelContactRow(row) {
  return {
    permitContactId: row.permit_contact_id,
    propertyImprovementId: row.property_improvement_id,
    companyId: row.company_id,
    contactRole: row.contact_role,
    rawName: row.raw_name,
    phone: row.phone,
    email: row.email,
    licenseNumber: row.license_number,
    sourceSystem: row.source_system,
    sourceRecordKey: row.source_record_key,
  };
}

function filterIdentityRows(rows, identities) {
  const keys = new Set(
    identities.map((identity) =>
      identityKey(identity.sourceSystem, identity.sourceRecordKey),
    ),
  );
  return rows.filter((row) =>
    keys.has(identityKey(row.sourceSystem, row.sourceRecordKey)),
  );
}

export function createPostgresTylerPrivateStore(client) {
  async function queryIdentityRows(tableName, columns, identities) {
    if (identities.length === 0) return [];
    const sourceSystems = [
      ...new Set(identities.map((identity) => identity.sourceSystem)),
    ];
    const sourceRecordKeys = [
      ...new Set(identities.map((identity) => identity.sourceRecordKey)),
    ];
    const result = await client.query(
      `/* tyler-private:read-${tableName} */
       SELECT ${columns}
       FROM public.${tableName}
       WHERE source_system = ANY($1::text[])
         AND source_record_key = ANY($2::text[])`,
      [sourceSystems, sourceRecordKeys],
    );
    const mapped = result.rows.map(
      tableName === "property_improvements"
        ? toCamelPermitRow
        : toCamelContactRow,
    );
    return filterIdentityRows(mapped, identities);
  }

  return {
    begin: () => client.query("BEGIN"),
    commit: () => client.query("COMMIT"),
    rollback: () => client.query("ROLLBACK"),
    async validateSchema() {
      const tableNames = Object.keys(REQUIRED_COLUMNS);
      const columnsResult = await client.query(
        `/* tyler-private:validate-columns */
         SELECT table_name, column_name, udt_name, is_nullable
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = ANY($1::text[])`,
        [tableNames],
      );
      const columns = new Map(
        columnsResult.rows.map((row) => [
          `${row.table_name}.${row.column_name}`,
          row,
        ]),
      );
      for (const [tableName, requiredColumns] of Object.entries(
        REQUIRED_COLUMNS,
      )) {
        for (const [columnName, expectedType] of Object.entries(
          requiredColumns,
        )) {
          const key = `${tableName}.${columnName}`;
          const actual = columns.get(key);
          if (!actual || actual.udt_name !== expectedType) {
            throw new Error(
              `Target schema mismatch for ${key}; expected ${expectedType}`,
            );
          }
          if (
            REQUIRED_NOT_NULL.has(key) &&
            actual.is_nullable !== "NO"
          ) {
            throw new Error(`Target schema requires ${key} to be NOT NULL`);
          }
        }
      }
      const indexesResult = await client.query(
        `/* tyler-private:validate-indexes */
         SELECT tablename, indexdef
         FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename = ANY($1::text[])`,
        [["property_improvements", "permit_contacts"]],
      );
      for (const tableName of [
        "property_improvements",
        "permit_contacts",
      ]) {
        const found = indexesResult.rows.some(
          (row) =>
            row.tablename === tableName &&
            /create unique index/i.test(row.indexdef) &&
            /\(\s*source_system\s*,\s*source_record_key\s*\)/i.test(
              row.indexdef.replaceAll('"', ""),
            ),
        );
        if (!found) {
          throw new Error(
            `Target schema lacks ${tableName} stable-source unique index`,
          );
        }
      }
      const foreignKeys = await client.query(
        `/* tyler-private:validate-foreign-key */
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
           AND tc.table_name = 'permit_contacts'`,
      );
      if (
        !foreignKeys.rows.some(
          (row) =>
            row.table_name === "permit_contacts" &&
            row.column_name === "property_improvement_id" &&
            row.foreign_table_name === "property_improvements" &&
            row.foreign_column_name === "property_improvement_id",
        )
      ) {
        throw new Error(
          "Target schema lacks permit_contacts parent foreign key",
        );
      }
    },
    acquireLock: () =>
      client.query(
        "SELECT pg_advisory_xact_lock($1, $2)",
        [12011, 7],
      ),
    async resolveParents(parcelIdentifiers) {
      const result = await client.query(
        `/* tyler-private:resolve-parents */
         SELECT property_id, parcel_id, parcel_identifier
         FROM public.properties
         WHERE source_system = 'broward_appraiser'
           AND parcel_identifier = ANY($1::text[])`,
        [parcelIdentifiers],
      );
      return result.rows.map((row) => ({
        propertyId: row.property_id,
        parcelId: row.parcel_id,
        parcelIdentifier: row.parcel_identifier,
      }));
    },
    findPermits: (identities) =>
      queryIdentityRows(
        "property_improvements",
        "property_improvement_id, property_id, parcel_id, parcel_identifier, permit_number, source_system, source_record_key",
        identities,
      ),
    async upsertPermit(record, parent) {
      const result = await client.query(PRIVATE_LOAD_SQL.upsertPermit, [
        parent.propertyId,
        parent.parcelId,
        record.sourceRecordId,
        record.permit_number,
        record.improvement_type,
        record.improvement_status,
        record.improvement_action,
        record.application_received_date,
        record.permit_issue_date,
        record.permit_close_date,
        record.fee,
        record.estimated_job_value,
        record.schemaVersion,
        record.source_system,
        record.source_url,
        record.improvement_type,
        record.improvement_status,
        record.improvement_status,
        record.opened_date,
        record.expiration_date,
        record.workAddress,
        record.parcel_identifier,
        record.description,
        JSON.stringify({
          isRoofPermit: record.isRoofPermit,
          contractors: record.contractors,
        }),
        JSON.stringify(record.sourcePayload),
        record.source_system,
        record.sourceRecordId,
        stableHash(record),
        record.source_url,
      ]);
      if (result.rows.length !== 1) {
        throw new Error(
          `Permit upsert did not return one row for ${record.permit_number}`,
        );
      }
      return toCamelPermitRow(result.rows[0]);
    },
    findContacts: (identities) =>
      queryIdentityRows(
        "permit_contacts",
        "permit_contact_id, property_improvement_id, company_id, contact_role, raw_name, phone, email, license_number, source_system, source_record_key",
        identities,
      ),
    async upsertContact(contact, propertyImprovementId) {
      const result = await client.query(PRIVATE_LOAD_SQL.upsertContact, [
        propertyImprovementId,
        contact.contactRole,
        contact.rawName,
        contact.phone,
        contact.email,
        contact.licenseNumber,
        JSON.stringify(contact.sourcePayload),
        contact.sourceSystem,
        contact.sourceRecordKey,
        stableHash(contact),
        null,
      ]);
      if (result.rows.length !== 1) {
        throw new Error(
          `Contractor upsert did not return one row for ${contact.rawName}`,
        );
      }
      return toCamelContactRow(result.rows[0]);
    },
    readPermits: (identities) =>
      queryIdentityRows(
        "property_improvements",
        "property_improvement_id, property_id, parcel_id, parcel_identifier, permit_number, source_system, source_record_key",
        identities,
      ),
    readContacts: (identities) =>
      queryIdentityRows(
        "permit_contacts",
        "permit_contact_id, property_improvement_id, company_id, contact_role, raw_name, phone, email, license_number, source_system, source_record_key",
        identities,
      ),
  };
}
