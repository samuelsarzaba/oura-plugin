/**
 * Live stdio smoke: initialize, tools/list, tools/call.
 * 1) no token  -> clean missing-token error
 * 2) bogus token against the real Oura API -> clean 401 error
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.js");

function parseLines(buffer) {
  return buffer
    .toString("utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function rpc(child, message) {
  child.stdin.write(JSON.stringify(message) + "\n");
}

async function session(env, requests, { waitMs = 8000 } = {}) {
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      ...env,
      NO_COLOR: "1",
      // Isolate env-only smoke from any real token file on the box.
      OURA_TOKEN_FILE: env.OURA_TOKEN_FILE || "/tmp/oura-plugin-smoke-missing-tokens.json",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  child.stdout.on("data", (c) => {
    stdout = Buffer.concat([stdout, c]);
  });
  child.stderr.on("data", (c) => {
    stderr = Buffer.concat([stderr, c]);
  });

  const received = [];
  const waitForCount = requests.filter((r) => r.id !== undefined).length;

  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `Timed out waiting for ${waitForCount} responses. stdout=${stdout.toString()} stderr=${stderr.toString()}`
        )
      );
    }, waitMs);

    const check = () => {
      try {
        const msgs = parseLines(stdout);
        if (msgs.length >= waitForCount) {
          clearTimeout(timer);
          received.splice(0, received.length, ...msgs);
          child.stdin.end();
          child.kill();
          resolve(msgs);
        }
      } catch {
        // incomplete line
      }
    };
    child.stdout.on("data", check);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  for (const req of requests) rpc(child, req);
  const msgs = await done;
  // allow the process to exit
  await new Promise((r) => setTimeout(r, 50));
  return { msgs, stdout: stdout.toString(), stderr: stderr.toString() };
}

const initAndList = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "oura-smoke", version: "0.1.0" },
    },
  },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
  {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "get_day_summary",
      arguments: { start_date: "2026-11-10", end_date: "2026-11-12" },
    },
  },
];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// --- 1. missing token ---
const missing = await session(
  { OURA_ACCESS_TOKEN: "" },
  initAndList
);
const [init, list, call] = missing.msgs;
assert(init.result?.serverInfo?.name === "oura", `initialize serverInfo: ${JSON.stringify(init)}`);
assert(init.result?.protocolVersion, `initialize protocol: ${JSON.stringify(init)}`);
const names = (list.result?.tools || []).map((t) => t.name).sort();
assert(names.includes("get_day_summary") && names.includes("get_personal_info"), `tools/list: ${JSON.stringify(list)}`);
assert(call.result?.isError === true, `missing-token should be isError: ${JSON.stringify(call)}`);
const missingText = call.result.content.map((c) => c.text).join("\n");
assert(
  /Missing OURA_ACCESS_TOKEN/i.test(missingText),
  `missing-token message unexpected: ${missingText}`
);
console.log("PASS  smoke initialize + tools/list + tools/call (missing token)");
console.log("  initialize:", JSON.stringify(init.result.serverInfo));
console.log("  tools:", names.join(", "));
console.log("  missing-token snippet:", missingText.slice(0, 240));

// --- 2. bogus token hits the real API ---
const bogus = await session(
  { OURA_ACCESS_TOKEN: "bogus-token-not-real" },
  initAndList,
  { waitMs: 20000 }
);
const bogusCall = bogus.msgs.find((m) => m.id === 3);
assert(bogusCall?.result?.isError === true, `bogus token should be isError: ${JSON.stringify(bogusCall)}`);
const bogusText = (bogusCall.result.content || []).map((c) => c.text).join("\n");
assert(
  /401|Unauthorized/i.test(bogusText),
  `expected a clean 401 message, got: ${bogusText}`
);
console.log("PASS  smoke tools/call against real API with bogus token");
console.log("  401 snippet:", bogusText.slice(0, 240));
