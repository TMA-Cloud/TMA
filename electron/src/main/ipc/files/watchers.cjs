/*
 * Registry for active desktop-edit sessions: the fs.watch handles per file, the
 * size-based download cache, and the recent-derived-upload dedupe map. Created
 * fresh per module load (see the ../files.cjs barrel) so tests get clean state.
 */
const { app } = require('electron');

// Minimum file size worth caching between edit sessions (~6 MB).
const EDIT_CACHE_MIN_BYTES = 6 * 1024 * 1024;

function closeWatcherSafely(handle) {
  if (!handle) return;
  try {
    handle.close();
  } catch {
    /* ignore */
  }
}

function createWatcherRegistry() {
  // fileId -> { watcher, dirWatcher, editDir }
  const activeWatchers = new Map();
  // fileId -> { editDir, filePath, remoteSize, remoteModifiedMs }; process-lifetime
  // only, always revalidated against fresh backend metadata before reuse.
  const editCache = new Map();
  // "originalId|size" -> timestamp; guards against duplicate derived uploads.
  const recentDerivedUploads = new Map();

  function closeWatchersForFile(fileId) {
    const handles = activeWatchers.get(fileId);
    if (!handles) return;
    activeWatchers.delete(fileId);
    closeWatcherSafely(handles.watcher);
    closeWatcherSafely(handles.dirWatcher);
  }

  // Edit dirs in use or still cached, so temp cleanup skips them and doesn't
  // yank files from an active edit session or invalidate a cached download.
  function getActiveEditDirs() {
    const dirs = new Set();
    for (const h of activeWatchers.values()) {
      if (h && h.editDir) dirs.add(h.editDir);
    }
    for (const entry of editCache.values()) {
      if (entry && entry.editDir) dirs.add(entry.editDir);
    }
    return dirs;
  }

  app.on('before-quit', () => {
    for (const fileId of activeWatchers.keys()) closeWatchersForFile(fileId);
  });

  return {
    activeWatchers,
    editCache,
    recentDerivedUploads,
    closeWatcherSafely,
    closeWatchersForFile,
    getActiveEditDirs,
    EDIT_CACHE_MIN_BYTES,
  };
}

module.exports = { createWatcherRegistry };
