/**
 * Form parsing and labels for the session timeout and access-time settings.
 * The ranges match the server's (backend/utils/activitySettings.js), which
 * checks them again.
 */

export interface WholeNumberRange {
  min: number;
  max: number;
}

export const SESSION_IDLE_DAYS_RANGE: WholeNumberRange = { min: 1, max: 365 };
export const ACCESS_TIME_WINDOW_RANGE: WholeNumberRange = { min: 0, max: 1440 };
export const ACCESS_TIME_FLUSH_RANGE: WholeNumberRange = { min: 1, max: 300 };

export type ParsedNumber = { ok: true; value: number } | { ok: false; error: string };

/** A whole number typed into a field, checked against its range. */
export function parseWholeNumber(text: string, range: WholeNumberRange, label: string): ParsedNumber {
  const trimmed = text.trim();
  const value = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  if (!Number.isInteger(value) || value < range.min || value > range.max) {
    return { ok: false, error: `${label} must be a whole number from ${range.min} to ${range.max}` };
  }
  return { ok: true, value };
}

const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? '' : 's'}`;

export function formatIdleDays(days: number): string {
  return plural(days, 'day');
}

/** How a stored access time follows reads, in a few words. */
export function describeAccessTime(enabled: boolean, windowMinutes: number): string {
  if (!enabled) return 'Off';
  if (windowMinutes === 0) return 'Every read';
  if (windowMinutes % 60 === 0) return `At most every ${plural(windowMinutes / 60, 'hour')}`;
  return `At most every ${plural(windowMinutes, 'minute')}`;
}
