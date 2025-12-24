const path = require('path');
const os = require('os');

/**
 * Validates custom drive path for security
 * @param {string} customDrivePath - Path to validate
 * @param {string} userId - User ID requesting the path
 * @param {Object} pool - Database connection pool
 * @returns {Promise<{valid: boolean, error?: string}>}
 */
async function validateCustomDrivePath(customDrivePath, userId, pool) {
  if (!customDrivePath || typeof customDrivePath !== 'string') {
    return { valid: false, error: 'Path is required' };
  }

  const pathModule = require('path');
  const resolvedPath = pathModule.resolve(customDrivePath);
  const normalizedPath = resolvedPath.toLowerCase();

  // 1. Must be absolute path
  if (!pathModule.isAbsolute(resolvedPath)) {
    return { valid: false, error: 'Custom drive path must be an absolute path' };
  }

  // 2. Prevent path traversal
  if (customDrivePath.includes('..') || customDrivePath.includes('~')) {
    return { valid: false, error: 'Invalid path: path traversal not allowed' };
  }

  // 3. Reject Docker Compose placeholder paths (only when running in Docker)
  // These are default placeholder paths from docker-compose.yml that should never be used
  // Check if running in Docker by checking for /.dockerenv file or DOCKER environment variable
  try {
    const fs = require('fs');
    const isDocker = fs.existsSync('/.dockerenv') || process.env.DOCKER_CONTAINER === 'true';
    
    if (isDocker) {
       // Check if path matches placeholder pattern from docker-compose.yml
       if (normalizedPath.includes('docker_unused_placeholder') || 
           normalizedPath.startsWith('/docker_unused_placeholder')) {
         return { 
           valid: false, 
           error: 'Cannot use Docker placeholder path. Set a real path in .env (CUSTOM_DRIVE_MOUNT_N=/host/path:/container/path).' 
         };
       }
    }
  } catch (error) {
    // If Docker detection fails, continue with validation (non-Docker environments)
  }

  // 4. Prevent risky system paths
  const riskyPaths = getRiskyPaths();
  for (const riskyPath of riskyPaths) {
    if (normalizedPath.startsWith(riskyPath.toLowerCase())) {
      return { 
        valid: false, 
        error: `Cannot use system directory: ${riskyPath}. Please use a user-specific directory.` 
      };
    }
  }

  // 5. Prevent mounting other users' custom drive paths
  // Get current user's existing path (if any) to allow them to keep the same path
  const currentUserResult = await pool.query(
    'SELECT custom_drive_path FROM users WHERE id = $1',
    [userId]
  );
  const currentUserPath = currentUserResult.rows[0]?.custom_drive_path 
    ? pathModule.resolve(currentUserResult.rows[0].custom_drive_path).toLowerCase()
    : null;

  const existingUsers = await pool.query(
    'SELECT id, email, custom_drive_path FROM users WHERE custom_drive_enabled = TRUE AND custom_drive_path IS NOT NULL AND id != $1',
    [userId]
  );

  for (const user of existingUsers.rows) {
    if (user.custom_drive_path) {
      const existingPathNormalized = pathModule.resolve(user.custom_drive_path).toLowerCase();
      
      // Check if paths are the same (case-insensitive)
      // Allow user to keep their current path
      if (normalizedPath === existingPathNormalized && normalizedPath !== currentUserPath) {
        return { 
          valid: false, 
          error: 'This path is already in use by another user. Each custom drive path can only be owned by one user.' 
        };
      }
      
      // Check if new path is inside existing user's path (prevents subdirectory mounting)
      if (normalizedPath !== currentUserPath && 
          (normalizedPath.startsWith(existingPathNormalized + pathModule.sep) ||
           (normalizedPath.startsWith(existingPathNormalized) && normalizedPath.length > existingPathNormalized.length))) {
        return { 
          valid: false, 
          error: 'Cannot mount a directory inside another user\'s custom drive path.' 
        };
      }
      
      // Check if existing path is inside new path (prevents parent directory mounting)
      if (normalizedPath !== currentUserPath &&
          (existingPathNormalized.startsWith(normalizedPath + pathModule.sep) ||
           (existingPathNormalized.startsWith(normalizedPath) && existingPathNormalized.length > normalizedPath.length))) {
        return { 
          valid: false, 
          error: 'Cannot mount a directory that contains another user\'s custom drive path.' 
        };
      }
    }
  }

  // 6. Prevent mounting UPLOAD_DIR (where regular files are stored)
  const { UPLOAD_DIR } = require('../config/paths');
  const uploadDirNormalized = pathModule.resolve(UPLOAD_DIR).toLowerCase();
  if (normalizedPath === uploadDirNormalized || 
      normalizedPath.startsWith(uploadDirNormalized + pathModule.sep)) {
    return { 
      valid: false, 
      error: 'Cannot use the default upload directory as custom drive path.' 
    };
  }

  return { valid: true };
}

/**
 * Get list of risky system paths that should not be used as custom drive
 * @returns {string[]} Array of risky paths
 */
function getRiskyPaths() {
  const platform = process.platform;
  const riskyPaths = [];

  if (platform === 'win32') {
    // Windows risky paths
    riskyPaths.push(
      'C:\\Windows',
      'C:\\Program Files',
      'C:\\Program Files (x86)',
      'C:\\ProgramData',
      'C:\\System Volume Information',
      'C:\\$Recycle.Bin',
      'C:\\Users\\Default',
      'C:\\Users\\Public',
      'C:\\Windows\\System32',
      'C:\\Windows\\SysWOW64',
      process.env.SYSTEMROOT || 'C:\\Windows',
      process.env.PROGRAMDATA || 'C:\\ProgramData'
    );
  } else {
    // Unix/Linux risky paths - only security-critical system directories
    // Allow normal directories like /data, /mnt, /opt, /srv, /media
    riskyPaths.push(
      '/bin',
      '/boot',
      '/dev',
      '/etc',
      '/lib',
      '/lib64',
      '/proc',
      '/root',
      '/run',
      '/sbin',
      '/sys',
      '/tmp',
      '/usr',
      '/var',
      '/home',  // Block /home to prevent accessing other users' home directories
      '/lost+found',
      '/snap'
    );
    
    // Add user's home directory subdirectories that are risky
    const homedir = os.homedir();
    if (homedir) {
      riskyPaths.push(
        path.join(homedir, '.config'),
        path.join(homedir, '.local'),
        path.join(homedir, '.cache'),
        path.join(homedir, '.ssh'),
        path.join(homedir, '.gnupg')
      );
    }
  }

  return riskyPaths;
}

/**
 * Check if a path is already owned by another user
 * @param {string} customDrivePath - Path to check
 * @param {string} userId - Current user ID
 * @param {Object} pool - Database connection pool
 * @returns {Promise<{taken: boolean, ownerId?: string, ownerEmail?: string}>}
 */
async function isPathTaken(customDrivePath, userId, pool) {
  const pathModule = require('path');
  const resolvedPath = pathModule.resolve(customDrivePath).toLowerCase();

  const result = await pool.query(
    'SELECT id, email FROM users WHERE custom_drive_enabled = TRUE AND custom_drive_path IS NOT NULL AND id != $1 AND LOWER(custom_drive_path) = $2',
    [userId, resolvedPath]
  );

  if (result.rows.length > 0) {
    return {
      taken: true,
      ownerId: result.rows[0].id,
      ownerEmail: result.rows[0].email
    };
  }

  return { taken: false };
}

module.exports = {
  validateCustomDrivePath,
  getRiskyPaths,
  isPathTaken
};

