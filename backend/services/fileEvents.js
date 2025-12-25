const { redisClient, isRedisConnected } = require('../config/redis');
const { logger } = require('../config/logger');

const FILE_EVENTS_CHANNEL = 'file:events';

/**
 * Event types for file operations
 */
const EventTypes = {
  FILE_UPLOADED: 'file.uploaded',
  FILE_DELETED: 'file.deleted',
  FILE_RENAMED: 'file.renamed',
  FILE_MOVED: 'file.moved',
  FILE_COPIED: 'file.copied',
  FOLDER_CREATED: 'folder.created',
  FILE_RESTORED: 'file.restored',
  FILE_PERMANENTLY_DELETED: 'file.permanently_deleted',
  FILE_STARRED: 'file.starred',
  FILE_SHARED: 'file.shared',
};

/**
 * Publish a file event to Redis pub/sub
 * @param {string} eventType - Type of event (from EventTypes)
 * @param {Object} eventData - Event data containing file information
 */
async function publishFileEvent(eventType, eventData) {
  if (!isRedisConnected()) {
    logger.debug('Redis not connected, skipping file event publication');
    return;
  }

  try {
    const event = {
      type: eventType,
      timestamp: new Date().toISOString(),
      data: eventData,
    };

    await redisClient.publish(FILE_EVENTS_CHANNEL, JSON.stringify(event));
    logger.debug({ eventType, eventData }, 'File event published');
  } catch (err) {
    logger.error({ err, eventType, eventData }, 'Failed to publish file event');
    // Don't throw - event publishing is non-critical
  }
}

/**
 * Subscribe to file events from Redis
 * @param {Function} callback - Callback function to handle events
 * @returns {Promise<Object>} Redis subscriber client
 */
async function subscribeToFileEvents(callback) {
  if (!isRedisConnected()) {
    logger.warn('Redis not connected, cannot subscribe to file events');
    return null;
  }

  try {
    // Create a separate subscriber client (Redis requires separate clients for pub/sub)
    const subscriber = redisClient.duplicate();
    await subscriber.connect();

    await subscriber.subscribe(FILE_EVENTS_CHANNEL, message => {
      try {
        const event = JSON.parse(message);
        callback(event);
      } catch (err) {
        logger.error({ err, message }, 'Failed to parse file event message');
      }
    });

    logger.info('Subscribed to file events channel');
    return subscriber;
  } catch (err) {
    logger.error({ err }, 'Failed to subscribe to file events');
    return null;
  }
}

/**
 * Unsubscribe from file events
 * @param {Object} subscriber - Redis subscriber client
 */
async function unsubscribeFromFileEvents(subscriber) {
  if (!subscriber) {
    return;
  }

  try {
    await subscriber.unsubscribe(FILE_EVENTS_CHANNEL);
    await subscriber.quit();
    logger.info('Unsubscribed from file events channel');
  } catch (err) {
    logger.error({ err }, 'Failed to unsubscribe from file events');
  }
}

module.exports = {
  EventTypes,
  publishFileEvent,
  subscribeToFileEvents,
  unsubscribeFromFileEvents,
};
