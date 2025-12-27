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
  FILE_UPDATED: 'file.updated',
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
 * Publish multiple file events in batch (optimized for bulk operations)
 * @param {Array<{eventType: string, eventData: Object, userId?: string}>} events - Array of events to publish
 */
async function publishFileEventsBatch(events) {
  if (!isRedisConnected()) {
    logger.debug('Redis not connected, skipping batch file event publication');
    return;
  }

  if (!Array.isArray(events) || events.length === 0) {
    return;
  }

  // Group events by userId for efficient publishing
  const eventsByUser = new Map();

  for (const { eventType, eventData, userId } of events) {
    const targetUserId = userId || eventData?.userId;
    if (!targetUserId) {
      logger.warn({ eventType, eventData }, 'Cannot publish file event: no userId provided');
      continue;
    }

    if (!eventsByUser.has(targetUserId)) {
      eventsByUser.set(targetUserId, []);
    }

    eventsByUser.get(targetUserId).push({
      type: eventType,
      timestamp: new Date().toISOString(),
      data: eventData,
    });
  }

  // Publish all events in parallel (grouped by user)
  const publishPromises = [];
  for (const [targetUserId, userEvents] of eventsByUser.entries()) {
    const channel = getUserEventsChannel(targetUserId);
    // Publish events sequentially for each user to maintain order
    for (const event of userEvents) {
      publishPromises.push(
        redisClient.publish(channel, JSON.stringify(event)).catch(err => {
          logger.error({ err, eventType: event.type, userId: targetUserId }, 'Failed to publish batch event');
        })
      );
    }
  }

  // Wait for all publishes to complete (but don't block on errors)
  await Promise.allSettled(publishPromises);

  logger.debug({ eventCount: events.length, userCount: eventsByUser.size }, 'Batch file events published');
}

// Track active subscriptions for connection management
const activeSubscriptions = new Map(); // userId -> subscriber client
const MAX_CONNECTIONS = 10000; // Maximum concurrent SSE connections

/**
 * Subscribe to file events from Redis (per-user channel for privacy)
 * Optimized with connection tracking and limits
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

  // Check connection limit
  if (activeSubscriptions.size >= MAX_CONNECTIONS) {
    logger.warn({ activeConnections: activeSubscriptions.size }, 'Maximum SSE connections reached');
    return null;
  }

  try {
    // Create a separate subscriber client (Redis requires separate clients for pub/sub)
    const subscriber = redisClient.duplicate();
    await subscriber.connect();

    const channel = getUserEventsChannel(userId);

    // Subscribe with error handling
    await subscriber.subscribe(channel, message => {
      try {
        const event = JSON.parse(message);
        callback(event);
      } catch (err) {
        logger.error({ err, message, userId }, 'Failed to parse file event message');
      }
    });

    // Track active subscription
    activeSubscriptions.set(userId, subscriber);

    // Handle subscriber errors
    subscriber.on('error', err => {
      logger.error({ err, userId, channel }, 'Subscriber client error');
      // Remove from tracking on error
      if (activeSubscriptions.get(userId) === subscriber) {
        activeSubscriptions.delete(userId);
      }
    });

    // Handle subscriber disconnect
    subscriber.on('end', () => {
      logger.debug({ userId, channel }, 'Subscriber client disconnected');
      if (activeSubscriptions.get(userId) === subscriber) {
        activeSubscriptions.delete(userId);
      }
    });

    logger.debug(
      { channel, userId, activeConnections: activeSubscriptions.size },
      'Subscribed to user file events channel'
    );
    return subscriber;
  } catch (err) {
    logger.error({ err, userId }, 'Failed to subscribe to file events');
    return null;
  }
}

/**
 * Unsubscribe from file events
 * Optimized with better cleanup and connection tracking
 * @param {Object} subscriber - Redis subscriber client
 * @param {string} userId - User ID (optional, for logging)
 */
async function unsubscribeFromFileEvents(subscriber, userId = null) {
  if (!subscriber) {
    return;
  }

  // Remove from tracking first
  if (userId && activeSubscriptions.has(userId)) {
    if (activeSubscriptions.get(userId) === subscriber) {
      activeSubscriptions.delete(userId);
    }
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
        logger.debug(
          { channel, userId, activeConnections: activeSubscriptions.size },
          'Unsubscribed from user file events channel'
        );
      } catch (unsubErr) {
        // Handle unsubscribe errors gracefully
        if (unsubErr.message && (unsubErr.message.includes('closed') || unsubErr.type === 'ClientClosedError')) {
          logger.debug({ userId, channel }, 'Channel already unsubscribed (client closed)');
          return;
        }
        throw unsubErr;
      }
    } else {
      // Fallback: try to unsubscribe from all channels
      try {
        await subscriber.unsubscribe();
        logger.debug({ userId }, 'Unsubscribed from all file events channels');
      } catch (unsubErr) {
        if (unsubErr.message && (unsubErr.message.includes('closed') || unsubErr.type === 'ClientClosedError')) {
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

/**
 * Get statistics about active SSE connections
 * @returns {Object} Connection statistics
 */
function getConnectionStats() {
  return {
    activeConnections: activeSubscriptions.size,
    maxConnections: MAX_CONNECTIONS,
  };
}

module.exports = {
  EventTypes,
  publishFileEvent,
  publishFileEventsBatch,
  subscribeToFileEvents,
  unsubscribeFromFileEvents,
  getUserEventsChannel,
  getConnectionStats,
};
