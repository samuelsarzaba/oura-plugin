# oura plugin — local verification

Updated 12 Nov 2026, about 7:35 PM America/New_York, at `/workspace/oura-plugin`. Official schemas from agent-plugins.org; Oura fields from OpenAPI 1.43; auth from https://cloud.ouraring.com/docs/authentication and OpenAPI 1.43.

## Data shape

`OuraDay = { day, sleep_score, readiness_score, activity_score, steps, total_sleep_hours, avg_hrv, lowest_heart_rate, contributors }`

Tools:

- `get_day_summary(start_date?, end_date?)` — YYYY-MM-DD, default last 7 **local** calendar days (`OURA_TIMEZONE` or the process zone)
- `get_personal_info()`

## Checks

### PASS — plugin.json and mcp.json schemas

Python `jsonschema` 4.26.0, `Draft202012Validator`, official Agent Plugins 1.0.0 schemas. `mcp.json` env keys: `OURA_ACCESS_TOKEN`, `OURA_TIMEZONE`, `OURA_CLIENT_ID`, `OURA_CLIENT_SECRET`, `OURA_TOKEN_FILE` (placeholders only). The official manifest schema still has no `variables` field.

```
PASS  plugin.json validates against https://agent-plugins.org/schemas/1.0.0/plugin.schema.json
PASS  mcp.json validates against https://agent-plugins.org/schemas/1.0.0/mcp.schema.json
```

### PASS — `node --check`

Node v24.22.1, including `src/tokens.js` and `scripts/oura-auth.js`.

```
node --check PASS
```

### PASS — merge fixture + local timezone unit tests

`node test/merge.test.js`. Includes the required proof that `2026-11-13T00:29Z` in `America/New_York` yields `end_date` 2026-11-12 and 7-day start 2026-11-06.

```
PASS  merge fixture tests
```

### PASS — token refresh fixture unit tests (mocked fetch)

`node test/tokens.test.js`. Tokens in this file are invented fixtures, not live credentials.

```
PASS  expiry-triggered refresh persists new tokens before retrying
PASS  401-triggered refresh retries once
PASS  concurrent calls trigger exactly one refresh
PASS  refresh failure yields a clean error and does not wipe the file
PASS  env-only token mode is unchanged
PASS  all token fixture tests
```

### PASS — stdio smoke, missing token and bogus token

`node test/smoke.js` (token file isolated so env-only mode is tested).

```
PASS  smoke initialize + tools/list + tools/call (missing token)
  initialize: {"name":"oura","version":"0.1.0"}
  tools: get_day_summary, get_personal_info
  missing-token snippet: Missing OURA_ACCESS_TOKEN (and no token file). ... or run: node scripts/oura-auth.js login.
PASS  smoke tools/call against real API with bogus token
  401 snippet: Unauthorized (401): Oura rejected the access token. It may be invalid, expired, malformed, or revoked.
```

### PASS — live `get_day_summary` with no args (env access token)

Real `OURA_ACCESS_TOKEN` from the box environment (value not printed). `OURA_TIMEZONE=America/New_York`. Only range and day count are recorded.

```
PASS  live get_day_summary (no args, env token, America/New_York)
  range: {"start_date":"2026-11-06","end_date":"2026-11-12","time_zone":"America/New_York"}
  days: 7
```

This confirms the default range is the local calendar day 2026-11-12 (not the UTC date 2026-11-13) and that data still returns.

### PASS — auth CLI without credentials

```
node scripts/oura-auth.js status
  Token file: ...
  Present: no
  Run: node scripts/oura-auth.js login

node scripts/oura-auth.js login   # no OURA_CLIENT_ID / SECRET
  OURA_CLIENT_ID and OURA_CLIENT_SECRET must be set ... Re-run: node scripts/oura-auth.js login
```

### PASS — copied (not symlinked) to `~/.cursor/plugins/local/oura`

Copied with `cp -a` from `/workspace/oura-plugin` to `/home/box/.cursor/plugins/local/oura` after these changes. Destination is a real directory with a different inode.

### FAIL (unavailable) — `loadUserLocalPlugins({ userHomeDir })`

`@anysphere/cursor-plugins` is not on the public npm registry (404). Not retried.

## Cannot be proven here

- Live `oura-auth.js login` or a live token refresh against Oura (no client id/secret on this box)
- Cursor IDE Customize UI discovering the plugin
- Org policy or marketplace review
- Grok Bot itself does not load local Cursor plugins

## Auth notes

Official docs: personal access tokens were deprecated in December 2025. The user currently has a ~30-day access token from the client-side (implicit) flow, which has no refresh token — env-only mode covers that. Auto-refresh requires the server-side authorization-code flow (`node scripts/oura-auth.js login`) plus `OURA_CLIENT_ID` / `OURA_CLIENT_SECRET`. Refresh tokens are single-use; the server persists the new pair atomically before use and serializes in-process refreshes.

## Live OAuth check (2026-11-12 ~7:43 PM ET)
- FIX: switched AUTHORIZE_URL/TOKEN_URL to https://api.ouraring.com/v2/oauth/{authorize,token} per live /.well-known/oauth-authorization-server; the legacy /oauth/token returned 400 invalid_request for the code exchange. Error text now includes Oura's `detail` field.
- PASS live login: tokens saved (mode 600), scope extapi:daily extapi:personal, refresh token present, expiry 30 days.
- PASS live refresh: forced expires_at into the past, then get_day_summary with OURA_ACCESS_TOKEN unset: access+refresh tokens both rotated (hash prefixes changed), file stayed mode 600, 7 days returned (2026-11-06..12, America/New_York).
- PASS unit tests after URL change.
