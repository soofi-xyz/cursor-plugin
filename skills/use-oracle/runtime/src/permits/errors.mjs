export class PermitSourceError extends Error {
  constructor(message, { classification, code, status = null, cause = null }) {
    super(message, { cause });
    this.name = "PermitSourceError";
    this.classification = classification;
    this.code = code;
    this.status = status;
  }
}

export function classifyPermitError(error) {
  if (error instanceof PermitSourceError) return error;
  if (
    error?.name === "AbortError" ||
    error?.name === "TimeoutError" ||
    error?.cause?.code === "UND_ERR_CONNECT_TIMEOUT"
  ) {
    return new PermitSourceError("Permit source request timed out", {
      classification: "transient",
      code: "request_timeout",
      cause: error,
    });
  }
  return new PermitSourceError(
    error instanceof Error ? error.message : String(error),
    {
      classification: "transient",
      code: "unexpected_source_error",
      cause: error instanceof Error ? error : null,
    },
  );
}

export function assertUsableResponse(response, body) {
  if (
    response.status === 401 ||
    response.status === 403 ||
    /access denied|service unavailable/i.test(body)
  ) {
    throw new PermitSourceError(
      `Permit source denied access with HTTP ${response.status}`,
      {
        classification: "blocked",
        code: "source_access_denied",
        status: response.status,
      },
    );
  }
  if (
    /encountered an error.*centralsquare|support id is/i.test(body)
  ) {
    throw new PermitSourceError(
      "CentralSquare did not establish a usable anonymous session",
      {
        classification: "blocked",
        code: "vendor_session_blocked",
        status: response.status,
      },
    );
  }
  if (response.status === 429 || response.status >= 500) {
    throw new PermitSourceError(
      `Permit source returned retryable HTTP ${response.status}`,
      {
        classification: "transient",
        code: "retryable_http_status",
        status: response.status,
      },
    );
  }
  if (!response.ok) {
    throw new PermitSourceError(
      `Permit source returned HTTP ${response.status}`,
      {
        classification: "permanent",
        code: "non_retryable_http_status",
        status: response.status,
      },
    );
  }
}
