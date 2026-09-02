/** User and sub-user management, plus admin storage-limit control. */
import { apiDelete, apiGet, apiPost, apiPut } from './client';

export interface UserSummary {
  id: string;
  name: string;
  email: string;
  createdAt: string;
  mfaEnabled: boolean;
  storageUsed?: number;
  storageLimit?: number | null;
  /** Effective capacity for the account; null when unlimited (S3, no limit set). */
  storageTotal?: number | null;
  /** Account this login belongs to; null for top-level accounts. */
  parentUserId?: string | null;
  /** Granted capabilities for sub-users; null for owners, who hold them all. */
  permissions?: string[] | null;
}

/**
 * A capability an owner can grant a sub-user. The catalog is served by the API
 * rather than hard-coded here, so the checklist always matches what the server
 * actually enforces.
 */
export interface PermissionDefinition {
  key: string;
  label: string;
  description: string;
}

/** A sub-user: an extra login sharing the owner's files and storage quota. */
export interface SubUser {
  id: string;
  name: string | null;
  email: string;
  permissions: string[];
  createdAt: string;
  mfaEnabled: boolean;
}

export async function fetchSubUsers(): Promise<{
  subUsers: SubUser[];
  availablePermissions: PermissionDefinition[];
}> {
  return apiGet<{ subUsers: SubUser[]; availablePermissions: PermissionDefinition[] }>('/api/user/sub-users');
}

export async function createSubUser(payload: {
  email: string;
  password: string;
  name: string;
  permissions: string[];
}): Promise<{ subUser: SubUser }> {
  return apiPost<{ subUser: SubUser }>('/api/user/sub-users', payload);
}

export async function updateSubUserPermissions(id: string, permissions: string[]): Promise<{ subUser: SubUser }> {
  return apiPut<{ subUser: SubUser }>(`/api/user/sub-users/${encodeURIComponent(id)}`, { permissions });
}

export async function deleteSubUser(id: string): Promise<{ message: string }> {
  return apiDelete<{ message: string }>(`/api/user/sub-users/${encodeURIComponent(id)}`);
}

export async function fetchAllUsers(): Promise<{
  users: UserSummary[];
}> {
  return apiGet<{ users: UserSummary[] }>('/api/user/all');
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
