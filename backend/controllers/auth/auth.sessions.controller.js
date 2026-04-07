import { logger } from '../../config/logger.js';
import { deleteHeartbeatBySession, deleteOtherHeartbeatsForUser } from '../../models/clientHeartbeat.model.js';
import { deleteOtherUserSessions, deleteSession, getActiveSessions } from '../../models/session.model.js';
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

    const currentTokenVersion = user.token_version || 1;
    const sessions = await getActiveSessions(req.userId, currentTokenVersion);

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

export { getSessions, revokeSession, revokeOtherSessions };
