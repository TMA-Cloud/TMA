/** Multi-factor auth setup, verification, backup codes, and password change. */
import { apiGet, apiPost } from './client';

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
