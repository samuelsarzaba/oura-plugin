/**
 * Fixture-only unit checks for token-file refresh.
 * Mock fetch only — no live Oura token endpoint is called.
 * Token values in this file are invented fixtures, not real secrets.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchPersonalInfo, ouraFetch } from "../src/oura.js";
import {
  isExpiringSoon,
  parseCallbackInput,
  publicTokenStatus,
  resetRefreshLock,
  resolveAccessToken,
  writeTokenFile,
  readTokenFile,
  tokensFromTokenResponse,
} from "../src/tokens.js";

const FIXTURE_OLD_ACCESS = "fixture-old-access-token";
const FIXTURE_OLD_REFRESH = "fixture-old-refresh-token";
const FIXTURE_NEW_ACCESS = "fixture-new-access-token";
const FIXTURE_NEW_REFRESH = "fixture-new-refresh-token";

function fixtureStore(overrides = {}) {
  return {
    _comment: "FIXTURE only — invented tokens for unit tests. Not live Oura credentials.",
    access_token: FIXTURE_OLD_ACCESS,
    refresh_token: FIXTURE_OLD_REFRESH,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    scope: "daily personal",
    ...overrides,
  };
}

function tempEnv(store, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "oura-plugin-test-"));
  const file = join(dir, "tokens.json");
  if (store) writeTokenFile(file, store);
  const env = {
    OURA_TOKEN_FILE: file,
    OURA_CLIENT_ID: "fixture-client-id",
    OURA_CLIENT_SECRET: "fixture-client-secret",
    ...extra,
  };
  return { dir, file, env };
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function isTokenUrl(url) {
  return String(url).startsWith("https://api.ouraring.com/v2/oauth/token");
}

function authHeader(init) {
  return (init?.headers?.Authorization || init?.headers?.authorization || "");
}

// --- tokensFromTokenResponse / expiry helper ---
{
  const tokens = tokensFromTokenResponse(
    {
      access_token: FIXTURE_NEW_ACCESS,
      refresh_token: FIXTURE_NEW_REFRESH,
      expires_in: 3600,
      scope: "daily personal",
    },
    Date.parse("2026-11-12T19:00:00Z")
  );
  assert.equal(tokens.expires_at, "2026-11-12T20:00:00.000Z");
  assert.equal(
    isExpiringSoon(
      { expires_at: "2026-11-13T00:04:00.000Z" },
      Date.parse("2026-11-13T00:00:00.000Z")
    ),
    true
  );
  assert.equal(
    isExpiringSoon(
      { expires_at: "2026-11-13T00:10:00.000Z" },
      Date.parse("2026-11-13T00:00:00.000Z")
    ),
    false
  );
}

// --- parse callback / state ---
{
  const parsed = parseCallbackInput(
    "http://localhost:8080/callback?code=fixture-code&state=abc",
    "abc"
  );
  assert.equal(parsed.code, "fixture-code");
  assert.throws(
    () => parseCallbackInput("http://localhost:8080/callback?code=fixture-code&state=nope", "abc"),
    /state did not match/
  );
}

resetRefreshLock();

// --- expiry-triggered refresh persists new tokens BEFORE the API is called ---
{
  resetRefreshLock();
  const now = Date.parse("2026-11-13T00:00:00.000Z");
  const { dir, file, env } = tempEnv(
    fixtureStore({ expires_at: new Date(now + 2 * 60 * 1000).toISOString() })
  );
  const events = [];
  const fetchMock = async (url, init) => {
    if (isTokenUrl(url)) {
      // File must still have the old refresh token at the moment of the refresh POST.
      const onDisk = readTokenFile(file);
      events.push({ type: "refresh", disk_access_is_old: onDisk.access_token === FIXTURE_OLD_ACCESS });
      return jsonResponse(200, {
        access_token: FIXTURE_NEW_ACCESS,
        refresh_token: FIXTURE_NEW_REFRESH,
        expires_in: 86400,
        scope: "daily personal",
      });
    }
    const onDisk = readTokenFile(file);
    events.push({
      type: "api",
      authorization: authHeader(init),
      disk_access_is_new: onDisk.access_token === FIXTURE_NEW_ACCESS,
      disk_refresh_is_new: onDisk.refresh_token === FIXTURE_NEW_REFRESH,
    });
    assert.equal(onDisk.access_token, FIXTURE_NEW_ACCESS, "new pair must be on disk before the API call");
    assert.equal(authHeader(init), `Bearer ${FIXTURE_NEW_ACCESS}`);
    return jsonResponse(200, { id: "fixture-user" });
  };
  try {
    const result = await fetchPersonalInfo({ env, fetch: fetchMock, now: () => now });
    assert.equal(result.id, "fixture-user");
    assert.equal(events[0].type, "refresh");
    assert.equal(events[1].type, "api");
    assert.equal(events[1].disk_access_is_new, true);
    assert.equal(events.filter((e) => e.type === "refresh").length, 1);
    const stored = readTokenFile(file);
    assert.equal(stored.access_token, FIXTURE_NEW_ACCESS);
    assert.equal(stored.refresh_token, FIXTURE_NEW_REFRESH);
    console.log("PASS  expiry-triggered refresh persists new tokens before retrying");
  } finally {
    cleanup(dir);
  }
}

// --- 401-triggered refresh retries the request once ---
{
  resetRefreshLock();
  const now = Date.parse("2026-11-13T00:00:00.000Z");
  const { dir, file, env } = tempEnv(
    fixtureStore({ expires_at: new Date(now + 60 * 60 * 1000).toISOString() })
  );
  let apiCalls = 0;
  let refreshCalls = 0;
  const fetchMock = async (url, init) => {
    if (isTokenUrl(url)) {
      refreshCalls += 1;
      return jsonResponse(200, {
        access_token: FIXTURE_NEW_ACCESS,
        refresh_token: FIXTURE_NEW_REFRESH,
        expires_in: 86400,
        scope: "daily personal",
      });
    }
    apiCalls += 1;
    const token = authHeader(init);
    if (token === `Bearer ${FIXTURE_OLD_ACCESS}`) {
      return jsonResponse(401, { detail: "fixture unauthorized" });
    }
    if (token === `Bearer ${FIXTURE_NEW_ACCESS}`) {
      return jsonResponse(200, { id: "fixture-user" });
    }
    throw new Error("unexpected token in fixture fetch");
  };
  try {
    const result = await fetchPersonalInfo({ env, fetch: fetchMock, now: () => now });
    assert.equal(result.id, "fixture-user");
    assert.equal(refreshCalls, 1);
    assert.equal(apiCalls, 2, "original 401 + one retry");
    assert.equal(readTokenFile(file).access_token, FIXTURE_NEW_ACCESS);
    console.log("PASS  401-triggered refresh retries once");
  } finally {
    cleanup(dir);
  }
}

// --- concurrent calls trigger exactly one refresh ---
{
  resetRefreshLock();
  const now = Date.parse("2026-11-13T00:00:00.000Z");
  const { dir, file, env } = tempEnv(
    fixtureStore({ expires_at: new Date(now + 60 * 1000).toISOString() })
  );
  let refreshCalls = 0;
  let refreshStarted = 0;
  let releaseRefresh;
  const gate = new Promise((resolve) => {
    releaseRefresh = resolve;
  });
  const fetchMock = async (url, init) => {
    if (isTokenUrl(url)) {
      refreshStarted += 1;
      await gate;
      refreshCalls += 1;
      return jsonResponse(200, {
        access_token: FIXTURE_NEW_ACCESS,
        refresh_token: FIXTURE_NEW_REFRESH,
        expires_in: 86400,
        scope: "daily personal",
      });
    }
    assert.equal(authHeader(init), `Bearer ${FIXTURE_NEW_ACCESS}`);
    return jsonResponse(200, { data: [{ day: "2026-11-12", score: 1 }] });
  };
  try {
    const a = ouraFetch("/daily_sleep", { env, fetch: fetchMock, now: () => now });
    const b = ouraFetch("/daily_readiness", { env, fetch: fetchMock, now: () => now });
    const c = resolveAccessToken({ env, fetch: fetchMock, now: () => now });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(refreshStarted, 1, "only one refresh should be in flight");
    releaseRefresh();
    const [ra, rb, token] = await Promise.all([a, b, c]);
    assert.equal(refreshCalls, 1);
    assert.equal(token, FIXTURE_NEW_ACCESS);
    assert.equal(ra.data[0].day, "2026-11-12");
    assert.equal(rb.data[0].day, "2026-11-12");
    assert.equal(readTokenFile(file).refresh_token, FIXTURE_NEW_REFRESH);
    console.log("PASS  concurrent calls trigger exactly one refresh");
  } finally {
    cleanup(dir);
  }
}

// --- refresh failure is a clean error and does not wipe the file ---
{
  resetRefreshLock();
  const now = Date.parse("2026-11-13T00:00:00.000Z");
  const original = fixtureStore({ expires_at: new Date(now + 60 * 1000).toISOString() });
  const { dir, file, env } = tempEnv(original);
  const before = readFileSync(file, "utf8");
  const fetchMock = async (url) => {
    if (isTokenUrl(url)) {
      return jsonResponse(400, { error: "invalid_grant", error_description: "Token already used or revoked" });
    }
    throw new Error("API should not be called after a failed refresh in this fixture");
  };
  try {
    await assert.rejects(
      () => resolveAccessToken({ env, fetch: fetchMock, now: () => now }),
      (err) => {
        assert.match(err.message, /token refresh failed \(400\)/i);
        assert.match(err.message, /Re-run: node scripts\/oura-auth.js login/);
        assert.doesNotMatch(err.message, /fixture-old-refresh-token/);
        assert.doesNotMatch(err.message, /fixture-old-access-token/);
        return true;
      }
    );
    assert.equal(existsSync(file), true, "token file must remain");
    assert.equal(readFileSync(file, "utf8"), before, "token file must be unchanged");
    const status = publicTokenStatus(readTokenFile(file), file, now);
    assert.equal(status.has_refresh_token, true);
    assert.equal(status.scope, "daily personal");
    console.log("PASS  refresh failure yields a clean error and does not wipe the file");
  } finally {
    cleanup(dir);
  }
}

// env-only mode still works with no token file (and does not try to refresh)
{
  resetRefreshLock();
  const { dir, env } = tempEnv(null, { OURA_ACCESS_TOKEN: "fixture-env-access-token" });
  // tempEnv still created a dir but no file
  let refreshCalls = 0;
  const fetchMock = async (url, init) => {
    if (isTokenUrl(url)) {
      refreshCalls += 1;
      throw new Error("env-only mode must not refresh");
    }
    assert.equal(authHeader(init), "Bearer fixture-env-access-token");
    return jsonResponse(200, { id: "fixture-env-user" });
  };
  try {
    const result = await fetchPersonalInfo({ env, fetch: fetchMock });
    assert.equal(result.id, "fixture-env-user");
    assert.equal(refreshCalls, 0);
    console.log("PASS  env-only token mode is unchanged");
  } finally {
    cleanup(dir);
  }
}

console.log("PASS  all token fixture tests");
