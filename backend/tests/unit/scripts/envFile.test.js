import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { hasEnvValue, setEnvValue, writeFileAtomic } from '../../../scripts/lib/envFile.js';

describe('setEnvValue', () => {
  const text =
    '# DATABASE_URL=commented\nNODE_ENV=production\nDATABASE_URL=postgresql://u:old@h/db\nREDIS_URL=redis://r\n';

  it('replaces the active line and leaves comments alone', () => {
    expect(setEnvValue(text, 'DATABASE_URL', 'postgresql://u:new@h/db?sslmode=disable&connect_timeout=5')).toBe(
      '# DATABASE_URL=commented\nNODE_ENV=production\n' +
        'DATABASE_URL=postgresql://u:new@h/db?sslmode=disable&connect_timeout=5\nREDIS_URL=redis://r\n'
    );
  });

  it('appends a missing key on its own line', () => {
    expect(setEnvValue('A=1', 'B', '2')).toBe('A=1\nB=2\n');
    expect(setEnvValue('', 'B', '2')).toBe('B=2\n');
  });

  it('writes values with $ patterns literally', () => {
    expect(setEnvValue('K=x\n', 'K', '$&$1')).toBe('K=$&$1\n');
  });

  it('does not match a key that only shares a prefix', () => {
    expect(setEnvValue('DATABASE_URL_FILE=/x\n', 'DATABASE_URL', 'y')).toBe('DATABASE_URL_FILE=/x\nDATABASE_URL=y\n');
    expect(hasEnvValue('DATABASE_URL_FILE=/x\n', 'DATABASE_URL')).toBe(false);
    expect(hasEnvValue('# DATABASE_URL=x\n', 'DATABASE_URL')).toBe(false);
  });
});

describe('writeFileAtomic', () => {
  let dir;

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('replaces the content and leaves no temporary file behind', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envfile-'));
    const target = path.join(dir, 'key');
    fs.writeFileSync(target, 'old', { mode: 0o600 });

    writeFileAtomic(target, 'new');

    expect(fs.readFileSync(target, 'utf8')).toBe('new');
    expect(fs.readdirSync(dir)).toEqual(['key']);
    if (process.platform !== 'win32') expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });
});
