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

/**
 * Run a PowerShell script passed via env var. No file, no temp, no disk.
 * Script in $env:OLE_SCRIPT, executed with iex. Windows env limit ~32KB.
 */
function runPowerShellEnv(scriptContent, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const env = { ...process.env, OLE_SCRIPT: scriptContent };
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', '$env:OLE_SCRIPT | iex'], {
      shell: false,
      windowsHide: true,
      env,
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

/**
 * Run a PowerShell script by piping it via stdin. No temp file needed — safe from temp cleanup.
 * Use for long scripts (e.g. OLE clipboard extraction) that exceed command-line limits.
 */
function runPowerShellStdin(scriptContent, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
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
    child.stdin.write(scriptContent, 'utf8');
    child.stdin.end();
  });
}

module.exports = {
  escapePathForPowerShellLiteralPath,
  runPowerShell,
  runPowerShellEnv,
  runPowerShellStdin,
};
