import {
  createStablePermitId,
  normalizedPermitRecordSchema,
} from "../contracts.mjs";
import { PermitSourceError } from "../errors.mjs";
import {
  isRoofPermit,
  parsePortalDate,
  parsePortalMoney,
} from "../normalization.mjs";

const TYLER_PERMIT_MODULE_ID = 1;
const TYLER_SEARCH_MODULE = 2;
const TYLER_SEARCH_PAGE_SIZE = 10;
const REQUIRED_TENANT_HEADERS = Object.freeze([
  "tenantid",
  "tenantname",
  "tyler-tenanturl",
  "tyler-tenant-culture",
]);

function nullableText(value) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text && !/^(?:n\/a|none|not available|null)$/i.test(text)
    ? text
    : null;
}

function sourceError(message, code, classification = "permanent") {
  return new PermitSourceError(message, { classification, code });
}

function requireObject(value, message, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw sourceError(message, code);
  }
  return value;
}

function readSuccessfulResult(payload, operation) {
  const envelope = requireObject(
    payload,
    `Tyler ${operation} returned an invalid response`,
    "tyler_response_shape_changed",
  );
  if (envelope.Success !== true || envelope.Result === undefined) {
    throw sourceError(
      nullableText(envelope.ErrorMessage) ??
        `Tyler ${operation} was not successful`,
      "tyler_response_unsuccessful",
    );
  }
  return envelope.Result;
}

function readNonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw sourceError(
      `Tyler ${name} must be a non-negative integer`,
      "tyler_response_shape_changed",
    );
  }
  return value;
}

function normalizeHttpsUrl(value, name) {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS`);
  }
  return url.href.replace(/\/$/, "");
}

function validateConfig(jurisdiction) {
  const config = jurisdiction?.adapterConfig;
  if (!config) throw new Error("Tyler adapter configuration is required");
  const baseUrl = normalizeHttpsUrl(config.baseUrl, "Tyler baseUrl");
  const apiBaseUrl = normalizeHttpsUrl(
    config.apiBaseUrl ?? config.baseUrl,
    "Tyler apiBaseUrl",
  );
  if (new URL(baseUrl).origin !== new URL(apiBaseUrl).origin) {
    throw new Error("Tyler baseUrl and apiBaseUrl must share an origin");
  }
  const expectedTenantId = nullableText(config.expectedTenantId);
  const expectedTenantName = nullableText(config.expectedTenantName);
  if ((expectedTenantId === null) !== (expectedTenantName === null)) {
    throw new Error(
      "Tyler expectedTenantId and expectedTenantName must be configured together",
    );
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.countyKey ?? "")) {
    throw new Error("Tyler countyKey must be lowercase kebab-case");
  }
  if (!/^[a-z0-9_]+_permits$/.test(config.sourceSystem ?? "")) {
    throw new Error(
      "Tyler sourceSystem must be a lowercase underscore key ending in _permits",
    );
  }
  if (!nullableText(config.countyName)) {
    throw new Error("Tyler countyName is required");
  }
  if (
    !Number.isInteger(config.maximumSearchPages) ||
    config.maximumSearchPages < 1 ||
    config.maximumSearchPages > 20
  ) {
    throw new Error("Tyler maximumSearchPages must be between 1 and 20");
  }
  if (
    !Number.isInteger(config.maximumContactPages) ||
    config.maximumContactPages < 1 ||
    config.maximumContactPages > 10
  ) {
    throw new Error("Tyler maximumContactPages must be between 1 and 10");
  }
  if (
    !Number.isInteger(config.minimumDelayMs) ||
    config.minimumDelayMs < 250
  ) {
    throw new Error("Tyler minimumDelayMs must be at least 250");
  }
  return Object.freeze({
    jurisdictionKey: jurisdiction.key,
    jurisdictionName: jurisdiction.name,
    baseUrl,
    apiBaseUrl,
    countyKey: config.countyKey,
    countyName: config.countyName,
    sourceSystem: config.sourceSystem,
    expectedTenantId,
    expectedTenantName,
    maximumSearchPages: config.maximumSearchPages,
    maximumContactPages: config.maximumContactPages,
    minimumDelayMs: config.minimumDelayMs,
  });
}

export function normalizeTylerParcelIdentifier(value) {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (!/^[A-Z0-9]{12}$/.test(normalized)) {
    throw sourceError(
      `Invalid Tyler parcel identifier "${String(value ?? "")}"`,
      "invalid_parcel_identifier",
    );
  }
  return normalized;
}

export function buildTylerApiUrl(jurisdiction, apiPath) {
  const config = validateConfig(jurisdiction);
  if (!/^api\/energov\/[a-z0-9/_-]+$/i.test(apiPath)) {
    throw new Error("Tyler API path must be an api/energov route");
  }
  return `${config.apiBaseUrl}/${apiPath}`;
}

export function validateTylerTenantHeaders(jurisdiction, rawHeaders) {
  const config = validateConfig(jurisdiction);
  const headers = Object.fromEntries(
    Object.entries(rawHeaders ?? {}).map(([key, value]) => [
      key.toLowerCase(),
      String(value),
    ]),
  );
  for (const name of REQUIRED_TENANT_HEADERS) {
    if (!nullableText(headers[name])) {
      throw sourceError(
        `Tyler tenant bootstrap omitted ${name}`,
        "tyler_tenant_identity_missing",
      );
    }
  }
  if (
    config.expectedTenantId !== null &&
    (headers.tenantid !== config.expectedTenantId ||
      headers.tenantname !== config.expectedTenantName)
  ) {
    throw sourceError(
      `${config.jurisdictionName} selected an unexpected Tyler tenant`,
      "tyler_tenant_identity_mismatch",
    );
  }
  return Object.freeze(
    Object.fromEntries(
      REQUIRED_TENANT_HEADERS.map((name) => [name, headers[name]]),
    ),
  );
}

function permitDetailUrl(config, sourceRecordId) {
  return `${config.baseUrl}#/permit/${encodeURIComponent(sourceRecordId)}`;
}

function cloneSearchTemplate(template) {
  const cloned = structuredClone(template);
  requireObject(
    cloned.PermitCriteria,
    "Tyler search template omitted PermitCriteria",
    "tyler_search_template_changed",
  );
  return cloned;
}

export function buildTylerParcelSearchRequest(
  template,
  parcelIdentifier,
  pageNumber,
) {
  const parcel = normalizeTylerParcelIdentifier(parcelIdentifier);
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    throw new Error("Tyler pageNumber must be positive");
  }
  const request = cloneSearchTemplate(template);
  Object.assign(request, {
    SearchModule: TYLER_SEARCH_MODULE,
    FilterModule: 0,
    Keyword: "",
    ExactMatch: true,
    PageNumber: pageNumber,
    PageSize: TYLER_SEARCH_PAGE_SIZE,
    SortBy: "PermitNumber.keyword",
    SortAscending: true,
  });
  Object.assign(request.PermitCriteria, {
    PermitNumber: null,
    PermitTypeId: "none",
    PermitWorkclassId: null,
    PermitStatusId: "none",
    ProjectName: null,
    IssueDateFrom: null,
    IssueDateTo: null,
    Address: null,
    Description: null,
    ExpireDateFrom: null,
    ExpireDateTo: null,
    FinalDateFrom: null,
    FinalDateTo: null,
    ApplyDateFrom: null,
    ApplyDateTo: null,
    SearchMainAddress: false,
    ContactId: null,
    TypeId: null,
    WorkClassIds: null,
    ParcelNumber: parcel,
    ExcludeCases: null,
    EnableDescriptionSearch: false,
    PageNumber: pageNumber,
    PageSize: TYLER_SEARCH_PAGE_SIZE,
    SortBy: "PermitNumber.keyword",
    SortAscending: true,
  });
  return request;
}

function buildExactPermitSearchRequest(template, permitNumber) {
  const normalizedPermitNumber = nullableText(permitNumber);
  if (!normalizedPermitNumber) {
    throw new Error("Tyler permit number is required");
  }
  const request = cloneSearchTemplate(template);
  Object.assign(request, {
    SearchModule: 1,
    FilterModule: 1,
    Keyword: normalizedPermitNumber,
    ExactMatch: true,
    PageNumber: 1,
    PageSize: TYLER_SEARCH_PAGE_SIZE,
    SortBy: null,
    SortAscending: true,
  });
  return request;
}

function isPermitEntity(entity) {
  return (
    entity.ModuleName === 2 ||
    nullableText(entity.ModuleName)?.toLowerCase() === "permit"
  );
}

export function parseTylerSearchResponse(
  payload,
  {
    jurisdiction,
    requestedParcelIdentifier,
    exactPermitNumber = null,
  },
) {
  const config = validateConfig(jurisdiction);
  const requestedParcel = normalizeTylerParcelIdentifier(
    requestedParcelIdentifier,
  );
  const result = requireObject(
    readSuccessfulResult(payload, "search"),
    "Tyler search Result must be an object",
    "tyler_response_shape_changed",
  );
  if (!Array.isArray(result.EntityResults)) {
    throw sourceError(
      "Tyler search omitted EntityResults",
      "tyler_response_shape_changed",
    );
  }
  const totalFound = readNonNegativeInteger(
    result.TotalFound ?? result.EntityResults.length,
    "TotalFound",
  );
  const totalPages = readNonNegativeInteger(
    result.TotalPages ?? (totalFound === 0 ? 0 : 1),
    "TotalPages",
  );
  if (
    exactPermitNumber === null &&
    result.EntityResults.some(
      (entity) => !entity || typeof entity !== "object" || !isPermitEntity(entity),
    )
  ) {
    throw sourceError(
      "Tyler parcel search returned a non-permit entity",
      "tyler_search_scope_mismatch",
    );
  }
  const references = result.EntityResults.flatMap((entity) => {
    if (!entity || typeof entity !== "object" || !isPermitEntity(entity)) {
      return [];
    }
    const sourceRecordId = nullableText(entity.CaseId);
    const permitNumber = nullableText(entity.CaseNumber);
    if (
      exactPermitNumber !== null &&
      permitNumber !== exactPermitNumber
    ) {
      return [];
    }
    if (!sourceRecordId || !permitNumber) {
      throw sourceError(
        "Tyler permit search result omitted source identity",
        "tyler_permit_identity_missing",
      );
    }
    const sourceParcel = normalizeTylerParcelIdentifier(entity.MainParcel);
    if (sourceParcel !== requestedParcel) {
      throw sourceError(
        `Tyler permit ${permitNumber} returned parcel ${sourceParcel}, expected ${requestedParcel}`,
        "parcel_evidence_mismatch",
      );
    }
    return [
      {
        sourceRecordId,
        permitNumber,
        parcelIdentifier: sourceParcel,
        sourceUrl: permitDetailUrl(config, sourceRecordId),
        sourcePayload: entity,
      },
    ];
  });
  if (exactPermitNumber !== null && references.length !== 1) {
    throw sourceError(
      `Tyler exact search expected one ${exactPermitNumber} permit result, received ${references.length}`,
      "tyler_permit_identity_ambiguous",
    );
  }
  return { references, totalFound, totalPages };
}

function contactEntries(payload) {
  const result = readSuccessfulResult(payload, "contact search");
  if (Array.isArray(result)) return result;
  const object = requireObject(
    result,
    "Tyler contact search Result must be an array or object",
    "tyler_contact_shape_changed",
  );
  for (const key of ["EntityResults", "Contacts", "Items", "Results"]) {
    if (Array.isArray(object[key])) return object[key];
  }
  throw sourceError(
    "Tyler contact search omitted its contact collection",
    "tyler_contact_shape_changed",
  );
}

function qualifierName(entry) {
  const assembled = [entry.FirstName, entry.MiddleName, entry.LastName]
    .map(nullableText)
    .filter(Boolean)
    .join(" ");
  return nullableText(entry.QualifierName) ?? nullableText(assembled);
}

function splitBusinessAndQualifier(value, qualifier) {
  const businessName = nullableText(value);
  if (!businessName || !qualifier || !businessName.includes("/")) {
    return businessName;
  }
  const separator = businessName.lastIndexOf("/");
  const business = nullableText(businessName.slice(0, separator));
  const suffix = nullableText(businessName.slice(separator + 1));
  const words = (text) =>
    String(text)
      .toUpperCase()
      .match(/[A-Z0-9]+/g)
      ?.sort()
      .join(" ") ?? "";
  return business && words(suffix) === words(qualifier)
    ? business
    : businessName;
}

export function parseTylerContractors(payload) {
  const contractors = [];
  const seen = new Set();
  for (const value of contactEntries(payload)) {
    if (!value || typeof value !== "object") continue;
    const role =
      nullableText(value.ContactTypeName) ??
      nullableText(value.ContactRoleName) ??
      nullableText(value.Role);
    if (!/\bcontractor\b/i.test(role ?? "")) continue;
    const qualifier = qualifierName(value);
    const businessName = splitBusinessAndQualifier(
      value.GlobalEntityName ??
        value.CompanyName ??
        value.BusinessName ??
        value.OrganizationName,
      qualifier,
    );
    if (!businessName) continue;
    const contractor = {
      businessName,
      licenseNumber:
        nullableText(value.LicenseNumber) ??
        nullableText(value.ContractorLicenseNumber) ??
        nullableText(value.BusinessLicenseNumber) ??
        nullableText(value.License?.LicenseNumber),
      qualifierName: qualifier,
      phone:
        nullableText(value.Phone) ??
        nullableText(value.PhoneNumber) ??
        nullableText(value.BusinessPhone),
      email:
        nullableText(value.Email) ??
        nullableText(value.EmailAddress) ??
        nullableText(value.BusinessEmail),
    };
    const key = Object.values(contractor).join("\u0000");
    if (!seen.has(key)) {
      seen.add(key);
      contractors.push(contractor);
    }
  }
  return contractors;
}

function workAddress(detail) {
  return (
    nullableText(detail.MainAddress) ??
    nullableText(detail.MainAddressInfo?.FormattedAddressString) ??
    nullableText(detail.MainAddressInfo?.AddressDisplay)
  );
}

export function normalizeTylerPermitDetail(
  { detailPayload, contactsPayload },
  {
    jurisdiction,
    reference,
    requestedParcelIdentifier,
    requestedPropertyId,
  },
) {
  const config = validateConfig(jurisdiction);
  const detail = requireObject(
    readSuccessfulResult(detailPayload, "permit detail"),
    "Tyler permit detail Result must be an object",
    "tyler_detail_shape_changed",
  );
  const sourceRecordId = nullableText(reference?.sourceRecordId);
  const expectedPermitNumber = nullableText(reference?.permitNumber);
  const permitNumber = nullableText(detail.PermitNumber);
  if (!sourceRecordId || !expectedPermitNumber || !permitNumber) {
    throw sourceError(
      "Tyler permit detail omitted source identity",
      "tyler_permit_identity_missing",
    );
  }
  if (permitNumber !== expectedPermitNumber) {
    throw sourceError(
      `Tyler detail permit ${permitNumber} differs from search permit ${expectedPermitNumber}`,
      "tyler_permit_identity_mismatch",
    );
  }
  const detailRecordId = nullableText(detail.PermitId);
  if (
    detailRecordId &&
    detailRecordId.toLowerCase() !== sourceRecordId.toLowerCase()
  ) {
    throw sourceError(
      "Tyler permit detail returned a different source record",
      "tyler_permit_identity_mismatch",
    );
  }
  const expectedSourceUrl = permitDetailUrl(config, sourceRecordId);
  if (new URL(reference.sourceUrl).href !== new URL(expectedSourceUrl).href) {
    throw sourceError(
      "Tyler permit detail URL left the configured tenant",
      "tyler_source_identity_mismatch",
    );
  }
  const requestedParcel = normalizeTylerParcelIdentifier(
    requestedParcelIdentifier,
  );
  const searchParcel = normalizeTylerParcelIdentifier(
    reference.parcelIdentifier ?? reference.sourcePayload?.MainParcel,
  );
  const detailParcel = normalizeTylerParcelIdentifier(
    detail.MainParcelNumber,
  );
  if (
    searchParcel !== requestedParcel ||
    detailParcel !== requestedParcel
  ) {
    throw sourceError(
      `Tyler permit ${permitNumber} did not preserve requested parcel ${requestedParcel}`,
      "parcel_evidence_mismatch",
    );
  }
  const description = nullableText(detail.Description);
  const permitType = nullableText(detail.PermitType);
  const workClass = nullableText(detail.WorkClassName);
  const contractors = parseTylerContractors(contactsPayload);
  return normalizedPermitRecordSchema.parse({
    schemaVersion: "elephant.normalized-permit-record.v1",
    property_improvement_id: createStablePermitId({
      countyKey: config.countyKey,
      jurisdictionKey: config.jurisdictionKey,
      sourceRecordId,
    }),
    property_id: requestedPropertyId,
    parcel_identifier: requestedParcel,
    permit_number: permitNumber,
    improvement_type: permitType,
    improvement_status: nullableText(detail.PermitStatus),
    improvement_action: workClass,
    permit_issue_date: parsePortalDate(detail.IssueDate),
    application_received_date: parsePortalDate(detail.ApplyDate),
    final_inspection_date: null,
    permit_close_date: parsePortalDate(detail.FinalizeDate),
    completion_date: parsePortalDate(detail.FinalizeDate),
    expiration_date: parsePortalDate(detail.ExpireDate),
    opened_date: parsePortalDate(detail.ApplyDate),
    source_system: config.sourceSystem,
    county_name: config.countyName,
    project_description: nullableText(detail.ProjectName) ?? description,
    description,
    estimated_job_value: parsePortalMoney(detail.Value),
    fee: null,
    countyKey: config.countyKey,
    jurisdictionKey: config.jurisdictionKey,
    sourceRecordId,
    sourceUrl: expectedSourceUrl,
    requestedParcelIdentifier: requestedParcel,
    requestedPropertyId,
    workAddress: workAddress(detail),
    isRoofPermit: isRoofPermit(
      permitType,
      workClass,
      description,
      ...contractors.map((contractor) => contractor.businessName),
    ),
    contractors,
    inspections: [],
    relatedRecords: [],
    sourcePayload: {
      permitDetail: detail,
      contacts: readSuccessfulResult(contactsPayload, "contact search"),
    },
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createTylerCivicAccessAdapter(jurisdiction, options = {}) {
  const config = validateConfig(jurisdiction);
  let sessionPromise = null;
  let nextRequestAt = 0;

  async function openSession() {
    const executablePath =
      options.chromiumExecutablePath ??
      process.env.CHROME_EXECUTABLE_PATH?.trim();
    if (!options.browser && !executablePath) {
      throw sourceError(
        "Tyler live access requires an explicit Chromium executable path",
        "browser_runtime_unavailable",
        "blocked",
      );
    }
    const browser =
      options.browser ??
      (
        await import("puppeteer-core")
      ).default.launch({
        executablePath,
        headless: options.headless ?? true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
    const resolvedBrowser = await browser;
    const page = await resolvedBrowser.newPage();
    const endpoint = `${config.apiBaseUrl}/api/energov/search/search`;
    const marker = "__elephant_tyler_tenant_bootstrap__";
    try {
      const responsePromise = page.waitForResponse(
        (response) => {
          if (
            response.url().toLowerCase() !== endpoint.toLowerCase() ||
            response.request().method() !== "POST"
          ) {
            return false;
          }
          try {
            return (
              JSON.parse(response.request().postData() ?? "{}").Keyword ===
              marker
            );
          } catch {
            return false;
          }
        },
        { timeout: options.timeoutMs ?? 45_000 },
      );
      const route = `${config.baseUrl}#/search?${new URLSearchParams({
        m: "1",
        fm: "1",
        ps: String(TYLER_SEARCH_PAGE_SIZE),
        pn: "1",
        em: "true",
        st: marker,
      })}`;
      await page.goto(route, {
        waitUntil: "domcontentloaded",
        timeout: options.timeoutMs ?? 45_000,
      });
      const response = await responsePromise;
      if (!response.ok()) {
        throw sourceError(
          `Tyler tenant bootstrap returned HTTP ${response.status()}`,
          "tyler_bootstrap_failed",
          response.status() >= 500 ? "transient" : "blocked",
        );
      }
      const requestTemplate = JSON.parse(
        response.request().postData() ?? "{}",
      );
      requireObject(
        requestTemplate.PermitCriteria,
        "Tyler bootstrap omitted PermitCriteria",
        "tyler_search_template_changed",
      );
      const tenantHeaders = validateTylerTenantHeaders(
        jurisdiction,
        response.request().headers(),
      );
      nextRequestAt = Date.now() + config.minimumDelayMs;
      return {
        browser: resolvedBrowser,
        ownsBrowser: !options.browser,
        page,
        requestTemplate,
        tenantHeaders,
      };
    } catch (error) {
      await page.close().catch(() => undefined);
      if (!options.browser) {
        await resolvedBrowser.close().catch(() => undefined);
      }
      throw error;
    }
  }

  function session() {
    sessionPromise ??= openSession();
    return sessionPromise;
  }

  async function postJson(apiPath, body) {
    const active = await session();
    const now = Date.now();
    if (nextRequestAt > now) await sleep(nextRequestAt - now);
    nextRequestAt = Date.now() + config.minimumDelayMs;
    const endpoint = `${config.apiBaseUrl}/${apiPath}`;
    const response = await active.page.evaluate(
      async (input) => {
        const result = await fetch(input.endpoint, {
          method: "POST",
          headers: {
            accept: "application/json, text/plain, */*",
            "content-type": "application/json;charset=UTF-8",
            ...input.headers,
          },
          credentials: "include",
          body: JSON.stringify(input.body),
          signal: AbortSignal.timeout(input.timeoutMs),
        });
        return { status: result.status, text: await result.text() };
      },
      {
        endpoint,
        headers: active.tenantHeaders,
        body,
        timeoutMs: options.timeoutMs ?? 45_000,
      },
    );
    if (response.status !== 200) {
      throw sourceError(
        `Tyler ${apiPath} returned HTTP ${response.status}`,
        response.status >= 500
          ? "retryable_http_status"
          : "non_retryable_http_status",
        response.status >= 500 ? "transient" : "permanent",
      );
    }
    try {
      return JSON.parse(response.text);
    } catch (error) {
      throw new PermitSourceError("Tyler returned malformed JSON", {
        classification: "permanent",
        code: "malformed_json",
        cause: error,
      });
    }
  }

  async function searchParcel(parcelIdentifier) {
    const requestedParcel =
      normalizeTylerParcelIdentifier(parcelIdentifier);
    const active = await session();
    const references = new Map();
    let expectedTotal = null;
    let expectedPages = null;
    for (let pageNumber = 1; ; pageNumber += 1) {
      const payload = await postJson(
        "api/energov/search/search",
        buildTylerParcelSearchRequest(
          active.requestTemplate,
          requestedParcel,
          pageNumber,
        ),
      );
      const parsed = parseTylerSearchResponse(payload, {
        jurisdiction,
        requestedParcelIdentifier: requestedParcel,
      });
      expectedTotal ??= parsed.totalFound;
      expectedPages ??= parsed.totalPages;
      if (
        parsed.totalFound !== expectedTotal ||
        parsed.totalPages !== expectedPages
      ) {
        throw sourceError(
          "Tyler parcel-search totals changed during pagination",
          "tyler_pagination_drift",
          "transient",
        );
      }
      if (expectedPages > config.maximumSearchPages) {
        throw sourceError(
          `Tyler parcel search requires ${expectedPages} pages; configured maximum is ${config.maximumSearchPages}`,
          "source_result_cap",
          "blocked",
        );
      }
      for (const reference of parsed.references) {
        const existing = references.get(reference.sourceRecordId);
        if (
          existing &&
          existing.permitNumber !== reference.permitNumber
        ) {
          throw sourceError(
            "Tyler reused a source record ID for different permits",
            "tyler_permit_identity_mismatch",
          );
        }
        references.set(reference.sourceRecordId, reference);
      }
      if (pageNumber >= expectedPages) break;
    }
    if (references.size !== expectedTotal) {
      throw sourceError(
        `Tyler parcel search reported ${expectedTotal} permits but yielded ${references.size} unique identities`,
        "tyler_search_reconciliation_mismatch",
      );
    }
    return [...references.values()];
  }

  async function searchPermitNumber(
    permitNumber,
    requestedParcelIdentifier,
  ) {
    const active = await session();
    const payload = await postJson(
      "api/energov/search/search",
      buildExactPermitSearchRequest(
        active.requestTemplate,
        permitNumber,
      ),
    );
    const parsed = parseTylerSearchResponse(payload, {
      jurisdiction,
      requestedParcelIdentifier,
      exactPermitNumber: permitNumber,
    });
    if (parsed.totalPages > 1) {
      throw sourceError(
        "Tyler exact permit search unexpectedly spans multiple pages",
        "tyler_permit_identity_ambiguous",
      );
    }
    return parsed.references[0];
  }

  async function fetchPermitDetail(reference, request) {
    const detailPayload = await postJson(
      "api/energov/permits/permitdetail",
      {
        EntityId: reference.sourceRecordId,
        ModuleId: TYLER_PERMIT_MODULE_ID,
      },
    );
    const contacts = [];
    for (
      let pageNumber = 1;
      pageNumber <= config.maximumContactPages;
      pageNumber += 1
    ) {
      const pagePayload = await postJson(
        "api/energov/entity/contacts/search/search",
        {
          PageNumber: pageNumber,
          PageSize: TYLER_SEARCH_PAGE_SIZE,
          SortField: "",
          IsSortedInAscendingOrder: true,
          ModuleId: TYLER_PERMIT_MODULE_ID,
          EntityId: reference.sourceRecordId,
        },
      );
      const pageContacts = contactEntries(pagePayload);
      contacts.push(...pageContacts);
      if (pageContacts.length < TYLER_SEARCH_PAGE_SIZE) break;
      if (pageNumber === config.maximumContactPages) {
        throw sourceError(
          `Tyler permit contact list exceeded ${config.maximumContactPages} pages`,
          "tyler_contact_result_cap",
          "blocked",
        );
      }
    }
    const contactsPayload = { Success: true, Result: contacts };
    return normalizeTylerPermitDetail(
      { detailPayload, contactsPayload },
      { jurisdiction, reference, ...request },
    );
  }

  async function close() {
    if (!sessionPromise) return;
    const active = await sessionPromise.catch(() => null);
    sessionPromise = null;
    if (!active) return;
    await active.page.close().catch(() => undefined);
    if (active.ownsBrowser) {
      await active.browser.close().catch(() => undefined);
    }
  }

  return Object.freeze({
    key: "tyler-civic-access",
    async probe() {
      const active = await session();
      return {
        status: "ok",
        tenantId: active.tenantHeaders.tenantid,
        tenantName: active.tenantHeaders.tenantname,
      };
    },
    searchParcel,
    searchPermitNumber,
    fetchPermitDetail,
    close,
  });
}
