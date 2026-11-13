# oura

Agent Plugin that exposes a user's Oura Ring API v2 data through two MCP tools and one skill.

Domain type (fields verified against Oura OpenAPI 1.43):

`OuraDay = { day, sleep_score, readiness_score, activity_score, steps, total_sleep_hours, avg_hrv, lowest_heart_rate, contributors }`

## Tools

- `get_day_summary(start_date?, end_date?)` — merges `daily_sleep`, `daily_readiness`, `daily_activity`, and `sleep` periods for an inclusive `YYYY-MM-DD` range. Default: the last 7 **local** calendar days (`OURA_TIMEZONE` if set to an IANA name such as `America/New_York`, otherwise the process time zone via `Intl`).
- `get_personal_info()` — `GET /v2/usercollection/personal_info`.

## Token

Oura deprecated personal access tokens in December 2025. Use an OAuth 2.0 access token as `Authorization: Bearer <token>`. This plugin supports two modes.

### Quick (30-day access token)

The Oura client-side / implicit flow (`response_type=token`) returns an access token that currently lasts about 30 days and **has no refresh token**. Export it and start the server:

```bash
export OURA_ACCESS_TOKEN="your-oauth-access-token"
# optional:
export OURA_TIMEZONE="America/New_York"
node src/server.js
```

When this token expires you must authorize again. The MCP server will not try to refresh an env-only token.

### Auto-refresh login (recommended)

The server-side authorization-code flow issues a refresh token. Oura refresh tokens are **single-use**: each refresh returns a new access + refresh pair, which this plugin writes atomically before using.

1. Register an [API application](https://cloud.ouraring.com/oauth/applications) with redirect URI `http://localhost:8080/callback`. Scopes: `daily` and `personal`.
2. From the plugin root:

```bash
export OURA_CLIENT_ID="your-client-id"
export OURA_CLIENT_SECRET="your-client-secret"
# optional:
export OURA_TIMEZONE="America/New_York"
export OURA_TOKEN_FILE="$HOME/.config/oura-plugin/tokens.json"

node scripts/oura-auth.js login
```

The command prints an authorize URL (PKCE S256), listens on `http://localhost:8080/callback`, and also accepts a pasted redirect URL or `node scripts/oura-auth.js login --code <code>` if the browser is not on this machine. Tokens are written to `$OURA_TOKEN_FILE` (default `~/.config/oura-plugin/tokens.json`), mode `0600`. Token values are never printed.

```bash
node scripts/oura-auth.js status
```

shows whether the file exists, the expiry time, and the scope — no secrets.

The MCP server prefers the token file if present, otherwise `OURA_ACCESS_TOKEN`. If the stored access token expires within 5 minutes, or a call returns 401, it refreshes once (serialized in-process), persists the new pair, and retries. If refresh fails, rerun `node scripts/oura-auth.js login`. The server needs `OURA_CLIENT_ID` and `OURA_CLIENT_SECRET` in its environment to refresh.

Authorize URL: `https://api.ouraring.com/v2/oauth/authorize`. Token URL: `https://api.ouraring.com/v2/oauth/token` (from Oura's live `/.well-known/oauth-authorization-server` metadata; the older `/oauth/*` URLs in the docs also respond). See [Oura authentication](https://cloud.ouraring.com/docs/authentication).

### How secrets are supplied

Agent Plugins 1.0.0 has **no portable `variables` field** — `plugin.json` is a closed schema. `mcp.json` uses placeholders for `OURA_ACCESS_TOKEN`, `OURA_TIMEZONE`, `OURA_CLIENT_ID`, `OURA_CLIENT_SECRET`, and `OURA_TOKEN_FILE`. The official spec only expands `${PLUGIN_ROOT}` and `${PLUGIN_DATA}`; an unexpanded placeholder is treated as unset. Never commit a real token or client secret.

Oura requires a non-empty `User-Agent`; this server sends `oura-plugin/0.1.0`.

## Layout

```
plugin.json              Agent Plugins manifest
mcp.json                 stdio MCP server
src/server.js            JSON-RPC 2.0 stdio entry
src/oura.js              Oura HTTP client
src/tokens.js            Token file + refresh
src/merge.js             OuraDay merge + local dates
scripts/oura-auth.js     login / status
skills/oura/SKILL.md     When to call the tools
```

Requires Node 18+ (global `fetch`). No npm dependencies.
