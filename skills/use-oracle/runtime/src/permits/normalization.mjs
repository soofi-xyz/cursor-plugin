import { PermitSourceError } from "./errors.mjs";

export function normalizeDuvalParcelIdentifier(value) {
  const raw = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/R$/, "");
  const digits = raw.replace(/\D/g, "");
  if (digits.length !== 10) {
    throw new PermitSourceError(
      `Invalid Duval RE number "${String(value ?? "")}"`,
      {
        classification: "permanent",
        code: "invalid_parcel_identifier",
      },
    );
  }
  return `${digits.slice(0, 6)}-${digits.slice(6)}`;
}

export function formatParcelForSource(parcelIdentifier, format) {
  const normalized = normalizeDuvalParcelIdentifier(parcelIdentifier);
  if (format === "digits-only") return normalized.replace("-", "");
  if (format === "source-specific") return normalized.replace("-", " ");
  return normalized;
}

export function routePermitJurisdiction(profile, city) {
  const normalizedCity = String(city ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
  const exact = profile.jurisdictions.find((jurisdiction) =>
    jurisdiction.routingCities.some(
      (alias) => alias.trim().toUpperCase() === normalizedCity,
    ),
  );
  return (
    exact ??
    profile.jurisdictions.find(
      (jurisdiction) => jurisdiction.defaultForUnmatchedCity,
    )
  );
}

export function parsePortalDate(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw || /no data|not available/i.test(raw)) return null;
  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  const usMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!usMatch) return null;
  return `${usMatch[3]}-${usMatch[1].padStart(2, "0")}-${usMatch[2].padStart(2, "0")}`;
}

export function parsePortalMoney(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).replace(/[$,\s]/g, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function isRoofPermit(...values) {
  return values.some((value) =>
    /\b(?:roof|reroof|re-roof|shingle)\b/i.test(String(value ?? "")),
  );
}
