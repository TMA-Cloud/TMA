/**
 * Escape a path for safe use inside a PowerShell single-quoted string (e.g. -LiteralPath '...').
 * In single-quoted strings only ' is special; escape as ''.
 * Control chars (newline, CR, null) are stripped so the path cannot break script or line-based parsing.
 */
function escapePathForPowerShellLiteralPath(pathStr) {
  if (pathStr == null || typeof pathStr !== 'string') return '';
  return pathStr.replace(/\r\n|\r|\n|\0/g, '').replace(/'/g, "''");
}

// PowerShell 5.1 writes the OEM code page, turning e.g. U+202F in a file name into "?".
const UTF8_OUTPUT = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ';

/** Spawn PowerShell and resolve with its stdout decoded as UTF-8. */
function spawnPowerShell(args, options, timeoutMs) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const child = spawn('powershell', args, { shell: false, windowsHide: true, ...options });
    // Decoded once at the end: a multi-byte character can straddle two chunks.
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', d => stdout.push(Buffer.from(d)));
    child.stderr.on('data', d => stderr.push(Buffer.from(d)));
    const t = setTimeout(() => {
      child.kill();
      reject(new Error('Timeout'));
    }, timeoutMs);
    child.on('close', code => {
      clearTimeout(t);
      const err = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) reject(new Error(err || `exit ${code}`));
      else resolve(Buffer.concat(stdout).toString('utf8'));
    });
    child.on('error', reject);
  });
}

/**
 * Run a PowerShell script without shell (avoids Node DEP0190). Returns promise with stdout string.
 */
function runPowerShell(script, timeoutMs = 5000) {
  return spawnPowerShell(['-NoProfile', '-Command', UTF8_OUTPUT + script], {}, timeoutMs);
}

/**
 * Run a PowerShell script passed via env var. No file, no temp, no disk.
 * Script in $env:OLE_SCRIPT, executed with iex. Windows env limit ~32KB.
 */
function runPowerShellEnv(scriptContent, timeoutMs = 5000) {
  return spawnPowerShell(
    ['-NoProfile', '-NonInteractive', '-Command', UTF8_OUTPUT + '$env:OLE_SCRIPT | iex'],
    { env: { ...process.env, OLE_SCRIPT: scriptContent } },
    timeoutMs
  );
}

module.exports = {
  escapePathForPowerShellLiteralPath,
  runPowerShell,
  runPowerShellEnv,
};
