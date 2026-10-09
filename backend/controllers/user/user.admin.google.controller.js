import { invalidateGoogleAuthConfig } from '../../config/googleAuth.js';
import { logger } from '../../config/logger.js';
import {
  clearGoogleAuthConfig,
  getGoogleAuthSummary,
  isFirstUser,
  loadGoogleAuthConfig,
  saveGoogleAuthConfig,
} from '../../models/user.model.js';
import { logAuditEvent } from '../../services/auditLogger.js';
import { verifyGoogleClient } from '../../services/googleAuthProbe.js';
import { normalizeGoogleAuthSettings } from '../../utils/googleAuthSettings.js';
import { sendError, sendSuccess } from '../../utils/response.js';

const KNOWN_FAILURES = new Set(['GoogleAuthSettingsError', 'GoogleAuthProbeError', 'GoogleAuthConfigConflictError']);

async function requireFirstUser(req, res, action) {
  if (await isFirstUser(req.userId)) return true;

  await logAuditEvent(
    `admin.settings.${action === 'read' ? 'read' : 'update'}`,
    {
      status: 'failure',
      resourceType: 'settings',
      metadata: { action: `${action}_google_auth_config`, reason: 'unauthorized' },
    },
    req
  );
  logger.warn({ userId: req.userId }, 'Unauthorized Google sign-in settings attempt');
  sendError(res, 403, `Only the first user can ${action === 'read' ? 'view' : 'configure'} Google sign-in`);
  return false;
}

// A secret that no longer decrypts (lost KEK) must not block entering a fresh one.
async function loadCurrentConfig() {
  try {
    return await loadGoogleAuthConfig();
  } catch (err) {
    logger.error({ err }, '[GoogleAuth] Saved Google client secret could not be decrypted');
    return null;
  }
}

async function auditFailure(req, err, action) {
  await logAuditEvent(
    'admin.settings.update',
    { status: 'failure', resourceType: 'settings', errorMessage: err.message, metadata: { action } },
    req
  );
}

function handleError(res, err, label) {
  if (KNOWN_FAILURES.has(err.name)) return sendError(res, err.status, err.message);
  if (err.message === 'Only the first user can configure Google sign-in') return sendError(res, 403, err.message);
  logger.error({ err }, label);
  sendError(res, 500, 'Server error', err);
}

async function getGoogleAuthSettings(req, res) {
  try {
    if (!(await requireFirstUser(req, res, 'read'))) return;
    sendSuccess(res, await getGoogleAuthSummary());
  } catch (err) {
    handleError(res, err, 'Failed to get Google sign-in settings');
  }
}

/** Check the client with Google, then save it. Nothing Google rejects is ever stored. */
async function updateGoogleAuthSettings(req, res) {
  try {
    if (!(await requireFirstUser(req, res, 'update'))) return;
    const current = await loadCurrentConfig();
    const config = normalizeGoogleAuthSettings(req.body, current);
    await verifyGoogleClient(config);

    const version = await saveGoogleAuthConfig(config, req.userId, req.body.expectedVersion ?? null);
    invalidateGoogleAuthConfig();

    await logAuditEvent(
      'admin.settings.update',
      {
        status: 'success',
        resourceType: 'settings',
        metadata: {
          setting: 'google_auth_config',
          clientId: config.clientId,
          redirectUri: config.redirectUri,
          secretChanged: !current || current.clientSecret !== config.clientSecret,
          version,
        },
      },
      req
    );
    sendSuccess(res, await getGoogleAuthSummary());
  } catch (err) {
    if (KNOWN_FAILURES.has(err.name)) await auditFailure(req, err, 'update_google_auth_config');
    handleError(res, err, 'Failed to update Google sign-in settings');
  }
}

/** Turn Google sign-in off. Accounts keep their Google link, so turning it back on restores it. */
async function deleteGoogleAuthSettings(req, res) {
  try {
    if (!(await requireFirstUser(req, res, 'update'))) return;
    const version = await clearGoogleAuthConfig(req.userId, req.body?.expectedVersion ?? null);
    invalidateGoogleAuthConfig();

    await logAuditEvent(
      'admin.settings.update',
      {
        status: 'success',
        resourceType: 'settings',
        metadata: { setting: 'google_auth_config', cleared: true, version },
      },
      req
    );
    sendSuccess(res, await getGoogleAuthSummary());
  } catch (err) {
    if (KNOWN_FAILURES.has(err.name)) await auditFailure(req, err, 'delete_google_auth_config');
    handleError(res, err, 'Failed to turn off Google sign-in');
  }
}

export { getGoogleAuthSettings, updateGoogleAuthSettings, deleteGoogleAuthSettings };
