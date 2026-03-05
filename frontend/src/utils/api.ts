/**
 * API utility functions (relative URLs; same origin as backend).
 */
import { ApiError } from './errorUtils';

interface ApiRequestOptions extends RequestInit {
  signal?: AbortSignal;
}

async function apiRequest(endpoint: string, options: ApiRequestOptions = {}): Promise<Response> {
  const fetchOptions = options;

  const defaultOptions: RequestInit = {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...fetchOptions.headers,
    },
    ...fetchOptions,
  };

  return await fetch(endpoint, defaultOptions);
}

async function throwApiErrorWithDetails(res: Response): Promise<never> {
  const errorData = await res.json().catch(() => ({ message: res.statusText }));
  const { message, error, ...rest } = (errorData ?? {}) as Record<string, unknown> & {
    message?: string;
    error?: string;
  };
  throw new ApiError(message || error || res.statusText, res.status, Object.keys(rest).length > 0 ? rest : undefined);
}

export async function apiGet<T = unknown>(endpoint: string, options?: ApiRequestOptions): Promise<T> {
  const res = await apiRequest(endpoint, { method: 'GET', ...options });
  if (!res.ok) {
    await throwApiErrorWithDetails(res);
  }
  return res.json();
}

export async function apiPost<T = unknown>(endpoint: string, data?: unknown, options?: ApiRequestOptions): Promise<T> {
  const res = await apiRequest(endpoint, {
    method: 'POST',
    body: data ? JSON.stringify(data) : undefined,
    ...options,
  });
  if (!res.ok) {
    await throwApiErrorWithDetails(res);
  }
  return res.json();
}

export async function apiPut<T = unknown>(endpoint: string, data?: unknown, options?: ApiRequestOptions): Promise<T> {
  const res = await apiRequest(endpoint, {
    method: 'PUT',
    body: data ? JSON.stringify(data) : undefined,
    ...options,
  });
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({ message: res.statusText }));
    throw new ApiError(errorData.message || errorData.error || res.statusText, res.status);
  }
  return res.json();
}

export async function apiPostForm<T = unknown>(endpoint: string, formData: FormData): Promise<T> {
  const res = await apiRequest(endpoint, {
    method: 'POST',
    body: formData,
    headers: {},
  });
  if (!res.ok) {
    await throwApiErrorWithDetails(res);
  }
  return res.json();
}

export async function checkGoogleAuthEnabled(): Promise<boolean> {
  try {
    const data = await apiGet<{ enabled: boolean }>('/api/google/enabled');
    return data.enabled;
  } catch {
    return false;
  }
}

/** When logged in: GET /api/user/signup-status; when not: GET /api/signup-status (public). */
export async function getSignupStatus(): Promise<{
  signupEnabled: boolean;
  canToggle: boolean;
  totalUsers?: number;
  additionalUsers?: number;
  hideFileExtensions?: boolean;
  canToggleHideFileExtensions?: boolean;
  electronOnlyAccess?: boolean;
  canToggleElectronOnlyAccess?: boolean;
  allowPasswordChange?: boolean;
  canToggleAllowPasswordChange?: boolean;
}> {
  try {
    const authenticated = await apiGet<{
      signupEnabled: boolean;
      canToggle: boolean;
      totalUsers?: number;
      additionalUsers?: number;
      hideFileExtensions?: boolean;
      canToggleHideFileExtensions?: boolean;
      electronOnlyAccess?: boolean;
      canToggleElectronOnlyAccess?: boolean;
      allowPasswordChange?: boolean;
      canToggleAllowPasswordChange?: boolean;
    }>('/api/user/signup-status');
    return authenticated;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      const publicRes = await apiGet<{ signupEnabled: boolean }>('/api/signup-status').catch(() => ({
        signupEnabled: true,
      }));
      return {
        ...publicRes,
        canToggle: false,
        hideFileExtensions: false,
        canToggleHideFileExtensions: false,
        electronOnlyAccess: false,
        canToggleElectronOnlyAccess: false,
      };
    }
    return {
      signupEnabled: true,
      canToggle: false,
      hideFileExtensions: false,
      canToggleHideFileExtensions: false,
      electronOnlyAccess: false,
      canToggleElectronOnlyAccess: false,
      allowPasswordChange: false,
      canToggleAllowPasswordChange: false,
    };
  }
}

export async function toggleSignup(enabled: boolean): Promise<{ signupEnabled: boolean }> {
  return await apiPost<{ signupEnabled: boolean }>('/api/user/signup-toggle', {
    enabled,
  });
}

export async function updateHideFileExtensionsConfig(hidden: boolean): Promise<{ hideFileExtensions: boolean }> {
  return await apiPut<{ hideFileExtensions: boolean }>('/api/user/hide-file-extensions-config', {
    hidden,
  });
}

export async function updateElectronOnlyAccessConfig(enabled: boolean): Promise<{ electronOnlyAccess: boolean }> {
  return await apiPut<{ electronOnlyAccess: boolean }>('/api/user/electron-only-access-config', {
    enabled,
  });
}

export async function updatePasswordChangeConfig(enabled: boolean): Promise<{ allowPasswordChange: boolean }> {
  return await apiPut<{ allowPasswordChange: boolean }>('/api/user/password-change-config', {
    enabled,
  });
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
}

export async function fetchAllUsers(): Promise<{
  users: UserSummary[];
}> {
  return await apiGet<{ users: UserSummary[] }>('/api/user/all');
}

export async function updateUserStorageLimit(
  targetUserId: string,
  storageLimit: number | null
): Promise<{ storageLimit: number | null }> {
  return await apiPut<{ storageLimit: number | null }>('/api/user/storage-limit', {
    targetUserId,
    storageLimit,
  });
}

export async function checkOnlyOfficeConfigured(): Promise<{
  configured: boolean;
}> {
  return await apiGet<{ configured: boolean }>('/api/user/onlyoffice-configured');
}

export async function getOnlyOfficeConfig(signal?: AbortSignal): Promise<{
  jwtSecretSet: boolean;
  url: string | null;
}> {
  return await apiGet<{ jwtSecretSet: boolean; url: string | null }>('/api/user/onlyoffice-config', { signal });
}

export async function updateOnlyOfficeConfig(
  jwtSecret: string | null,
  url: string | null
): Promise<{ jwtSecretSet: boolean; url: string | null }> {
  return await apiPut<{ jwtSecretSet: boolean; url: string | null }>('/api/user/onlyoffice-config', { jwtSecret, url });
}

export async function getShareBaseUrlConfig(signal?: AbortSignal): Promise<{
  url: string | null;
}> {
  return await apiGet<{ url: string | null }>('/api/user/share-base-url-config', { signal });
}

export async function updateShareBaseUrlConfig(url: string | null): Promise<{ url: string | null }> {
  return await apiPut<{ url: string | null }>('/api/user/share-base-url-config', { url });
}

export async function getMaxUploadSizeConfig(signal?: AbortSignal): Promise<{
  maxBytes: number;
}> {
  return await apiGet<{ maxBytes: number }>('/api/user/max-upload-size-config', { signal });
}

export async function updateMaxUploadSizeConfig(maxBytes: number): Promise<{ maxBytes: number }> {
  return await apiPut<{ maxBytes: number }>('/api/user/max-upload-size-config', { maxBytes });
}

export async function logoutAllDevices(): Promise<{
  message: string;
  sessionsInvalidated: boolean;
}> {
  return await apiPost<{ message: string; sessionsInvalidated: boolean }>('/api/logout-all');
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

export async function getActiveSessions(): Promise<{
  sessions: ActiveSession[];
}> {
  return await apiGet<{ sessions: ActiveSession[] }>('/api/sessions');
}

export async function apiDelete<T = unknown>(endpoint: string, options?: ApiRequestOptions): Promise<T> {
  const res = await apiRequest(endpoint, { method: 'DELETE', ...options });
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({ message: res.statusText }));
    throw new ApiError(errorData.message || errorData.error || res.statusText, res.status);
  }
  return res.json();
}

export async function revokeSession(sessionId: string): Promise<{
  message: string;
}> {
  return await apiDelete<{ message: string }>(`/api/sessions/${sessionId}`);
}

export async function revokeOtherSessions(): Promise<{
  message: string;
  deletedCount: number;
}> {
  return await apiPost<{ message: string; deletedCount: number }>('/api/sessions/revoke-others');
}

export async function getMfaStatus(): Promise<{ enabled: boolean }> {
  return await apiGet<{ enabled: boolean }>('/api/mfa/status');
}

export async function setupMfa(): Promise<{
  secret: string;
  qrCode: string;
}> {
  return await apiPost<{
    secret: string;
    qrCode: string;
  }>('/api/mfa/setup');
}

export async function verifyAndEnableMfa(code: string): Promise<{
  message: string;
  backupCodes?: string[];
  shouldPromptSessions?: boolean;
}> {
  return await apiPost<{
    message: string;
    backupCodes?: string[];
    shouldPromptSessions?: boolean;
  }>('/api/mfa/verify', { code });
}

export async function disableMfa(code: string): Promise<{
  message: string;
  shouldPromptSessions?: boolean;
}> {
  return await apiPost<{ message: string; shouldPromptSessions?: boolean }>('/api/mfa/disable', { code });
}

export async function regenerateBackupCodes(): Promise<{
  backupCodes: string[];
}> {
  return await apiPost<{ backupCodes: string[] }>('/api/mfa/backup-codes/regenerate');
}

export async function changePassword(
  oldPassword: string,
  newPassword: string
): Promise<{
  message: string;
}> {
  return await apiPost<{ message: string }>('/api/change-password', { oldPassword, newPassword });
}

export async function getBackupCodesCount(): Promise<{ count: number }> {
  return await apiGet<{ count: number }>('/api/mfa/backup-codes/count');
}

export interface VersionInfo {
  frontend: string;
  backend: string;
  electron?: string;
}

export async function getCurrentVersions(): Promise<VersionInfo> {
  const backendVersions = await apiGet<{ backend: string }>('/api/version');

  const frontendVersion = typeof __FRONTEND_VERSION__ !== 'undefined' ? __FRONTEND_VERSION__ : 'unknown';

  return {
    backend: backendVersions.backend ?? 'unknown',
    frontend: frontendVersion,
  };
}

export async function fetchLatestVersions(): Promise<VersionInfo> {
  return apiGet<VersionInfo>('/api/version/latest');
}

export async function checkUploadStorage(fileSize: number): Promise<{ allowed: true }> {
  return apiPost<{ allowed: true }>('/api/files/upload/check', { fileSize });
}

export async function downloadFile(id: string, fallbackFilename?: string): Promise<void> {
  const url = `/api/files/${id}/download`;
  const response = await fetch(url, {
    method: 'GET',
    credentials: 'include',
  });

  if (!response.ok) {
    let errorMessage = response.statusText;
    try {
      const data = await response.json();
      errorMessage = data.message || data.error || response.statusText;
    } catch {
      // ignore
    }
    const error = new Error(errorMessage || `Download failed: ${response.statusText}`);
    (error as { status?: number }).status = response.status;
    throw error;
  }

  const contentDisposition = response.headers.get('Content-Disposition');
  let filename: string | null = null;

  if (contentDisposition) {
    const rfc5987Match = contentDisposition.match(/filename\*=UTF-8''([^;,\s]+)/i);
    if (rfc5987Match && rfc5987Match[1]) {
      try {
        filename = decodeURIComponent(rfc5987Match[1]);
      } catch {
        filename = rfc5987Match[1];
      }
    } else {
      const quotedMatch = contentDisposition.match(/filename="([^"]+)"/);
      if (quotedMatch && quotedMatch[1]) {
        filename = quotedMatch[1];
      } else {
        const unquotedMatch = contentDisposition.match(/filename=([^;,\s]+)/);
        if (unquotedMatch && unquotedMatch[1]) {
          filename = unquotedMatch[1].trim();
          try {
            filename = decodeURIComponent(filename);
          } catch {
            // use as is
          }
        }
      }
    }
  }

  if (!filename || filename.trim() === '') {
    filename = fallbackFilename || 'download';
  }

  const blob = await response.blob();
  const downloadUrl = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = downloadUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(downloadUrl);
}

export const AUTH_STATE_KEY = 'tma_cloud_auth_state';
const AUTH_STATE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

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

/** Returns null if not authenticated, or { user, authenticated: true } if authenticated. Uses localStorage hint to skip API when no prior auth. */
export async function checkAuthSilently(signal?: AbortSignal): Promise<{
  user: unknown;
  authenticated: boolean;
} | null> {
  const hasValidAuthState = hasAuthState();
  const mightBeOAuth = mightBeAuthCallback();
  if (!hasValidAuthState && !mightBeOAuth) {
    return null;
  }

  try {
    const response = await fetch('/api/profile', {
      method: 'GET',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      signal,
    });

    if (response.status === 401) {
      setAuthState(false);
      return null;
    }

    if (response.ok) {
      const data = await response.json();
      setAuthState(true);
      return { user: data, authenticated: true };
    }

    if (import.meta.env.DEV) {
      console.warn(`[Auth] Unexpected status ${response.status} from /api/profile: ${response.statusText}`);
    }
    return null;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return null;
    }
    if (import.meta.env.DEV) {
      if (error instanceof TypeError && error.message.includes('fetch')) {
        console.warn('[Auth] Network error during auth check:', error);
      }
    }
    return null;
  }
}
