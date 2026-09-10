import { logger } from '../../config/logger.js';
import { getKnownProxiesSettings, isFirstUser, setKnownProxiesSettings } from '../../models/user.model.js';
import { logAuditEvent } from '../../services/auditLogger.js';
import { sendError, sendSuccess } from '../../utils/response.js';

async function requireFirstUser(req, res, action) {
  if (await isFirstUser(req.userId)) return true;

  await logAuditEvent(
    `admin.settings.${action === 'read' ? 'read' : 'update'}`,
    {
      status: 'failure',
      resourceType: 'settings',
      metadata: { action: `${action}_known_proxies`, reason: 'unauthorized' },
    },
    req
  );
  logger.warn({ userId: req.userId }, 'Unauthorized known proxies settings attempt');
  sendError(res, 403, `Only the first user can ${action === 'read' ? 'view' : 'configure'} known proxies`);
  return false;
}

async function getKnownProxiesConfig(req, res) {
  try {
    if (!(await requireFirstUser(req, res, 'read'))) return;
    sendSuccess(res, { knownProxies: await getKnownProxiesSettings() });
  } catch (err) {
    logger.error({ err }, 'Failed to get known proxies settings');
    sendError(res, 500, 'Server error', err);
  }
}

async function updateKnownProxiesConfig(req, res) {
  try {
    if (!(await requireFirstUser(req, res, 'update'))) return;
    const knownProxies = await setKnownProxiesSettings(req.body.knownProxies, req.userId);

    await logAuditEvent(
      'admin.settings.update',
      {
        status: 'success',
        resourceType: 'settings',
        metadata: { setting: 'known_proxies', count: knownProxies.length },
      },
      req
    );
    sendSuccess(res, { knownProxies, restartRequired: true });
  } catch (err) {
    if (err.message === 'Only the first user can configure known proxies') {
      return sendError(res, 403, err.message);
    }
    logger.error({ err }, 'Failed to update known proxies settings');
    sendError(res, 500, 'Server error', err);
  }
}

export { getKnownProxiesConfig, updateKnownProxiesConfig };
