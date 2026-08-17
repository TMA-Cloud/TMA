import { generateSecret, generateURI, verify as verifyTotp } from 'otplib';
import QRCode from 'qrcode';

import { logger } from '../../config/logger.js';
import {
  canRegenerateBackupCodes,
  claimBackupCodeRegeneration,
  consumeMfaTimeStep,
  disableMfa,
  enableMfa,
  generateBackupCodes,
  getMfaStatus,
  getRemainingBackupCodesCount,
  getUserById,
  replaceBackupCodes,
  setMfaSecret,
  verifyAndConsumeBackupCode,
} from '../../models/user.model.js';
import { sendError, sendSuccess } from '../../utils/response.js';

// RFC 4226 §4 requires at least 128 bits of shared secret and recommends 160.
// 20 bytes hits the recommendation and base32-encodes to a 32-character string.
const MFA_SECRET_BYTES = 20;

const MFA_ISSUER = 'Cloud Storage';

// RFC 6238 §5.2: at most one step of slack, for transmission delay so it goes
// in the past only. Accepts the current and previous step; two live codes, not
// five. Loosen to [30, 30] only if clock-skew reports appear.
const MFA_EPOCH_TOLERANCE_SECONDS = [30, 0];

const TOTP_CODE_PATTERN = /^\d{6}$/;

const TOTP_PERIOD_SECONDS = 30;

/**
 * Replay floor to hand the verifier, or undefined to skip the check.
 *
 * A floor ahead of now (server clock moved back) throws, which would read as a
 * bad code and lock the user out. Dropping an untrustworthy floor loses replay
 * protection for one attempt — much cheaper than an unusable account.
 *
 * @param {number|null|undefined} lastTimeStep
 * @returns {number|undefined}
 */
function replayFloor(lastTimeStep) {
  if (!Number.isInteger(lastTimeStep) || lastTimeStep < 0) {
    return undefined;
  }

  const currentTimeStep = Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS);
  if (lastTimeStep > currentTimeStep) {
    logger.warn({ lastTimeStep, currentTimeStep }, 'Stored MFA time step is in the future; skipping replay check');
    return undefined;
  }

  return lastTimeStep;
}

/**
 * Check a user-supplied code against a stored base32 TOTP secret.
 *
 * Callers pass whatever the user typed, including 8-character backup codes.
 * The verifier throws on anything that isn't a 6-digit token, so unparseable
 * input is reported as a plain mismatch and falls through to the backup check.
 *
 * @param {string} secret - Base32-encoded shared secret.
 * @param {unknown} token - Raw user input.
 * @param {number|null} [lastTimeStep] - Last step already spent, if any.
 * @returns {Promise<{valid: boolean, timeStep: number|null}>}
 */
async function verifyTotpCode(secret, token, lastTimeStep = null) {
  if (typeof token !== 'string' || !TOTP_CODE_PATTERN.test(token)) {
    return { valid: false, timeStep: null };
  }

  try {
    const { valid, timeStep } = await verifyTotp({
      secret,
      token,
      epochTolerance: MFA_EPOCH_TOLERANCE_SECONDS,
      afterTimeStep: replayFloor(lastTimeStep),
    });
    return { valid, timeStep: valid ? timeStep : null };
  } catch (err) {
    // Stored secret won't decode. Fail the check rather than throw on every
    // sign-in attempt from here on.
    logger.error({ err }, 'TOTP verification failed to run');
    return { valid: false, timeStep: null };
  }
}

/**
 * Verify a code and spend its time step. Accepted only if the step was unspent.
 *
 * @param {string} userId
 * @param {{secret: string, lastTimeStep: number|null}} mfa
 * @param {unknown} code
 * @returns {Promise<boolean>}
 */
async function verifyAndSpendTotpCode(userId, mfa, code) {
  const { valid, timeStep } = await verifyTotpCode(mfa.secret, code, mfa.lastTimeStep);
  if (!valid) {
    return false;
  }

  if (!(await consumeMfaTimeStep(userId, timeStep))) {
    logger.warn({ userId, timeStep }, 'Rejected replay of an already-used MFA code');
    return false;
  }

  return true;
}

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
    const secret = generateSecret({ length: MFA_SECRET_BYTES });

    // Generate QR code data URL from the otpauth:// provisioning URI
    const otpauthUrl = generateURI({ issuer: MFA_ISSUER, label: user.email, secret });
    const qrCodeUrl = await QRCode.toDataURL(otpauthUrl);

    // Store secret temporarily (not enabled yet - user needs to verify first)
    // We'll store it in the database but mark as not enabled
    // This allows the user to verify before enabling
    await setMfaSecret(userId, secret, false);

    sendSuccess(res, {
      secret,
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

    const mfaStatus = await getMfaStatus(userId);
    if (!mfaStatus?.secret) {
      return sendError(res, 400, 'MFA not set up. Please set up MFA first.');
    }

    // Enrolment only. Without this, re-posting a valid code appends another ten
    // backup codes to the live set and sidesteps the regeneration cooldown.
    if (mfaStatus.enabled) {
      return sendError(res, 400, 'MFA is already enabled');
    }

    const secret = mfaStatus.secret;

    // Storing the secret cleared the replay counter, so enrolment starts clean.
    const verified = await verifyAndSpendTotpCode(userId, { secret, lastTimeStep: null }, code);

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
    const verified = await verifyAndSpendTotpCode(userId, mfaStatus, code);

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
  const totpValid = await verifyAndSpendTotpCode(userId, mfaStatus, code);

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

    // Claim the cooldown up front; losing means another request got there first.
    if (!(await claimBackupCodeRegeneration(userId))) {
      const cooldownCheck = await canRegenerateBackupCodes(userId);
      const remainingSeconds = Math.ceil(Math.max(cooldownCheck.remainingMs ?? 0, 0) / 1000);
      const remainingMinutes = Math.floor(remainingSeconds / 60);
      const remainingSecs = remainingSeconds % 60;
      const timeMessage =
        remainingMinutes > 0
          ? `${remainingMinutes} minute${remainingMinutes > 1 ? 's' : ''} and ${remainingSecs} second${remainingSecs !== 1 ? 's' : ''}`
          : `${remainingSecs} second${remainingSecs !== 1 ? 's' : ''}`;
      return sendError(res, 429, `Please wait ${timeMessage} before regenerating backup codes again`, null, {
        retryAfterMs: cooldownCheck.remainingMs,
      });
    }

    // One transaction, so a failure part-way leaves the old codes usable
    const backupCodes = await replaceBackupCodes(userId, 10);

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

export {
  setupMfa,
  verifyAndEnableMfa,
  disableMfaController,
  getMfaStatusController,
  verifyMfaCode,
  regenerateBackupCodes,
  getBackupCodesCount,
};
