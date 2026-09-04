/*
 * Read files off the Windows clipboard, trying three sources in order:
 * FileDropList (fast), OLE FileContents (Outlook/Snipping Tool), then clipboard
 * text interpreted as file paths.
 */
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const { clipboard } = require('electron');
const { runPowerShell, runPowerShellEnv } = require('../../utils/powershell.cjs');
const { mimeForFilenameOrDefault: getMimeForName } = require('../../utils/mime-types.cjs');
const { getOleExtractScriptContent } = require('./oleScript.cjs');

const CLIPBOARD_DEBUG = process.env.TMA_CLOUD_CLIPBOARD_DEBUG === '1';

// Absolute Windows path: C:\... or \\server\...
const ABS_PATH_REGEX = /^[a-zA-Z]:[\\/]|^\\\\/;
const MAX_PATHS_FROM_TEXT = 100;

async function readFileDropList() {
  const stdout = await runPowerShell(
    'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetFileDropList() | ForEach-Object { $_ }',
    5000
  );
  const paths = stdout
    .split(/\r?\n/)
    .map(p => p.trim())
    .filter(Boolean);
  if (paths.length === 0) return [];
  const files = [];
  for (const p of paths) {
    try {
      const stat = fs.statSync(p);
      if (!stat.isFile()) continue;
      const buf = fs.readFileSync(p);
      const name = path.basename(p);
      files.push({ name, mime: getMimeForName(name), data: buf.toString('base64') });
    } catch (_) {
      /* ignore */
    }
  }
  return files;
}

function parsePathsFromText(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .split(/\r?\n/)
    .map(line => line.trim().replace(/^["']|["']$/g, ''))
    .filter(line => line.length > 0 && ABS_PATH_REGEX.test(line))
    .slice(0, MAX_PATHS_FROM_TEXT);
}

async function readFilesFromPaths(paths) {
  const files = [];
  for (const p of paths) {
    try {
      const stat = await fsPromises.stat(p);
      if (!stat.isFile()) continue;
      const buf = await fsPromises.readFile(p);
      const name = path.basename(p);
      files.push({ name, mime: getMimeForName(name), data: buf.toString('base64') });
    } catch (_) {
      /* ignore */
    }
  }
  return files;
}

async function readFilesFromClipboard() {
  if (process.platform !== 'win32') return [];

  // 1. FileDropList (Explorer/desktop copy): one small PowerShell call, no C# compile.
  try {
    const fileDropFiles = await readFileDropList();
    if (fileDropFiles.length > 0) {
      if (CLIPBOARD_DEBUG) console.log('[clipboard] FileDropList:', fileDropFiles.length, 'files');
      return fileDropFiles;
    }
  } catch (_) {
    /* ignore */
  }

  // 2. OLE FileContents (Outlook attachments, Snipping Tool): heavier C# compile + extraction.
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

  // 3. Clipboard text containing file paths (Copy as path, IDEs, etc.).
  try {
    const text = await clipboard.readText();
    const paths = parsePathsFromText(text);
    if (paths.length > 0) {
      const textFiles = await readFilesFromPaths(paths);
      if (textFiles.length > 0) {
        if (CLIPBOARD_DEBUG) console.log('[clipboard] text-as-paths:', textFiles.length, 'files');
        return textFiles;
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
  readFileDropList,
  parsePathsFromText,
  readFilesFromPaths,
  readFilesFromClipboard,
  peekClipboardFileNames,
};
