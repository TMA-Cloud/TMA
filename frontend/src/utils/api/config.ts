/** Instance and per-user configuration endpoints. */
import { ApiError } from '../errorUtils';
import { apiGet, apiPost, apiPut } from './client';

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
        allowPasswordChange: false,
        canToggleAllowPasswordChange: false,
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
  return apiPost<{ signupEnabled: boolean }>('/api/user/signup-toggle', {
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

export async function getKnownProxiesConfig(signal?: AbortSignal): Promise<{ knownProxies: string[] }> {
  return await apiGet<{ knownProxies: string[] }>('/api/user/known-proxies-config', { signal });
}

export async function updateKnownProxiesConfig(
  knownProxies: string[]
): Promise<{ knownProxies: string[]; restartRequired: boolean }> {
  return await apiPut<{ knownProxies: string[]; restartRequired: boolean }>('/api/user/known-proxies-config', {
    knownProxies,
  });
}
