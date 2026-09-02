/** Running vs latest version info for the update banner. */
import { apiGet } from './client';

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
