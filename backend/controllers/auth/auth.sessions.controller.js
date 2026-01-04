const { getUserById } = require('../../models/user.model');
const { getActiveSessions, deleteSession, deleteOtherUserSessions } = require('../../models/session.model');
const { sendError, sendSuccess } = require('../../utils/response');
const { logger } = require('../../config/logger');
const { logAuditEvent } = require('../../services/auditLogger');
const { getSessionIdFromRequest } = require('../../utils/tokenExtractor');

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

module.exports = {
  getSessions,
  revokeSession,
  revokeOtherSessions,
};
