---
name: oura
description: Use when the user asks about their own Oura Ring sleep, readiness, activity, recovery, HRV, resting heart rate, steps, or profile — call get_day_summary or get_personal_info instead of inventing numbers.
---

# Oura

Call the `oura` MCP tools for the authenticated user's live Oura API v2 data. Never invent or estimate scores, hours, HRV, heart rate, or steps.

## When to use which tool

- `get_day_summary` — sleep score, readiness score, activity score, steps, total sleep hours, average HRV, lowest heart rate, or the contributor breakdowns for a date range. Optional arguments: `start_date` and `end_date` as `YYYY-MM-DD`. If omitted, the server uses the last 7 local calendar days (`OURA_TIMEZONE`, else the process time zone). The returned `range` includes `time_zone`.
- `get_personal_info` — the profile attached to this token (age, height, weight, biological_sex, email).

Do not call these tools for someone else's ring or for general Oura product questions that do not need this user's data.

## How to read a day

Each `get_day_summary` element is one `OuraDay`:

`{ day, sleep_score, readiness_score, activity_score, steps, total_sleep_hours, avg_hrv, lowest_heart_rate, contributors }`

- Scores and `steps` come from Oura's daily_sleep, daily_readiness, and daily_activity documents.
- `total_sleep_hours` is derived from sleep-period `total_sleep_duration` (seconds). `avg_hrv` and `lowest_heart_rate` come from the primary `long_sleep` period that day. Oura has no field named `resting_hr`; `contributors.readiness.resting_heart_rate` is a 1–100 score contribution, not bpm.
- `null` means that document or period was missing, not that the value is zero.

If a tool returns an error (missing token, 401, 403, 429, or a failed refresh), report that error and, when the message says so, ask the user to run `node scripts/oura-auth.js login`. Do not substitute made-up data.
