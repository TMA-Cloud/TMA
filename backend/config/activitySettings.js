/**
 * The session and access-time settings this process acts on. The first user
 * changes them in Settings; each API process re-reads them every
 * REFRESH_INTERVAL_MS, so all of them converge without a restart. Reads are
 * synchronous because the auth middleware needs them on every request.
 */

import { DEFAULT_ACTIVITY_SETTINGS } from '../utils/activitySettings.js';
import { logger } from './logger.js';

const REFRESH_INTERVAL_MS = 15_000;

let current = { ...DEFAULT_ACTIVITY_SETTINGS };
let loader = null;
let listener = null;
let refreshTimer = null;

const same = (a, b) => Object.keys(DEFAULT_ACTIVITY_SETTINGS).every(key => a[key] === b[key]);

function getActivitySettings() {
  return current;
}

/** Make `next` current and tell the listener when anything changed. */
function applyActivitySettings(next) {
  const previous = current;
  current = Object.freeze({ ...next });
  if (!same(previous, current) && listener) listener(current, previous);
  return current;
}

async function refreshActivitySettings() {
  if (!loader) return current;
  return applyActivitySettings(await loader());
}

/**
 * Load the settings once, then keep them current.
 * @param {() => Promise<object>} load - Reads the settings from the database
 * @param {(next: object, previous: object) => void} onChange - Called after a change
 */
async function startActivitySettings(load, onChange) {
  loader = load;
  listener = onChange;
  await refreshActivitySettings();
  // The listener also needs the starting values, changed or not.
  if (listener) listener(current, null);

  refreshTimer = setInterval(() => {
    refreshActivitySettings().catch(err => {
      logger.warn({ err }, 'Could not re-read session and access-time settings; keeping the current ones');
    });
  }, REFRESH_INTERVAL_MS);
  refreshTimer.unref?.();
}

function stopActivitySettings() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

/** Test seam: back to the defaults, with no loader or listener. */
function resetActivitySettings() {
  stopActivitySettings();
  current = { ...DEFAULT_ACTIVITY_SETTINGS };
  loader = null;
  listener = null;
}

export {
  getActivitySettings,
  applyActivitySettings,
  refreshActivitySettings,
  startActivitySettings,
  stopActivitySettings,
  resetActivitySettings,
};
