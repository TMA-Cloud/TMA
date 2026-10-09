/**
 * Google sign-in settings end to end: only the first user may see or change
 * them, the client secret is stored encrypted and never returned, nothing
 * Google rejects is saved, the login page follows a change at once, and a
 * master key rotation rewraps the secret like the bucket secret.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import pool from '../../config/db.js';
import { invalidateGoogleAuthConfig } from '../../config/googleAuth.js';
import { loadGoogleAuthConfig } from '../../models/user/user.admin.model.js';
import { countKeysByVersion } from '../../models/kekRewrap.model.js';
import { kekVersionsInUse } from '../../models/kekCheck.model.js';
import { rewrapToPrimaryKey } from '../../services/kekRewrap.js';
import { client, createAndLogin, ensureOwner } from './helpers/app.js';

const { verifyGoogleClient } = vi.hoisted(() => ({ verifyGoogleClient: vi.fn() }));
vi.mock('../../services/googleAuthProbe.js', async importOriginal => ({
  ...(await importOriginal()),
  verifyGoogleClient,
}));

const { GoogleAuthProbeError } = await import('../../services/googleAuthProbe.js');

const SECRET = 'GOCSPX-abcdefghijklmnopqrstuvwxyz12';
const settings = {
  clientId: '123456789012-abcdefghijklmnop0123456789abcdef.apps.googleusercontent.com',
  clientSecret: SECRET,
  redirectUri: 'https://cloud.example.com/api/google/callback',
};

async function googleRow() {
  const { rows } = await pool.query(
    `SELECT google_client_id, google_client_secret_encrypted, google_client_secret_kek_version, google_redirect_uri,
            google_config_version
       FROM app_settings`
  );
  return rows[0];
}

const enabled = async () => (await client().get('/api/google/enabled')).body.enabled;

beforeEach(() => {
  verifyGoogleClient.mockReset();
  verifyGoogleClient.mockResolvedValue(undefined);
  invalidateGoogleAuthConfig();
});

afterEach(() => vi.unstubAllEnvs());

describe('who may manage Google sign-in', () => {
  it('refuses every account but the first, for reading and for writing', async () => {
    await ensureOwner();
    const { client: other } = await createAndLogin();

    expect((await other.get('/api/user/google-auth-config')).status).toBe(403);
    expect((await other.put('/api/user/google-auth-config').send(settings)).status).toBe(403);
    expect((await other.delete('/api/user/google-auth-config').send({})).status).toBe(403);
    expect(verifyGoogleClient).not.toHaveBeenCalled();
    expect((await googleRow()).google_client_id).toBeNull();
  });
});

describe('saving', () => {
  it('stores the secret encrypted, never returns it, and turns sign-in on', async () => {
    const { client: admin } = await ensureOwner();
    expect(await enabled()).toBe(false);

    const res = await admin.put('/api/user/google-auth-config').send(settings);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      configured: true,
      clientId: settings.clientId,
      redirectUri: settings.redirectUri,
      version: 1,
    });
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(JSON.stringify((await admin.get('/api/user/google-auth-config')).body)).not.toContain(SECRET);

    const row = await googleRow();
    expect(row.google_client_secret_encrypted.toString('latin1')).not.toContain(SECRET);
    expect((await loadGoogleAuthConfig()).clientSecret).toBe(SECRET);
    expect(verifyGoogleClient).toHaveBeenCalledWith(settings);
    expect(await enabled()).toBe(true);
  });

  it('sends the browser to Google with the saved client and redirect URI', async () => {
    const { client: admin } = await ensureOwner();
    await admin.put('/api/user/google-auth-config').send(settings);

    const res = await client().get('/api/google/login');

    expect(res.status).toBe(302);
    const url = new URL(res.headers.location);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('client_id')).toBe(settings.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(settings.redirectUri);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(res.headers.location).not.toContain(SECRET);
  });

  it('saves nothing Google rejects', async () => {
    const { client: admin } = await ensureOwner();
    verifyGoogleClient.mockRejectedValue(
      new GoogleAuthProbeError('Google rejected the client ID or secret. Copy both again from Google Cloud.', 400)
    );

    const res = await admin.put('/api/user/google-auth-config').send(settings);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/rejected the client ID or secret/);
    expect((await googleRow()).google_client_id).toBeNull();
    expect(await enabled()).toBe(false);
  });

  it('rejects a redirect URI Google would refuse, before asking Google', async () => {
    const { client: admin } = await ensureOwner();

    const res = await admin
      .put('/api/user/google-auth-config')
      .send({ ...settings, redirectUri: 'http://cloud.example.com/api/google/callback' });

    expect(res.status).toBe(400);
    expect(verifyGoogleClient).not.toHaveBeenCalled();
  });

  it('keeps the saved secret when it is left blank, and checks the kept pair with Google', async () => {
    const { client: admin } = await ensureOwner();
    await admin.put('/api/user/google-auth-config').send(settings);
    const redirectUri = 'https://files.example.com/api/google/callback';

    const res = await admin
      .put('/api/user/google-auth-config')
      .send({ ...settings, clientSecret: '', redirectUri, expectedVersion: 1 });

    expect(res.status).toBe(200);
    expect(verifyGoogleClient).toHaveBeenLastCalledWith({ ...settings, redirectUri });
    expect(await loadGoogleAuthConfig()).toMatchObject({ clientSecret: SECRET, redirectUri, version: 2 });
  });

  it('refuses a save based on settings another tab has since changed', async () => {
    const { client: admin } = await ensureOwner();
    await admin.put('/api/user/google-auth-config').send(settings);

    const res = await admin.put('/api/user/google-auth-config').send({ ...settings, expectedVersion: 0 });

    expect(res.status).toBe(409);
    expect((await googleRow()).google_config_version).toBe(1);
  });

  it('turns sign-in off again, and the login routes answer 503', async () => {
    const { client: admin } = await ensureOwner();
    await admin.put('/api/user/google-auth-config').send(settings);

    const res = await admin.delete('/api/user/google-auth-config').send({ expectedVersion: 1 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ configured: false, version: 2 });
    expect(await googleRow()).toMatchObject({ google_client_id: null, google_client_secret_encrypted: null });
    expect(await enabled()).toBe(false);
    expect((await client().get('/api/google/login')).status).toBe(503);
  });

  it('has the database refuse a half-written client', async () => {
    await expect(
      pool.query(`UPDATE app_settings SET google_client_id = '1-a.apps.googleusercontent.com'`)
    ).rejects.toThrow(/app_settings_google_complete/);
  });
});

describe('master key rotation', () => {
  it('rewraps the client secret to the new key, which still opens it', async () => {
    const { client: admin } = await ensureOwner();
    await admin.put('/api/user/google-auth-config').send(settings);
    expect(await kekVersionsInUse()).toContain(1);

    vi.stubEnv('FILE_ENCRYPTION_KEY', `1:${process.env.FILE_ENCRYPTION_KEY}\n2:${'b2'.repeat(32)}`);
    const result = await rewrapToPrimaryKey();

    expect(result).toMatchObject({ primary: 2, googleSecret: true });
    expect((await countKeysByVersion()).googleSecretVersion).toBe(2);
    expect(await loadGoogleAuthConfig()).toMatchObject({ clientSecret: SECRET, version: 1 });
    expect((await rewrapToPrimaryKey()).googleSecret).toBe(false);
  });
});
