/**
 * Storage settings end to end: only the first user may see or change them,
 * the secret never leaves the server and is stored encrypted, nothing is saved
 * unless the live connection check passes, and an unconfigured instance answers
 * file requests with a setup error instead of crashing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import pool from '../../config/db.js';
import { invalidateS3Config } from '../../config/storage.js';
import { ensureOwner, createAndLogin } from './helpers/app.js';

const { probeStorage } = vi.hoisted(() => ({ probeStorage: vi.fn() }));
vi.mock('../../services/storageProbe.js', async importOriginal => ({
  ...(await importOriginal()),
  probeStorage,
}));

const { StorageProbeError } = await import('../../services/storageProbe.js');

const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const settings = {
  provider: 's3',
  endpoint: 'https://s3.example.com',
  bucket: 'tma-files',
  region: 'eu-central-1',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: SECRET,
};

async function clearStorageConfig() {
  await pool.query(
    `UPDATE app_settings SET storage_provider = NULL, storage_endpoint = NULL, storage_region = NULL,
       storage_bucket = NULL, storage_force_path_style = NULL, storage_access_key_id = NULL,
       storage_secret_encrypted = NULL, storage_secret_kek_version = NULL WHERE id = 'app_settings'`
  );
  invalidateS3Config();
}

beforeEach(async () => {
  probeStorage.mockReset();
  probeStorage.mockResolvedValue({ checks: ['connect', 'list', 'write', 'read', 'delete'] });
  await clearStorageConfig();
});

describe('an instance with no storage', () => {
  it('reports itself unconfigured, and tells the first user they can fix it', async () => {
    const { client: admin } = await ensureOwner();

    const res = await admin.get('/api/user/storage-status');

    expect(res.body).toEqual({ configured: false, canConfigure: true });
  });

  it('refuses an upload with a setup error, not a crash', async () => {
    const { client: admin } = await ensureOwner();

    const res = await admin.post('/api/files/upload').attach('file', Buffer.from('hello'), 'hello.txt');

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('STORAGE_NOT_CONFIGURED');
  });
});

describe('configuring storage', () => {
  it('saves only after the connection check passes, and encrypts the secret at rest', async () => {
    const { client: admin } = await ensureOwner();

    const res = await admin.put('/api/user/storage-config').send(settings);

    expect(res.status).toBe(200);
    expect(probeStorage).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: 'tma-files', secretAccessKey: SECRET }),
      expect.anything()
    );
    const row = (await pool.query('SELECT storage_secret_encrypted FROM app_settings')).rows[0];
    expect(row.storage_secret_encrypted.includes(Buffer.from(SECRET))).toBe(false);
    expect((await admin.get('/api/user/storage-status')).body.configured).toBe(true);
  });

  it('never returns the secret, and masks the access key ID', async () => {
    const { client: admin } = await ensureOwner();
    await admin.put('/api/user/storage-config').send(settings);

    const res = await admin.get('/api/user/storage-config');

    expect(res.body).toMatchObject({
      configured: true,
      provider: 's3',
      endpoint: 'https://s3.example.com',
      bucket: 'tma-files',
      accessKeyIdMasked: 'AKIA••••MPLE',
    });
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(JSON.stringify(res.body)).not.toContain(settings.accessKeyId);
  });

  it('stores nothing when the connection check fails', async () => {
    const { client: admin } = await ensureOwner();
    probeStorage.mockRejectedValue(
      new StorageProbeError('connect', 'The access key ID or secret access key was rejected')
    );

    const res = await admin.put('/api/user/storage-config').send(settings);

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: 'STORAGE_PROBE_FAILED', step: 'connect' });
    expect((await admin.get('/api/user/storage-config')).body.configured).toBe(false);
  });

  it('rejects invalid settings before contacting the endpoint', async () => {
    const { client: admin } = await ensureOwner();

    const res = await admin.put('/api/user/storage-config').send({ ...settings, endpoint: 'http://s3.example.com' });

    expect(res.status).toBe(400);
    expect(probeStorage).not.toHaveBeenCalled();
  });

  it('keeps the saved credentials when an edit leaves them blank', async () => {
    const { client: admin } = await ensureOwner();
    await admin.put('/api/user/storage-config').send(settings);

    const res = await admin
      .put('/api/user/storage-config')
      .send({ ...settings, region: 'eu-west-1', accessKeyId: '', secretAccessKey: '' });

    expect(res.status).toBe(200);
    expect(res.body.region).toBe('eu-west-1');
    expect(probeStorage).toHaveBeenLastCalledWith(
      expect.objectContaining({ accessKeyId: settings.accessKeyId, secretAccessKey: SECRET }),
      expect.anything()
    );
  });

  it('refuses a stale edit from another session', async () => {
    const { client: admin } = await ensureOwner();
    const first = await admin.put('/api/user/storage-config').send({ ...settings, expectedVersion: 0 });

    const stale = await admin.put('/api/user/storage-config').send({ ...settings, expectedVersion: 0 });

    expect(first.status).toBe(200);
    expect(stale.status).toBe(409);
  });

  it('can be tested without saving', async () => {
    const { client: admin } = await ensureOwner();

    const res = await admin.post('/api/user/storage-config/test').send(settings);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect((await admin.get('/api/user/storage-config')).body.configured).toBe(false);
  });
});

describe('who may configure storage', () => {
  it('is the first user only', async () => {
    await ensureOwner();
    const { client: other } = await createAndLogin({ email: 'second@example.com' });

    expect((await other.get('/api/user/storage-config')).status).toBe(403);
    expect((await other.put('/api/user/storage-config').send(settings)).status).toBe(403);
    expect((await other.post('/api/user/storage-config/test').send(settings)).status).toBe(403);
    expect((await other.get('/api/user/storage-status')).body).toEqual({ configured: false, canConfigure: false });
    expect(probeStorage).not.toHaveBeenCalled();
  });
});
