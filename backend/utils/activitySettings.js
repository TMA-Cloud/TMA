/**
 * Session idle timeout and last-access tracking settings: ranges, defaults and
 * validation. Pure, so tests cover it directly. The database enforces the same
 * ranges (migration 051).
 */

const SESSION_IDLE_DAYS_RANGE = { min: 1, max: 365, default: 30 };
// relatime writes an access time at most once a day; a longer window adds nothing.
const ACCESS_TIME_WINDOW_RANGE = { min: 0, max: 1440, default: 60 };
const ACCESS_TIME_FLUSH_RANGE = { min: 1, max: 300, default: 10 };

const DEFAULT_ACTIVITY_SETTINGS = Object.freeze({
  sessionIdleDays: SESSION_IDLE_DAYS_RANGE.default,
  accessTimeTracking: true,
  accessTimeWindowMinutes: ACCESS_TIME_WINDOW_RANGE.default,
  accessTimeFlushSeconds: ACCESS_TIME_FLUSH_RANGE.default,
});

class ActivitySettingsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ActivitySettingsError';
    this.status = 400;
  }
}

function wholeNumberIn(value, range, label) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(number) || number < range.min || number > range.max) {
    throw new ActivitySettingsError(`${label} must be a whole number from ${range.min} to ${range.max}`);
  }
  return number;
}

function normalizeSessionIdleDays(value) {
  return wholeNumberIn(value, SESSION_IDLE_DAYS_RANGE, 'Session idle timeout (days)');
}

function normalizeAccessTimeSettings({ enabled, windowMinutes, flushSeconds } = {}) {
  if (typeof enabled !== 'boolean') throw new ActivitySettingsError('Access time tracking must be on or off');
  return {
    accessTimeTracking: enabled,
    accessTimeWindowMinutes: wholeNumberIn(windowMinutes, ACCESS_TIME_WINDOW_RANGE, 'Access time window (minutes)'),
    accessTimeFlushSeconds: wholeNumberIn(flushSeconds, ACCESS_TIME_FLUSH_RANGE, 'Write interval (seconds)'),
  };
}

/** Settings from an app_settings row; a missing row or column means the defaults. */
function activitySettingsFromRow(row) {
  if (!row) return { ...DEFAULT_ACTIVITY_SETTINGS };
  const pick = (value, range) =>
    Number.isInteger(value) && value >= range.min && value <= range.max ? value : range.default;
  return {
    sessionIdleDays: pick(row.session_idle_days, SESSION_IDLE_DAYS_RANGE),
    accessTimeTracking: row.access_time_tracking !== false,
    accessTimeWindowMinutes: pick(row.access_time_window_minutes, ACCESS_TIME_WINDOW_RANGE),
    accessTimeFlushSeconds: pick(row.access_time_flush_seconds, ACCESS_TIME_FLUSH_RANGE),
  };
}

export {
  SESSION_IDLE_DAYS_RANGE,
  ACCESS_TIME_WINDOW_RANGE,
  ACCESS_TIME_FLUSH_RANGE,
  DEFAULT_ACTIVITY_SETTINGS,
  ActivitySettingsError,
  normalizeSessionIdleDays,
  normalizeAccessTimeSettings,
  activitySettingsFromRow,
};
