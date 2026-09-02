/*
 * clipboard IPC barrel. Splits the Windows clipboard bridge into focused
 * modules and re-exports the single public entry point unchanged:
 *   oleScript - the OLE FileContents extraction script (+ inlined fallback)
 *   read      - read files off the clipboard (drop list / OLE / text paths)
 *   write     - the ipcMain handlers (read + stage-and-set file-drop list)
 */
const { registerClipboardHandlers } = require('./clipboard/write.cjs');

module.exports = { registerClipboardHandlers };
