import { logger } from '../../config/logger.js';
import { getCloudDriveSaveOnly, isFirstUser, setCloudDriveSaveOnly } from '../../models/user.model.js';
import { logAuditEvent } from '../../services/auditLogger.js';
import { sendError, sendSuccess } from '../../utils/response.js';

const FORBIDDEN = 'Only the first user can configure the Cloud Drive mode';

/** Any signed-in user: every desktop app reads the mode it must apply. */
async function getCloudDriveConfig(req, res) {
  try {
    const [saveOnly, canConfigure] = await Promise.all([getCloudDriveSaveOnly(), isFirstUser(req.userId)]);
    sendSuccess(res, { saveOnly, canConfigure });
  } catch (err) {
    logger.error({ err }, 'Failed to get the Cloud Drive mode');
    sendError(res, 500, 'Server error', err);
  }
}

async function auditFailure(req, reason) {
  await logAuditEvent(
    'admin.settings.update',
    {
      status: 'failure',
      resourceType: 'settings',
      metadata: { action: 'update_cloud_drive_mode', reason },
    },
    req
  );
  logger.warn({ userId: req.userId }, 'Unauthorized Cloud Drive mode update attempt');
}

async function updateCloudDriveConfig(req, res) {
  try {
    if (!(await isFirstUser(req.userId))) {
      await auditFailure(req, 'unauthorized');
      return sendError(res, 403, FORBIDDEN);
    }

    await setCloudDriveSaveOnly(req.body.saveOnly, req.userId);
    const saveOnly = await getCloudDriveSaveOnly();

    await logAuditEvent(
      'admin.settings.update',
      { status: 'success', resourceType: 'settings', metadata: { setting: 'cloud_drive_save_only', saveOnly } },
      req
    );
    sendSuccess(res, { saveOnly, canConfigure: true });
  } catch (err) {
    // The first user changed between the check and the transaction.
    if (err.message === FORBIDDEN) {
      await auditFailure(req, 'unauthorized');
      return sendError(res, 403, err.message);
    }
    logger.error({ err }, 'Failed to update the Cloud Drive mode');
    sendError(res, 500, 'Server error', err);
  }
}

export { getCloudDriveConfig, updateCloudDriveConfig };
