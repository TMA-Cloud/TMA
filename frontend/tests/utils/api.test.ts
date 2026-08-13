import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AUTH_STATE_KEY,
  apiDelete,
  apiGet,
  apiPost,
  apiPostForm,
  apiPut,
  checkAuthSilently,
  checkGoogleAuthEnabled,
  downloadFile,
  getSignupStatus,
  hasAuthState,
  setAuthState,
} from '../../src/utils/api';
import { ApiError } from '../../src/utils/errorUtils';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Build a minimal Response-like object for the fetch mock. */
function jsonResponse(body: unknown, { status = 200, headers = {} as Record<string, string> } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
    blob: async () => new Blob([JSON.stringify(body)]),
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? headers[name] ?? null },
  } as unknown as Response;
}

describe('request construction', () => {
  it('sends credentials and the CSRF header on every call', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await apiGet('/api/files');

    const [, init] = fetchMock.mock.calls[0];
    expect(init.credentials).toBe('include');
    expect(init.headers['X-Requested-With']).toBe('XMLHttpRequest');
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it.each([
    ['apiGet', apiGet, 'GET'],
    ['apiDelete', apiDelete, 'DELETE'],
  ])('%s uses the %s verb', async (_label, fn, method) => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await (fn as (e: string) => Promise<unknown>)('/api/x');
    expect(fetchMock.mock.calls[0][1].method).toBe(method);
  });

  it('apiPost serialises the body as JSON', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await apiPost('/api/x', { a: 1 });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
  });

  it('apiPut serialises the body as JSON', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await apiPut('/api/x', { b: 2 });
    expect(fetchMock.mock.calls[0][1].body).toBe('{"b":2}');
  });

  it('omits the body when a POST carries no data', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await apiPost('/api/x');
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
  });

  it('apiPostForm sends the FormData body with the CSRF header', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    const form = new FormData();
    await apiPostForm('/api/files/upload', form);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.body).toBe(form);
    expect(init.headers['X-Requested-With']).toBe('XMLHttpRequest');
  });

  it('apiPostForm still forces Content-Type: application/json, which would break a real upload', async () => {
    // apiRequest spreads its JSON default *before* the caller's headers, and
    // apiPostForm only overrides X-Requested-With. An explicit Content-Type
    // stops fetch generating a multipart boundary, so the server cannot parse
    // the body. The helper is currently unused, which is why this has not
    // surfaced; pinned here so a future caller does not get bitten.
    fetchMock.mockResolvedValue(jsonResponse({}));
    await apiPostForm('/api/files/upload', new FormData());
    expect(fetchMock.mock.calls[0][1].headers['Content-Type']).toBe('application/json');
  });

  it('forwards an abort signal', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    const controller = new AbortController();
    await apiGet('/api/x', { signal: controller.signal });
    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });
});

describe('error handling', () => {
  it('throws an ApiError carrying the status', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Not found' }, { status: 404 }));
    await expect(apiGet('/api/x')).rejects.toMatchObject({ message: 'Not found', status: 404 });
  });

  it('falls back to the error field, then the status text', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'STORAGE_LIMIT_EXCEEDED' }, { status: 413 }));
    await expect(apiGet('/api/x')).rejects.toThrow('STORAGE_LIMIT_EXCEEDED');

    fetchMock.mockResolvedValue(jsonResponse({}, { status: 500 }));
    await expect(apiGet('/api/x')).rejects.toThrow('Error');
  });

  it('attaches the remaining body fields as structured error data', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Too big', limit: 100, used: 99 }, { status: 413 }));
    await expect(apiGet('/api/x')).rejects.toMatchObject({ data: { limit: 100, used: 99 } });
  });

  it('survives an error response whose body is not JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: async () => {
        throw new Error('not json');
      },
    } as unknown as Response);
    await expect(apiGet('/api/x')).rejects.toThrow('Bad Gateway');
  });

  it('propagates a network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(apiGet('/api/x')).rejects.toThrow('Failed to fetch');
  });
});

describe('checkGoogleAuthEnabled', () => {
  it('reports what the server says', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ enabled: true }));
    expect(await checkGoogleAuthEnabled()).toBe(true);
  });

  it('reports false when the endpoint fails, rather than surfacing an error', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    expect(await checkGoogleAuthEnabled()).toBe(false);
  });
});

describe('getSignupStatus', () => {
  it('returns the authenticated payload when the session is valid', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ signupEnabled: true, canToggle: true, totalUsers: 3 }));
    expect(await getSignupStatus()).toMatchObject({ signupEnabled: true, canToggle: true });
  });

  it('falls back to the public endpoint on 401 and reports no admin capabilities', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ message: 'No token provided' }, { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ signupEnabled: false }));

    const status = await getSignupStatus();

    expect(status.signupEnabled).toBe(false);
    expect(status.canToggle).toBe(false);
    expect(status.canToggleElectronOnlyAccess).toBe(false);
  });

  it('defaults to signup enabled when both endpoints fail', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    expect(await getSignupStatus()).toMatchObject({ signupEnabled: true, canToggle: false });
  });
});

describe('auth state hint', () => {
  it('records a hint on login and reads it back', () => {
    setAuthState(true);
    expect(hasAuthState()).toBe(true);
  });

  it('clears the hint on logout', () => {
    setAuthState(true);
    setAuthState(false);
    expect(hasAuthState()).toBe(false);
  });

  it('reports false when nothing was ever stored', () => {
    expect(hasAuthState()).toBe(false);
  });

  it('discards a hint written by an older version', () => {
    localStorage.setItem(AUTH_STATE_KEY, JSON.stringify({ timestamp: Date.now(), version: 0 }));
    expect(hasAuthState()).toBe(false);
    expect(localStorage.getItem(AUTH_STATE_KEY)).toBeNull();
  });

  it('discards a hint older than the server session window', () => {
    const tooOld = Date.now() - 31 * 24 * 60 * 60 * 1000;
    localStorage.setItem(AUTH_STATE_KEY, JSON.stringify({ timestamp: tooOld, version: 1 }));
    expect(hasAuthState()).toBe(false);
  });

  it('keeps a hint that is just inside the window', () => {
    const recent = Date.now() - 29 * 24 * 60 * 60 * 1000;
    localStorage.setItem(AUTH_STATE_KEY, JSON.stringify({ timestamp: recent, version: 1 }));
    expect(hasAuthState()).toBe(true);
  });

  it('discards a hint with a timestamp in the future', () => {
    localStorage.setItem(AUTH_STATE_KEY, JSON.stringify({ timestamp: Date.now() + 60_000, version: 1 }));
    expect(hasAuthState()).toBe(false);
  });

  it('discards an unparseable hint', () => {
    localStorage.setItem(AUTH_STATE_KEY, 'not json');
    expect(hasAuthState()).toBe(false);
    expect(localStorage.getItem(AUTH_STATE_KEY)).toBeNull();
  });

  it('does not rewrite a hint that is under an hour old, avoiding needless writes', () => {
    setAuthState(true);
    const first = localStorage.getItem(AUTH_STATE_KEY);
    setAuthState(true);
    expect(localStorage.getItem(AUTH_STATE_KEY)).toBe(first);
  });

  it('does not throw when storage is unavailable, as in private browsing', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    vi.stubGlobal('localStorage', throwing);
    expect(() => setAuthState(true)).not.toThrow();
    expect(hasAuthState()).toBe(false);
  });
});

describe('checkAuthSilently', () => {
  it('skips the network entirely when there was no prior login', async () => {
    const result = await checkAuthSilently();
    expect(result).toEqual({ status: 'unauthenticated' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports authenticated and refreshes the hint on a 200', async () => {
    setAuthState(true);
    fetchMock.mockResolvedValue(jsonResponse({ id: 'u1', email: 'a@b.com' }));

    const result = await checkAuthSilently();

    expect(result).toMatchObject({ status: 'authenticated' });
    expect(hasAuthState()).toBe(true);
  });

  it('reports unauthenticated and clears the hint on a 401', async () => {
    setAuthState(true);
    fetchMock.mockResolvedValue(jsonResponse({ message: 'expired' }, { status: 401 }));

    expect(await checkAuthSilently()).toEqual({ status: 'unauthenticated' });
    expect(hasAuthState()).toBe(false);
  });

  it('reports "unknown" for a server error, so a deploy blip does not eject the user', async () => {
    setAuthState(true);
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 502 }));

    expect(await checkAuthSilently()).toEqual({ status: 'unknown' });
    expect(hasAuthState()).toBe(true);
  });

  it('reports "unknown" on a network failure and keeps the hint', async () => {
    setAuthState(true);
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    expect(await checkAuthSilently()).toEqual({ status: 'unknown' });
    expect(hasAuthState()).toBe(true);
  });

  it('reports "unknown" when the check is aborted', async () => {
    setAuthState(true);
    fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));

    expect(await checkAuthSilently()).toEqual({ status: 'unknown' });
  });

  it('still checks after an OAuth redirect even with no stored hint', async () => {
    sessionStorage.setItem('oauth_initiated', 'true');
    fetchMock.mockResolvedValue(jsonResponse({ id: 'u1' }));

    expect(await checkAuthSilently()).toMatchObject({ status: 'authenticated' });
    expect(sessionStorage.getItem('oauth_initiated')).toBeNull();
  });
});

describe('downloadFile', () => {
  beforeEach(() => {
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:mock'),
      revokeObjectURL: vi.fn(),
    });
  });

  it('reads the filename from the RFC 5987 parameter', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {},
        {
          headers: { 'content-disposition': 'attachment; filename="_.pdf"; filename*=UTF-8\'\'%E5%A0%B1%E5%91%8A.pdf' },
        }
      )
    );
    const anchor = document.createElement('a');
    const clickSpy = vi.spyOn(anchor, 'click').mockImplementation(() => {});
    vi.spyOn(document, 'createElement').mockReturnValue(anchor);

    await downloadFile('abcDEF1234567890');

    expect(anchor.download).toBe('報告.pdf');
    expect(clickSpy).toHaveBeenCalled();
  });

  it('falls back to the quoted legacy filename', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({}, { headers: { 'content-disposition': 'attachment; filename="report.pdf"' } })
    );
    const anchor = document.createElement('a');
    vi.spyOn(anchor, 'click').mockImplementation(() => {});
    vi.spyOn(document, 'createElement').mockReturnValue(anchor);

    await downloadFile('abcDEF1234567890');

    expect(anchor.download).toBe('report.pdf');
  });

  it('uses the supplied fallback name when the header is absent', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    const anchor = document.createElement('a');
    vi.spyOn(anchor, 'click').mockImplementation(() => {});
    vi.spyOn(document, 'createElement').mockReturnValue(anchor);

    await downloadFile('abcDEF1234567890', 'my-file.txt');

    expect(anchor.download).toBe('my-file.txt');
  });

  it('throws an error carrying the HTTP status when the download is refused', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Forbidden' }, { status: 403 }));
    await expect(downloadFile('abcDEF1234567890')).rejects.toMatchObject({ message: 'Forbidden', status: 403 });
  });
});

describe('exported ApiError contract', () => {
  it('is the error type thrown by the API helpers, so callers can branch on status', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'nope' }, { status: 401 }));
    await expect(apiGet('/api/x')).rejects.toBeInstanceOf(ApiError);
  });
});
