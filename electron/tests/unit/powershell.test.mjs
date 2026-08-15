import childProcess from 'child_process';
import { describe, expect, it, vi } from 'vitest';

import powershell from '../../src/main/utils/powershell.cjs';
import { fakeSpawn, fakeSpawnResult } from '../helpers/childProcess.cjs';

const { escapePathForPowerShellLiteralPath, runPowerShell, runPowerShellEnv } = powershell;

describe('escapePathForPowerShellLiteralPath', () => {
  it('leaves an ordinary Windows path untouched', () => {
    expect(escapePathForPowerShellLiteralPath('C:\\Users\\me\\file.txt')).toBe('C:\\Users\\me\\file.txt');
  });

  it('doubles single quotes so a quote in a filename cannot end the literal', () => {
    expect(escapePathForPowerShellLiteralPath("C:\\it's\\file.txt")).toBe("C:\\it''s\\file.txt");
  });

  it('strips newlines and carriage returns so a path cannot append a command', () => {
    const injected = "C:\\a.txt'\r\n; Remove-Item C:\\ -Recurse";
    const escaped = escapePathForPowerShellLiteralPath(injected);
    expect(escaped).not.toMatch(/[\r\n]/);
    // The quote that would have closed the literal is neutralised as well.
    expect(escaped).toBe("C:\\a.txt''; Remove-Item C:\\ -Recurse");
  });

  it('strips NUL bytes, which line-based parsing would otherwise carry through', () => {
    expect(escapePathForPowerShellLiteralPath('C:\\a\0b.txt')).toBe('C:\\ab.txt');
  });

  it('returns an empty string for null and non-string input', () => {
    expect(escapePathForPowerShellLiteralPath(null)).toBe('');
    expect(escapePathForPowerShellLiteralPath(undefined)).toBe('');
    expect(escapePathForPowerShellLiteralPath(42)).toBe('');
  });
});

describe('runPowerShell', () => {
  it('resolves with stdout when the script exits cleanly', async () => {
    fakeSpawnResult(vi, { stdout: 'C:\\a.txt\r\nC:\\b.txt\r\n' });
    await expect(runPowerShell('Get-Thing')).resolves.toBe('C:\\a.txt\r\nC:\\b.txt\r\n');
  });

  it('runs powershell without a shell and without flashing a console window', async () => {
    const spawned = fakeSpawnResult(vi, { stdout: 'ok' });
    await runPowerShell('Get-Thing');
    const [command, args, options] = [spawned[0].command, spawned[0].args, childProcess.spawn.mock.calls[0][2]];
    expect(command).toBe('powershell');
    expect(args).toEqual(['-NoProfile', '-Command', 'Get-Thing']);
    expect(options).toMatchObject({ shell: false, windowsHide: true });
  });

  it('rejects with stderr when the script exits non-zero', async () => {
    fakeSpawnResult(vi, { stderr: 'access denied', code: 1 });
    await expect(runPowerShell('Get-Thing')).rejects.toThrow('access denied');
  });

  it('reports the exit code when the failure produced no stderr', async () => {
    fakeSpawnResult(vi, { code: 3 });
    await expect(runPowerShell('Get-Thing')).rejects.toThrow('exit 3');
  });

  it('kills the process and rejects once the timeout elapses', async () => {
    const spawned = fakeSpawn(vi); // never exits on its own
    const pending = runPowerShell('Start-Sleep 60', 20);
    await expect(pending).rejects.toThrow('Timeout');
    expect(spawned[0].killed).toBe(true);
  });

  it('rejects when powershell cannot be launched at all', async () => {
    const spawned = fakeSpawn(vi);
    const pending = runPowerShell('Get-Thing');
    spawned[0].emit('error', new Error('spawn powershell ENOENT'));
    await expect(pending).rejects.toThrow('ENOENT');
  });
});

describe('runPowerShellEnv', () => {
  it('passes the script through an environment variable instead of a temp file', async () => {
    fakeSpawnResult(vi, { stdout: '{}' });
    await runPowerShellEnv('Write-Output "{}"');
    const [command, args, options] = childProcess.spawn.mock.calls[0];
    expect(command).toBe('powershell');
    expect(args).toEqual(['-NoProfile', '-NonInteractive', '-Command', '$env:OLE_SCRIPT | iex']);
    expect(options.env.OLE_SCRIPT).toBe('Write-Output "{}"');
    expect(options).toMatchObject({ shell: false, windowsHide: true });
  });

  it('keeps the rest of the environment so PATH still resolves powershell', async () => {
    fakeSpawnResult(vi, { stdout: '{}' });
    await runPowerShellEnv('script');
    expect(childProcess.spawn.mock.calls[0][2].env.PATH ?? childProcess.spawn.mock.calls[0][2].env.Path).toBeDefined();
  });

  it('rejects on a non-zero exit', async () => {
    fakeSpawnResult(vi, { stderr: 'compile error', code: 1 });
    await expect(runPowerShellEnv('script')).rejects.toThrow('compile error');
  });

  it('kills a hung extraction once the timeout elapses', async () => {
    const spawned = fakeSpawn(vi);
    const pending = runPowerShellEnv('script', 20);
    await expect(pending).rejects.toThrow('Timeout');
    expect(spawned[0].killed).toBe(true);
  });
});
