const { subscribeToFileEvents, unsubscribeFromFileEvents } = require('../../services/fileEvents');
const { logger } = require('../../config/logger');

/**
 * Server-Sent Events endpoint for real-time file events
 * Each user subscribes to their own private channel for privacy
 */
async function streamFileEvents(req, res) {
  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

  // Send initial connection message
  res.write(`data: ${JSON.stringify({ type: 'connected', message: 'Connected to file events stream' })}\n\n`);

  let subscriber = null;
  let keepAliveInterval = null;
  let isCleanedUp = false; // Flag to prevent double cleanup
  const userId = req.userId;

  // Helper function to cleanup resources (idempotent)
  const cleanup = async () => {
    if (isCleanedUp) {
      return; // Already cleaned up
    }
    isCleanedUp = true;

    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
      keepAliveInterval = null;
    }
    if (subscriber) {
      await unsubscribeFromFileEvents(subscriber, userId);
      subscriber = null;
    }
  };

  // Handle client disconnect
  req.on('close', async () => {
    logger.debug({ userId }, 'Client disconnected from file events stream');
    await cleanup();
    res.end();
  });

  // Subscribe to Redis pub/sub (user-specific channel for privacy)
  subscriber = await subscribeToFileEvents(userId, event => {
    try {
      // Send event to client
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (err) {
      logger.error({ err, event, userId }, 'Failed to send event to client');
    }
  });

  if (!subscriber) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'Failed to connect to event stream' })}\n\n`);
    res.end();
    return;
  }

  // Send keepalive ping every 30 seconds
  keepAliveInterval = setInterval(() => {
    try {
      res.write(`: keepalive\n\n`);
    } catch (_err) {
      logger.debug({ userId }, 'Client disconnected, stopping keepalive');
      void cleanup(); // Fire and forget, cleanup will handle idempotency
    }
  }, 30000);

  // Clean up on error
  req.on('error', async err => {
    // Ignore expected connection errors (client disconnect, aborted, etc.)
    // These are normal and don't need error logging
    const isExpectedError =
      err.code === 'ECONNRESET' ||
      err.code === 'EPIPE' ||
      err.message === 'aborted' ||
      err.message?.includes('aborted');

    if (!isExpectedError) {
      logger.warn({ userId, err }, 'Unexpected request error, cleaning up');
    } else {
      logger.debug({ userId, code: err.code }, 'Client disconnected (expected), cleaning up');
    }
    await cleanup();
  });
}

module.exports = {
  streamFileEvents,
};
