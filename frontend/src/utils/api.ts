/**
 * API utility functions
 */

/**
 * Make a fetch request with default options
 * Using relative URLs since frontend and backend are served from the same origin
 */
async function apiRequest(
  endpoint: string,
  options: RequestInit = {},
): Promise<Response> {
  const url = endpoint.startsWith("http") ? endpoint : endpoint;

  const defaultOptions: RequestInit = {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
    ...options,
  };

  return fetch(url, defaultOptions);
}

/**
 * Make a GET request
 */
export async function apiGet<T = unknown>(endpoint: string): Promise<T> {
  const res = await apiRequest(endpoint, { method: "GET" });
  if (!res.ok) {
    const errorData = await res
      .json()
      .catch(() => ({ message: res.statusText }));
    throw new Error(errorData.message || errorData.error || res.statusText);
  }
  return res.json();
}

/**
 * Make a POST request
 */
export async function apiPost<T = unknown>(
  endpoint: string,
  data?: unknown,
): Promise<T> {
  const res = await apiRequest(endpoint, {
    method: "POST",
    body: data ? JSON.stringify(data) : undefined,
  });
  if (!res.ok) {
    const errorData = await res
      .json()
      .catch(() => ({ message: res.statusText }));
    throw new Error(errorData.message || errorData.error || res.statusText);
  }
  return res.json();
}

/**
 * Make a PUT request
 */
export async function apiPut<T = unknown>(
  endpoint: string,
  data?: unknown,
): Promise<T> {
  const res = await apiRequest(endpoint, {
    method: "PUT",
    body: data ? JSON.stringify(data) : undefined,
  });
  if (!res.ok) {
    const errorData = await res
      .json()
      .catch(() => ({ message: res.statusText }));
    throw new Error(errorData.message || errorData.error || res.statusText);
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
    throw new Error(`API request failed: ${res.statusText}`);
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
}> {
  const url = targetUserId
    ? `/api/user/custom-drive?targetUserId=${encodeURIComponent(targetUserId)}`
    : "/api/user/custom-drive";
  return await apiGet<{ enabled: boolean; path: string | null }>(url);
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
): Promise<{ enabled: boolean; path: string | null }> {
  return await apiPut<{ enabled: boolean; path: string | null }>(
    "/api/user/custom-drive",
    { enabled, path, targetUserId },
  );
}

export interface UserSummary {
  id: string;
  name: string;
  email: string;
  createdAt: string;
}

export async function fetchAllUsers(): Promise<{
  users: UserSummary[];
}> {
  return await apiGet<{ users: UserSummary[] }>("/api/user/all");
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
export async function apiDelete<T = unknown>(endpoint: string): Promise<T> {
  const res = await apiRequest(endpoint, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`API request failed: ${res.statusText}`);
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

export interface VersionInfo {
  frontend: string;
  backend: string;
}

/**
 * Get currently deployed versions for frontend and backend
 * Backend version comes from server, frontend version is embedded at build time
 */
export async function getCurrentVersions(): Promise<VersionInfo> {
  const backendVersions = await apiGet<{ backend: string }>("/api/version");

  // Frontend version is embedded at build time, so use it directly
  const frontendVersion =
    typeof __FRONTEND_VERSION__ !== "undefined"
      ? __FRONTEND_VERSION__
      : "unknown";

  return {
    backend: backendVersions.backend,
    frontend: frontendVersion,
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
    throw new Error(`Download failed: ${response.statusText}`);
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
