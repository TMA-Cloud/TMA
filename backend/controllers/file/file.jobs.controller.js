import { getBoss } from '../../services/auditLogger/queue.js';
import { ACCOUNT_FILE_OPERATION_QUEUE } from '../../services/backgroundQueue.js';
import { sendError, sendSuccess } from '../../utils/response.js';

/** Return the state of a user-triggered background file mutation. */
async function getFileJob(req, res) {
  const jobId =
    typeof req.params.jobId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(req.params.jobId)
      ? req.params.jobId
      : null;
  if (!jobId) return sendError(res, 400, 'Invalid background job ID');

  const boss = getBoss();
  if (!boss) return sendError(res, 503, 'Background worker queue is unavailable');

  const job = await boss.getJobById(ACCOUNT_FILE_OPERATION_QUEUE, jobId);
  if (!job || job.data?.userId !== req.ownerId) return sendError(res, 404, 'Background file job not found');
  if (job.state === 'failed' || job.state === 'cancelled') {
    return sendError(res, 500, 'Background file operation failed');
  }
  if (job.state !== 'completed') {
    return res.status(202).json({ jobId: job.id, status: job.state });
  }
  return sendSuccess(res, { jobId: job.id, status: job.state, result: job.output || {} });
}

export { getFileJob };
