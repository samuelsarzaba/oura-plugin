/**
 * Fixture-only unit checks for mergeDays / resolveDateRange.
 * The documents in test/fixtures/days.json are invented and labeled as a fixture.
 * They are not live Oura data.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultDateRange,
  formatDateInTimeZone,
  mergeDays,
  primarySleepPeriod,
  resolveDateRange,
  resolveTimeZone,
} from "../src/merge.js";

const fixture = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures/days.json"), "utf8")
);

assert.equal(fixture._comment.includes("FIXTURE"), true, "fixture must be labeled as fixture");

const days = mergeDays(fixture);
assert.deepEqual(
  days.map((d) => d.day),
  ["2026-11-10", "2026-11-11"],
  "union of days, sorted"
);

const d0 = days[0];
assert.equal(d0.sleep_score, 82);
assert.equal(d0.readiness_score, 71);
assert.equal(d0.activity_score, 88);
assert.equal(d0.steps, 10432);
// 25200 + 1800 = 27000 seconds = 7.5 hours; rest/deleted excluded
assert.equal(d0.total_sleep_hours, 7.5);
assert.equal(d0.avg_hrv, 41, "HRV from long_sleep, not the nap or rest");
assert.equal(d0.lowest_heart_rate, 52);
assert.equal(d0.contributors.sleep.total_sleep, 78);
assert.equal(d0.contributors.readiness.resting_heart_rate, 72);
assert.equal(d0.contributors.activity.stay_active, 85);

const d1 = days[1];
assert.equal(d1.sleep_score, null, "missing daily_sleep stays null");
assert.equal(d1.readiness_score, null);
assert.equal(d1.activity_score, 50);
assert.equal(d1.steps, 2100);
assert.equal(d1.total_sleep_hours, null, "no sleep periods => null, not 0");
assert.equal(d1.avg_hrv, null);
assert.equal(d1.lowest_heart_rate, null);
assert.equal(d1.contributors.sleep, null);
assert.equal(d1.contributors.activity.meet_daily_targets, 40);

const primary = primarySleepPeriod(fixture.sleepPeriods);
assert.equal(primary.id, "period-long");

assert.deepEqual(resolveDateRange({}, new Date("2026-11-12T15:00:00Z"), "America/New_York"), {
  start_date: "2026-11-06",
  end_date: "2026-11-12",
  time_zone: "America/New_York",
});
assert.deepEqual(resolveDateRange({ start_date: "2026-11-01", end_date: "2026-11-03" }, new Date(), "UTC"), {
  start_date: "2026-11-01",
  end_date: "2026-11-03",
  time_zone: "UTC",
});

assert.throws(() => resolveDateRange({ start_date: "2026-13-01" }), /start_date/);
assert.throws(() => resolveDateRange({ start_date: "2026-11-10", end_date: "2026-11-01" }), /on or before/);
assert.throws(() => resolveDateRange({ start_date: "not-a-date", end_date: "2026-11-01" }), /YYYY-MM-DD/);

const defUtc = defaultDateRange(new Date("2026-01-01T00:00:00Z"), "UTC");
assert.deepEqual(defUtc, { start_date: "2025-12-26", end_date: "2026-01-01", time_zone: "UTC" });

// 2026-11-13T00:29Z is 2026-11-12 19:29 in America/New_York (EST, UTC-5).
const nyInstant = new Date("2026-11-13T00:29:00Z");
assert.equal(formatDateInTimeZone(nyInstant, "America/New_York"), "2026-11-12");
assert.deepEqual(defaultDateRange(nyInstant, "America/New_York"), {
  start_date: "2026-11-06",
  end_date: "2026-11-12",
  time_zone: "America/New_York",
});
assert.deepEqual(resolveDateRange({}, nyInstant, "America/New_York"), {
  start_date: "2026-11-06",
  end_date: "2026-11-12",
  time_zone: "America/New_York",
});
assert.equal(resolveTimeZone({ OURA_TIMEZONE: "America/New_York" }), "America/New_York");
assert.equal(resolveTimeZone({ OURA_TIMEZONE: "${OURA_TIMEZONE}" }), Intl.DateTimeFormat().resolvedOptions().timeZone);
assert.throws(() => resolveTimeZone({ OURA_TIMEZONE: "Not/AZone" }), /Invalid time zone/);

assert.deepEqual(mergeDays({}), []);

console.log("PASS  merge fixture tests");
