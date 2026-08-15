import { getFileStats, getRecentFiles, RECENT_CACHE_SIZE, searchFiles } from '../../models/file.model.js';
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

  const files = await searchFiles(req.ownerId, validatedQuery, limit);
  sendSuccess(res, files);
}

/**
 * Get file statistics
 */
async function getFileStatsController(req, res) {
  const stats = await getFileStats(req.ownerId);
  sendSuccess(res, stats);
}

/**
 * List recently opened files for the dashboard.
 */
async function listRecentController(req, res) {
  const limit = validateLimit(req.query.limit, RECENT_CACHE_SIZE) || 10;
  const files = await getRecentFiles(req.ownerId, limit);
  sendSuccess(res, files);
}

const searchFilesExport = searchFilesController;
const getFileStatsExport = getFileStatsController;
const listRecent = listRecentController;

export { searchFilesExport as searchFiles, getFileStatsExport as getFileStats, listRecent };
