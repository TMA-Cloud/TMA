/** Active-session listing and revocation. */
import { apiDelete, apiGet, apiPost } from './client';

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
  is_online?: boolean;
  isCurrent?: boolean;
}

export async function getActiveSessions(refreshIp = false): Promise<{
  sessions: ActiveSession[];
}> {
  const endpoint = refreshIp ? '/api/sessions?refreshIp=true' : '/api/sessions';
  return await apiGet<{ sessions: ActiveSession[] }>(endpoint);
}

export async function sendSessionHeartbeat(): Promise<{ ok: boolean }> {
  return await apiPost<{ ok: boolean }>('/api/sessions/heartbeat');
}

export async function sendSessionOffline(): Promise<{ ok: boolean }> {
  return await apiPost<{ ok: boolean }>('/api/sessions/offline', undefined, { keepalive: true });
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
