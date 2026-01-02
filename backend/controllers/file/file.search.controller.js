const { sendError, sendSuccess } = require('../../utils/response');
const { searchFiles, getFileStats } = require('../../models/file.model');
const { validateSearchQuery, validateLimit } = require('../../utils/validation');

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

module.exports = {
  searchFiles: searchFilesController,
  getFileStats: getFileStatsController,
};
