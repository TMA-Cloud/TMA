import { applyActivitySettings } from '../../config/activitySettings.js';
import { logger } from '../../config/logger.js';
import {
  isFirstUser,
  loadActivitySettings,
  setAccessTimeSettings,
  setSessionIdleDays,
} from '../../models/user.model.js';
import { logAuditEvent } from '../../services/auditLogger.js';
import { ActivitySettingsError } from '../../utils/activitySettings.js';
import { sendError, sendSuccess } from '../../utils/response.js';

async function requireFirstUser(req, res, action) {
  if (await isFirstUser(req.userId)) return true;

  await logAuditEvent(
    `admin.settings.${action === 'read' ? 'read' : 'update'}`,
    {
      status: 'failure',
      resourceType: 'settings',
      metadata: { action: `${action}_activity_settings`, reason: 'unauthorized' },
    },
    req
  );
  logger.warn({ userId: req.userId, action }, 'Unauthorized session and access-time settings attempt');
  sendError(res, 403, 'Only the first user can manage session and access-time settings');
  return false;
}

async function getActivityConfig(req, res) {
  try {
    if (!(await requireFirstUser(req, res, 'read'))) return;
    sendSuccess(res, await loadActivitySettings());
  } catch (err) {
    logger.error({ err }, 'Failed to get session and access-time settings');
    sendError(res, 500, 'Server error', err);
  }
}

/** Save through `save`, apply the result in this process at once, and audit it. */
async function saveActivityConfig(req, res, setting, save) {
  try {
    if (!(await requireFirstUser(req, res, 'update'))) return;
    // Other API processes pick the change up on their next refresh.
    const saved = applyActivitySettings(await save());

    await logAuditEvent(
      'admin.settings.update',
      { status: 'success', resourceType: 'settings', metadata: { setting, ...saved } },
      req
    );
    sendSuccess(res, saved);
  } catch (err) {
    if (err instanceof ActivitySettingsError) return sendError(res, 400, err.message);
    if (err.message?.startsWith('Only the first user can')) return sendError(res, 403, err.message);
    logger.error({ err, setting }, 'Failed to update session and access-time settings');
    sendError(res, 500, 'Server error', err);
  }
}

function updateSessionTimeoutConfig(req, res) {
  return saveActivityConfig(req, res, 'session_idle_days', () => setSessionIdleDays(req.body.idleDays, req.userId));
}

function updateAccessTimeConfig(req, res) {
  const { enabled, windowMinutes, flushSeconds } = req.body;
  return saveActivityConfig(req, res, 'access_time', () =>
    setAccessTimeSettings({ enabled, windowMinutes, flushSeconds }, req.userId)
  );
}

export { getActivityConfig, updateSessionTimeoutConfig, updateAccessTimeConfig };
