/*
 * files IPC barrel. Owns one watcher registry (created here so it resets per
 * module load, which the tests rely on) and wires it into the split handlers,
 * re-exporting the same three names consumers and tests already use:
 *   watchers        - active edit-session state (fs.watch handles, download cache)
 *   editWithDesktop - files:editWithDesktop
 *   saveFile        - files:saveFile / files:saveFilesBulk
 */
const { createWatcherRegistry } = require('./files/watchers.cjs');
const { registerEditWithDesktopHandler } = require('./files/editWithDesktop.cjs');
const { registerSaveFileHandlers } = require('./files/saveFile.cjs');

const registry = createWatcherRegistry();

module.exports = {
  registerEditWithDesktopHandler: () => registerEditWithDesktopHandler(registry),
  registerSaveFileHandlers,
  getActiveEditDirs: () => registry.getActiveEditDirs(),
};
