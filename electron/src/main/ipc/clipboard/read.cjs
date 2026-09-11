/*
 * Read files off the Windows clipboard, trying three sources in order:
 * FileDropList (fast), OLE FileContents (Outlook/Snipping Tool), then clipboard
 * text interpreted as file paths.
 */
const path = require('path');
const fsPromises = require('fs').promises;
const { clipboard } = require('electron');
const { runPowerShell, runPowerShellEnv } = require('../../utils/powershell.cjs');
const { mimeForFilenameOrDefault: getMimeForName } = require('../../utils/mime-types.cjs');
const { getOleExtractScriptContent } = require('./oleScript.cjs');

const CLIPBOARD_DEBUG = process.env.TMA_CLOUD_CLIPBOARD_DEBUG === '1';

// Absolute Windows path: C:\... or \\server\...
const ABS_PATH_REGEX = /^[a-zA-Z]:[\\/]|^\\\\/;
const MAX_PATHS_FROM_TEXT = 100;

async function readClipboardFilePaths() {
  if (process.platform !== 'win32') return [];
  try {
    const stdout = await runPowerShell(
      'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetFileDropList() | ForEach-Object { $_ }',
      5000
    );
    const paths = stdout
      .split(/\r?\n/)
      .map(p => p.trim())
      .filter(Boolean)
      .slice(0, MAX_PATHS_FROM_TEXT);
    const valid = [];
    for (const filePath of paths) {
      const stat = await fsPromises.stat(filePath).catch(() => null);
      if (stat?.isFile()) valid.push(filePath);
    }
    if (valid.length > 0) return valid;
  } catch {
    // Fall through to text paths.
  }
  try {
    const paths = parsePathsFromText(await clipboard.readText());
    const valid = [];
    for (const filePath of paths) {
      const stat = await fsPromises.stat(filePath).catch(() => null);
      if (stat?.isFile()) valid.push(filePath);
    }
    return valid;
  } catch {
    return [];
  }
}

function parsePathsFromText(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .split(/\r?\n/)
    .map(line => line.trim().replace(/^["']|["']$/g, ''))
    .filter(line => line.length > 0 && ABS_PATH_REGEX.test(line))
    .slice(0, MAX_PATHS_FROM_TEXT);
}

async function readFilesFromClipboard() {
  if (process.platform !== 'win32') return [];
  // Physical and text paths use clipboard:uploadFiles and stream from disk.
  // This compatibility endpoint is only for virtual OLE content, which has no
  // filesystem path for Node to stream.
  try {
    const scriptContent = getOleExtractScriptContent();
    const stdout = await runPowerShellEnv(scriptContent, 15000);
    const trimmed = (stdout || '').trim();
    if (trimmed.startsWith('{') && trimmed !== '{}') {
      const obj = JSON.parse(trimmed);
      const psFiles = Object.entries(obj).map(([name, data]) => ({ name, data }));
      if (psFiles.length > 0) {
        if (CLIPBOARD_DEBUG) console.log('[clipboard] OLE extracted', psFiles.length, 'files');
        return psFiles.map(f => ({ name: f.name, mime: getMimeForName(f.name), data: f.data }));
      }
    }
  } catch (_) {
    /* ignore */
  }

  return [];
}

// Peek clipboard file names without reading bytes, so the renderer can detect an
// external clipboard overwrite. FileDropList only — the OLE path isn't worth the
// latency for a freshness check.
async function peekClipboardFileNames() {
  if (process.platform !== 'win32') return [];
  try {
    const stdout = await runPowerShell(
      'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetFileDropList() | ForEach-Object { $_ }',
      5000
    );
    const paths = stdout
      .split(/\r?\n/)
      .map(p => p.trim())
      .filter(Boolean);
    return paths.map(p => path.basename(p));
  } catch (_) {
    return [];
  }
}

module.exports = {
  parsePathsFromText,
  readFilesFromClipboard,
  peekClipboardFileNames,
  readClipboardFilePaths,
};
