import jwt from 'jsonwebtoken';

import { setUserId, setAccountContext } from './requestId.middleware.js';
import { logger } from '../config/logger.js';
import { getUserTokenVersion, getAccountContext } from '../models/user.model.js';
import { sessionExists, updateSessionActivity } from '../models/session.model.js';
import { extractRawToken } from '../utils/tokenExtractor.js';
import {
  generateAuthToken,
  getCookieOptions,
  SESSION_IDLE_TTL_SECONDS,
  TOKEN_RENEWAL_THRESHOLD_SECONDS,
} from '../utils/auth.js';

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  logger.error('JWT_SECRET environment variable is required');
  process.exit(1);
}

/**
 * Re-issue the auth token when it is close enough to expiry.
 *
 * Tokens are minted for the full idle window, so without this an active user
 * would still be forcibly logged out at the end of that window. Refreshing
 * while the user is active turns the fixed window into a sliding one: the
 * session only ends after SESSION_IDLE_TTL_SECONDS of genuine inactivity.
 *
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Object} decoded - Verified JWT payload
 */
function renewTokenIfNeeded(req, res, decoded) {
  // Nothing to renew if headers already went out (e.g. a streaming response
  // that started before this ran) or the payload has no expiry.
  if (res.headersSent || !decoded.exp) return;

  const secondsRemaining = decoded.exp - Math.floor(Date.now() / 1000);
  if (secondsRemaining > TOKEN_RENEWAL_THRESHOLD_SECONDS) return;

  try {
    const token = generateAuthToken(decoded.id, JWT_SECRET, {
      tokenVersion: decoded.v || 1,
      sessionId: decoded.sid || null,
    });
    res.cookie('token', token, getCookieOptions());
    logger.debug({ userId: decoded.id, sessionId: decoded.sid, secondsRemaining }, 'Auth token renewed');
  } catch (err) {
    // A failed renewal must never break the request: the current token is
    // still valid, the user simply gets another chance on the next call.
    logger.warn({ err, userId: decoded.id }, 'Failed to renew auth token');
  }
}

export default async function authMiddleware(req, res, next) {
  const token = extractRawToken(req);
  if (!token) {
    return res.status(401).json({ message: 'No token provided' });
  }

  try {
    // Explicitly specify allowed algorithms to prevent algorithm confusion attacks
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    req.userId = decoded.id;
    req.sessionId = decoded.sid || null;

    // Verify token version - protects against stolen tokens after "logout all devices"
    const currentTokenVersion = await getUserTokenVersion(decoded.id);
    if (currentTokenVersion === null) {
      logger.warn({ userId: decoded.id }, 'Token validation failed: user not found');
      return res.status(401).json({ message: 'Invalid token' });
    }

    // Check if token version matches (token.v might be undefined for old tokens)
    const tokenVersion = decoded.v || 1;
    if (tokenVersion !== currentTokenVersion) {
      logger.warn(
        { userId: decoded.id, tokenVersion, currentTokenVersion },
        'Token validation failed: session invalidated'
      );
      return res.status(401).json({ message: 'Session expired. Please login again.' });
    }

    // Validate session ID if present in token (for individual session revocation)
    // Exception: Allow DELETE requests to revoke sessions even if the session being revoked
    // is the same as the one in the token (user revoking their own current session)
    let isRevokingOwnSession = false;
    if (decoded.sid) {
      // Check if this is a DELETE request to revoke a session
      // Extract sessionId from URL path (handle both /api/sessions/... and /sessions/...)
      if (req.method === 'DELETE' && req.path) {
        // Match both /api/sessions/:id and /sessions/:id patterns
        const sessionRevokeMatch = req.path.match(/\/(?:api\/)?sessions\/([^/]+)$/);
        if (sessionRevokeMatch && sessionRevokeMatch[1] === decoded.sid) {
          isRevokingOwnSession = true;
        }
      }

      if (!isRevokingOwnSession) {
        const sessionValid = await sessionExists(decoded.sid, decoded.id, tokenVersion, SESSION_IDLE_TTL_SECONDS);
        if (!sessionValid) {
          logger.warn({ userId: decoded.id, sessionId: decoded.sid }, 'Token validation failed: session revoked');
          return res.status(401).json({ message: 'Session has been revoked. Please login again.' });
        }

        // Update last activity timestamp for this session (fire-and-forget, don't block request)
        // Only update if session is valid and not being revoked
        updateSessionActivity(decoded.sid).catch(err => {
          // Log error but don't fail the request if activity update fails
          logger.debug({ err, sessionId: decoded.sid }, 'Failed to update session activity');
        });
      }
      // If user is revoking their own session, allow the request to proceed
      // The controller will handle the deletion, and subsequent requests will fail
    }

    // Resolve which account this identity acts under. Owners act for
    // themselves; a sub-user acts on its parent's files and storage quota, so
    // every data-access path keys off `req.ownerId` rather than `req.userId`.
    const account = await getAccountContext(decoded.id);
    if (!account) {
      logger.warn({ userId: decoded.id }, 'Token validation failed: account not found');
      return res.status(401).json({ message: 'Invalid token' });
    }

    req.ownerId = account.ownerId;
    req.permissions = account.permissions;
    req.isSubUser = account.isSubUser;

    // Store identity in CLS context for automatic propagation to logs and audit events
    setUserId(decoded.id);
    setAccountContext({ ownerId: account.ownerId, isSubUser: account.isSubUser });

    // Keep an active session alive rather than expiring it on a fixed schedule.
    renewTokenIfNeeded(req, res, decoded);

    next();
  } catch (err) {
    logger.warn({ err }, 'Invalid token provided');
    return res.status(401).json({ message: 'Invalid token' });
  }
}
