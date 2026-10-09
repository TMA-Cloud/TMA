/**
 * Master key rotation end to end: a new key added to the keyring encrypts new
 * uploads, the rewrap moves every stored file key (trashed files included) and
 * the bucket secret to it, files still download afterwards, and the startup
 * check refuses a keyring that lost a version stored data needs.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import pool from '../../config/db.js';
import { loadStorageConfig } from '../../models/user/user.admin.model.js';
import { countKeysByVersion } from '../../models/kekRewrap.model.js';
import { verifyEncryptionKeys } from '../../services/encryptionKeyCheck.js';
import { rewrapToPrimaryKey } from '../../services/kekRewrap.js';
import { signUpAndLogin } from './helpers/app.js';

const V1 = process.env.FILE_ENCRYPTION_KEY;
const V2 = 'b2'.repeat(32);
const V3 = 'c3'.repeat(32);

function upload(c, name, content) {
  return c
    .post('/api/files/upload')
    .attach('file', Buffer.from(content), { filename: name, contentType: 'text/plain' });
}

async function download(c, id) {
  const res = await c
    .get(`/api/files/${id}/download`)
    .buffer()
    .parse((r, cb) => {
      const chunks = [];
      r.on('data', chunk => chunks.push(chunk));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  expect(res.status).toBe(200);
  return res.body.toString('utf8');
}

async function fileVersions() {
  const { rows } = await pool.query("SELECT name, dek_kek_version AS v FROM files WHERE type = 'file' ORDER BY name");
  return Object.fromEntries(rows.map(row => [row.name, row.v]));
}

async function idOf(name) {
  return (await pool.query('SELECT id FROM files WHERE name = $1', [name])).rows[0].id;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('master key rotation', () => {
  it('rewraps every file key and the bucket secret, and files still open', async () => {
    const { client: c } = await signUpAndLogin();
    await upload(c, 'kept.txt', 'kept under v1');
    await upload(c, 'trashed.txt', 'trashed under v1');
    await c.post('/api/files/delete').send({ ids: [await idOf('trashed.txt')] });
    await verifyEncryptionKeys();

    vi.stubEnv('FILE_ENCRYPTION_KEY', `1:${V1}\n2:${V2}`);
    await verifyEncryptionKeys();
    await upload(c, 'new.txt', 'written under v2');
    expect(await fileVersions()).toEqual({ 'kept.txt': 1, 'new.txt': 2, 'trashed.txt': 1 });

    const result = await rewrapToPrimaryKey();

    expect(result).toMatchObject({ primary: 2, rewrapped: 2, storageSecret: true, failures: [] });
    expect(await fileVersions()).toEqual({ 'kept.txt': 2, 'new.txt': 2, 'trashed.txt': 2 });
    const { files, storageSecretVersion } = await countKeysByVersion();
    expect([...files]).toEqual([[2, 3]]);
    expect(storageSecretVersion).toBe(2);
    expect((await loadStorageConfig()).secretAccessKey).toBe('test-secret');

    await c.post('/api/files/trash/restore').send({ ids: [await idOf('trashed.txt')] });
    expect(await download(c, await idOf('kept.txt'))).toBe('kept under v1');
    expect(await download(c, await idOf('trashed.txt'))).toBe('trashed under v1');
    expect(await download(c, await idOf('new.txt'))).toBe('written under v2');

    // Nothing left to do on a second run.
    expect(await rewrapToPrimaryKey()).toMatchObject({ rewrapped: 0, storageSecret: false });
  });

  it('lets two runs at once share the work without losing a key', async () => {
    const { client: c } = await signUpAndLogin();
    for (let i = 0; i < 12; i += 1) await upload(c, `f${String(i).padStart(2, '0')}.txt`, `content ${i}`);

    vi.stubEnv('FILE_ENCRYPTION_KEY', `1:${V1}\n3:${V3}`);
    const [a, b] = await Promise.all([rewrapToPrimaryKey(), rewrapToPrimaryKey()]);

    expect(a.rewrapped + b.rewrapped).toBe(12);
    expect(new Set(Object.values(await fileVersions()))).toEqual(new Set([3]));
    expect(await download(c, await idOf('f07.txt'))).toBe('content 7');
  });

  it('refuses to start when the keyring lost a version that data uses', async () => {
    const { client: c } = await signUpAndLogin();
    await upload(c, 'a.txt', 'a');
    vi.stubEnv('FILE_ENCRYPTION_KEY', `1:${V1}\n2:${V2}`);
    await rewrapToPrimaryKey();

    vi.stubEnv('FILE_ENCRYPTION_KEY', V1);

    await expect(verifyEncryptionKeys()).rejects.toThrow(/key version 2, which FILE_ENCRYPTION_KEY does not contain/);
  });

  it('moves a production install off a passphrase key', async () => {
    const passphrase = 'tma_cloud_file_encryption_key';
    // Version 1 sealed the seeded bucket secret.
    vi.stubEnv('FILE_ENCRYPTION_KEY', `1:${V1}\n9:${passphrase}`);
    const { client: c } = await signUpAndLogin();
    await upload(c, 'old.txt', 'under the passphrase');
    await verifyEncryptionKeys();
    vi.stubEnv('NODE_ENV', 'production');
    await expect(verifyEncryptionKeys()).rejects.toThrow(/must be a random 32-byte key/);

    vi.stubEnv('FILE_ENCRYPTION_KEY', `1:${V1}\n9:${passphrase}\n10:${V2}`);
    await verifyEncryptionKeys();
    vi.stubEnv('NODE_ENV', 'test');
    await rewrapToPrimaryKey();

    expect(await fileVersions()).toEqual({ 'old.txt': 10 });
    expect(await download(c, await idOf('old.txt'))).toBe('under the passphrase');
  });

  it('refuses a keyring whose new version is not the key recorded for it', async () => {
    vi.stubEnv('FILE_ENCRYPTION_KEY', `1:${V1}\n2:${V2}`);
    await verifyEncryptionKeys();

    vi.stubEnv('FILE_ENCRYPTION_KEY', `1:${V1}\n2:${V3}`);

    await expect(verifyEncryptionKeys()).rejects.toThrow(/key version 2\) does not match/);
  });
});
