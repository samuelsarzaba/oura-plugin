/**
 * Merge Oura v2 daily_sleep, daily_readiness, daily_activity, and sleep
 * period documents into one OuraDay per calendar day.
 *
 * Field sources (official OpenAPI 1.43 at
 * https://cloud.ouraring.com/v2/static/json/openapi-1.43.json):
 *   sleep_score          <- PublicDailySleep.score
 *   readiness_score      <- PublicDailyReadiness.score
 *   activity_score       <- PublicDailyActivity.score
 *   steps                <- PublicDailyActivity.steps
 *   total_sleep_hours    <- sum of PublicModifiedSleepModel.total_sleep_duration
 *                           (seconds) / 3600 for contributing periods that day
 *                           (derived; the API field is total_sleep_duration)
 *   avg_hrv              <- PublicModifiedSleepModel.average_hrv of the primary
 *                           long_sleep (else longest contributing period)
 *   lowest_heart_rate    <- PublicModifiedSleepModel.lowest_heart_rate of that
 *                           same period. There is no API field named resting_hr.
 *                           PublicReadinessContributors.resting_heart_rate is a
 *                           1-100 score contribution, not bpm, and is left in
 *                           contributors.readiness.
 *   contributors.sleep      <- PublicSleepContributors
 *   contributors.readiness  <- PublicReadinessContributors
 *   contributors.activity   <- PublicActivityContributors
 *
 * PublicSleepType: deleted | sleep | long_sleep | late_nap | rest
 * deleted and rest do not contribute to totals or primary-period vitals.
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Sleep types that contribute to daily scores (Oura PublicSleepType). */
const CONTRIBUTING_SLEEP_TYPES = new Set(["long_sleep", "sleep", "late_nap"]);

export function isIsoDate(value) {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const [, y, m, d] = value.match(DATE_RE).map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

export function isPlaceholderEnv(value, key) {
  if (value == null) return true;
  const s = String(value).trim();
  return s === "" || s === "${" + key + "}";
}

export function envValue(env, key) {
  if (!env || isPlaceholderEnv(env[key], key)) return null;
  return String(env[key]).trim();
}

/** IANA zone from OURA_TIMEZONE, else the process's resolved zone. */
export function resolveTimeZone(env = process.env) {
  const set = envValue(env, "OURA_TIMEZONE");
  if (set) {
    formatDateInTimeZone(new Date(), set);
    return set;
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** YYYY-MM-DD in an IANA time zone, via Intl en-CA. */
export function formatDateInTimeZone(date, timeZone) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch (err) {
    const error = new Error(
      `Invalid time zone ${JSON.stringify(timeZone)}: ${err.message}`
    );
    error.code = "invalid_timezone";
    throw error;
  }
}

export function formatUtcDate(date) {
  return formatDateInTimeZone(date, "UTC");
}

export function addCalendarDays(isoDate, days) {
  const [, y, m, d] = isoDate.match(DATE_RE).map(Number);
  return formatUtcDate(new Date(Date.UTC(y, m - 1, d + days)));
}

/** @deprecated use addCalendarDays */
export const addUtcDays = addCalendarDays;

/** Inclusive last 7 local calendar days: start = today-6, end = today in timeZone. */
export function defaultDateRange(now = new Date(), timeZone = resolveTimeZone()) {
  const end_date = formatDateInTimeZone(now, timeZone);
  return { start_date: addCalendarDays(end_date, -6), end_date, time_zone: timeZone };
}

export function resolveDateRange(args = {}, now = new Date(), timeZone = resolveTimeZone()) {
  const defaults = defaultDateRange(now, timeZone);
  const start_date = args.start_date ?? defaults.start_date;
  const end_date = args.end_date ?? defaults.end_date;

  const errors = [];
  if (!isIsoDate(start_date)) {
    errors.push(`start_date must be a real calendar date in YYYY-MM-DD form (got ${JSON.stringify(args.start_date ?? start_date)})`);
  }
  if (!isIsoDate(end_date)) {
    errors.push(`end_date must be a real calendar date in YYYY-MM-DD form (got ${JSON.stringify(args.end_date ?? end_date)})`);
  }
  if (errors.length) {
    const err = new Error(errors.join(" "));
    err.code = "invalid_date";
    throw err;
  }
  if (start_date > end_date) {
    const err = new Error(`start_date (${start_date}) must be on or before end_date (${end_date})`);
    err.code = "invalid_date";
    throw err;
  }
  const span =
    (Date.parse(`${end_date}T00:00:00Z`) - Date.parse(`${start_date}T00:00:00Z`)) /
    86400000;
  if (span > 365) {
    const err = new Error(`Date range is ${span + 1} days; the maximum supported range is 366 inclusive days`);
    err.code = "invalid_date";
    throw err;
  }
  return { start_date, end_date, time_zone: timeZone };
}

function indexByDay(docs) {
  const map = new Map();
  for (const doc of docs || []) {
    if (doc && typeof doc.day === "string") map.set(doc.day, doc);
  }
  return map;
}

function groupPeriodsByDay(periods) {
  const map = new Map();
  for (const period of periods || []) {
    if (!period || typeof period.day !== "string") continue;
    const list = map.get(period.day);
    if (list) list.push(period);
    else map.set(period.day, [period]);
  }
  return map;
}

function isContributing(period) {
  if (!period || period.type === "deleted" || period.type === "rest") return false;
  if (period.type == null || period.type === "") {
    return Number(period.total_sleep_duration) > 0;
  }
  return CONTRIBUTING_SLEEP_TYPES.has(period.type);
}

/**
 * Prefer long_sleep; otherwise the contributing period with the longest
 * total_sleep_duration. Ties keep the earlier document.
 */
export function primarySleepPeriod(periods) {
  const contributing = (periods || []).filter(isContributing);
  const longs = contributing.filter((p) => p.type === "long_sleep");
  const pool = longs.length ? longs : contributing;
  if (!pool.length) return null;
  return pool.reduce((best, cur) =>
    (cur.total_sleep_duration || 0) > (best.total_sleep_duration || 0) ? cur : best
  );
}

function hoursFromSeconds(seconds) {
  return Math.round((seconds / 3600) * 100) / 100;
}

export function mergeDays({ dailySleep, dailyReadiness, dailyActivity, sleepPeriods }) {
  const sleepMap = indexByDay(dailySleep);
  const readyMap = indexByDay(dailyReadiness);
  const activityMap = indexByDay(dailyActivity);
  const periodsByDay = groupPeriodsByDay(sleepPeriods);

  const days = new Set([
    ...sleepMap.keys(),
    ...readyMap.keys(),
    ...activityMap.keys(),
    ...periodsByDay.keys(),
  ]);

  return [...days].sort().map((day) => {
    const sleep = sleepMap.get(day);
    const readiness = readyMap.get(day);
    const activity = activityMap.get(day);
    const periods = periodsByDay.get(day) || [];
    const contributing = periods.filter(isContributing);
    const primary = primarySleepPeriod(periods);
    const totalSeconds = contributing.reduce(
      (sum, p) => sum + (Number(p.total_sleep_duration) || 0),
      0
    );

    return {
      day,
      sleep_score: sleep && "score" in sleep ? sleep.score : null,
      readiness_score: readiness && "score" in readiness ? readiness.score : null,
      activity_score: activity && "score" in activity ? activity.score : null,
      steps: activity && "steps" in activity ? activity.steps : null,
      total_sleep_hours: contributing.length ? hoursFromSeconds(totalSeconds) : null,
      avg_hrv: primary && "average_hrv" in primary ? primary.average_hrv : null,
      lowest_heart_rate:
        primary && "lowest_heart_rate" in primary ? primary.lowest_heart_rate : null,
      contributors: {
        sleep: sleep?.contributors ?? null,
        readiness: readiness?.contributors ?? null,
        activity: activity?.contributors ?? null,
      },
    };
  });
}
