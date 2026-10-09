import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../models/user/user.admin.google.model.js', () => ({ loadGoogleAuthConfig: vi.fn() }));
vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn(function OAuth2Client(clientId) {
    this.clientId = clientId;
  }),
}));

const { loadGoogleAuthConfig } = await import('../../../models/user/user.admin.google.model.js');
const { getGoogleAuthConfig, invalidateGoogleAuthConfig, oauthClientFor } =
  await import('../../../config/googleAuth.js');

const saved = { clientId: 'a.apps.googleusercontent.com', clientSecret: 's', redirectUri: 'https://x.io', version: 1 };

beforeEach(() => {
  vi.useRealTimers();
  loadGoogleAuthConfig.mockReset();
  invalidateGoogleAuthConfig();
});

describe('getGoogleAuthConfig', () => {
  it('reads the database once for requests that arrive together', async () => {
    loadGoogleAuthConfig.mockResolvedValue(saved);
    const results = await Promise.all([getGoogleAuthConfig(), getGoogleAuthConfig(), getGoogleAuthConfig()]);
    expect(results).toEqual([saved, saved, saved]);
    expect(loadGoogleAuthConfig).toHaveBeenCalledTimes(1);
  });

  it('re-reads after the cache lifetime, so other processes follow a change', async () => {
    vi.useFakeTimers();
    loadGoogleAuthConfig.mockResolvedValue(saved);
    await getGoogleAuthConfig();

    loadGoogleAuthConfig.mockResolvedValue(null);
    vi.advanceTimersByTime(14_000);
    expect(await getGoogleAuthConfig()).toEqual(saved);
    vi.advanceTimersByTime(1_000);
    expect(await getGoogleAuthConfig()).toBeNull();
  });

  it('reads again at once after a save in this process', async () => {
    loadGoogleAuthConfig.mockResolvedValue(saved);
    await getGoogleAuthConfig();
    loadGoogleAuthConfig.mockResolvedValue(null);

    invalidateGoogleAuthConfig();

    expect(await getGoogleAuthConfig()).toBeNull();
  });

  it('turns sign-in off when the saved secret cannot be decrypted', async () => {
    loadGoogleAuthConfig.mockRejectedValue(new Error('Unsupported state or unable to authenticate data'));
    expect(await getGoogleAuthConfig()).toBeNull();
  });
});

describe('oauthClientFor', () => {
  it('reuses the client until the saved settings change', () => {
    const first = oauthClientFor(saved);
    expect(oauthClientFor({ ...saved })).toBe(first);
    const next = oauthClientFor({ ...saved, clientId: 'b.apps.googleusercontent.com', version: 2 });
    expect(next).not.toBe(first);
    expect(next.clientId).toBe('b.apps.googleusercontent.com');
  });
});
