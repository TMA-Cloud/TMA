import { getFileStats, searchFiles } from '../../models/file.model.js';
import { sendError, sendSuccess } from '../../utils/response.js';
import { validateLimit, validateSearchQuery } from '../../utils/validation.js';

/**
 * Search for files
 */
async function searchFilesController(req, res) {
  const query = req.query.q || req.query.query || '';
  const validatedQuery = validateSearchQuery(query);
  if (!validatedQuery) {
    return sendError(res, 400, 'Invalid search query');
  }
  const limit = validateLimit(req.query.limit, 100) || 100;

  const files = await searchFiles(req.userId, validatedQuery, limit);
  sendSuccess(res, files);
}

/**
 * Get file statistics
 */
async function getFileStatsController(req, res) {
  const stats = await getFileStats(req.userId);
  sendSuccess(res, stats);
}

const searchFilesExport = searchFilesController;
const getFileStatsExport = getFileStatsController;

export { searchFilesExport as searchFiles, getFileStatsExport as getFileStats };
