/*
 * Execute one bridge request from the native filesystem host against the
 * backend, using the app's authenticated REST helpers. Bulk bytes travel via
 * shared staging files (never over the pipe); src/dest paths are confined to
 * the staging dir so a pipe client can't touch arbitrary files.
 */
const { getServerUrl } = require('../config.cjs');
const { isInStagingDir } = require('./staging.cjs');
const {
  downloadToFile,
  uploadFileToReplace,
  uploadNewFile,
  listFilesFromBackend,
  apiPostJson,
  getCookieHeader,
  getJson,
} = require('../utils/file-utils.cjs');

// 1 MB: control messages are tiny; guard against a runaway line.
const MAX_LINE_BYTES = 1 << 20;

async function dispatch(msg) {
  const base = getServerUrl();
  if (!base) throw new Error('server URL not configured');

  switch (msg.op) {
    case 'list':
      return listFilesFromBackend(base, msg.parentId || null);

    case 'download': {
      if (!isInStagingDir(msg.dest)) throw new Error('invalid dest path');
      const url = `${base}/api/files/${encodeURIComponent(String(msg.id))}/download`;
      await downloadToFile(url, msg.dest);
      return { ok: true };
    }

    case 'upload':
      if (!isInStagingDir(msg.src)) throw new Error('invalid src path');
      return uploadNewFile(base, msg.parentId || null, msg.src, msg.name);

    case 'replace':
      if (!isInStagingDir(msg.src)) throw new Error('invalid src path');
      await uploadFileToReplace(base, msg.id, msg.src, msg.name);
      return { ok: true };

    case 'mkdir':
      return apiPostJson(base, '/api/files/folder', { name: msg.name, parentId: msg.parentId || null });

    case 'rename':
      return apiPostJson(base, '/api/files/rename', { id: msg.id, name: msg.name });

    case 'move':
      return apiPostJson(base, '/api/files/move', { ids: msg.ids, parentId: msg.parentId || null });

    case 'delete':
      return apiPostJson(base, '/api/files/delete', { ids: msg.ids });

    case 'stats': {
      const cookieHeader = await getCookieHeader(base);
      return getJson(`${base}/api/user/storage`, cookieHeader); // { used, total, free }
    }

    default:
      throw new Error('unknown op: ' + msg.op);
  }
}

module.exports = { dispatch, MAX_LINE_BYTES };
