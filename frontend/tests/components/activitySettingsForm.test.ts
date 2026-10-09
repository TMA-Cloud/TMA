import { describe, expect, it } from 'vitest';

import {
  ACCESS_TIME_WINDOW_RANGE,
  SESSION_IDLE_DAYS_RANGE,
  describeAccessTime,
  formatIdleDays,
  parseWholeNumber,
} from '../../src/components/settings/sections/activitySettingsForm';

describe('parseWholeNumber', () => {
  it('accepts whole numbers inside the range, ignoring surrounding spaces', () => {
    expect(parseWholeNumber('1', SESSION_IDLE_DAYS_RANGE, 'Timeout')).toEqual({ ok: true, value: 1 });
    expect(parseWholeNumber(' 365 ', SESSION_IDLE_DAYS_RANGE, 'Timeout')).toEqual({ ok: true, value: 365 });
    expect(parseWholeNumber('0', ACCESS_TIME_WINDOW_RANGE, 'Window')).toEqual({ ok: true, value: 0 });
  });

  it.each(['', '0', '366', '1.5', '-1', 'abc', '1e2'])('rejects %j with the range in the message', text => {
    const parsed = parseWholeNumber(text, SESSION_IDLE_DAYS_RANGE, 'Timeout');
    expect(parsed).toEqual({ ok: false, error: 'Timeout must be a whole number from 1 to 365' });
  });
});

describe('labels', () => {
  it('names the idle timeout in days', () => {
    expect(formatIdleDays(1)).toBe('1 day');
    expect(formatIdleDays(30)).toBe('30 days');
  });

  it('describes how often an access time can change', () => {
    expect(describeAccessTime(false, 60)).toBe('Off');
    expect(describeAccessTime(true, 0)).toBe('Every read');
    expect(describeAccessTime(true, 60)).toBe('At most every 1 hour');
    expect(describeAccessTime(true, 1440)).toBe('At most every 24 hours');
    expect(describeAccessTime(true, 90)).toBe('At most every 90 minutes');
  });
});
