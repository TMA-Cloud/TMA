/**
 * Rate limiting middleware using express-rate-limit
 * Replaces custom implementation with industry-standard package
 */

const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

/**
 * Rate limiter for authentication endpoints (stricter)
 * 5 attempts per 15 minutes per IP/email combination
 */
const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts per window
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
  keyGenerator: req => {
    // Use IP + email if available for login/signup
    // Use ipKeyGenerator helper for IPv6 safety
    const ip = ipKeyGenerator(req.ip || req.socket?.remoteAddress || 'unknown');
    const email = req.body?.email || '';
    return `auth:${ip}:${email}`;
  },
  skip: req => {
    // Skip rate limiting for OPTIONS requests
    return req.method === 'OPTIONS';
  },
});

/**
 * Rate limiter for MFA verification endpoints (very strict)
 * 5 attempts per minute per IP/User to prevent DoS via CPU-intensive bcrypt operations
 */
const mfaRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // 5 attempts per minute
  message: { error: 'Too many MFA verification attempts, please try again in a minute' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => {
    const ip = ipKeyGenerator(req.ip || req.socket?.remoteAddress || 'unknown');
    // Use userId if authenticated, otherwise use IP
    const userId = req.userId || '';
    return `mfa:${ip}:${userId}`;
  },
  skip: req => req.method === 'OPTIONS',
});

/**
 * Rate limiter for general API endpoints
 * 100 requests per 15 minutes per IP
 */
const apiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => `api:${ipKeyGenerator(req.ip || req.socket?.remoteAddress || 'unknown')}`,
  skip: req => req.method === 'OPTIONS',
});

/**
 * Rate limiter for file upload endpoints
 * 50 uploads per hour per user/IP
 */
const uploadRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 50, // 50 uploads per hour
  message: { error: 'Too many uploads, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => {
    if (req.userId) {
      return `upload:${req.userId}`;
    }
    const ip = ipKeyGenerator(req.ip || req.socket?.remoteAddress || 'unknown');
    return `upload:${ip}`;
  },
  skip: req => req.method === 'OPTIONS',
});

/**
 * Rate limiter for SSE (Server-Sent Events) connections
 * Limits concurrent SSE connections per user to prevent resource exhaustion
 * Note: This is connection limiting, not request rate limiting
 */
const sseConnectionTracker = new Map(); // userId -> connection count

/**
 * Track and limit SSE connections per user
 * @param {number} maxConnectionsPerUser - Maximum concurrent connections per user (default: 3)
 */
function createSSEConnectionLimiter(maxConnectionsPerUser = 3) {
  return (req, res, next) => {
    // Only apply to authenticated requests with userId
    if (!req.userId) {
      return next();
    }

    const userId = req.userId;
    const currentConnections = sseConnectionTracker.get(userId) || 0;

    if (currentConnections >= maxConnectionsPerUser) {
      return res.status(429).json({
        error: 'Too many active connections. Please close other tabs or wait a moment.',
      });
    }

    // Increment connection count
    sseConnectionTracker.set(userId, currentConnections + 1);

    // Track connection cleanup
    const originalEnd = res.end;
    res.end = function (...args) {
      // Decrement on connection close
      const count = sseConnectionTracker.get(userId) || 0;
      if (count > 0) {
        sseConnectionTracker.set(userId, count - 1);
      } else {
        sseConnectionTracker.delete(userId);
      }
      return originalEnd.apply(this, args);
    };

    // Also handle connection errors
    req.on('close', () => {
      const count = sseConnectionTracker.get(userId) || 0;
      if (count > 0) {
        sseConnectionTracker.set(userId, count - 1);
      } else {
        sseConnectionTracker.delete(userId);
      }
    });

    next();
  };
}

// Clean up stale connection tracking (users who disconnected without cleanup)
setInterval(
  () => {
    // This is a safety net - the connection cleanup should handle this
    // But we'll keep it for edge cases
    for (const [userId, count] of sseConnectionTracker.entries()) {
      if (count <= 0) {
        sseConnectionTracker.delete(userId);
      }
    }
  },
  5 * 60 * 1000
); // Every 5 minutes

const sseConnectionLimiter = createSSEConnectionLimiter(3); // Max 3 concurrent SSE connections per user

module.exports = {
  authRateLimiter,
  mfaRateLimiter,
  apiRateLimiter,
  uploadRateLimiter,
  sseConnectionLimiter,
  createSSEConnectionLimiter,
};
