/**
 * Rate limiting middleware to prevent brute force attacks
 */

// Simple in-memory rate limiter (for production, consider using Redis)
const rateLimitStore = new Map();

/**
 * Cleans up old entries from rate limit store
 */
function cleanupRateLimitStore() {
  const now = Date.now();
  for (const [key, data] of rateLimitStore.entries()) {
    if (now > data.resetTime) {
      rateLimitStore.delete(key);
    }
  }
}

// Clean up every 5 minutes
setInterval(cleanupRateLimitStore, 5 * 60 * 1000);

/**
 * Creates a rate limiter middleware
 * @param {Object} options - Rate limit options
 * @param {number} options.windowMs - Time window in milliseconds
 * @param {number} options.max - Maximum number of requests per window
 * @param {Function} options.keyGenerator - Function to generate rate limit key
 * @returns {Function} Express middleware
 */
function createRateLimiter({ windowMs = 15 * 60 * 1000, max = 100, keyGenerator = req => req.ip }) {
  return (req, res, next) => {
    const key = keyGenerator(req);
    const now = Date.now();

    const record = rateLimitStore.get(key);

    if (!record || now > record.resetTime) {
      // Create new record
      rateLimitStore.set(key, {
        count: 1,
        resetTime: now + windowMs,
      });
      return next();
    }

    // Increment count
    record.count++;

    if (record.count > max) {
      return res.status(429).json({
        error: 'Too many requests, please try again later',
      });
    }

    next();
  };
}

/**
 * Rate limiter for authentication endpoints (stricter)
 */
const authRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts per 15 minutes
  keyGenerator: req => {
    // Use IP + email if available for login/signup
    const email = req.body?.email || '';
    return `auth:${req.ip}:${email}`;
  },
});

/**
 * Rate limiter for general API endpoints
 */
const apiRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per 15 minutes
  keyGenerator: req => `api:${req.ip}`,
});

/**
 * Rate limiter for file upload endpoints
 */
const uploadRateLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 50, // 50 uploads per hour
  keyGenerator: req => `upload:${req.userId || req.ip}`,
});

module.exports = {
  createRateLimiter,
  authRateLimiter,
  apiRateLimiter,
  uploadRateLimiter,
};
