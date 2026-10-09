/** Object storage (bucket) settings, configured by the first user. */
import { apiGet, apiPost, apiPut } from './client';

export type StorageProvider = 's3' | 'r2' | 'aws';

export interface StorageStatus {
  configured: boolean;
  canConfigure: boolean;
}

export interface StorageSettingsSummary {
  configured: boolean;
  version: number;
  provider?: StorageProvider;
  endpoint?: string;
  region?: string;
  bucket?: string;
  forcePathStyle?: boolean;
  accessKeyIdMasked?: string | null;
  updatedAt?: string | null;
}

/** Blank credentials keep the saved pair on the server. */
export interface StorageSettingsInput {
  provider: StorageProvider;
  endpoint: string;
  region: string;
  bucket: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  expectedVersion?: number;
}

export async function getStorageStatus(signal?: AbortSignal): Promise<StorageStatus> {
  return apiGet<StorageStatus>('/api/user/storage-status', { signal });
}

export async function getStorageConfig(signal?: AbortSignal): Promise<StorageSettingsSummary> {
  return apiGet<StorageSettingsSummary>('/api/user/storage-config', { signal });
}

export async function testStorageConfig(input: StorageSettingsInput): Promise<{ ok: boolean; checks: string[] }> {
  return apiPost<{ ok: boolean; checks: string[] }>('/api/user/storage-config/test', input);
}

export async function updateStorageConfig(input: StorageSettingsInput): Promise<StorageSettingsSummary> {
  return apiPut<StorageSettingsSummary>('/api/user/storage-config', input);
}
