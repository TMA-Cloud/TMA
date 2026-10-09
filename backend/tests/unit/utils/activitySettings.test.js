import { describe, expect, it } from 'vitest';

import {
  ActivitySettingsError,
  DEFAULT_ACTIVITY_SETTINGS,
  activitySettingsFromRow,
  normalizeAccessTimeSettings,
  normalizeSessionIdleDays,
} from '../../../utils/activitySettings.js';

describe('normalizeSessionIdleDays', () => {
  it('accepts whole days from 1 to 365, as numbers or numeric strings', () => {
    expect(normalizeSessionIdleDays(1)).toBe(1);
    expect(normalizeSessionIdleDays(365)).toBe(365);
    expect(normalizeSessionIdleDays('30')).toBe(30);
  });

  it.each([0, 366, 1.5, -3, '', ' ', 'thirty', null, undefined, true, NaN, Infinity])('rejects %j', value => {
    expect(() => normalizeSessionIdleDays(value)).toThrow(ActivitySettingsError);
  });
});

describe('normalizeAccessTimeSettings', () => {
  const valid = { enabled: true, windowMinutes: 60, flushSeconds: 10 };

  it('maps the request shape onto the stored settings', () => {
    expect(normalizeAccessTimeSettings(valid)).toEqual({
      accessTimeTracking: true,
      accessTimeWindowMinutes: 60,
      accessTimeFlushSeconds: 10,
    });
  });

  it('accepts the edges of each range', () => {
    expect(normalizeAccessTimeSettings({ enabled: false, windowMinutes: 0, flushSeconds: 1 })).toMatchObject({
      accessTimeWindowMinutes: 0,
      accessTimeFlushSeconds: 1,
    });
    expect(normalizeAccessTimeSettings({ enabled: true, windowMinutes: 1440, flushSeconds: 300 })).toMatchObject({
      accessTimeWindowMinutes: 1440,
      accessTimeFlushSeconds: 300,
    });
  });

  it.each([
    { ...valid, enabled: 'true' },
    { ...valid, enabled: 1 },
    { ...valid, windowMinutes: -1 },
    { ...valid, windowMinutes: 1441 },
    { ...valid, flushSeconds: 0 },
    { ...valid, flushSeconds: 301 },
    { ...valid, flushSeconds: 2.5 },
  ])('rejects %j', settings => {
    expect(() => normalizeAccessTimeSettings(settings)).toThrow(ActivitySettingsError);
  });

  it('rejects a missing body', () => {
    expect(() => normalizeAccessTimeSettings()).toThrow(ActivitySettingsError);
  });
});

describe('activitySettingsFromRow', () => {
  it('uses the defaults when there is no settings row', () => {
    expect(activitySettingsFromRow(undefined)).toEqual(DEFAULT_ACTIVITY_SETTINGS);
  });

  it('reads a stored row', () => {
    expect(
      activitySettingsFromRow({
        session_idle_days: 7,
        access_time_tracking: false,
        access_time_window_minutes: 1440,
        access_time_flush_seconds: 60,
      })
    ).toEqual({
      sessionIdleDays: 7,
      accessTimeTracking: false,
      accessTimeWindowMinutes: 1440,
      accessTimeFlushSeconds: 60,
    });
  });

  it('falls back per field on a value outside its range', () => {
    const settings = activitySettingsFromRow({
      session_idle_days: 0,
      access_time_tracking: null,
      access_time_window_minutes: 99999,
      access_time_flush_seconds: 'x',
    });
    expect(settings).toEqual(DEFAULT_ACTIVITY_SETTINGS);
  });
});
