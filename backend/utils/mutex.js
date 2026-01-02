/**
 * Mutex utility for key-based locking
 * Uses a Map of mutexes to support per-key locking
 */

const { Mutex } = require('async-mutex');

// Map of keys to mutex instances
const mutexMap = new Map();

/**
 * Get or create a mutex for a specific key
 * @param {string} key - Lock key
 * @returns {Mutex} Mutex instance for the key
 */
function getMutex(key) {
  if (!mutexMap.has(key)) {
    mutexMap.set(key, new Mutex());
  }
  return mutexMap.get(key);
}

/**
 * File operation locks to prevent concurrent modifications
 * @param {string} fileId - File ID to lock
 * @param {Function} operation - Operation to execute
 * @returns {Promise<any>} Result of the operation
 */
const fileOperationLock = async (fileId, operation) => {
  const mutex = getMutex(`file:${fileId}`);
  return mutex.runExclusive(operation);
};

/**
 * User operation locks to prevent concurrent user-level operations
 * @param {string} userId - User ID to lock
 * @param {Function} operation - Operation to execute
 * @returns {Promise<any>} Result of the operation
 */
const userOperationLock = async (userId, operation) => {
  const mutex = getMutex(`user:${userId}`);
  return mutex.runExclusive(operation);
};

module.exports = {
  fileOperationLock,
  userOperationLock,
};
