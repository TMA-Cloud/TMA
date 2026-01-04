import React, { useEffect, useState, useRef } from "react";
import { AuthContext, type User } from "./AuthContext";
import { checkAuthSilently, setAuthState, AUTH_STATE_KEY } from "../utils/api";

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Function to load and update user profile
  const loadProfile = React.useCallback(async (abortSignal?: AbortSignal) => {
    try {
      const result = await checkAuthSilently(abortSignal);

      // Check if request was aborted
      if (abortSignal?.aborted) {
        return;
      }

      // Standardized return type: null | {user, authenticated}
      if (result === null) {
        setUser(null);
      } else {
        setUser(result.user as User);
      }
    } catch {
      // Only handle errors if request wasn't aborted
      if (!abortSignal?.aborted) {
        setUser(null);
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

    loadProfile(abortController.signal);

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
    window.addEventListener("storage", handleStorageChange);

    // Cleanup: only remove event listener
    // Don't abort requests here - the shared abortControllerRef is managed by
    // the main effect cleanup, not the storage listener cleanup
    return () => {
      window.removeEventListener("storage", handleStorageChange);
    };
  }, [loadProfile]);

  const login = async (email: string, password: string, mfaCode?: string) => {
    try {
      const res = await fetch(`/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password, mfaCode }),
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        const message = errorData.message || "Login failed";
        // Return error info for MFA requirement detection
        throw {
          status: res.status,
          message,
          requiresMfa: message === "MFA code required",
          invalidMfa: message === "Invalid MFA code",
        };
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
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email, password, name }),
    });
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.message || "Failed to sign up");
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
        method: "POST",
        credentials: "include",
      });
    } catch {
      // ignore
    }
    setUser(null);
    // Clear auth state from localStorage
    setAuthState(false);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, signup, logout }}>
      {children}
    </AuthContext.Provider>
  );
};
