import { logger } from '../../config/logger.js';
import {
  deleteHeartbeatBySession,
  deleteOtherHeartbeatsForUser,
  upsertClientHeartbeat,
} from '../../models/clientHeartbeat.model.js';
import {
  deleteOtherUserSessions,
  deleteSession,
  getActiveSessions,
  updateSessionActivity,
} from '../../models/session.model.js';
import { getUserById } from '../../models/user.model.js';
import { logAuditEvent } from '../../services/auditLogger.js';
import { getSessionIdFromRequest } from '../../utils/tokenExtractor.js';
import { sendError, sendSuccess } from '../../utils/response.js';

/**
 * Get all active sessions for the current user
 */
async function getSessions(req, res) {
  try {
    if (!req.userId) {
      return sendError(res, 401, 'Not authenticated');
    }

    const user = await getUserById(req.userId);
    if (!user) {
      return sendError(res, 404, 'User not found');
    }

    // Get session ID from token to identify current session
    const currentSessionId = getSessionIdFromRequest(req);

    const refreshIp = req.query.refreshIp === 'true';
    if (refreshIp && currentSessionId) {
      // The middleware touch is intentionally fire-and-forget. Await this one so
      // an on-demand refresh always includes this device's IP from this request.
      await updateSessionActivity(currentSessionId, req.ip || req.socket?.remoteAddress || null);
    }

    const currentTokenVersion = user.token_version || 1;
    const sessions = await getActiveSessions(req.userId, currentTokenVersion, refreshIp);

    // Mark which session is the current one
    const sessionsWithCurrent = sessions.map(session => ({
      ...session,
      isCurrent: session.id === currentSessionId,
    }));

    sendSuccess(res, { sessions: sessionsWithCurrent });
  } catch (err) {
    logger.error({ err, userId: req.userId }, 'Failed to get sessions');
    sendError(res, 500, 'Failed to get sessions', err);
  }
}

/**
 * Record that the current browser/device is still online. Besides keeping the
 * activity window current, this captures the IP observed by the server after a
 * device changes network.
 */
async function sessionHeartbeat(req, res) {
  try {
    if (!req.userId || !req.sessionId) {
      return sendError(res, 401, 'Active session not found');
    }

    const ipAddress = req.ip || req.socket?.remoteAddress || null;
    await Promise.all([
      updateSessionActivity(req.sessionId, ipAddress),
      upsertClientHeartbeat({
        userId: req.userId,
        clientId: null,
        sessionId: req.sessionId,
        appVersion: 'web',
        platform: 'web',
        userAgent: req.get('User-Agent') || null,
        ipAddress,
      }),
    ]);
    sendSuccess(res, { ok: true });
  } catch (err) {
    logger.error({ err, userId: req.userId, sessionId: req.sessionId }, 'Failed to record session heartbeat');
    sendError(res, 500, 'Failed to record session heartbeat', err);
  }
}

/** Remove the presence heartbeat without revoking the signed-in session. */
async function sessionOffline(req, res) {
  try {
    if (!req.userId || !req.sessionId) {
      return sendError(res, 401, 'Active session not found');
    }

    await deleteHeartbeatBySession(req.userId, req.sessionId);
    sendSuccess(res, { ok: true });
  } catch (err) {
    logger.error({ err, userId: req.userId, sessionId: req.sessionId }, 'Failed to mark session offline');
    sendError(res, 500, 'Failed to mark session offline', err);
  }
}

/**
 * Revoke a specific session
 */
async function revokeSession(req, res) {
  try {
    if (!req.userId) {
      return sendError(res, 401, 'Not authenticated');
    }

    const { sessionId } = req.params;
    if (!sessionId) {
      return sendError(res, 400, 'Session ID required');
    }

    const deleted = await deleteSession(sessionId, req.userId);
    if (!deleted) {
      return sendError(res, 404, 'Session not found');
    }

    // Remove associated desktop heartbeat row for this session
    await deleteHeartbeatBySession(req.userId, sessionId);

    // Log the security event
    await logAuditEvent(
      'auth.session_revoked',
      {
        status: 'success',
        resourceType: 'auth',
        resourceId: sessionId,
        details: 'User revoked a specific session',
      },
      req
    );

    logger.info({ userId: req.userId, sessionId }, 'User revoked a session');
    sendSuccess(res, { message: 'Session revoked successfully' });
  } catch (err) {
    logger.error({ err, userId: req.userId }, 'Failed to revoke session');
    sendError(res, 500, 'Failed to revoke session', err);
  }
}

/**
 * Revoke all other sessions (except current one)
 */
async function revokeOtherSessions(req, res) {
  try {
    if (!req.userId) {
      return sendError(res, 401, 'Not authenticated');
    }

    const user = await getUserById(req.userId);
    if (!user) {
      return sendError(res, 404, 'User not found');
    }

    // Get current session ID from token
    const currentSessionId = getSessionIdFromRequest(req);

    if (!currentSessionId) {
      return sendError(res, 400, 'Current session not found');
    }

    const currentTokenVersion = user.token_version || 1;
    const deletedCount = await deleteOtherUserSessions(req.userId, currentSessionId, currentTokenVersion);
    await deleteOtherHeartbeatsForUser(req.userId, currentSessionId);

    // Log the security event
    await logAuditEvent(
      'auth.other_sessions_revoked',
      {
        status: 'success',
        resourceType: 'auth',
        resourceId: req.userId,
        details: `User revoked ${deletedCount} other session(s)`,
      },
      req
    );

    logger.info({ userId: req.userId, deletedCount, currentSessionId }, 'User revoked other sessions');
    sendSuccess(res, { message: 'Other sessions revoked successfully', deletedCount });
  } catch (err) {
    logger.error({ err, userId: req.userId }, 'Failed to revoke other sessions');
    sendError(res, 500, 'Failed to revoke other sessions', err);
  }
}

export { getSessions, sessionHeartbeat, sessionOffline, revokeSession, revokeOtherSessions };
