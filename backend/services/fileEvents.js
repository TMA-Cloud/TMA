import { logger } from '../config/logger.js';
import { redisClient, isRedisConnected } from '../config/redis.js';

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

  // One publication per user. The browser already coalesces a burst into one
  // refresh, so publishing hundreds of individual messages only multiplies
  // Redis and SSE framing work without adding useful fidelity.
  const publishPromises = [];
  for (const [targetUserId, userEvents] of eventsByUser.entries()) {
    const channel = getUserEventsChannel(targetUserId);
    const envelope = {
      type: 'file.batch',
      timestamp: new Date().toISOString(),
      data: { events: userEvents },
    };
    publishPromises.push(
      redisClient.publish(channel, JSON.stringify(envelope)).catch(err => {
        logger.error({ err, eventCount: userEvents.length, userId: targetUserId }, 'Failed to publish batch event');
      })
    );
  }

  // Wait for all publishes to complete (but don't block on errors)
  await Promise.allSettled(publishPromises);

  logger.debug({ eventCount: events.length, userCount: eventsByUser.size }, 'Batch file events published');
}

// One subscriber connection per process, shared by every SSE stream: node-redis
// multiplexes channels and listeners on it and resubscribes after a reconnect.
// Duplicating the client per stream cost one Redis socket per open tab.
let sharedSubscriber = null;
let sharedSubscriberConnecting = null;
let totalActiveConnections = 0;
const MAX_CONNECTIONS = 10000; // Maximum concurrent SSE connections

async function getSharedSubscriber() {
  if (sharedSubscriber?.isReady) return sharedSubscriber;
  sharedSubscriberConnecting ??= (async () => {
    const client = redisClient.duplicate();
    client.on('error', err => logger.error({ err }, 'File events subscriber error'));
    await client.connect();
    sharedSubscriber = client;
    return client;
  })().finally(() => {
    sharedSubscriberConnecting = null;
  });
  return sharedSubscriberConnecting;
}

/**
 * Subscribe to file events from Redis (per-user channel for privacy)
 * @param {string} userId - User ID to subscribe to events for
 * @param {Function} callback - Callback function to handle events
 * @returns {Promise<{ channel: string, listener: Function, active: boolean } | null>} Subscription handle
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

  if (totalActiveConnections >= MAX_CONNECTIONS) {
    logger.warn({ activeConnections: totalActiveConnections }, 'Maximum SSE connections reached');
    return null;
  }

  const channel = getUserEventsChannel(userId);
  const listener = message => {
    try {
      callback(JSON.parse(message));
    } catch (err) {
      logger.error({ err, message, userId }, 'Failed to parse file event message');
    }
  };

  try {
    const subscriber = await getSharedSubscriber();
    await subscriber.subscribe(channel, listener);
    totalActiveConnections++;
    logger.debug({ channel, userId, activeConnections: totalActiveConnections }, 'Subscribed to user file events');
    return { channel, listener, active: true };
  } catch (err) {
    logger.error({ err, userId }, 'Failed to subscribe to file events');
    return null;
  }
}

/**
 * Unsubscribe one stream's listener; the channel itself is dropped once no
 * listener is left. Safe to call more than once.
 * @param {{ channel: string, listener: Function, active: boolean } | null} subscription
 * @param {string} [userId] - For logging only
 */
async function unsubscribeFromFileEvents(subscription, userId = null) {
  if (!subscription?.active) return;
  subscription.active = false;
  totalActiveConnections--;
  if (!sharedSubscriber?.isReady) return;
  try {
    await sharedSubscriber.unsubscribe(subscription.channel, subscription.listener);
    logger.debug({ channel: subscription.channel, userId }, 'Unsubscribed from user file events');
  } catch (err) {
    logger.debug({ err, userId }, 'Failed to unsubscribe from file events');
  }
}

/**
 * Get statistics about active SSE connections
 * @returns {Object} Connection statistics
 */
function getConnectionStats() {
  return {
    activeConnections: totalActiveConnections,
    maxConnections: MAX_CONNECTIONS,
  };
}

export {
  EventTypes,
  publishFileEvent,
  publishFileEventsBatch,
  subscribeToFileEvents,
  unsubscribeFromFileEvents,
  getUserEventsChannel,
  getConnectionStats,
};
