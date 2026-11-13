/**
 * Minimal Oura API v2 client.
 * Official base: https://api.ouraring.com/v2/usercollection
 * User-Agent is required by Oura (requests without one may 403).
 *
 * Token resolution: token file (if present) else OURA_ACCESS_TOKEN.
 * Stored tokens that expire within 5 minutes, or a 401 response, trigger
 * one serialized refresh; the new pair is persisted before use.
 */

import {
  OuraError,
  USER_AGENT,
  canAttemptRefresh,
  readAccessTokenFromEnv,
  refreshAndPersist,
  resolveAccessToken,
} from "./tokens.js";

export { OuraError, readAccessTokenFromEnv as readAccessToken } from "./tokens.js";

const BASE = "https://api.ouraring.com/v2/usercollection";

function optionsOf(opts = {}) {
  return {
    env: opts.env || process.env,
    fetch: opts.fetch || globalThis.fetch,
    now: opts.now || (() => Date.now()),
  };
}

async function ouraFetchOnce(path, { token, query, fetchImpl }) {
  const url = new URL(path.startsWith("http") ? path : `${BASE}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value != null && value !== "") url.searchParams.set(key, String(value));
    }
  }

  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
  });

  if (response.status === 401) {
    throw new OuraError(
      "Unauthorized (401): Oura rejected the access token. It may be invalid, expired, malformed, or revoked.",
      { code: "unauthorized", status: 401 }
    );
  }
  if (response.status === 403) {
    throw new OuraError(
      "Forbidden (403): the token may lack the required Oura scope, the user's Oura subscription may have expired, or the request was rejected (Oura also 403s requests with no User-Agent).",
      { code: "forbidden", status: 403 }
    );
  }
  if (response.status === 429) {
    const retryAfter = response.headers.get("Retry-After");
    throw new OuraError(
      `Rate limit exceeded (429).${retryAfter ? ` Retry after ${retryAfter} seconds.` : ""}`,
      { code: "rate_limited", status: 429 }
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new OuraError(
      `Oura API error ${response.status}: ${body.slice(0, 300) || response.statusText}`,
      { status: response.status }
    );
  }

  return response.json();
}

/**
 * Authorized GET with expiry refresh and a single 401-triggered refresh+retry
 * when a token file with a refresh_token is in use.
 */
export async function ouraFetch(path, opts = {}) {
  const io = optionsOf(opts);
  const token = opts.token || (await resolveAccessToken(io));
  try {
    return await ouraFetchOnce(path, { token, query: opts.query, fetchImpl: io.fetch });
  } catch (err) {
    if (err?.status === 401 && !opts._retried && canAttemptRefresh(io.env)) {
      await refreshAndPersist(io);
      return ouraFetch(path, { ...opts, env: io.env, fetch: io.fetch, now: io.now, token: undefined, _retried: true });
    }
    throw err;
  }
}

/** Follow next_token until exhausted. Returns the concatenated data array. */
export async function fetchCollection(path, opts = {}) {
  const documents = [];
  let next_token;
  do {
    const query = { start_date: opts.start_date, end_date: opts.end_date };
    if (next_token) query.next_token = next_token;
    const page = await ouraFetch(path, { ...opts, query });
    if (Array.isArray(page?.data)) documents.push(...page.data);
    next_token = page?.next_token || null;
  } while (next_token);
  return documents;
}

export async function fetchPersonalInfo(opts = {}) {
  // Back-compat: fetchPersonalInfo(tokenString)
  if (typeof opts === "string") opts = { token: opts };
  return ouraFetch("/personal_info", opts);
}

export async function fetchDaySources(rangeOrToken, maybeRange, maybeOpts) {
  // Back-compat: fetchDaySources(token, range) or fetchDaySources(range, opts)
  let range;
  let opts;
  if (typeof rangeOrToken === "string") {
    range = maybeRange || {};
    opts = { ...(maybeOpts || {}), token: rangeOrToken };
  } else {
    range = rangeOrToken || {};
    opts = maybeRange || {};
  }
  const query = { start_date: range.start_date, end_date: range.end_date };
  const [dailySleep, dailyReadiness, dailyActivity, sleepPeriods] = await Promise.all([
    fetchCollection("/daily_sleep", { ...opts, ...query }),
    fetchCollection("/daily_readiness", { ...opts, ...query }),
    fetchCollection("/daily_activity", { ...opts, ...query }),
    fetchCollection("/sleep", { ...opts, ...query }),
  ]);
  return { dailySleep, dailyReadiness, dailyActivity, sleepPeriods };
}

export { resolveAccessToken, readAccessTokenFromEnv };
