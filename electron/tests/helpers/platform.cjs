/*
 * Platform override.
 *
 * Nearly every desktop feature is gated on process.platform === 'win32'.
 * Forcing the value keeps the suite identical on a developer's Windows machine
 * and on the Linux runner in CI, and lets the non-Windows guards be tested from
 * either one.
 */
'use strict';

const original = Object.getOwnPropertyDescriptor(process, 'platform');

/** Pretend the process is running on the given platform. Restore in afterEach. */
function usePlatform(platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function restorePlatform() {
  if (original) Object.defineProperty(process, 'platform', original);
}

module.exports = { usePlatform, restorePlatform };
