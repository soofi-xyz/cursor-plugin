import {
  assertUsableResponse,
  classifyPermitError,
  PermitSourceError,
} from "./errors.mjs";

const DEFAULT_USER_AGENT =
  "ElephantOraclePermitHarvester/1.0 (+https://elephant.xyz; public-records-research)";

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class PermitHttpClient {
  constructor({
    minimumDelayMs = 1000,
    timeoutMs = 30000,
    maxAttempts = 3,
    fetchImpl = fetch,
    userAgent = DEFAULT_USER_AGENT,
  } = {}) {
    this.minimumDelayMs = minimumDelayMs;
    this.timeoutMs = timeoutMs;
    this.maxAttempts = maxAttempts;
    this.fetchImpl = fetchImpl;
    this.userAgent = userAgent;
    this.cookies = new Map();
    this.nextRequestAt = 0;
  }

  absorbCookies(response) {
    const setCookies = response.headers.getSetCookie?.() ?? [];
    for (const cookie of setCookies) {
      const [pair] = cookie.split(";");
      const separator = pair.indexOf("=");
      if (separator > 0) {
        this.cookies.set(
          pair.slice(0, separator),
          pair.slice(separator + 1),
        );
      }
    }
  }

  cookieHeader() {
    return [...this.cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  async throttle() {
    const now = Date.now();
    const scheduledAt = Math.max(now, this.nextRequestAt);
    this.nextRequestAt = scheduledAt + this.minimumDelayMs;
    if (scheduledAt > now) {
      await sleep(scheduledAt - now);
    }
  }

  async request(url, options = {}) {
    let lastError;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await this.requestOnce(url, options);
      } catch (error) {
        const classified = classifyPermitError(error);
        lastError = classified;
        if (
          classified.classification !== "transient" ||
          attempt === this.maxAttempts
        ) {
          throw classified;
        }
        await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000));
      }
    }
    throw lastError;
  }

  async requestOnce(inputUrl, inputOptions) {
    let url = new URL(inputUrl);
    let options = { ...inputOptions };
    for (let redirectCount = 0; redirectCount <= 8; redirectCount += 1) {
      await this.throttle();
      const headers = new Headers(options.headers);
      headers.set("user-agent", this.userAgent);
      if (!headers.has("accept")) headers.set("accept", "*/*");
      const cookie = this.cookieHeader();
      if (cookie) headers.set("cookie", cookie);
      const response = await this.fetchImpl(url, {
        ...options,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      this.absorbCookies(response);
      if (response.status < 300 || response.status >= 400) return response;
      const location = response.headers.get("location");
      if (!location) {
        throw new PermitSourceError(
          `Redirect from ${url.href} omitted Location`,
          {
            classification: "permanent",
            code: "invalid_redirect",
            status: response.status,
          },
        );
      }
      url = new URL(location, url);
      options =
        response.status === 307 || response.status === 308
          ? options
          : { method: "GET" };
    }
    throw new PermitSourceError("Permit source exceeded redirect limit", {
      classification: "permanent",
      code: "redirect_limit",
    });
  }

  async text(url, options = {}) {
    const response = await this.request(url, options);
    const body = await response.text();
    assertUsableResponse(response, body);
    return { response, body };
  }

  async json(url, options = {}) {
    const { response, body } = await this.text(url, {
      ...options,
      headers: {
        accept: "application/json",
        ...options.headers,
      },
    });
    try {
      return { response, body: JSON.parse(body) };
    } catch (error) {
      throw new PermitSourceError(
        `Permit source returned malformed JSON from ${url}`,
        {
          classification: "permanent",
          code: "malformed_json",
          status: response.status,
          cause: error,
        },
      );
    }
  }
}
