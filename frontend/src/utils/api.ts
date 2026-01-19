/**
 * API utility functions
 */
import { ApiError } from "./errorUtils";

/**
 * Request options with additional configuration
 */
interface ApiRequestOptions extends RequestInit {
  /**
   * If true, 401 errors will be handled silently (no console errors)
   * Useful for authentication checks where 401 is expected
   *
   * Note: Currently only returns the response without throwing; doesn't suppress
   * console logs by itself. Consider removing if not used elsewhere.
   */
  silentAuth?: boolean;
  /**
   * AbortSignal for request cancellation
   */
  signal?: AbortSignal;
}

/**
 * Make a fetch request with default options and enhanced error handling
 * Using relative URLs since frontend and backend are served from the same origin
 */
async function apiRequest(
  endpoint: string,
  options: ApiRequestOptions = {},
): Promise<Response> {
  const { silentAuth = false, ...fetchOptions } = options;

  const defaultOptions: RequestInit = {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...fetchOptions.headers,
    },
    ...fetchOptions,
  };

  try {
    const response = await fetch(endpoint, defaultOptions);

    // Handle 401 silently if requested (for auth checks)
    if (response.status === 401 && silentAuth) {
      // Return response without throwing - let caller handle it
      return response;
    }

    return response;
  } catch (error) {
    // Only log network errors if not in silent mode
    if (!silentAuth && error instanceof TypeError) {
      // Network errors are real failures, but we'll let the caller decide
      throw error;
    }
    throw error;
  }
}

/**
 * Make a GET request
 */
export async function apiGet<T = unknown>(
  endpoint: string,
  options?: ApiRequestOptions,
): Promise<T> {
  const res = await apiRequest(endpoint, { method: "GET", ...options });
  if (!res.ok) {
    const errorData = await res
      .json()
      .catch(() => ({ message: res.statusText }));
    const { message, error, ...rest } = errorData;
    throw new ApiError(
      message || error || res.statusText,
      res.status,
      Object.keys(rest).length > 0 ? rest : undefined,
    );
  }
  return res.json();
}

/**
 * Make a POST request
 */
export async function apiPost<T = unknown>(
  endpoint: string,
  data?: unknown,
  options?: ApiRequestOptions,
): Promise<T> {
  const res = await apiRequest(endpoint, {
    method: "POST",
    body: data ? JSON.stringify(data) : undefined,
    ...options,
  });
  if (!res.ok) {
    const errorData = await res
      .json()
      .catch(() => ({ message: res.statusText }));
    const { message, error, ...rest } = errorData;
    throw new ApiError(
      message || error || res.statusText,
      res.status,
      Object.keys(rest).length > 0 ? rest : undefined,
    );
  }
  return res.json();
}

/**
 * Make a PUT request
 */
export async function apiPut<T = unknown>(
  endpoint: string,
  data?: unknown,
  options?: ApiRequestOptions,
): Promise<T> {
  const res = await apiRequest(endpoint, {
    method: "PUT",
    body: data ? JSON.stringify(data) : undefined,
    ...options,
  });
  if (!res.ok) {
    const errorData = await res
      .json()
      .catch(() => ({ message: res.statusText }));
    throw new ApiError(
      errorData.message || errorData.error || res.statusText,
      res.status,
    );
  }
  return res.json();
}

/**
 * Make a POST request with FormData (for file uploads)
 */
export async function apiPostForm<T = unknown>(
  endpoint: string,
  formData: FormData,
): Promise<T> {
  const res = await apiRequest(endpoint, {
    method: "POST",
    body: formData,
    headers: {}, // Don't set Content-Type, let browser set it with boundary
  });
  if (!res.ok) {
    const errorData = await res
      .json()
      .catch(() => ({ message: res.statusText }));
    const { message, error, ...rest } = errorData;
    throw new ApiError(
      message || error || res.statusText,
      res.status,
      Object.keys(rest).length > 0 ? rest : undefined,
    );
  }
  return res.json();
}

/**
 * Check if Google auth is enabled
 */
export async function checkGoogleAuthEnabled(): Promise<boolean> {
  try {
    const data = await apiGet<{ enabled: boolean }>("/api/google/enabled");
    return data.enabled;
  } catch {
    return false;
  }
}

/**
 * Get signup status and whether current user can toggle it
 */
export async function getSignupStatus(): Promise<{
  signupEnabled: boolean;
  canToggle: boolean;
  totalUsers?: number;
  additionalUsers?: number;
}> {
  try {
    return await apiGet<{
      signupEnabled: boolean;
      canToggle: boolean;
      totalUsers?: number;
      additionalUsers?: number;
    }>("/api/user/signup-status");
  } catch {
    return { signupEnabled: true, canToggle: false };
  }
}

/**
 * Toggle signup enabled/disabled (only for first user)
 */
export async function toggleSignup(
  enabled: boolean,
): Promise<{ signupEnabled: boolean }> {
  return await apiPost<{ signupEnabled: boolean }>("/api/user/signup-toggle", {
    enabled,
  });
}

/**
 * Get user's custom drive settings
 */
export async function getCustomDriveSettings(targetUserId?: string): Promise<{
  enabled: boolean;
  path: string | null;
  ignorePatterns: string[];
}> {
  const url = targetUserId
    ? `/api/user/custom-drive?targetUserId=${encodeURIComponent(targetUserId)}`
    : "/api/user/custom-drive";
  return await apiGet<{
    enabled: boolean;
    path: string | null;
    ignorePatterns: string[];
  }>(url);
}

/**
 * Get all users' custom drive settings (admin only)
 */
export interface UserCustomDriveInfo {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  customDrive: {
    enabled: boolean;
    path: string | null;
    ignorePatterns: string[];
  };
}

export async function getAllUsersCustomDriveSettings(): Promise<{
  users: UserCustomDriveInfo[];
}> {
  return await apiGet<{ users: UserCustomDriveInfo[] }>(
    "/api/user/custom-drive/all",
  );
}

/**
 * Update user's custom drive settings (admin only)
 */
export async function updateCustomDriveSettings(
  enabled: boolean,
  path: string | null,
  targetUserId?: string,
  ignorePatterns?: string[],
): Promise<{
  enabled: boolean;
  path: string | null;
  ignorePatterns: string[];
}> {
  return await apiPut<{
    enabled: boolean;
    path: string | null;
    ignorePatterns: string[];
  }>("/api/user/custom-drive", { enabled, path, targetUserId, ignorePatterns });
}

export interface UserSummary {
  id: string;
  name: string;
  email: string;
  createdAt: string;
  mfaEnabled: boolean;
  storageUsed?: number;
  storageLimit?: number | null;
  storageTotal?: number;
  actualDiskSize?: number; // Actual disk space available (for validation)
}

export async function fetchAllUsers(): Promise<{
  users: UserSummary[];
}> {
  return await apiGet<{ users: UserSummary[] }>("/api/user/all");
}

/**
 * Update user storage limit (admin only)
 */
export async function updateUserStorageLimit(
  targetUserId: string,
  storageLimit: number | null,
): Promise<{ storageLimit: number | null }> {
  return await apiPut<{ storageLimit: number | null }>(
    "/api/user/storage-limit",
    {
      targetUserId,
      storageLimit,
    },
  );
}

/**
 * Check if OnlyOffice is configured (all authenticated users)
 */
export async function checkOnlyOfficeConfigured(): Promise<{
  configured: boolean;
}> {
  return await apiGet<{ configured: boolean }>(
    "/api/user/onlyoffice-configured",
  );
}

/**
 * Get OnlyOffice configuration (admin only)
 */
export async function getOnlyOfficeConfig(signal?: AbortSignal): Promise<{
  jwtSecretSet: boolean;
  url: string | null;
}> {
  return await apiGet<{ jwtSecretSet: boolean; url: string | null }>(
    "/api/user/onlyoffice-config",
    { signal },
  );
}

/**
 * Update OnlyOffice configuration (admin only)
 */
export async function updateOnlyOfficeConfig(
  jwtSecret: string | null,
  url: string | null,
): Promise<{ jwtSecretSet: boolean; url: string | null }> {
  return await apiPut<{ jwtSecretSet: boolean; url: string | null }>(
    "/api/user/onlyoffice-config",
    { jwtSecret, url },
  );
}

/**
 * Get agent configuration (admin only)
 */
export async function getAgentConfig(signal?: AbortSignal): Promise<{
  tokenSet: boolean;
  url: string | null;
}> {
  return await apiGet<{ tokenSet: boolean; url: string | null }>(
    "/api/user/agent-config",
    { signal },
  );
}

/**
 * Update agent configuration (admin only)
 */
export async function updateAgentConfig(
  token: string | null,
  url: string | null,
): Promise<{ tokenSet: boolean; url: string | null }> {
  return await apiPut<{ tokenSet: boolean; url: string | null }>(
    "/api/user/agent-config",
    { token, url },
  );
}

/**
 * Get agent paths (admin only)
 */
export async function getAgentPaths(): Promise<{ paths: string[] }> {
  return await apiGet<{ paths: string[] }>("/api/user/agent-paths");
}

/**
 * Check agent status (admin only)
 */
export async function checkAgentStatus(): Promise<{ isOnline: boolean }> {
  return await apiGet<{ isOnline: boolean }>("/api/user/agent-status");
}

/**
 * Check agent status for current user (non-admin endpoint)
 */
export async function checkMyAgentStatus(): Promise<{ isOnline: boolean }> {
  return await apiGet<{ isOnline: boolean }>("/api/user/my-agent-status");
}

/**
 * Refresh agent connection (admin only)
 */
export async function refreshAgentConnection(): Promise<{ isOnline: boolean }> {
  return await apiPost<{ isOnline: boolean }>("/api/user/agent-refresh");
}

/**
 * Logout from all devices by invalidating all tokens
 * This will log out the user from every device/browser
 */
export async function logoutAllDevices(): Promise<{
  message: string;
  sessionsInvalidated: boolean;
}> {
  return await apiPost<{ message: string; sessionsInvalidated: boolean }>(
    "/api/logout-all",
  );
}

export interface ActiveSession {
  id: string;
  user_id: string;
  token_version: number;
  user_agent: string | null;
  ip_address: string | null;
  created_at: string;
  last_activity: string;
  isCurrent?: boolean;
}

/**
 * Get all active sessions for the current user
 */
export async function getActiveSessions(): Promise<{
  sessions: ActiveSession[];
}> {
  return await apiGet<{ sessions: ActiveSession[] }>("/api/sessions");
}

/**
 * Make a DELETE request
 */
export async function apiDelete<T = unknown>(
  endpoint: string,
  options?: ApiRequestOptions,
): Promise<T> {
  const res = await apiRequest(endpoint, { method: "DELETE", ...options });
  if (!res.ok) {
    const errorData = await res
      .json()
      .catch(() => ({ message: res.statusText }));
    throw new ApiError(
      errorData.message || errorData.error || res.statusText,
      res.status,
    );
  }
  return res.json();
}

/**
 * Revoke a specific session
 */
export async function revokeSession(sessionId: string): Promise<{
  message: string;
}> {
  return await apiDelete<{ message: string }>(`/api/sessions/${sessionId}`);
}

/**
 * Revoke all other sessions (except current one)
 */
export async function revokeOtherSessions(): Promise<{
  message: string;
  deletedCount: number;
}> {
  return await apiPost<{ message: string; deletedCount: number }>(
    "/api/sessions/revoke-others",
  );
}

/**
 * MFA (Multi-Factor Authentication) API functions
 */

/**
 * Get MFA status for current user
 */
export async function getMfaStatus(): Promise<{ enabled: boolean }> {
  return await apiGet<{ enabled: boolean }>("/api/mfa/status");
}

/**
 * Setup MFA - generate secret and QR code
 */
export async function setupMfa(): Promise<{
  secret: string;
  qrCode: string;
}> {
  return await apiPost<{
    secret: string;
    qrCode: string;
  }>("/api/mfa/setup");
}

/**
 * Verify and enable MFA
 */
export async function verifyAndEnableMfa(code: string): Promise<{
  message: string;
  backupCodes?: string[];
  shouldPromptSessions?: boolean;
}> {
  return await apiPost<{
    message: string;
    backupCodes?: string[];
    shouldPromptSessions?: boolean;
  }>("/api/mfa/verify", { code });
}

/**
 * Disable MFA
 */
export async function disableMfa(code: string): Promise<{
  message: string;
  shouldPromptSessions?: boolean;
}> {
  return await apiPost<{ message: string; shouldPromptSessions?: boolean }>(
    "/api/mfa/disable",
    { code },
  );
}

/**
 * Regenerate backup codes
 */
export async function regenerateBackupCodes(): Promise<{
  backupCodes: string[];
}> {
  return await apiPost<{ backupCodes: string[] }>(
    "/api/mfa/backup-codes/regenerate",
  );
}

/**
 * Get remaining backup codes count
 */
export async function getBackupCodesCount(): Promise<{ count: number }> {
  return await apiGet<{ count: number }>("/api/mfa/backup-codes/count");
}

export interface VersionInfo {
  frontend: string;
  backend: string;
  agent: string;
}

/**
 * Get currently deployed versions for frontend, backend, and agent
 * Backend and agent versions come from server, frontend version is embedded at build time
 */
export async function getCurrentVersions(): Promise<VersionInfo> {
  const backendVersions = await apiGet<{ backend: string; agent: string }>(
    "/api/version",
  );

  // Frontend version is embedded at build time, so use it directly
  const frontendVersion =
    typeof __FRONTEND_VERSION__ !== "undefined"
      ? __FRONTEND_VERSION__
      : "unknown";

  return {
    backend: backendVersions.backend,
    frontend: frontendVersion,
    agent: backendVersions.agent || "unknown",
  };
}

/**
 * Fetch the latest published versions from the update feed
 * Uses backend proxy to avoid CORS issues
 */
export async function fetchLatestVersions(): Promise<VersionInfo> {
  return apiGet<VersionInfo>("/api/version/latest");
}

/**
 * Download a file or folder
 * For files: triggers direct download
 * For folders: fetches zip and triggers download
 * @param id - File or folder ID
 * @param fallbackFilename - Fallback filename to use if Content-Disposition header is missing or invalid
 */
export async function downloadFile(
  id: string,
  fallbackFilename?: string,
): Promise<void> {
  const url = `/api/files/${id}/download`;
  const response = await fetch(url, {
    method: "GET",
    credentials: "include",
  });

  if (!response.ok) {
    // Extract error message from response
    let errorMessage = response.statusText;
    try {
      const data = await response.json();
      errorMessage = data.message || data.error || response.statusText;
    } catch {
      // If JSON parsing fails, use statusText
    }
    const error = new Error(
      errorMessage || `Download failed: ${response.statusText}`,
    );
    // Attach status code to error for agent detection
    (error as { status?: number }).status = response.status;
    throw error;
  }

  // Get the filename from Content-Disposition header or use fallback
  const contentDisposition = response.headers.get("Content-Disposition");
  let filename: string | null = null;

  if (contentDisposition) {
    // Try to extract filename from Content-Disposition header
    // Handle both quoted and unquoted filenames, and RFC 5987 encoded filenames (filename*=UTF-8''...)

    // First try RFC 5987 encoding (filename*=UTF-8''...)
    const rfc5987Match = contentDisposition.match(
      /filename\*=UTF-8''([^;,\s]+)/i,
    );
    if (rfc5987Match && rfc5987Match[1]) {
      try {
        filename = decodeURIComponent(rfc5987Match[1]);
      } catch {
        filename = rfc5987Match[1];
      }
    } else {
      // Fallback to standard filename parameter
      // Try quoted filename first: filename="name.ext"
      const quotedMatch = contentDisposition.match(/filename="([^"]+)"/);
      if (quotedMatch && quotedMatch[1]) {
        filename = quotedMatch[1];
      } else {
        // Try unquoted filename: filename=name.ext
        const unquotedMatch = contentDisposition.match(/filename=([^;,\s]+)/);
        if (unquotedMatch && unquotedMatch[1]) {
          filename = unquotedMatch[1].trim();
          // Decode URI component if needed
          try {
            filename = decodeURIComponent(filename);
          } catch {
            // If decoding fails, use as is
          }
        }
      }
    }
  }

  // Use extracted filename if available, otherwise use fallback
  if (!filename || filename.trim() === "") {
    filename = fallbackFilename || "download";
  }

  // Get the blob
  const blob = await response.blob();

  // Create a download link and trigger download
  const downloadUrl = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = downloadUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(downloadUrl);
}

/**
 * Auth state management using localStorage
 * Used as an optimization hint to avoid unnecessary API calls on first visit.
 * Includes cross-tab synchronization via storage events.
 */
export const AUTH_STATE_KEY = "tma_cloud_auth_state";
const AUTH_STATE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days (matches token expiry)

interface AuthState {
  timestamp: number;
  version: number; // For future compatibility
}

const AUTH_STATE_VERSION = 1;

/**
 * Set authentication state with timestamp
 * Triggers storage event for cross-tab synchronization
 * Only updates if state actually changes to prevent infinite loops
 */
export function setAuthState(authenticated: boolean): void {
  try {
    if (authenticated) {
      // Check if auth state already exists and is valid
      // Only update if it doesn't exist or is invalid to prevent infinite loops
      const existing = localStorage.getItem(AUTH_STATE_KEY);
      if (existing) {
        try {
          const existingState: AuthState = JSON.parse(existing);
          // If state exists, is valid version, and timestamp is recent (within 1 hour),
          // don't update to avoid triggering unnecessary storage events
          if (
            existingState.version === AUTH_STATE_VERSION &&
            Date.now() - existingState.timestamp < 60 * 60 * 1000 // 1 hour
          ) {
            // State is already valid and recent, no need to update
            return;
          }
        } catch {
          // Invalid existing state, proceed to update
        }
      }

      // Update auth state with fresh timestamp
      const state: AuthState = {
        timestamp: Date.now(),
        version: AUTH_STATE_VERSION,
      };
      localStorage.setItem(AUTH_STATE_KEY, JSON.stringify(state));
    } else {
      // Only remove if it exists to avoid unnecessary storage events
      if (localStorage.getItem(AUTH_STATE_KEY)) {
        localStorage.removeItem(AUTH_STATE_KEY);
      }
    }
  } catch {
    // Ignore localStorage errors (e.g., private browsing mode)
  }
}

/**
 * Check if we have a valid authentication state
 * Validates timestamp to avoid using stale data
 */
export function hasAuthState(): boolean {
  try {
    const stored = localStorage.getItem(AUTH_STATE_KEY);
    if (!stored) return false;

    let state: AuthState;
    try {
      state = JSON.parse(stored);
    } catch {
      // Invalid JSON, clear it
      localStorage.removeItem(AUTH_STATE_KEY);
      return false;
    }

    // Validate version
    if (state.version !== AUTH_STATE_VERSION) {
      localStorage.removeItem(AUTH_STATE_KEY);
      return false;
    }

    // Validate timestamp is reasonable (not in future, not too old)
    const now = Date.now();
    const age = now - state.timestamp;

    // Reject if timestamp is in the future
    if (age < 0) {
      localStorage.removeItem(AUTH_STATE_KEY);
      return false;
    }

    // Reject if timestamp is too old (beyond token expiry period)
    if (age > AUTH_STATE_MAX_AGE) {
      localStorage.removeItem(AUTH_STATE_KEY);
      return false;
    }

    // State is valid
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if we might be coming from an OAuth callback
 * Uses sessionStorage flag set when OAuth flow is initiated
 *
 * Note: sessionStorage is per-tab, so if OAuth redirects to a new tab/window
 * or browser restores a different session context, the flag may not carry over.
 * This is a best-effort hint, not a guarantee.
 */
function mightBeAuthCallback(): boolean {
  try {
    // Check sessionStorage for OAuth indicator (set by OAuth button click)
    if (sessionStorage.getItem("oauth_initiated") === "true") {
      sessionStorage.removeItem("oauth_initiated");
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Silent authentication check
 *
 * Returns null if not authenticated, or {user, authenticated: true} if authenticated.
 *
 * Uses localStorage as an optimization hint to avoid unnecessary API calls on first visit.
 * Always makes API call when there's evidence of previous auth (validated state or OAuth flow).
 * Treats 401 responses as expected (not logged as errors).
 *
 * Note: Uses raw fetch() instead of apiRequest() for direct control over abort signal handling.
 * The apiRequest() function also supports signal, so we could unify later to reduce code duplication.
 * Current approach is simpler and works well for this specific use case.
 *
 * @param signal - Optional AbortSignal to cancel the request
 * @returns null if not authenticated, or {user, authenticated: true} if authenticated
 */
export async function checkAuthSilently(signal?: AbortSignal): Promise<{
  user: unknown;
  authenticated: boolean;
} | null> {
  // Check if we have a valid auth state (optimization hint)
  const hasValidAuthState = hasAuthState();
  const mightBeOAuth = mightBeAuthCallback();

  // Only skip API call if we have no valid auth state AND no OAuth indicators
  // This prevents console errors on genuine first visits
  if (!hasValidAuthState && !mightBeOAuth) {
    return null;
  }

  try {
    // Make the API call to verify token is still valid
    const response = await fetch("/api/profile", {
      method: "GET",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
      },
      signal, // Pass abort signal to actually cancel the request
    });

    // If fetch returns, it usually didn't abort (abort throws AbortError)
    // AbortError is handled in catch block below

    if (response.status === 401) {
      // Expected: user is not authenticated (token expired or invalid)
      // Clear auth state and return null (401 is expected, not an error)
      setAuthState(false);
      return null;
    }

    if (response.ok) {
      const data = await response.json();
      // Only update auth state if it doesn't already exist or is stale
      // This prevents infinite loops from storage events
      setAuthState(true);
      return { user: data, authenticated: true };
    }

    // Unexpected error status (not 401) - only log in development
    if (import.meta.env.DEV) {
      console.warn(
        `[Auth] Unexpected status ${response.status} from /api/profile: ${response.statusText}`,
      );
    }
    return null;
  } catch (error) {
    // Handle abort errors silently
    if (error instanceof Error && error.name === "AbortError") {
      return null;
    }

    // Handle network errors gracefully
    // Only log in development mode for debugging
    if (import.meta.env.DEV) {
      if (error instanceof TypeError && error.message.includes("fetch")) {
        console.warn("[Auth] Network error during auth check:", error);
      }
    }
    // Return null on any error - treat as unauthenticated
    return null;
  }
}
