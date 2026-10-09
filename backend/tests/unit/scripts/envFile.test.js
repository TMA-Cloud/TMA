import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { hasEnvValue, setEnvValue, writeFileAtomic } from '../../../scripts/lib/envFile.js';

describe('setEnvValue', () => {
  const text = '# DB_PASSWORD=commented\nDB_HOST=postgres\nDB_PASSWORD=old\nREDIS_PASSWORD=r\n';

  it('replaces the active line and leaves comments alone', () => {
    expect(setEnvValue(text, 'DB_PASSWORD', 'new')).toBe(
      '# DB_PASSWORD=commented\nDB_HOST=postgres\nDB_PASSWORD=new\nREDIS_PASSWORD=r\n'
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
    expect(setEnvValue('DB_PASSWORD_FILE=/x\n', 'DB_PASSWORD', 'y')).toBe('DB_PASSWORD_FILE=/x\nDB_PASSWORD=y\n');
    expect(hasEnvValue('DB_PASSWORD_FILE=/x\n', 'DB_PASSWORD')).toBe(false);
    expect(hasEnvValue('# DB_PASSWORD=x\n', 'DB_PASSWORD')).toBe(false);
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
