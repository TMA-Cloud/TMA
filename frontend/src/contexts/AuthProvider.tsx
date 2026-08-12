import React, { useEffect, useState, useRef } from 'react';
import { AuthContext, type AccountPermission, type User } from './AuthContext';
import { checkAuthSilently, setAuthState, AUTH_STATE_KEY } from '../utils/api';

// Backoff between retries when the server cannot be reached. A deploy or a
// brief proxy hiccup should not push anyone to the login screen, so we wait it
// out instead of treating an unreachable server as a rejected session. Kept
// short so a genuinely down backend still resolves to the login screen quickly.
const RETRY_DELAYS_MS = [500, 1500, 3000];

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Function to load and update user profile
  const loadProfile = React.useCallback(async (abortSignal?: AbortSignal) => {
    try {
      for (let attempt = 0; ; attempt++) {
        const result = await checkAuthSilently(abortSignal);

        // Check if request was aborted
        if (abortSignal?.aborted) {
          return;
        }

        if (result.status === 'authenticated') {
          setUser(result.user as User);
          return;
        }

        // The server said the session is gone — that is the only case that
        // signs the user out.
        if (result.status === 'unauthenticated') {
          setUser(null);
          return;
        }

        // status === 'unknown': the session may well be fine. Retry a few
        // times, then give up for this pass while leaving the current user in
        // place so the UI does not flip to the login screen.
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay === undefined) {
          return;
        }
        await sleep(delay, abortSignal);
        if (abortSignal?.aborted) {
          return;
        }
      }
    } finally {
      if (!abortSignal?.aborted) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    // Cancel any pending requests on unmount
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    Promise.resolve().then(() => loadProfile(abortController.signal));

    // Cleanup: abort request if component unmounts
    return () => {
      abortController.abort();
      abortControllerRef.current = null;
    };
  }, [loadProfile]);

  // Cross-tab synchronization: Listen for localStorage changes
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      // Only react to changes to our auth state key
      if (e.key === AUTH_STATE_KEY && e.newValue !== e.oldValue) {
        // Cancel any in-flight auth check
        if (abortControllerRef.current) {
          abortControllerRef.current.abort();
        }

        // Auth state changed in another tab - always re-check to sync
        const abortController = new AbortController();
        abortControllerRef.current = abortController;

        // Silent refresh: don't show loading state for cross-tab sync
        // This prevents UI flicker when another tab logs in/out
        // Note: UI may briefly show stale state until re-check finishes (acceptable trade-off)
        loadProfile(abortController.signal);
      }
    };

    // Listen for storage events (cross-tab synchronization)
    window.addEventListener('storage', handleStorageChange);

    // Cleanup: only remove event listener
    // Don't abort requests here - the shared abortControllerRef is managed by
    // the main effect cleanup, not the storage listener cleanup
    return () => {
      window.removeEventListener('storage', handleStorageChange);
    };
  }, [loadProfile]);

  const login = async (email: string, password: string, mfaCode?: string) => {
    try {
      const res = await fetch(`/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'include',
        body: JSON.stringify({ email, password, mfaCode }),
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        const message = errorData.message || 'Login failed';
        // Return error info for MFA requirement detection
        const error = new Error(message) as Error & {
          status: number;
          requiresMfa: boolean;
          invalidMfa: boolean;
        };
        error.status = res.status;
        error.requiresMfa = message === 'MFA code required';
        error.invalidMfa = message === 'Invalid MFA code';
        throw error;
      }
      const data = await res.json();
      setUser(data.user);
      // Mark user as authenticated in localStorage
      setAuthState(true);
      return { success: true };
    } catch (err) {
      const error = err as {
        requiresMfa?: boolean;
        invalidMfa?: boolean;
        message?: string;
      };
      if (error.requiresMfa) {
        return { success: false, requiresMfa: true, message: error.message };
      }
      if (error.invalidMfa) {
        return { success: false, requiresMfa: true, message: error.message };
      }
      return { success: false, requiresMfa: false, message: error.message };
    }
  };

  const signup = async (email: string, password: string, name?: string) => {
    const res = await fetch(`/api/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'include',
      body: JSON.stringify({ email, password, name }),
    });
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.message || 'Failed to sign up');
    }
    const data = await res.json();
    setUser(data.user);
    // Mark user as authenticated in localStorage
    setAuthState(true);
    return true;
  };

  const logout = async () => {
    try {
      await fetch(`/api/logout`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
    } catch {
      // ignore
    }
    setUser(null);
    // Clear auth state from localStorage
    setAuthState(false);
  };

  const isSubUser = user?.isSubUser === true;

  // Only sub-users are constrained. Owners — and any state where the profile
  // has not reported a permission list — keep every action, so a missing field
  // can never silently strip an owner's own capabilities.
  const can = React.useCallback(
    (permission: AccountPermission) => {
      if (!user?.isSubUser) return true;
      return Array.isArray(user.permissions) && user.permissions.includes(permission);
    },
    [user]
  );

  return (
    <AuthContext.Provider value={{ user, loading, isSubUser, can, login, signup, logout }}>
      {children}
    </AuthContext.Provider>
  );
};
