const { redisClient, isRedisConnected } = require('../config/redis');
const { logger } = require('../config/logger');

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
 * Get the Redis channel name for a user's file events
 * @param {string} userId - User ID
 * @returns {string} Channel name
 */
function getUserEventsChannel(userId) {
  return `file:events:${userId}`;
}

/**
 * Publish a file event to Redis pub/sub (per-user channel for privacy)
 * @param {string} eventType - Type of event (from EventTypes)
 * @param {Object} eventData - Event data containing file information
 * @param {string} userId - User ID to publish the event to (from eventData.userId if not provided)
 */
async function publishFileEvent(eventType, eventData, userId = null) {
  if (!isRedisConnected()) {
    logger.debug('Redis not connected, skipping file event publication');
    return;
  }

  // Extract userId from eventData if not provided
  const targetUserId = userId || eventData.userId;
  if (!targetUserId) {
    logger.warn({ eventType, eventData }, 'Cannot publish file event: no userId provided');
    return;
  }

  try {
    const event = {
      type: eventType,
      timestamp: new Date().toISOString(),
      data: eventData,
    };

    const channel = getUserEventsChannel(targetUserId);
    await redisClient.publish(channel, JSON.stringify(event));
    logger.debug({ eventType, channel, userId: targetUserId }, 'File event published to user channel');
  } catch (err) {
    logger.error({ err, eventType, eventData, userId: targetUserId }, 'Failed to publish file event');
    // Don't throw - event publishing is non-critical
  }
}

/**
 * Subscribe to file events from Redis (per-user channel for privacy)
 * @param {string} userId - User ID to subscribe to events for
 * @param {Function} callback - Callback function to handle events
 * @returns {Promise<Object>} Redis subscriber client
 */
async function subscribeToFileEvents(userId, callback) {
  if (!isRedisConnected()) {
    logger.warn('Redis not connected, cannot subscribe to file events');
    return null;
  }

  if (!userId) {
    logger.warn('Cannot subscribe to file events: no userId provided');
    return null;
  }

  try {
    // Create a separate subscriber client (Redis requires separate clients for pub/sub)
    const subscriber = redisClient.duplicate();
    await subscriber.connect();

    const channel = getUserEventsChannel(userId);
    await subscriber.subscribe(channel, message => {
      try {
        const event = JSON.parse(message);
        callback(event);
      } catch (err) {
        logger.error({ err, message }, 'Failed to parse file event message');
      }
    });

    logger.info({ channel, userId }, 'Subscribed to user file events channel');
    return subscriber;
  } catch (err) {
    logger.error({ err, userId }, 'Failed to subscribe to file events');
    return null;
  }
}

/**
 * Unsubscribe from file events
 * @param {Object} subscriber - Redis subscriber client
 * @param {string} userId - User ID (optional, for logging)
 */
async function unsubscribeFromFileEvents(subscriber, userId = null) {
  if (!subscriber) {
    return;
  }

  try {
    // Check if client is ready before attempting operations
    if (subscriber.isReady === false) {
      logger.debug({ userId }, 'Subscriber client not ready, skipping unsubscribe');
      return;
    }

    // Get the channel name if userId is provided, otherwise unsubscribe from all
    if (userId) {
      const channel = getUserEventsChannel(userId);
      try {
        await subscriber.unsubscribe(channel);
        logger.info({ channel, userId }, 'Unsubscribed from user file events channel');
      } catch (unsubErr) {
        // Handle unsubscribe errors gracefully
        if (unsubErr.message && unsubErr.message.includes('closed')) {
          logger.debug({ userId, channel }, 'Channel already unsubscribed (client closed)');
          return;
        }
        throw unsubErr;
      }
    } else {
      // Fallback: try to unsubscribe from all channels
      try {
        await subscriber.unsubscribe();
        logger.info('Unsubscribed from file events channel');
      } catch (unsubErr) {
        if (unsubErr.message && unsubErr.message.includes('closed')) {
          logger.debug({ userId }, 'Already unsubscribed (client closed)');
          return;
        }
        throw unsubErr;
      }
    }

    // Quit the client (this may fail if already closed, which is fine)
    try {
      await subscriber.quit();
    } catch (quitErr) {
      // Handle "client is closed" error gracefully (expected if called multiple times)
      if (quitErr.message && (quitErr.message.includes('closed') || quitErr.type === 'ClientClosedError')) {
        logger.debug({ userId }, 'Subscriber client already closed during quit');
        return;
      }
      throw quitErr;
    }
  } catch (err) {
    // Handle "client is closed" error gracefully (expected if called multiple times)
    if (err.message && (err.message.includes('closed') || err.type === 'ClientClosedError')) {
      logger.debug({ userId }, 'Subscriber client already closed during unsubscribe');
      return;
    }
    logger.error({ err, userId }, 'Failed to unsubscribe from file events');
  }
}

module.exports = {
  EventTypes,
  publishFileEvent,
  subscribeToFileEvents,
  unsubscribeFromFileEvents,
  getUserEventsChannel,
};
