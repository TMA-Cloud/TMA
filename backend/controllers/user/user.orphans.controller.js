/**
 * Orphan review endpoints (first user only).
 *
 * Scanning is read-only; deletion is always an explicit, itemised request from
 * the admin UI. See models/file/file.orphan.model.js for the safety rules.
 */

import { logger } from '../../config/logger.js';
import { DEFAULT_GRACE_MINUTES } from '../../models/file/file.orphan.model.js';
import { isFirstUser } from '../../models/user.model.js';
import { logAuditEvent } from '../../services/auditLogger.js';
import { getBoss } from '../../services/auditLogger/queue.js';
import { ORPHAN_MAINTENANCE_QUEUE } from '../../services/backgroundQueue.js';
import { sendError, sendSuccess } from '../../utils/response.js';

/**
 * Reject anyone who is not the first user, logging the attempt.
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {string} action - Audit metadata action name
 * @returns {Promise<boolean>} true when the request was rejected
 */
async function rejectIfNotFirstUser(req, res, action) {
  if (await isFirstUser(req.userId)) return false;

  await logAuditEvent(
    'admin.orphans.access',
    {
      status: 'failure',
      resourceType: 'settings',
      metadata: { action, reason: 'unauthorized' },
    },
    req
  );
  logger.warn({ userId: req.userId, action }, 'Unauthorized orphan endpoint access attempt');
  sendError(res, 403, 'Only the first user can review orphaned files');
  return true;
}

/**
 * Scan for orphaned storage objects and database rows (read-only).
 */
async function _getOrphans(req, res) {
  try {
    if (await rejectIfNotFirstUser(req, res, 'scan_orphans')) return;

    const boss = getBoss();
    if (!boss) return sendError(res, 503, 'Background worker queue is unavailable');
    if (req.query.jobId) {
      const job = await boss.getJobById(ORPHAN_MAINTENANCE_QUEUE, String(req.query.jobId));
      if (!job || job.data?.requestedBy !== req.userId) return sendError(res, 404, 'Orphan scan job not found');
      if (job.state === 'failed' || job.state === 'cancelled') return sendError(res, 500, 'Orphan scan failed');
      if (job.state !== 'completed') return res.status(202).json({ jobId: job.id, status: job.state });
      return sendSuccess(res, job.output);
    }

    const graceMinutes = req.query.graceMinutes != null ? Number(req.query.graceMinutes) : DEFAULT_GRACE_MINUTES;
    const jobId = await boss.send(ORPHAN_MAINTENANCE_QUEUE, {
      task: 'scan',
      graceMinutes,
      requestedBy: req.userId,
    });

    await logAuditEvent(
      'admin.orphans.scan',
      {
        status: 'success',
        resourceType: 'settings',
        metadata: {
          graceMinutes,
          jobId,
        },
      },
      req
    );

    res.status(202).json({ jobId, status: 'created' });
  } catch (err) {
    logger.error({ err }, 'Failed to scan for orphaned files');
    sendError(res, 500, 'Failed to scan for orphaned files', err);
  }
}

/**
 * Delete the orphans the admin explicitly selected. Each entry is re-verified
 * before removal; entries that no longer qualify come back as skipped.
 */
async function _deleteOrphans(req, res) {
  try {
    if (await rejectIfNotFirstUser(req, res, 'delete_orphans')) return;

    const boss = getBoss();
    if (!boss) return sendError(res, 503, 'Background worker queue is unavailable');
    if (req.body.jobId) {
      const job = await boss.getJobById(ORPHAN_MAINTENANCE_QUEUE, String(req.body.jobId));
      if (!job || job.data?.requestedBy !== req.userId) return sendError(res, 404, 'Orphan cleanup job not found');
      if (job.state === 'failed' || job.state === 'cancelled') return sendError(res, 500, 'Orphan cleanup failed');
      if (job.state !== 'completed') return res.status(202).json({ jobId: job.id, status: job.state });
      return sendSuccess(res, job.output);
    }

    const { storageKeys = [], fileIds = [], graceMinutes } = req.body;
    if (storageKeys.length === 0 && fileIds.length === 0) {
      return sendError(res, 400, 'Select at least one orphan to delete');
    }

    const jobId = await boss.send(ORPHAN_MAINTENANCE_QUEUE, {
      task: 'delete',
      storageKeys,
      fileIds,
      graceMinutes,
      requestedBy: req.userId,
    });

    await logAuditEvent(
      'admin.orphans.delete',
      {
        status: 'success',
        resourceType: 'file',
        metadata: {
          graceMinutes,
          requestedStorage: storageKeys.length,
          requestedDatabase: fileIds.length,
          jobId,
        },
      },
      req
    );
    logger.info(
      {
        userId: req.userId,
        jobId,
      },
      'Admin deleted orphaned entries'
    );

    res.status(202).json({ jobId, status: 'created' });
  } catch (err) {
    logger.error({ err }, 'Failed to delete orphaned files');
    sendError(res, 500, 'Failed to delete orphaned files', err);
  }
}

export { _getOrphans as getOrphans, _deleteOrphans as deleteOrphans };
