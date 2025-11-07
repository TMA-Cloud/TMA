/**
 * API utility functions
 */

const API_URL = import.meta.env.VITE_API_URL;

/**
 * Make a fetch request with default options
 */
async function apiRequest(
  endpoint: string,
  options: RequestInit = {},
): Promise<Response> {
  const url = endpoint.startsWith("http") ? endpoint : `${API_URL}${endpoint}`;

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
    throw new Error(`API request failed: ${res.statusText}`);
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
    throw new Error(`API request failed: ${res.statusText}`);
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
}> {
  try {
    return await apiGet<{ signupEnabled: boolean; canToggle: boolean }>(
      "/api/user/signup-status",
    );
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
