#!/usr/bin/env node
/**
 * Zero-dependency MCP stdio server for the Oura Ring API v2.
 * JSON-RPC 2.0 over newline-delimited stdin/stdout, with Content-Length
 * framing accepted and echoed so official MCP clients also work.
 */

import { mergeDays, resolveDateRange } from "./merge.js";
import { OuraError, fetchDaySources, fetchPersonalInfo } from "./oura.js";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "oura", version: "0.1.0" };

const TOOLS = [
  {
    name: "get_day_summary",
    description:
      "Return one OuraDay per calendar day in the inclusive start_date–end_date range (YYYY-MM-DD). Merges daily_sleep, daily_readiness, daily_activity, and sleep periods. Defaults to the last 7 local calendar days (OURA_TIMEZONE, else the process time zone). Use for the user's own sleep, readiness, activity, recovery, HRV, resting heart rate (lowest_heart_rate), or step questions.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: {
          type: "string",
          description:
            "Inclusive start date (YYYY-MM-DD). Defaults to 6 days before end_date.",
        },
        end_date: {
          type: "string",
          description: "Inclusive end date (YYYY-MM-DD). Defaults to today in the local time zone (OURA_TIMEZONE, else the process zone).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_personal_info",
    description:
      "Return the authenticated user's Oura personal_info (id, age, weight, height, biological_sex, email). Use when a question needs the profile attached to this Oura token, not daily scores.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

let contentLengthMode = false;

function send(message) {
  const json = JSON.stringify(message);
  if (contentLengthMode) {
    const payload = Buffer.from(json, "utf8");
    process.stdout.write(`Content-Length: ${payload.length}\r\n\r\n`);
    process.stdout.write(payload);
  } else {
    process.stdout.write(json + "\n");
  }
}

function ok(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, { code, message, data }) {
  send({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
}

function toolResult(id, text, isError = false) {
  ok(id, { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });
}

function toolErrorMessage(err) {
  if (err instanceof OuraError || err.code) return err.message;
  return err && err.message ? err.message : String(err);
}

async function callGetDaySummary(args) {
  const range = resolveDateRange(args || {});
  const sources = await fetchDaySources(range);
  const days = mergeDays(sources);
  return {
    range,
    days,
    source: "oura_api_v2",
    notes: [
      "total_sleep_hours is derived from sleep period total_sleep_duration (seconds).",
      "avg_hrv and lowest_heart_rate come from the primary long_sleep period (else the longest contributing sleep/late_nap). Oura has no field named resting_hr.",
    ],
  };
}

async function callGetPersonalInfo() {
  const info = await fetchPersonalInfo();
  return { source: "oura_api_v2", personal_info: info };
}

async function handleRequest(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    const requested = params?.protocolVersion;
    ok(id, {
      protocolVersion: requested || PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
    return;
  }

  if (method === "notifications/initialized" || method === "initialized") {
    return;
  }

  if (method === "ping") {
    ok(id, {});
    return;
  }

  if (method === "tools/list") {
    ok(id, { tools: TOOLS });
    return;
  }

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    try {
      if (name === "get_day_summary") {
        const result = await callGetDaySummary(args);
        toolResult(id, JSON.stringify(result, null, 2));
        return;
      }
      if (name === "get_personal_info") {
        const result = await callGetPersonalInfo();
        toolResult(id, JSON.stringify(result, null, 2));
        return;
      }
      toolResult(id, `Unknown tool: ${name || "(missing name)"}`, true);
    } catch (err) {
      toolResult(id, toolErrorMessage(err), true);
    }
    return;
  }

  if (id !== undefined && id !== null) {
    fail(id, { code: -32601, message: `Method not found: ${method}` });
  }
}

function dispatch(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    fail(null, { code: -32700, message: "Parse error" });
    return;
  }
  if (message == null || typeof message !== "object") {
    fail(null, { code: -32600, message: "Invalid Request" });
    return;
  }
  Promise.resolve(handleRequest(message)).catch((err) => {
    if (message.id !== undefined && message.id !== null) {
      fail(message.id, { code: -32603, message: toolErrorMessage(err) });
    }
  });
}

/**
 * Read either LSP-style Content-Length frames or newline-delimited JSON.
 */
function listen() {
  let buffer = Buffer.alloc(0);

  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length) {
      const asString = buffer.toString("utf8");
      const headerMatch = asString.match(/^Content-Length:\s*(\d+)\r\n\r\n/i);
      if (headerMatch) {
        contentLengthMode = true;
        const headerLen = headerMatch[0].length;
        const length = Number(headerMatch[1]);
        const total = headerLen + length;
        if (buffer.length < total) return;
        const body = buffer.subarray(headerLen, total).toString("utf8");
        buffer = buffer.subarray(total);
        dispatch(body);
        continue;
      }

      // If a Content-Length header is arriving but incomplete, wait.
      if (/^Content-Length:/i.test(asString) && !asString.includes("\r\n\r\n")) {
        return;
      }

      const nl = buffer.indexOf(0x0a);
      if (nl === -1) return;
      let line = buffer.subarray(0, nl);
      buffer = buffer.subarray(nl + 1);
      if (line.length && line[line.length - 1] === 0x0d) {
        line = line.subarray(0, line.length - 1);
      }
      const text = line.toString("utf8").trim();
      if (!text) continue;
      contentLengthMode = false;
      dispatch(text);
    }
  });

  process.stdin.on("end", () => process.exit(0));
  process.stdin.resume();
}

listen();
