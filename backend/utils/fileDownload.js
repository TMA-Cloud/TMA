const fs = require('fs');
const { resolveFilePath, isValidPath } = require('./filePath');

/**
 * Validates and resolves file path for download
 * @param {Object} file - File object from database
 * @returns {Object} { success: boolean, filePath?: string, error?: string }
 */
function validateAndResolveFile(file) {
  if (!file) {
    return { success: false, error: 'File not found' };
  }
  
  if (!file.path) {
    return { success: false, error: 'File path not found' };
  }
  
  if (!isValidPath(file.path)) {
    return { success: false, error: 'Invalid file path' };
  }
  
  let filePath;
  try {
    filePath = resolveFilePath(file.path);
  } catch (err) {
    return { success: false, error: err.message || 'Invalid file path' };
  }
  
  if (!fs.existsSync(filePath)) {
    return { success: false, error: 'File not found on disk' };
  }
  
  return { success: true, filePath };
}

module.exports = {
  validateAndResolveFile,
};

