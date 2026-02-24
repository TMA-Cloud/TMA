/**
 * Escape a path for safe use inside a PowerShell single-quoted string (e.g. -LiteralPath '...').
 * In single-quoted strings only ' is special; escape as ''.
 * Control chars (newline, CR, null) are stripped so the path cannot break script or line-based parsing.
 */
function escapePathForPowerShellLiteralPath(pathStr) {
  if (pathStr == null || typeof pathStr !== 'string') return '';
  return pathStr.replace(/\r\n|\r|\n|\0/g, '').replace(/'/g, "''");
}

/**
 * Run a PowerShell script without shell (avoids Node DEP0190). Returns promise with stdout string.
 */
function runPowerShell(script, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const child = spawn('powershell', ['-NoProfile', '-Command', script], {
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => {
      stdout += d.toString();
    });
    child.stderr.on('data', d => {
      stderr += d.toString();
    });
    const t = setTimeout(() => {
      child.kill();
      reject(new Error('Timeout'));
    }, timeoutMs);
    child.on('close', code => {
      clearTimeout(t);
      if (code !== 0) reject(new Error(stderr || `exit ${code}`));
      else resolve(stdout);
    });
    child.on('error', reject);
  });
}

module.exports = {
  escapePathForPowerShellLiteralPath,
  runPowerShell,
};
