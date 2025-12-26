const { subscribeToFileEvents, unsubscribeFromFileEvents } = require('../../services/fileEvents');
const { logger } = require('../../config/logger');

// Configuration
const KEEPALIVE_INTERVAL = 30000; // 30 seconds
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY = 1000; // 1 second
const IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes - close idle connections

/**
 * Server-Sent Events endpoint for real-time file events
 * Optimized for better performance, stability, and resource management
 * Each user subscribes to their own private channel for privacy
 */
async function streamFileEvents(req, res) {
  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

  // Send initial connection message
  try {
    res.write(`data: ${JSON.stringify({ type: 'connected', message: 'Connected to file events stream' })}\n\n`);
  } catch (err) {
    logger.error({ err, userId: req.userId }, 'Failed to send initial connection message');
    res.end();
    return;
  }

  let subscriber = null;
  let keepAliveInterval = null;
  let idleTimeout = null;
  let isCleanedUp = false;
  let isConnectionClosed = false;
  let lastActivity = Date.now();
  const userId = req.userId;

  // Helper function to check if connection is still alive
  const isConnectionAlive = () => {
    return !isConnectionClosed && !res.destroyed && !res.writableEnded;
  };

  // Helper function to safely write to response
  const safeWrite = data => {
    if (!isConnectionAlive()) {
      return false;
    }
    try {
      res.write(data);
      lastActivity = Date.now(); // Update activity timestamp
      resetIdleTimeout(); // Reset idle timeout on activity
      return true;
    } catch (err) {
      // Connection closed or error
      isConnectionClosed = true;
      logger.debug({ userId, err: err.message }, 'Failed to write to SSE connection');
      return false;
    }
  };

  // Reset idle timeout when there's activity
  const resetIdleTimeout = () => {
    if (idleTimeout) {
      clearTimeout(idleTimeout);
    }
    idleTimeout = setTimeout(() => {
      if (isConnectionAlive()) {
        logger.debug({ userId, idleTime: Date.now() - lastActivity }, 'Closing idle SSE connection');
        void cleanup();
      }
    }, IDLE_TIMEOUT);
  };

  // Helper function to cleanup resources (idempotent)
  const cleanup = async () => {
    if (isCleanedUp) {
      return; // Already cleaned up
    }
    isCleanedUp = true;
    isConnectionClosed = true;

    if (idleTimeout) {
      clearTimeout(idleTimeout);
      idleTimeout = null;
    }

    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
      keepAliveInterval = null;
    }

    if (subscriber) {
      try {
        await unsubscribeFromFileEvents(subscriber, userId);
      } catch (err) {
        logger.debug({ err, userId }, 'Error during unsubscribe cleanup');
      }
      subscriber = null;
    }

    // Ensure response is closed
    if (!res.destroyed && !res.writableEnded) {
      try {
        res.end();
      } catch (_err) {
        // Ignore errors when closing response
      }
    }
  };

  // Handle client disconnect
  req.on('close', async () => {
    logger.debug({ userId }, 'Client disconnected from file events stream');
    await cleanup();
  });

  // Handle request abort
  req.on('aborted', async () => {
    logger.debug({ userId }, 'Request aborted');
    await cleanup();
  });

  // Subscribe to Redis pub/sub (user-specific channel for privacy)
  let retryCount = 0;
  while (retryCount < MAX_RETRY_ATTEMPTS && !subscriber && isConnectionAlive()) {
    try {
      subscriber = await subscribeToFileEvents(userId, event => {
        if (!isConnectionAlive()) {
          return;
        }

        try {
          // Send event to client
          const eventData = `data: ${JSON.stringify(event)}\n\n`;
          if (!safeWrite(eventData)) {
            // Connection closed, trigger cleanup
            void cleanup();
          }
        } catch (err) {
          logger.error({ err, event, userId }, 'Failed to send event to client');
          // Don't throw - continue processing other events
        }
      });

      if (subscriber) {
        break; // Successfully subscribed
      }
    } catch (err) {
      logger.error({ err, userId, retryCount }, 'Failed to subscribe to file events');
    }

    if (!subscriber && retryCount < MAX_RETRY_ATTEMPTS - 1) {
      // Wait before retry
      await new Promise(resolve => {
        setTimeout(
          () => {
            resolve();
          },
          RETRY_DELAY * (retryCount + 1)
        );
      });
      retryCount++;
    } else {
      retryCount++;
    }
  }

  if (!subscriber) {
    const errorMsg = { type: 'error', message: 'Failed to connect to event stream' };
    try {
      res.write(`data: ${JSON.stringify(errorMsg)}\n\n`);
    } catch (err) {
      logger.debug({ err, userId }, 'Failed to send error message');
    }
    res.end();
    return;
  }

  // Send keepalive ping at optimized interval
  keepAliveInterval = setInterval(() => {
    if (!isConnectionAlive()) {
      void cleanup();
      return;
    }

    // Check if connection is idle
    const timeSinceLastActivity = Date.now() - lastActivity;
    if (timeSinceLastActivity > IDLE_TIMEOUT) {
      logger.debug({ userId, idleTime: timeSinceLastActivity }, 'Connection idle, closing');
      void cleanup();
      return;
    }

    try {
      // Use comment-style keepalive (lighter weight)
      if (!safeWrite(`: keepalive\n\n`)) {
        void cleanup();
      }
    } catch (_err) {
      logger.debug({ userId }, 'Keepalive failed, cleaning up');
      void cleanup();
    }
  }, KEEPALIVE_INTERVAL);

  // Start idle timeout monitoring
  resetIdleTimeout();

  // Clean up on error
  req.on('error', async err => {
    // Ignore expected connection errors (client disconnect, aborted, etc.)
    const isExpectedError =
      err.code === 'ECONNRESET' ||
      err.code === 'EPIPE' ||
      err.code === 'ECONNABORTED' ||
      err.message === 'aborted' ||
      err.message?.includes('aborted') ||
      err.message?.includes('socket hang up');

    if (!isExpectedError) {
      logger.warn({ userId, err: err.message, code: err.code }, 'Unexpected request error, cleaning up');
    } else {
      logger.debug({ userId, code: err.code }, 'Client disconnected (expected), cleaning up');
    }
    await cleanup();
  });

  // Handle response errors
  res.on('error', async err => {
    logger.debug({ userId, err: err.message }, 'Response error, cleaning up');
    await cleanup();
  });

  // Handle response finish
  res.on('finish', () => {
    logger.debug({ userId }, 'Response finished');
    void cleanup();
  });
}

module.exports = {
  streamFileEvents,
};
