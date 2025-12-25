const { getUserById } = require('../../models/user.model');
const { getActiveSessions, deleteSession } = require('../../models/session.model');
const { sendError, sendSuccess } = require('../../utils/response');
const { logger } = require('../../config/logger');
const { logAuditEvent } = require('../../services/auditLogger');

const JWT_SECRET = process.env.JWT_SECRET;

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
    let currentSessionId = null;
    try {
      const jwt = require('jsonwebtoken');
      let token;
      if (req.headers.cookie) {
        const cookies = req.headers.cookie.split(';').map(c => c.trim());
        const t = cookies.find(c => c.startsWith('token='));
        if (t) token = t.slice('token='.length);
      }
      if (!token && req.headers.authorization) {
        token = req.headers.authorization.split(' ')[1];
      }
      if (token) {
        const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
        currentSessionId = decoded.sid || null;
      }
    } catch (err) {
      // If token decode fails, continue without current session ID
      logger.debug({ err }, 'Could not decode token to get current session ID');
    }

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

module.exports = {
  getSessions,
  revokeSession,
};
