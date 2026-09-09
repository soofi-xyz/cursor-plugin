import { z } from "zod";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const DURABLE_BLOCKER_SCHEMA_VERSION =
  "elephant.enrichment-source-blocker.v1";

const blockerSchema = z
  .object({
    schemaVersion: z.literal(DURABLE_BLOCKER_SCHEMA_VERSION),
    county: z.string().min(1),
    field: z.enum(["hoa_flag", "avm_value"]),
    owner: z.string().min(1),
    status: z.literal("blocked"),
    attemptedSources: z.array(z.string().min(1)).min(1),
    missingRequirement: z.string().min(1),
    evidence: z.array(z.string().min(1)).min(1),
    nextAction: z.string().min(1),
    observedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export function normalizeFolio(value) {
  const compact = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/R$/, "");
  if (!/^\d{10}$/.test(compact)) return null;
  return `${compact.slice(0, 6)}-${compact.slice(6)}`;
}

export function ownerOccupiedFromHomestead(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }
  const amount = Number(String(value).replaceAll(",", ""));
  if (!Number.isFinite(amount) || amount < 0) return null;
  return amount > 0;
}

export function deriveHoaFlag(evidence) {
  if (!evidence || typeof evidence !== "object") return null;
  if (
    evidence.authoritative !== true ||
    evidence.complete !== true ||
    evidence.effective !== true ||
    evidence.publicationPermitted !== true
  ) {
    return null;
  }
  if (evidence.linkMethod !== "parcel_identifier") return null;
  if (evidence.membership === true) return true;
  if (evidence.membership === false && evidence.authoritativeNegative === true) {
    return false;
  }
  return null;
}

export function selectLatestApprovedAvm(rows) {
  const approved = rows
    .filter((row) => {
      if (!row || typeof row !== "object" || row.approved !== true) return false;
      if (!ISO_DATE.test(String(row.valuation_date ?? ""))) return false;
      if (String(row.valuation_method_type ?? "").trim().length === 0) {
        return false;
      }
      if (
        row.publication_permitted !== true ||
        String(row.immutable_source_provenance ?? "").trim().length === 0
      ) {
        return false;
      }
      const value = Number(row.current_avm_value);
      return Number.isFinite(value) && value > 0;
    })
    .sort((left, right) => {
      const leftDate = String(left.valuation_date);
      const rightDate = String(right.valuation_date);
      const byDate =
        leftDate < rightDate ? 1 : leftDate > rightDate ? -1 : 0;
      if (byDate !== 0) return byDate;
      const leftMethod = String(left.valuation_method_type ?? "");
      const rightMethod = String(right.valuation_method_type ?? "");
      return leftMethod < rightMethod ? -1 : leftMethod > rightMethod ? 1 : 0;
    });
  return approved[0] ?? null;
}

export function avmValueFromApprovedRows(rows) {
  const selected = selectLatestApprovedAvm(rows);
  return selected === null ? null : Number(selected.current_avm_value);
}

export function buildDurableBlocker(value) {
  return blockerSchema.parse({
    schemaVersion: DURABLE_BLOCKER_SCHEMA_VERSION,
    status: "blocked",
    ...value,
  });
}

export function assertNoPlaceholderEnrichment(row) {
  if (
    row.avm_value_source === "appraisal_market_value"
  ) {
    throw new Error(
      "avm_value must not copy appraisal market_value; provide an approved AVM record",
    );
  }
  if (
    row.hoa_flag !== null &&
    row.hoa_flag !== undefined &&
    row.hoa_provenance?.linkMethod !== "parcel_identifier"
  ) {
    throw new Error(
      "hoa_flag requires authoritative parcel-identifier membership provenance",
    );
  }
  return row;
}
