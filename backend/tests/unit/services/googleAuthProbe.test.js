import { afterEach, describe, expect, it, vi } from 'vitest';

import { GoogleAuthProbeError, verifyGoogleClient } from '../../../services/googleAuthProbe.js';

const config = {
  clientId: '123-abc.apps.googleusercontent.com',
  clientSecret: 'GOCSPX-secret-value',
  redirectUri: 'https://cloud.example.com/api/google/callback',
};

function answer(status, body) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

afterEach(() => vi.restoreAllMocks());

describe('verifyGoogleClient', () => {
  it('accepts a client Google authenticated, which then refuses the made-up code', async () => {
    const fetch = answer(400, { error: 'invalid_grant' });
    await expect(verifyGoogleClient(config)).resolves.toBeUndefined();

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    const sent = new URLSearchParams(init.body);
    expect(sent.get('grant_type')).toBe('authorization_code');
    expect(sent.get('client_id')).toBe(config.clientId);
    expect(sent.get('client_secret')).toBe(config.clientSecret);
    expect(sent.get('redirect_uri')).toBe(config.redirectUri);
  });

  it.each(['invalid_client', 'unauthorized_client'])('rejects a client Google answers %s for', async error => {
    answer(401, { error });
    const err = await verifyGoogleClient(config).catch(e => e);
    expect(err).toBeInstanceOf(GoogleAuthProbeError);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/rejected the client ID or secret/);
  });

  it('does not save on an answer it does not understand', async () => {
    answer(500, { error: 'server_error' });
    await expect(verifyGoogleClient(config)).rejects.toMatchObject({ status: 502 });
  });

  it('reports an unreachable Google as a gateway error, not a bad client', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    await expect(verifyGoogleClient(config)).rejects.toMatchObject({
      status: 502,
      message: expect.stringMatching(/Could not reach Google/),
    });
  });

  it('treats a non-JSON body as unexpected', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>', { status: 200 }));
    await expect(verifyGoogleClient(config)).rejects.toMatchObject({ status: 502 });
  });
});
