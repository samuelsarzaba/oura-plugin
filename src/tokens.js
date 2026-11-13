/**
 * Oura OAuth token store and refresh.
 * Default file: ~/.config/oura-plugin/tokens.json (override OURA_TOKEN_FILE).
 * Refresh tokens are single-use: persist the new pair atomically before use.
 */

import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  existsSync,
  writeSync,
} from "node:fs";
import { dirname, join, basename } from "node:path";
import { homedir } from "node:os";
import { randomBytes, createHash } from "node:crypto";
import { envValue } from "./merge.js";

export const USER_AGENT = "oura-plugin/0.1.0";
export const AUTHORIZE_URL = "https://api.ouraring.com/v2/oauth/authorize";
export const TOKEN_URL = "https://api.ouraring.com/v2/oauth/token";
export const DEFAULT_REDIRECT_URI = "http://localhost:8080/callback";
export const DEFAULT_SCOPES = "daily personal";
export const REFRESH_SKEW_MS = 5 * 60 * 1000;
export const PENDING_TTL_MS = 15 * 60 * 1000;

export class OuraError extends Error {
  constructor(message, { code, status } = {}) {
    super(message);
    this.name = "OuraError";
    this.code = code || (status ? `http_${status}` : "oura_error");
    this.status = status ?? null;
  }
}

export function tokenFilePath(env = process.env) {
  return envValue(env, "OURA_TOKEN_FILE") || join(homedir(), ".config/oura-plugin/tokens.json");
}

export function pendingAuthPath(env = process.env) {
  return join(dirname(tokenFilePath(env)), "pending-auth.json");
}

export function redirectUri(env = process.env) {
  return envValue(env, "OURA_REDIRECT_URI") || DEFAULT_REDIRECT_URI;
}

export function requireClientCredentials(env = process.env) {
  const client_id = envValue(env, "OURA_CLIENT_ID");
  const client_secret = envValue(env, "OURA_CLIENT_SECRET");
  if (!client_id || !client_secret) {
    throw new OuraError(
      "OURA_CLIENT_ID and OURA_CLIENT_SECRET must be set (from your Oura API application). Re-run: node scripts/oura-auth.js login",
      { code: "missing_client" }
    );
  }
  return { client_id, client_secret };
}

function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best-effort on filesystems that don't allow chmod
  }
}

/** Atomic write of JSON (temp file in the same directory + rename), mode 0600. */
export function writeJsonAtomic(filePath, value) {
  const dir = dirname(filePath);
  ensurePrivateDir(dir);
  const tmp = join(
    dir,
    `.${basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  );
  const body = JSON.stringify(value, null, 2);
  try {
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeAll(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    renameSync(tmp, filePath);
    chmodSync(filePath, 0o600);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore cleanup
    }
    throw err;
  }
}

function writeAll(fd, text) {
  const buf = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < buf.length) {
    const n = writeSync(fd, buf, offset, buf.length - offset);
    if (n <= 0) throw new Error("short write");
    offset += n;
  }
}

export function writeTokenFile(filePath, tokens) {
  writeJsonAtomic(filePath, {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? null,
    expires_at: tokens.expires_at ?? null,
    scope: tokens.scope ?? null,
  });
}

export function readTokenFile(filePath) {
  if (!existsSync(filePath)) return null;
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new OuraError(`Could not read Oura token file: ${err.message}`, {
      code: "token_file_unreadable",
    });
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new OuraError(
      `Oura token file is not valid JSON. Re-run: node scripts/oura-auth.js login`,
      { code: "token_file_invalid" }
    );
  }
  if (!data || typeof data !== "object" || !data.access_token) {
    throw new OuraError(
      `Oura token file is missing access_token. Re-run: node scripts/oura-auth.js login`,
      { code: "token_file_invalid" }
    );
  }
  return data;
}

export function isExpiringSoon(store, now = Date.now(), skewMs = REFRESH_SKEW_MS) {
  if (!store?.expires_at) return false;
  const t = Date.parse(store.expires_at);
  if (!Number.isFinite(t)) return false;
  return t <= now + skewMs;
}

export function tokensFromTokenResponse(data, now = Date.now()) {
  if (!data || !data.access_token) {
    throw new OuraError(
      "Oura token response did not include an access_token. Re-run: node scripts/oura-auth.js login",
      { code: "refresh_failed" }
    );
  }
  const expires_in = Number(data.expires_in);
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? null,
    expires_at: Number.isFinite(expires_in)
      ? new Date(now + expires_in * 1000).toISOString()
      : null,
    scope: data.scope ?? null,
  };
}

export function publicTokenStatus(store, filePath, now = Date.now()) {
  if (!store) {
    return { present: false, path: filePath };
  }
  const expiresAt = store.expires_at ? Date.parse(store.expires_at) : NaN;
  return {
    present: true,
    path: filePath,
    expires_at: store.expires_at || null,
    expired: Number.isFinite(expiresAt) ? expiresAt <= now : null,
    expiring_soon: isExpiringSoon(store, now),
    scope: store.scope || null,
    has_refresh_token: Boolean(store.refresh_token),
  };
}

function base64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function generatePkce() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(24));
  return { verifier, challenge, state };
}

export function buildAuthorizeUrl({ client_id, redirect_uri, scope, state, challenge }) {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client_id);
  url.searchParams.set("redirect_uri", redirect_uri);
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export function parseCallbackInput(input, expectedState) {
  const text = String(input || "").trim();
  if (!text) {
    throw new OuraError("No authorization code or redirect URL was provided.", {
      code: "missing_code",
    });
  }
  let code;
  let state;
  let error;
  let error_description;
  if (/^https?:\/\//i.test(text) || text.startsWith("/callback") || text.includes("?")) {
    const url = text.startsWith("/callback")
      ? new URL(text, DEFAULT_REDIRECT_URI)
      : text.includes("://")
        ? new URL(text)
        : new URL(text, DEFAULT_REDIRECT_URI);
    code = url.searchParams.get("code");
    state = url.searchParams.get("state");
    error = url.searchParams.get("error");
    error_description = url.searchParams.get("error_description");
  } else {
    code = text;
  }
  if (error) {
    throw new OuraError(
      `Oura authorization failed: ${error}${error_description ? ` (${error_description})` : ""}. Re-run: node scripts/oura-auth.js login`,
      { code: "auth_denied" }
    );
  }
  if (!code) {
    throw new OuraError("Redirect URL did not include an authorization code.", {
      code: "missing_code",
    });
  }
  if (expectedState && state && state !== expectedState) {
    throw new OuraError("OAuth state did not match; refusing to exchange the code. Re-run login.", {
      code: "state_mismatch",
    });
  }
  if (expectedState && !state && /^https?:\/\//i.test(text)) {
    throw new OuraError("Redirect URL did not include state; refusing to exchange the code. Re-run login.", {
      code: "state_mismatch",
    });
  }
  return { code, state: state || expectedState };
}

export async function safeOAuthErrorText(response) {
  const text = await response.text().catch(() => "");
  try {
    const json = JSON.parse(text);
    const parts = [json.error, json.error_description, json.message, json.detail].filter(Boolean);
    return parts.join(": ") || response.statusText || String(response.status);
  } catch {
    return response.statusText || String(response.status);
  }
}

export async function exchangeAuthorizationCode({
  code,
  code_verifier,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
}) {
  const { client_id, client_secret } = requireClientCredentials(env);
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(env),
      client_id,
      client_secret,
      code_verifier,
    }).toString(),
  });
  if (!response.ok) {
    const detail = await safeOAuthErrorText(response);
    throw new OuraError(
      `Oura authorization-code exchange failed (${response.status}): ${detail}. Re-run: node scripts/oura-auth.js login`,
      { code: "exchange_failed", status: response.status }
    );
  }
  const data = await response.json();
  return tokensFromTokenResponse(data, now);
}

let inFlightRefresh = null;

export function resetRefreshLock() {
  inFlightRefresh = null;
}

export function readStoredTokens(env = process.env) {
  const path = tokenFilePath(env);
  return { path, store: existsSync(path) ? readTokenFile(path) : null };
}

export async function refreshAndPersist(options = {}, store = null) {
  if (!inFlightRefresh) {
    inFlightRefresh = doRefresh(options, store).finally(() => {
      inFlightRefresh = null;
    });
  }
  return inFlightRefresh;
}

async function doRefresh(options, store) {
  const env = options.env || process.env;
  const path = tokenFilePath(env);
  const current = (existsSync(path) ? readTokenFile(path) : null) || store;
  if (!current?.refresh_token) {
    throw new OuraError(
      "The stored Oura token has no refresh_token (the client-side implicit flow cannot be refreshed). Re-run: node scripts/oura-auth.js login",
      { code: "refresh_unavailable" }
    );
  }
  const { client_id, client_secret } = requireClientCredentials(env);
  const fetchImpl = options.fetch || globalThis.fetch;
  const now = typeof options.now === "function" ? options.now() : Date.now();
  let response;
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: current.refresh_token,
        client_id,
        client_secret,
      }).toString(),
    });
  } catch (err) {
    throw new OuraError(
      `Oura token refresh failed: ${err.message}. Re-run: node scripts/oura-auth.js login`,
      { code: "refresh_failed" }
    );
  }
  if (!response.ok) {
    const detail = await safeOAuthErrorText(response);
    throw new OuraError(
      `Oura token refresh failed (${response.status}): ${detail}. Re-run: node scripts/oura-auth.js login`,
      { code: "refresh_failed", status: response.status }
    );
  }
  const data = await response.json();
  const tokens = tokensFromTokenResponse(data, now);
  if (!tokens.refresh_token) tokens.refresh_token = current.refresh_token;
  if (!tokens.scope) tokens.scope = current.scope;
  writeTokenFile(path, tokens);
  return tokens;
}

export function readAccessTokenFromEnv(env = process.env) {
  const raw = envValue(env, "OURA_ACCESS_TOKEN");
  if (!raw) {
    throw new OuraError(
      "Missing OURA_ACCESS_TOKEN (and no token file). Set an Oura OAuth 2.0 access token in the environment, or run: node scripts/oura-auth.js login. Personal access tokens were deprecated in December 2025 and are no longer available for new use; see https://cloud.ouraring.com/docs/authentication.",
      { code: "missing_token" }
    );
  }
  return raw;
}

/**
 * Token resolution: token file if present, else OURA_ACCESS_TOKEN.
 * If the stored token expires within 5 minutes, refresh once, persist, then return.
 */
export async function resolveAccessToken(options = {}) {
  const env = options.env || process.env;
  const { store } = readStoredTokens(env);
  if (store?.access_token) {
    const now = typeof options.now === "function" ? options.now() : Date.now();
    if (options.forceRefresh || isExpiringSoon(store, now)) {
      const refreshed = await refreshAndPersist(options, store);
      return refreshed.access_token;
    }
    return store.access_token;
  }
  return readAccessTokenFromEnv(env);
}

export function canAttemptRefresh(env = process.env) {
  const { store } = readStoredTokens(env);
  return Boolean(store?.refresh_token);
}

export function writePendingAuth(env, pending) {
  writeJsonAtomic(pendingAuthPath(env), pending);
}

export function readPendingAuth(env = process.env, now = Date.now()) {
  const path = pendingAuthPath(env);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (!data?.verifier || !data?.state) return null;
    if (data.created_at && now - Date.parse(data.created_at) > PENDING_TTL_MS) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

export function clearPendingAuth(env = process.env) {
  const path = pendingAuthPath(env);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // ignore
  }
}
