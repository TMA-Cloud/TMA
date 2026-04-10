import bcrypt from 'bcryptjs';

import { logger } from '../../config/logger.js';
import { deleteAllUserSessions, isSessionRecent } from '../../models/session.model.js';
import {
  getPasswordChangeSettings,
  getMfaStatus,
  getUserByIdWithPassword,
  invalidateAllSessions,
  updateUserPassword,
} from '../../models/user.model.js';
import { logAuditEvent } from '../../services/auditLogger.js';
import { sendError, sendSuccess } from '../../utils/response.js';

import { verifyMfaCode } from './auth.mfa.controller.js';

/** Maximum session age (in seconds) to allow a password change without MFA re-verification. */
const RECENT_AUTH_WINDOW_SECONDS = 10 * 60; // 10 minutes

/**
 * Change current user's password
 *
 * Security: requires *recent* authentication to protect against session
 * hijacking.  If the session is older than RECENT_AUTH_WINDOW_SECONDS the
 * request is rejected with a 403 asking the user to re-authenticate.
 * When MFA is enabled the user must additionally supply a valid MFA / backup
 * code regardless of session age.
 */
async function changePassword(req, res) {
  try {
    if (!req.userId) {
      return sendError(res, 401, 'Not authenticated!!');
    }

    const { oldPassword, newPassword, mfaCode } = req.body;

    const allowPasswordChange = await getPasswordChangeSettings();
    if (!allowPasswordChange) {
      return sendError(res, 403, 'Password change is currently disabled by the administrator!!');
    }

    // --- Re-authentication gate ------------------------------------------------
    // 1. Session must have been created recently (user logged in within the last
    //    10 minutes).  This limits the damage window if an attacker hijacks an
    //    existing long-lived session.
    if (req.sessionId) {
      const recent = await isSessionRecent(req.sessionId, req.userId, RECENT_AUTH_WINDOW_SECONDS);
      if (!recent) {
        await logAuditEvent(
          'auth.password_change',
          {
            status: 'failure',
            resourceType: 'auth',
            metadata: { reason: 'session_not_recent' },
          },
          req
        );
        return sendError(res, 403, 'For your security, please log in again before changing your password.');
      }
    }

    // 2. If MFA is enabled, require a valid MFA code on every password change.
    const mfaStatus = await getMfaStatus(req.userId);
    if (mfaStatus?.enabled) {
      if (!mfaCode || typeof mfaCode !== 'string') {
        return sendError(res, 400, 'MFA verification code is required to change your password.');
      }

      const mfaValid = await verifyMfaCode(req.userId, mfaCode);
      if (!mfaValid) {
        await logAuditEvent(
          'auth.password_change',
          {
            status: 'failure',
            resourceType: 'auth',
            metadata: { reason: 'invalid_mfa_code' },
          },
          req
        );
        return sendError(res, 401, 'Invalid MFA code.');
      }
    }
    // ---------------------------------------------------------------------------

    const user = await getUserByIdWithPassword(req.userId);
    if (!user) {
      return sendError(res, 404, 'User not found!!');
    }

    if (!user.password) {
      return sendError(res, 400, 'Password change is not available for this account!!');
    }

    const validOld = await bcrypt.compare(oldPassword, user.password);
    if (!validOld) {
      await logAuditEvent(
        'auth.password_change',
        {
          status: 'failure',
          resourceType: 'auth',
          metadata: { reason: 'invalid_current_password' },
        },
        req
      );
      return sendError(res, 400, 'Current password is incorrect!!');
    }

    if (oldPassword === newPassword) {
      return sendError(res, 400, 'New password must be different from the current password!!');
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    await updateUserPassword(req.userId, hashed);

    const newTokenVersion = await invalidateAllSessions(req.userId);
    await deleteAllUserSessions(req.userId);

    await logAuditEvent(
      'auth.password_change',
      {
        status: 'success',
        resourceType: 'auth',
        metadata: { newTokenVersion },
      },
      req
    );
    logger.info({ userId: req.userId }, 'User changed password successfully');

    sendSuccess(res, { message: 'Password changed successfully, Please log in again!' });
  } catch (err) {
    logger.error({ err, userId: req.userId }, 'Failed to change password!!');
    sendError(res, 500, 'Failed to change password!!', err);
  }
}

export { changePassword };
