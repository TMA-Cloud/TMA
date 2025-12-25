import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../../../contexts/AuthContext";
import {
  getActiveSessions,
  revokeSession,
  logoutAllDevices,
  type ActiveSession,
} from "../../../utils/api";
import { useToast } from "../../../hooks/useToast";

export function useSessions() {
  const { logout } = useAuth();
  const { showToast } = useToast();
  const [activeSessions, setActiveSessions] = useState<ActiveSession[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [revokingSessionId, setRevokingSessionId] = useState<string | null>(
    null,
  );
  const [loggingOutAll, setLoggingOutAll] = useState(false);

  const loadActiveSessions = useCallback(async () => {
    try {
      setLoadingSessions(true);
      const { sessions } = await getActiveSessions();
      setActiveSessions(sessions);
    } catch (error) {
      console.error("Failed to load active sessions:", error);
    } finally {
      setLoadingSessions(false);
    }
  }, []);

  const handleRevokeSession = async (sessionId: string) => {
    if (revokingSessionId) return;

    // Check if this is the current session
    const sessionToRevoke = activeSessions.find((s) => s.id === sessionId);
    const isRevokingCurrent = sessionToRevoke?.isCurrent || false;

    try {
      setRevokingSessionId(sessionId);
      await revokeSession(sessionId);
      showToast("Session revoked successfully", "success");

      // If revoking current session, user will be logged out on next request
      if (isRevokingCurrent) {
        // Give a moment for the toast to show, then logout
        setTimeout(async () => {
          try {
            await logout();
          } catch (error) {
            console.error("Failed to logout after revoking session:", error);
            window.location.href = "/";
          }
        }, 1000);
      } else {
        // Reload sessions to update the list
        await loadActiveSessions();
      }
    } catch (error) {
      console.error("Failed to revoke session:", error);
      showToast("Failed to revoke session", "error");
    } finally {
      setRevokingSessionId(null);
    }
  };

  const handleLogoutAllDevices = async () => {
    if (loggingOutAll) return;

    try {
      setLoggingOutAll(true);
      await logoutAllDevices();
      showToast("Successfully logged out from all devices", "success");
      // Clear sessions list since all are invalidated
      setActiveSessions([]);
    } catch (error) {
      console.error("Failed to logout from all devices:", error);
      showToast("Failed to logout from all devices", "error");
      // Don't return - still clear local session to avoid inconsistent state
      // (e.g., server may have processed the request before network error)
    } finally {
      setLoggingOutAll(false);
    }

    // Always clear local session to ensure consistent state
    // If server logout failed, user can simply log back in
    // If server logout succeeded (or partially succeeded), this ensures local state matches
    try {
      await logout();
    } catch (error) {
      console.error("Failed to clear local session:", error);
      // Redirect to login page manually if logout() fails
      window.location.href = "/";
    }
  };

  useEffect(() => {
    loadActiveSessions();
  }, [loadActiveSessions]);

  return {
    activeSessions,
    loadingSessions,
    revokingSessionId,
    loggingOutAll,
    loadActiveSessions,
    handleRevokeSession,
    handleLogoutAllDevices,
  };
}
