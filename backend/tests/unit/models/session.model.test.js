import { describe, expect, it } from 'vitest';

import { executedCalls, queueQueryResults } from '../../mocks/db.mock.js';
import { getActiveClients, upsertClientHeartbeat } from '../../../models/clientHeartbeat.model.js';
import { getActiveSessions, updateSessionActivity } from '../../../models/session.model.js';
import { cacheKeys, setCache } from '../../../utils/cache.js';

const USER_ID = 'user000000000001';

describe('active-session IP refresh', () => {
  it('bypasses a cached list and merges recent online-client IPs when forced', async () => {
    await setCache(cacheKeys.activeSessions(USER_ID, 1), [{ id: 'cached-session', ip_address: '192.0.2.1' }], 120);
    queueQueryResults({ rows: [{ id: 'live-session', ip_address: '198.51.100.8', is_online: true }] });

    const sessions = await getActiveSessions(USER_ID, 1, true);

    expect(sessions).toEqual([{ id: 'live-session', ip_address: '198.51.100.8', is_online: true }]);
    const query = executedCalls()[0];
    expect(query.sql).toContain('LEFT JOIN LATERAL');
    expect(query.sql).toContain('client_heartbeats');
    expect(query.sql).toContain('COALESCE(online_client.ip_address, s.ip_address::text)');
    expect(query.sql).not.toContain('OR s.last_activity');
    expect(query.sql).toContain("h.last_seen_at > NOW() - INTERVAL '3 minutes'");
    expect(query.params).toEqual([USER_ID, 1]);
  });

  it('stores the request IP while touching session activity', async () => {
    await updateSessionActivity('session-1', '203.0.113.42');

    const query = executedCalls()[0];
    expect(query.sql).toContain('ip_address = COALESCE($2, ip_address)');
    expect(query.params).toEqual(['session-1', '203.0.113.42']);
  });

  it('reattaches a stable desktop client to its latest login session', async () => {
    queueQueryResults({ rows: [{ id: `${USER_ID}:client-1` }] });

    await upsertClientHeartbeat({
      userId: USER_ID,
      clientId: 'client-1',
      sessionId: 'new-session',
      appVersion: '3.1.1',
      platform: 'win32',
      userAgent: 'test',
      ipAddress: '203.0.113.10',
    });

    expect(executedCalls()[0].sql).toContain('session_id   = EXCLUDED.session_id');
  });

  it('does not expose web presence rows as Electron clients', async () => {
    queueQueryResults({ rows: [] });

    await getActiveClients();

    expect(executedCalls()[0].sql).toContain("h.platform IS DISTINCT FROM 'web'");
  });
});
