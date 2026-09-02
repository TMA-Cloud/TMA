/*
 * Write a set of local file paths onto the Windows clipboard as a file-drop
 * list (CF_HDROP), so a subsequent Explorer paste drops the real files. The
 * paths are handed to PowerShell via a temp file to avoid any quoting issues.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { escapePathForPowerShellLiteralPath, runPowerShell } = require('../powershell.cjs');

function setClipboardToPaths(writtenPaths) {
  const safePaths = (writtenPaths || []).filter(p => typeof p === 'string' && p.length > 0 && !/[\r\n\0]/.test(p));
  if (safePaths.length === 0) return Promise.resolve();
  const tmpRoot = os.tmpdir();
  const tmp = path.join(tmpRoot, `electron-desktop-${Date.now()}.txt`);
  fs.writeFileSync(tmp, safePaths.join('\n'), 'utf8');
  const ps = `Add-Type -AssemblyName System.Windows.Forms; $col = New-Object System.Collections.Specialized.StringCollection; Get-Content -Encoding UTF8 -LiteralPath '${escapePathForPowerShellLiteralPath(tmp)}' | ForEach-Object { $col.Add($_) }; [System.Windows.Forms.Clipboard]::SetFileDropList($col)`;
  return runPowerShell(ps).then(() => {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {
      /* ignore */
    }
  });
}

module.exports = { setClipboardToPaths };
