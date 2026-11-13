#!/usr/bin/env node
/**
 * Oura OAuth login/status helper (server-side authorization-code + PKCE).
 * Never prints access or refresh token values.
 *
 *   export OURA_CLIENT_ID=...
 *   export OURA_CLIENT_SECRET=...
 *   node scripts/oura-auth.js login
 *   node scripts/oura-auth.js status
 *
 * Redirect URI (must match the API application): http://localhost:8080/callback
 * Scopes: daily personal
 */

import http from "node:http";
import { createInterface } from "node:readline";
import { chmodSync, statSync } from "node:fs";
import {
  OuraError,
  DEFAULT_SCOPES,
  PENDING_TTL_MS,
  buildAuthorizeUrl,
  clearPendingAuth,
  exchangeAuthorizationCode,
  generatePkce,
  parseCallbackInput,
  publicTokenStatus,
  readPendingAuth,
  readStoredTokens,
  redirectUri,
  requireClientCredentials,
  tokenFilePath,
  writePendingAuth,
  writeTokenFile,
} from "../src/tokens.js";
import { formatDateInTimeZone, resolveTimeZone } from "../src/merge.js";

function usage(exitCode = 1) {
  console.error(`Usage:
  node scripts/oura-auth.js login [--code <code>] [--callback-url <url>]
  node scripts/oura-auth.js status

login requires OURA_CLIENT_ID and OURA_CLIENT_SECRET.
Tokens are written to $OURA_TOKEN_FILE or ~/.config/oura-plugin/tokens.json (mode 0600).
Token values are never printed.`);
  process.exit(exitCode);
}

function fail(err) {
  const message = err instanceof OuraError || err?.message ? err.message : String(err);
  console.error(message);
  process.exit(1);
}

function formatLocalExpiry(iso, timeZone) {
  if (!iso) return "unknown";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  const calendar = formatDateInTimeZone(date, timeZone);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(date);
  return `${calendar} ${time} (${timeZone})`;
}

function parseArgs(argv) {
  const args = { command: argv[0], code: null, callbackUrl: null };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") usage(0);
    else if (a === "--code") args.code = argv[++i];
    else if (a.startsWith("--code=")) args.code = a.slice("--code=".length);
    else if (a === "--callback-url") args.callbackUrl = argv[++i];
    else if (a.startsWith("--callback-url=")) args.callbackUrl = a.slice("--callback-url=".length);
    else {
      console.error(`Unknown argument: ${a}`);
      usage(1);
    }
  }
  return args;
}

function cmdStatus(env = process.env) {
  const path = tokenFilePath(env);
  const { store } = readStoredTokens(env);
  const timeZone = resolveTimeZone(env);
  if (!store) {
    console.log(`Token file: ${path}`);
    console.log("Present: no");
    console.log("Run: node scripts/oura-auth.js login");
    return;
  }
  const status = publicTokenStatus(store, path);
  let mode = "unknown";
  try {
    mode = (statSync(path).mode & 0o777).toString(8).padStart(3, "0");
  } catch {
    // ignore
  }
  console.log(`Token file: ${status.path}`);
  console.log("Present: yes");
  console.log(`File mode: ${mode}`);
  console.log(`Expires: ${formatLocalExpiry(status.expires_at, timeZone)}`);
  console.log(`Scope: ${status.scope || "(not recorded)"}`);
  console.log(`Refresh token: ${status.has_refresh_token ? "present" : "missing"}`);
  if (status.expired) console.log("State: expired — run node scripts/oura-auth.js login");
  else if (status.expiring_soon) console.log("State: expiring within 5 minutes; the MCP server will refresh on the next call");
}

async function completeLogin({ code, state, pending, env }) {
  if (pending.state && state && pending.state !== state) {
    throw new OuraError("OAuth state did not match; refusing to exchange the code. Re-run login.", {
      code: "state_mismatch",
    });
  }
  const tokens = await exchangeAuthorizationCode({
    code,
    code_verifier: pending.verifier,
    env,
  });
  const path = tokenFilePath(env);
  writeTokenFile(path, tokens);
  clearPendingAuth(env);
  try {
    chmodSync(path, 0o600);
  } catch {
    // already set
  }
  const timeZone = resolveTimeZone(env);
  console.log(`Saved tokens to ${path} (mode 0600).`);
  console.log(`Access token expires: ${formatLocalExpiry(tokens.expires_at, timeZone)}`);
  console.log(`Scope: ${tokens.scope || DEFAULT_SCOPES}`);
  console.log(`Refresh token: ${tokens.refresh_token ? "present" : "missing"}`);
}

/**
 * Listen on localhost for /callback, and also accept a pasted redirect URL or code on stdin.
 */
function waitForAuthorizationCode({ expectedState, redirect, provided }) {
  if (provided) {
    return Promise.resolve(parseCallbackInput(provided, expectedState));
  }

  const url = new URL(redirect);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const host = url.hostname === "localhost" ? "127.0.0.1" : url.hostname;
  const callbackPath = url.pathname || "/callback";

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      try {
        server.close();
      } catch {
        // ignore
      }
      if (rl) {
        try {
          rl.close();
        } catch {
          // ignore
        }
      }
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };

    const server = http.createServer((req, res) => {
      const incoming = new URL(req.url, redirect);
      if (incoming.pathname !== callbackPath) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      try {
        const parsed = parseCallbackInput(incoming.toString(), expectedState);
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Oura authorization complete. You can close this tab and return to the terminal.");
        finish(null, parsed);
      } catch (err) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(err.message || "Authorization failed");
        finish(err);
      }
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.error(
          `Port ${port} is already in use, so the callback server could not start. Paste the full redirect URL or re-run with --code <code>.`
        );
      } else {
        finish(err);
      }
    });

    server.listen(port, host, () => {
      console.log(`Listening for the redirect on ${redirect}`);
    });

    let rl = null;
    if (process.stdin.isTTY || !process.stdin.readableEnded) {
      rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
      if (process.stdin.isTTY) {
        rl.setPrompt("Paste the full redirect URL or the code, then press Enter: ");
        rl.prompt();
      }
      rl.on("line", (line) => {
        const text = line.trim();
        if (!text) {
          if (process.stdin.isTTY) rl.prompt();
          return;
        }
        try {
          finish(null, parseCallbackInput(text, expectedState));
        } catch (err) {
          finish(err);
        }
      });
    }

    const timer = setTimeout(() => {
      finish(
        new OuraError(
          `Timed out waiting for the OAuth callback after ${PENDING_TTL_MS / 60000} minutes. Pending PKCE is kept briefly; re-run with --code <code> if you already authorized.`,
          { code: "auth_timeout" }
        )
      );
    }, PENDING_TTL_MS);
  });
}

async function cmdLogin(args, env = process.env) {
  const { client_id } = requireClientCredentials(env);
  const redirect = redirectUri(env);
  const provided = args.callbackUrl || args.code;

  let pending = provided ? readPendingAuth(env) : null;
  if (provided && !pending) {
    throw new OuraError(
      "No pending PKCE verifier was found (it expires after 15 minutes). Run login without --code first to print a new authorize URL.",
      { code: "pending_missing" }
    );
  }

  if (!pending) {
    const pkce = generatePkce();
    pending = {
      verifier: pkce.verifier,
      challenge: pkce.challenge,
      state: pkce.state,
      created_at: new Date().toISOString(),
      redirect_uri: redirect,
      scope: DEFAULT_SCOPES,
    };
    writePendingAuth(env, pending);
    const url = buildAuthorizeUrl({
      client_id,
      redirect_uri: redirect,
      scope: DEFAULT_SCOPES,
      state: pending.state,
      challenge: pending.challenge,
    });
    console.log("Open this authorization URL in a browser (scopes: daily personal):");
    console.log("");
    console.log(url);
    console.log("");
    console.log(
      "This process will catch the redirect at http://localhost:8080/callback. If the browser is not on this machine, paste the full redirect URL or the code below, or stop and re-run: node scripts/oura-auth.js login --code <code>"
    );
    console.log("");
  }

  const parsed = await waitForAuthorizationCode({
    expectedState: pending.state,
    redirect,
    provided,
  });
  await completeLogin({ code: parsed.code, state: parsed.state, pending, env });
}

const argv = process.argv.slice(2);
const command = argv[0];
if (!command || command === "--help" || command === "-h") usage(command ? 0 : 1);

try {
  if (command === "status") {
    cmdStatus();
  } else if (command === "login") {
    const args = parseArgs(argv);
    await cmdLogin(args);
  } else {
    console.error(`Unknown command: ${command}`);
    usage(1);
  }
} catch (err) {
  fail(err);
}
