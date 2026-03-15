/**
 * Mutex utility for key-based locking
 * Uses a Map of mutexes to support per-key locking, with automatic cleanup.
 */

import { Mutex } from 'async-mutex';

const mutexMap = new Map();

/**
 * Get or create a mutex for a specific key.
 * Automatically removes the mutex after the lock is released and no waiters remain.
 */
function getMutex(key) {
  if (!mutexMap.has(key)) {
    mutexMap.set(key, new Mutex());
  }
  return mutexMap.get(key);
}

async function runWithMutex(key, operation) {
  const mutex = getMutex(key);
  try {
    return await mutex.runExclusive(operation);
  } finally {
    if (!mutex.isLocked()) {
      mutexMap.delete(key);
    }
  }
}

const fileOperationLock = async (fileId, operation) => {
  return runWithMutex(`file:${fileId}`, operation);
};

const userOperationLock = async (userId, operation) => {
  return runWithMutex(`user:${userId}`, operation);
};

export { fileOperationLock, userOperationLock };
