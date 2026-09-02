/**
 * Client-side auth-state hint (localStorage) and the silent session check.
 * The hint lets us skip an API round-trip when there was never a prior login.
 */
export const AUTH_STATE_KEY = 'tma_cloud_auth_state';
// Must not be shorter than the server's session idle window (SESSION_IDLE_DAYS,
// 30 days by default). This value only gates whether we bother asking the
// server; if it expired first, a still-valid session would be shown the login
// screen without a single request being made.
const AUTH_STATE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

interface AuthState {
  timestamp: number;
  version: number;
}

const AUTH_STATE_VERSION = 1;

export function setAuthState(authenticated: boolean): void {
  try {
    if (authenticated) {
      const existing = localStorage.getItem(AUTH_STATE_KEY);
      if (existing) {
        try {
          const existingState: AuthState = JSON.parse(existing);
          if (existingState.version === AUTH_STATE_VERSION && Date.now() - existingState.timestamp < 60 * 60 * 1000) {
            return;
          }
        } catch {
          // invalid state, overwrite
        }
      }

      const state: AuthState = {
        timestamp: Date.now(),
        version: AUTH_STATE_VERSION,
      };
      localStorage.setItem(AUTH_STATE_KEY, JSON.stringify(state));
    } else {
      if (localStorage.getItem(AUTH_STATE_KEY)) {
        localStorage.removeItem(AUTH_STATE_KEY);
      }
    }
  } catch {
    // ignore (e.g. private browsing)
  }
}

export function hasAuthState(): boolean {
  try {
    const stored = localStorage.getItem(AUTH_STATE_KEY);
    if (!stored) return false;

    let state: AuthState;
    try {
      state = JSON.parse(stored);
    } catch {
      localStorage.removeItem(AUTH_STATE_KEY);
      return false;
    }

    if (state.version !== AUTH_STATE_VERSION) {
      localStorage.removeItem(AUTH_STATE_KEY);
      return false;
    }

    const now = Date.now();
    const age = now - state.timestamp;

    if (age < 0 || age > AUTH_STATE_MAX_AGE) {
      localStorage.removeItem(AUTH_STATE_KEY);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function mightBeAuthCallback(): boolean {
  try {
    if (sessionStorage.getItem('oauth_initiated') === 'true') {
      sessionStorage.removeItem('oauth_initiated');
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Outcome of a silent auth check.
 *
 * `unknown` is the important one: the server did not say the session is
 * invalid, we simply could not reach it or got an error unrelated to auth
 * (502 during a deploy, 429, a dropped connection). Treating that as
 * "logged out" is what used to eject users from a perfectly valid session, so
 * it is reported separately and the caller keeps whatever state it had.
 */
export type AuthCheckResult =
  { status: 'authenticated'; user: unknown } | { status: 'unauthenticated' } | { status: 'unknown' };

/** Checks the current session. Uses the localStorage hint to skip the API call when there was no prior login. */
export async function checkAuthSilently(signal?: AbortSignal): Promise<AuthCheckResult> {
  const hasValidAuthState = hasAuthState();
  const mightBeOAuth = mightBeAuthCallback();
  if (!hasValidAuthState && !mightBeOAuth) {
    return { status: 'unauthenticated' };
  }

  try {
    const response = await fetch('/api/profile', {
      method: 'GET',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      signal,
    });

    // Only the server explicitly rejecting the session ends it.
    if (response.status === 401) {
      setAuthState(false);
      return { status: 'unauthenticated' };
    }

    if (response.ok) {
      const data = await response.json();
      setAuthState(true);
      return { status: 'authenticated', user: data };
    }

    if (import.meta.env.DEV) {
      console.warn(`[Auth] Unexpected status ${response.status} from /api/profile: ${response.statusText}`);
    }
    return { status: 'unknown' };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { status: 'unknown' };
    }
    if (import.meta.env.DEV) {
      console.warn('[Auth] Network error during auth check:', error);
    }
    return { status: 'unknown' };
  }
}
