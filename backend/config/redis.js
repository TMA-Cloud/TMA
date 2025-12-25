const { createClient } = require('redis');
const { logger } = require('./logger');

// Redis configuration
const redisConfig = {
  socket: {
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT) || 6379,
  },
  database: Number(process.env.REDIS_DB) || 0,
};

// Add password if provided
if (process.env.REDIS_PASSWORD) {
  redisConfig.password = process.env.REDIS_PASSWORD;
}

// Create Redis client
const redisClient = createClient(redisConfig);

// Error handling
redisClient.on('error', err => {
  logger.error({ err }, 'Redis client error');
});

redisClient.on('connect', () => {
  logger.info('Redis client connecting...');
});

redisClient.on('ready', () => {
  logger.info('Redis client ready');
});

redisClient.on('reconnecting', () => {
  logger.warn('Redis client reconnecting...');
});

// Connect to Redis
let isConnected = false;

async function connectRedis() {
  if (isConnected) {
    return redisClient;
  }

  try {
    await redisClient.connect();
    isConnected = true;
    logger.info('Redis connected successfully');
    return redisClient;
  } catch (err) {
    logger.error({ err }, 'Failed to connect to Redis');
    // Don't throw - allow app to continue without Redis (graceful degradation)
    isConnected = false;
    return null;
  }
}

// Disconnect from Redis
async function disconnectRedis() {
  if (!isConnected) {
    return;
  }

  try {
    await redisClient.quit();
    isConnected = false;
    logger.info('Redis disconnected');
  } catch (err) {
    logger.error({ err }, 'Error disconnecting from Redis');
  }
}

// Check if Redis is connected
function isRedisConnected() {
  return isConnected && redisClient.isReady;
}

module.exports = {
  redisClient,
  connectRedis,
  disconnectRedis,
  isRedisConnected,
};
