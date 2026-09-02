/*
 * clouddrive barrel. Splits the WinFsp cloud-drive bridge into focused modules
 * and re-exports the same functional API consumers and tests already use:
 *   log/mode/staging/locate/security/dispatch - stateless helpers
 *   driver - the stateful CloudDrive class (pipe bridge, SSE, lifecycle, IPC)
 *
 * A single instance is created here (in the barrel, which a fresh require
 * resets) so the exported functions keep the exact names and behavior of the
 * original module.
 */
'use strict';

const { CloudDrive } = require('./clouddrive/driver.cjs');

const drive = new CloudDrive();

module.exports = {
  startCloudDrive: opts => drive.startCloudDrive(opts),
  stopCloudDrive: () => drive.stopCloudDrive(),
  getMountPoint: () => drive.getMountPoint(),
  isRunning: () => drive.isRunning(),
  registerCloudDriveHandlers: () => drive.registerCloudDriveHandlers(),
  watchAuthAndMount: () => drive.watchAuthAndMount(),
};
