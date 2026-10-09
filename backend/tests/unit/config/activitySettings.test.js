import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyActivitySettings,
  getActivitySettings,
  refreshActivitySettings,
  resetActivitySettings,
  startActivitySettings,
} from '../../../config/activitySettings.js';
import { DEFAULT_ACTIVITY_SETTINGS } from '../../../utils/activitySettings.js';

const custom = { ...DEFAULT_ACTIVITY_SETTINGS, sessionIdleDays: 7, accessTimeFlushSeconds: 30 };

afterEach(() => {
  vi.useRealTimers();
  resetActivitySettings();
});

describe('activity settings in memory', () => {
  it('starts from the defaults before anything is loaded', () => {
    expect(getActivitySettings()).toEqual(DEFAULT_ACTIVITY_SETTINGS);
  });

  it('loads at start and gives the listener the starting values', async () => {
    const onChange = vi.fn();
    await startActivitySettings(async () => custom, onChange);

    expect(getActivitySettings()).toEqual(custom);
    expect(onChange).toHaveBeenLastCalledWith(custom, null);
  });

  it('tells the listener only about real changes', async () => {
    const onChange = vi.fn();
    await startActivitySettings(async () => DEFAULT_ACTIVITY_SETTINGS, onChange);
    onChange.mockClear();

    applyActivitySettings({ ...DEFAULT_ACTIVITY_SETTINGS });
    expect(onChange).not.toHaveBeenCalled();

    applyActivitySettings(custom);
    expect(onChange).toHaveBeenCalledWith(custom, DEFAULT_ACTIVITY_SETTINGS);
  });

  it('picks up a change saved by another process on the next refresh', async () => {
    vi.useFakeTimers();
    let stored = DEFAULT_ACTIVITY_SETTINGS;
    await startActivitySettings(
      async () => stored,
      () => {}
    );

    stored = custom;
    await vi.advanceTimersByTimeAsync(15_000);

    expect(getActivitySettings()).toEqual(custom);
  });

  it('keeps the current values when a refresh fails', async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => custom);
    await startActivitySettings(load, () => {});

    load.mockRejectedValueOnce(new Error('database down'));
    await vi.advanceTimersByTimeAsync(15_000);

    expect(getActivitySettings()).toEqual(custom);
  });

  it('hands out a frozen copy, so callers cannot change it in place', () => {
    const applied = applyActivitySettings(custom);
    expect(Object.isFrozen(applied)).toBe(true);
  });

  it('refreshes to the current values when nothing was started', async () => {
    expect(await refreshActivitySettings()).toEqual(DEFAULT_ACTIVITY_SETTINGS);
  });
});
