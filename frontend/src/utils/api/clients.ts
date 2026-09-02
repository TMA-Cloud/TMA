/** Connected desktop (Electron) clients and their heartbeat. */
import { apiGet, apiPost } from './client';

export interface ActiveClient {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  appVersion: string;
  platform: string | null;
  ipAddress: string | null;
  lastSeenAt: string;
  connectedSince: string;
}

const HEARTBEAT_CLIENT_ID_KEY = 'tma_cloud_electron_client_id';

function getHeartbeatClientId(): string | null {
  try {
    const existing = localStorage.getItem(HEARTBEAT_CLIENT_ID_KEY);
    if (existing && existing.trim()) return existing;
    const generated =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `cid-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(HEARTBEAT_CLIENT_ID_KEY, generated);
    return generated;
  } catch {
    return null;
  }
}

export async function sendClientHeartbeat(appVersion: string, platform?: string): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>('/api/user/client-heartbeat', {
    appVersion,
    platform,
    clientId: getHeartbeatClientId(),
  });
}

export async function fetchActiveClients(): Promise<{ clients: ActiveClient[] }> {
  return apiGet<{ clients: ActiveClient[] }>('/api/user/active-clients');
}
