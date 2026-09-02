import { logger } from '../../config/logger.js';
import { isFirstUser } from '../../models/user.model.js';
import {
  upsertClientHeartbeat,
  getActiveClients as getActiveClientsModel,
} from '../../models/clientHeartbeat.model.js';
import { sendError, sendSuccess } from '../../utils/response.js';

/**
 * Record a heartbeat from an Electron desktop client (any authenticated user)
 * The frontend calls this periodically when running inside Electron
 */
async function clientHeartbeat(req, res) {
  try {
    const { appVersion, platform, sessionId, clientId } = req.body;
    if (!appVersion || typeof appVersion !== 'string') {
      return sendError(res, 400, 'appVersion is required');
    }

    await upsertClientHeartbeat({
      userId: req.userId,
      clientId: typeof clientId === 'string' && clientId.trim() ? clientId.trim() : null,
      sessionId: sessionId || req.sessionId || null,
      appVersion,
      platform: platform || null,
      userAgent: req.get('User-Agent') || null,
      ipAddress: req.ip || null,
    });

    sendSuccess(res, { ok: true });
  } catch (err) {
    logger.error({ err }, 'Failed to record client heartbeat');
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * Get all active Electron desktop clients (admin / first user only)
 */
async function getActiveClients(req, res) {
  try {
    const userIsFirst = await isFirstUser(req.userId);
    if (!userIsFirst) {
      return sendError(res, 403, 'Only the first user can view active clients');
    }

    const clients = await getActiveClientsModel(5);

    sendSuccess(res, {
      clients: clients.map(c => ({
        id: c.id,
        userId: c.user_id,
        userName: c.user_name,
        userEmail: c.user_email,
        appVersion: c.app_version,
        platform: c.platform,
        ipAddress: c.ip_address,
        lastSeenAt: c.last_seen_at,
        connectedSince: c.created_at,
      })),
    });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch active clients');
    sendError(res, 500, 'Server error', err);
  }
}

export { clientHeartbeat, getActiveClients };
