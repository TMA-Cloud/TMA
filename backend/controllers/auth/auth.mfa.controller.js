const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const {
  getMfaStatus,
  setMfaSecret,
  enableMfa,
  disableMfa,
  getMfaSecret,
  getUserById,
  generateBackupCodes,
  verifyAndConsumeBackupCode,
  getRemainingBackupCodesCount,
  deleteBackupCodes,
} = require('../../models/user.model');
const { sendError, sendSuccess } = require('../../utils/response');
const { logger } = require('../../config/logger');

/**
 * Generate MFA secret and QR code for setup
 */
async function setupMfa(req, res) {
  try {
    const userId = req.userId;
    const user = await getUserById(userId);
    if (!user) {
      return sendError(res, 404, 'User not found');
    }

    // Check if MFA is already enabled
    const mfaStatus = await getMfaStatus(userId);
    if (mfaStatus?.enabled) {
      return sendError(res, 400, 'MFA is already enabled');
    }

    // Generate secret
    const secret = speakeasy.generateSecret({
      name: `Cloud Storage (${user.email})`,
      length: 32,
    });

    // Generate QR code data URL
    const qrCodeUrl = await QRCode.toDataURL(secret.otpauth_url);

    // Store secret temporarily (not enabled yet - user needs to verify first)
    // We'll store it in the database but mark as not enabled
    // This allows the user to verify before enabling
    await setMfaSecret(userId, secret.base32, false);

    sendSuccess(res, {
      secret: secret.base32,
      qrCode: qrCodeUrl,
    });
  } catch (err) {
    logger.error({ err, userId: req.userId }, 'MFA setup failed');
    sendError(res, 500, 'Failed to setup MFA', err);
  }
}

/**
 * Verify and enable MFA
 */
async function verifyAndEnableMfa(req, res) {
  try {
    const userId = req.userId;
    const { code } = req.body;

    if (!code || typeof code !== 'string') {
      return sendError(res, 400, 'Verification code required');
    }

    const secret = await getMfaSecret(userId);
    if (!secret) {
      return sendError(res, 400, 'MFA not set up. Please set up MFA first.');
    }

    // Verify the code
    const verified = speakeasy.totp.verify({
      secret,
      encoding: 'base32',
      token: code,
      window: 2, // Allow 2 time steps before/after current time
    });

    if (!verified) {
      return sendError(res, 400, 'Invalid verification code');
    }

    // The secret is already stored, now enable MFA
    await enableMfa(userId);

    // Generate backup codes
    const backupCodes = await generateBackupCodes(userId, 10);

    logger.info({ userId }, 'MFA verified and enabled');
    sendSuccess(res, {
      message: 'MFA enabled successfully',
      backupCodes,
      shouldPromptSessions: true,
    });
  } catch (err) {
    logger.error({ err, userId: req.userId }, 'MFA verification failed');
    sendError(res, 500, 'Failed to verify MFA', err);
  }
}

/**
 * Disable MFA
 */
async function disableMfaController(req, res) {
  try {
    const userId = req.userId;
    const { code } = req.body;

    // Verify code before disabling
    const mfaStatus = await getMfaStatus(userId);
    if (!mfaStatus?.enabled) {
      return sendError(res, 400, 'MFA is not enabled');
    }

    if (!code || typeof code !== 'string') {
      return sendError(res, 400, 'Verification code required to disable MFA');
    }

    // Verify the code
    const verified = speakeasy.totp.verify({
      secret: mfaStatus.secret,
      encoding: 'base32',
      token: code,
      window: 2,
    });

    // Also check backup codes
    if (!verified) {
      const backupCodeValid = await verifyAndConsumeBackupCode(userId, code);
      if (!backupCodeValid) {
        return sendError(res, 400, 'Invalid verification code');
      }
    }

    // disableMfa already deletes backup codes
    await disableMfa(userId);

    logger.info({ userId }, 'MFA disabled');
    sendSuccess(res, { message: 'MFA disabled successfully', shouldPromptSessions: true });
  } catch (err) {
    logger.error({ err, userId: req.userId }, 'MFA disable failed');
    sendError(res, 500, 'Failed to disable MFA', err);
  }
}

/**
 * Get MFA status
 */
async function getMfaStatusController(req, res) {
  try {
    const userId = req.userId;
    const mfaStatus = await getMfaStatus(userId);
    if (!mfaStatus) {
      return sendError(res, 404, 'User not found');
    }
    sendSuccess(res, { enabled: mfaStatus.enabled });
  } catch (err) {
    logger.error({ err, userId: req.userId }, 'Failed to get MFA status');
    sendError(res, 500, 'Failed to get MFA status', err);
  }
}

/**
 * Verify MFA code (used during login)
 * Checks both TOTP codes and backup codes
 */
async function verifyMfaCode(userId, code) {
  const mfaStatus = await getMfaStatus(userId);
  if (!mfaStatus?.enabled || !mfaStatus.secret) {
    return false;
  }

  // First try TOTP code
  const totpValid = speakeasy.totp.verify({
    secret: mfaStatus.secret,
    encoding: 'base32',
    token: code,
    window: 2,
  });

  if (totpValid) {
    return true;
  }

  // If TOTP fails, try backup code
  return verifyAndConsumeBackupCode(userId, code);
}

/**
 * Regenerate backup codes
 */
async function regenerateBackupCodes(req, res) {
  try {
    const userId = req.userId;
    const mfaStatus = await getMfaStatus(userId);

    if (!mfaStatus?.enabled) {
      return sendError(res, 400, 'MFA is not enabled');
    }

    // Delete old backup codes
    await deleteBackupCodes(userId);

    // Generate new backup codes
    const backupCodes = await generateBackupCodes(userId, 10);

    logger.info({ userId }, 'Backup codes regenerated');
    sendSuccess(res, { backupCodes });
  } catch (err) {
    logger.error({ err, userId: req.userId }, 'Failed to regenerate backup codes');
    sendError(res, 500, 'Failed to regenerate backup codes', err);
  }
}

/**
 * Get remaining backup codes count
 */
async function getBackupCodesCount(req, res) {
  try {
    const userId = req.userId;
    const mfaStatus = await getMfaStatus(userId);

    if (!mfaStatus?.enabled) {
      return sendError(res, 400, 'MFA is not enabled');
    }

    const count = await getRemainingBackupCodesCount(userId);
    sendSuccess(res, { count });
  } catch (err) {
    logger.error({ err, userId: req.userId }, 'Failed to get backup codes count');
    sendError(res, 500, 'Failed to get backup codes count', err);
  }
}

module.exports = {
  setupMfa,
  verifyAndEnableMfa,
  disableMfaController,
  getMfaStatusController,
  verifyMfaCode,
  regenerateBackupCodes,
  getBackupCodesCount,
};
