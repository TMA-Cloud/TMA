const { subscribeToFileEvents, unsubscribeFromFileEvents } = require('../../services/fileEvents');
const { logger } = require('../../config/logger');

/**
 * Server-Sent Events endpoint for real-time file events
 * All users receive the same events (broadcast to everyone)
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

  // Handle client disconnect
  req.on('close', async () => {
    logger.debug('Client disconnected from file events stream');
    if (subscriber) {
      await unsubscribeFromFileEvents(subscriber);
    }
    res.end();
  });

  // Subscribe to Redis pub/sub
  subscriber = await subscribeToFileEvents(event => {
    try {
      // Send event to client
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (err) {
      logger.error({ err, event }, 'Failed to send event to client');
    }
  });

  if (!subscriber) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'Failed to connect to event stream' })}\n\n`);
    res.end();
    return;
  }

  // Send keepalive ping every 30 seconds
  const keepAliveInterval = setInterval(() => {
    try {
      res.write(`: keepalive\n\n`);
    } catch (_err) {
      logger.debug('Client disconnected, stopping keepalive');
      clearInterval(keepAliveInterval);
      if (subscriber) {
        unsubscribeFromFileEvents(subscriber).catch(() => {});
      }
    }
  }, 30000);

  // Clean up on error
  req.on('error', async _err => {
    clearInterval(keepAliveInterval);
    if (subscriber) {
      await unsubscribeFromFileEvents(subscriber);
    }
  });
}

module.exports = {
  streamFileEvents,
};
