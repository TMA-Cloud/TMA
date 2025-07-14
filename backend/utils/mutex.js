class Mutex {
  constructor() {
    this.promises = new Map();
  }

  async lock(key) {
    while (this.promises.has(key)) {
      await this.promises.get(key);
    }
    
    let resolve;
    const promise = new Promise(r => resolve = r);
    this.promises.set(key, promise);
    
    return {
      unlock: () => {
        this.promises.delete(key);
        resolve();
      }
    };
  }
}

const mutex = new Mutex();

// File operation locks to prevent concurrent modifications
const fileOperationLock = async (fileId, operation) => {
  const lock = await mutex.lock(`file:${fileId}`);
  try {
    return await operation();
  } finally {
    lock.unlock();
  }
};

// User operation locks to prevent concurrent user-level operations
const userOperationLock = async (userId, operation) => {
  const lock = await mutex.lock(`user:${userId}`);
  try {
    return await operation();
  } finally {
    lock.unlock();
  }
};

module.exports = {
  Mutex,
  fileOperationLock,
  userOperationLock
};
