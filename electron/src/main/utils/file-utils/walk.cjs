/*
 * Expand pasted files and folders into upload entries, the way a dropped
 * folder expands in the browser: each file carries its path below the pasted
 * folder, so the server rebuilds the same tree.
 */
const fs = require('fs');
const path = require('path');

/** Enough for any real folder, low enough that a paste of C:\ fails fast. */
const MAX_PASTE_FILES = 50000;
/** Stats in flight per directory; one at a time crawled on large folders. */
const STAT_CONCURRENCY = 32;

class TooManyFilesError extends Error {
  constructor() {
    super(`That is more than ${MAX_PASTE_FILES.toLocaleString('en-US')} files. Paste a smaller folder.`);
    this.name = 'TooManyFilesError';
  }
}

const unreadable = (relativePath, error) => ({
  fileName: relativePath,
  reason: error?.code === 'EACCES' || error?.code === 'EPERM' ? 'Access denied' : 'Could not be read',
});

async function statAll(items) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fs.promises.stat(items[index]).catch(error => ({ error }));
    }
  };
  await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, items.length) }, worker));
  return out;
}

/**
 * Walk `roots` (absolute paths of pasted files and folders) into
 * `{ entries: [{ filePath, relativePath, size }], skipped: [{ fileName, reason }] }`.
 * A top-level file has relativePath null. Links and junctions are reported and
 * not followed, so a loop cannot hang the walk or reach outside the paste.
 */
async function collectPasteEntries(roots) {
  const entries = [];
  const skipped = [];
  const addFile = (filePath, relativePath, size) => {
    if (entries.length >= MAX_PASTE_FILES) throw new TooManyFilesError();
    entries.push({ filePath, relativePath, size });
  };

  // Depth-first with an explicit stack, as the browser walk does: a deep tree
  // cannot exhaust the call stack, and each folder's files stay together.
  const stack = [];
  for (const root of [...roots].reverse()) {
    const name = path.basename(root);
    const stat = await fs.promises.lstat(root).catch(error => ({ error }));
    if (stat.error) skipped.push(unreadable(name, stat.error));
    else if (stat.isSymbolicLink()) skipped.push({ fileName: name, reason: 'Links are not uploaded' });
    else if (stat.isDirectory()) stack.push({ dir: root, prefix: name });
    else if (stat.isFile()) stack.push({ file: root, size: stat.size });
  }

  while (stack.length > 0) {
    const item = stack.pop();
    if (item.file) {
      addFile(item.file, null, item.size);
      continue;
    }
    let dirents;
    try {
      dirents = [];
      for await (const dirent of await fs.promises.opendir(item.dir)) dirents.push(dirent);
    } catch (error) {
      skipped.push(unreadable(item.prefix, error));
      continue;
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    const files = dirents.filter(dirent => dirent.isFile());
    const stats = await statAll(files.map(dirent => path.join(item.dir, dirent.name)));
    files.forEach((dirent, i) => {
      const relativePath = `${item.prefix}/${dirent.name}`;
      if (stats[i].error) skipped.push(unreadable(relativePath, stats[i].error));
      else addFile(path.join(item.dir, dirent.name), relativePath, stats[i].size);
    });
    for (const dirent of dirents) {
      if (dirent.isSymbolicLink())
        skipped.push({ fileName: `${item.prefix}/${dirent.name}`, reason: 'Links are not uploaded' });
    }
    const subdirs = dirents.filter(dirent => dirent.isDirectory()).reverse();
    for (const dirent of subdirs) {
      stack.push({ dir: path.join(item.dir, dirent.name), prefix: `${item.prefix}/${dirent.name}` });
    }
  }
  return { entries, skipped };
}

module.exports = { collectPasteEntries };
