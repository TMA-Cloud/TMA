import { getS3ConfigOrNull, invalidateS3Config } from '../../config/storage.js';
import { logger } from '../../config/logger.js';
import {
  getStorageSampleKeys,
  getStorageSettingsSummary,
  isFirstUser,
  loadStorageConfig,
  saveStorageConfig,
} from '../../models/user.model.js';
import { logAuditEvent } from '../../services/auditLogger.js';
import { probeStorage } from '../../services/storageProbe.js';
import { sendError, sendSuccess } from '../../utils/response.js';
import { normalizeStorageSettings, sameStorageTarget } from '../../utils/storageSettings.js';

const KNOWN_FAILURES = new Set(['StorageSettingsError', 'StorageProbeError', 'StorageConfigConflictError']);

async function requireFirstUser(req, res, action) {
  if (await isFirstUser(req.userId)) return true;

  await logAuditEvent(
    `admin.settings.${action === 'read' ? 'read' : 'update'}`,
    {
      status: 'failure',
      resourceType: 'settings',
      metadata: { action: `${action}_storage_config`, reason: 'unauthorized' },
    },
    req
  );
  logger.warn({ userId: req.userId }, 'Unauthorized storage settings attempt');
  sendError(res, 403, `Only the first user can ${action === 'read' ? 'view' : 'configure'} storage`);
  return false;
}

// A secret that no longer decrypts (lost KEK) must not block entering fresh credentials.
async function loadCurrentConfig() {
  try {
    return await loadStorageConfig();
  } catch (err) {
    logger.error({ err }, '[Storage] Saved storage secret could not be decrypted');
    return null;
  }
}

async function candidateFrom(req) {
  const current = await loadCurrentConfig();
  const config = normalizeStorageSettings(req.body, current);
  return { current, config, sampleKeys: await getStorageSampleKeys() };
}

function sendKnownFailure(res, err) {
  if (err.name === 'StorageProbeError') {
    return sendError(res, err.status, err.message, null, { error: 'STORAGE_PROBE_FAILED', step: err.step });
  }
  return sendError(res, err.status, err.message);
}

/** Whether storage is ready, for every signed-in user (drives the setup banner). */
async function getStorageStatus(req, res) {
  try {
    const [config, canConfigure] = await Promise.all([getS3ConfigOrNull(), isFirstUser(req.userId)]);
    sendSuccess(res, { configured: Boolean(config), canConfigure });
  } catch (err) {
    logger.error({ err }, 'Failed to read storage status');
    sendError(res, 500, 'Server error', err);
  }
}

async function getStorageConfig(req, res) {
  try {
    if (!(await requireFirstUser(req, res, 'read'))) return;
    sendSuccess(res, await getStorageSettingsSummary());
  } catch (err) {
    logger.error({ err }, 'Failed to get storage settings');
    sendError(res, 500, 'Server error', err);
  }
}

/** Run the connection checks without saving anything. */
async function testStorageConfig(req, res) {
  try {
    if (!(await requireFirstUser(req, res, 'update'))) return;
    const { config, sampleKeys } = await candidateFrom(req);
    const { checks } = await probeStorage(config, { sampleKeys });
    sendSuccess(res, { ok: true, checks });
  } catch (err) {
    if (KNOWN_FAILURES.has(err.name)) return sendKnownFailure(res, err);
    logger.error({ err }, 'Failed to test storage settings');
    sendError(res, 500, 'Server error', err);
  }
}

/** Verify the candidate against the live endpoint, then save it. Nothing unverified is ever stored. */
async function updateStorageConfig(req, res) {
  try {
    if (!(await requireFirstUser(req, res, 'update'))) return;
    const { current, config, sampleKeys } = await candidateFrom(req);
    await probeStorage(config, { sampleKeys });

    const version = await saveStorageConfig(config, req.userId, req.body.expectedVersion ?? null);
    invalidateS3Config();

    await logAuditEvent(
      'admin.settings.update',
      {
        status: 'success',
        resourceType: 'settings',
        metadata: {
          setting: 'storage_config',
          provider: config.provider,
          endpoint: config.endpoint,
          bucket: config.bucket,
          region: config.region,
          targetChanged: Boolean(current) && !sameStorageTarget(config, current),
          credentialsChanged: current?.accessKeyId !== config.accessKeyId,
          version,
        },
      },
      req
    );
    sendSuccess(res, await getStorageSettingsSummary());
  } catch (err) {
    if (KNOWN_FAILURES.has(err.name)) {
      await logAuditEvent(
        'admin.settings.update',
        {
          status: 'failure',
          resourceType: 'settings',
          errorMessage: err.message,
          metadata: { action: 'update_storage_config', step: err.step },
        },
        req
      );
      return sendKnownFailure(res, err);
    }
    if (err.message === 'Only the first user can configure storage') return sendError(res, 403, err.message);
    logger.error({ err }, 'Failed to update storage settings');
    sendError(res, 500, 'Server error', err);
  }
}

export { getStorageStatus, getStorageConfig, testStorageConfig, updateStorageConfig };
