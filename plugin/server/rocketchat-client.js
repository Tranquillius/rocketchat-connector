// Lightweight client for the Rocket.Chat REST API (https://developer.rocket.chat/apidocs)
import { VERSION } from "./version.js";

export class RocketChatError extends Error {
  constructor(message, { status, path, errorType, details } = {}) {
    super(message);
    this.name = "RocketChatError";
    this.status = status;
    this.path = path;
    this.errorType = errorType;
    this.details = details;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class RocketChatClient {
  /**
   * @param {{baseUrl: string, userId: string, token: string, timeoutMs?: number, fetchImpl?: typeof fetch, maxRateLimitWaitMs?: number}} opts
   */
  constructor({ baseUrl, userId, token, timeoutMs = 30000, fetchImpl, maxRateLimitWaitMs = 65000 }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.userId = userId;
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.maxRateLimitWaitMs = maxRateLimitWaitMs;
    this.fetch = fetchImpl ?? globalThis.fetch;
  }

  /** Accepts paths relative to /api/v1 ("/chat.search") as well as "/api/info" or "/api/v1/…". */
  buildUrl(path, params) {
    let clean = path.startsWith("/") ? path : `/${path}`;
    if (clean.startsWith("/api/v1/")) clean = clean.slice("/api/v1".length);
    const full = clean.startsWith("/api/") ? this.baseUrl + clean : this.baseUrl + "/api/v1" + clean;
    const url = new URL(full);
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v === undefined || v === null || v === "") continue;
      // query/sort/fields/selector are passed as JSON
      url.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    return url;
  }

  async request(method, path, { params, body, retry = true } = {}, attempt = 0) {
    const url = this.buildUrl(path, params);
    const headers = {
      "X-User-Id": this.userId,
      "X-Auth-Token": this.token,
      Accept: "application/json",
      "User-Agent": `rocketchat-connector-mcp/${VERSION}`,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const reason = err?.name === "AbortError" ? `timed out after ${this.timeoutMs} ms` : err?.message;
      throw new RocketChatError(`Rocket.Chat not reachable (${method} ${url.pathname}): ${reason}`, { path });
    } finally {
      clearTimeout(timer);
    }

    // Rate limit: wait until the reset and retry (at most twice).
    // retry=false for queries across many rooms – partial results are better than waiting for minutes.
    if (res.status === 429 && retry && attempt < 2) {
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      const wait = Number.isFinite(reset) && reset > 0 ? Math.max(0, reset - Date.now()) + 250 : 5000;
      if (wait <= this.maxRateLimitWaitMs) {
        await res.text().catch(() => {});
        await sleep(wait);
        return this.request(method, path, { params, body, retry }, attempt + 1);
      }
    }

    const text = await res.text();
    let data;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    const failed = !res.ok || (data && typeof data === "object" && data.success === false);
    if (failed) {
      let msg = res.statusText;
      let errorType;
      if (data && typeof data === "object") {
        errorType = data.errorType ?? (typeof data.error === "string" && /^[a-z-]+$/.test(data.error) ? data.error : undefined);
        msg = data.error ?? data.message ?? data.reason ?? msg;
        if (typeof msg === "object") msg = JSON.stringify(msg);
      } else if (typeof data === "string") {
        msg = data.slice(0, 300);
      }
      const hint =
        res.status === 401
          ? " – user ID or token is invalid or expired. If the credentials were just changed in the settings: " +
            "quit and restart Claude completely – server instances that are already running keep the old values until then."
          : res.status === 403 || errorType === "error-not-allowed" || errorType === "unauthorized"
            ? " – the user lacks the required permission."
            : res.status === 429
              ? " – Rocket.Chat API rate limit reached; try again later or query fewer rooms at once."
              : errorType === "totp-required" || errorType === "totp-invalid"
                ? " – two-factor prompt: create the personal access token again with the option \"Ignore Two Factor Authentication\" enabled."
                : "";
      throw new RocketChatError(`Rocket.Chat API ${res.status} on ${method} ${url.pathname}: ${msg}${hint}`, {
        status: res.status,
        path,
        errorType,
        details: data,
      });
    }
    return data;
  }

  get(path, params, { retry } = {}) {
    return this.request("GET", path, { params, retry });
  }
  post(path, body) {
    return this.request("POST", path, { body });
  }

  /**
   * Loads a list page by page with count/offset, up to max entries.
   * @param {string} key Name of the array in the response (e.g. "messages")
   * @returns {Promise<{items: any[], total: number}>}
   */
  async collect(path, key, params = {}, { max = 1000, pageSize = 100 } = {}) {
    const items = [];
    let total = 0;
    while (items.length < max) {
      const want = Math.min(pageSize, max - items.length);
      const data = await this.get(path, { ...params, count: want, offset: items.length });
      const batch = data?.[key] ?? [];
      items.push(...batch);
      total = data?.total ?? items.length;
      if (batch.length < want || items.length >= total) break;
    }
    return { items: items.slice(0, max), total };
  }
}
