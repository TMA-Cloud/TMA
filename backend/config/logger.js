const pino = require('pino');
const pinoHttp = require('pino-http');
const { getRequestId, getUserId } = require('../middleware/requestId.middleware');
const os = require('os');

const isDevelopment = process.env.NODE_ENV !== 'production';
// Default to 'info' in all envs so development is not spammy; set LOG_LEVEL=debug if needed
const logLevel = process.env.LOG_LEVEL || 'info';
const logFormat = process.env.LOG_FORMAT || (isDevelopment ? 'pretty' : 'json');

/**
 * Mask sensitive string values (show first/last few characters)
 * @param {string} value - The sensitive value to mask
 * @returns {string} Masked value
 */
function maskSecret(value) {
  if (!value || typeof value !== 'string') return '[REDACTED]';

  const len = value.length;
  if (len <= 8) return '***';

  // Show first 4 and last 4 characters for long values
  const start = value.slice(0, 4);
  const end = value.slice(-4);
  return `${start}${'*'.repeat(Math.min(20, len - 8))}${end}`;
}

/**
 * Mask JWT tokens (show header and signature parts partially)
 * @param {string} token - The JWT token
 * @returns {string} Masked token
 */
function maskJWT(token) {
  if (!token || typeof token !== 'string') return '[REDACTED]';

  const parts = token.split('.');
  if (parts.length !== 3) return maskSecret(token);

  // Mask the payload entirely, show partial header and signature
  return `${parts[0].slice(0, 8)}...***...${parts[2].slice(-8)}`;
}

/**
 * Mask cookie header (show cookie names but hide values)
 * Handles both request cookies (Cookie: a=1; b=2) and response cookies (Set-Cookie: a=1; HttpOnly)
 * @param {string} cookieStr - The cookie string
 * @returns {string} Masked cookie
 */
function maskCookie(cookieStr) {
  if (!cookieStr || typeof cookieStr !== 'string') return '[REDACTED]';

  // Common Set-Cookie options (these should not be masked)
  const cookieOptions = [
    'path',
    'domain',
    'expires',
    'max-age',
    'secure',
    'httponly',
    'samesite',
    'partitioned',
    'priority',
  ];

  // Split by semicolon and process each part
  const parts = cookieStr.split(';').map(part => part.trim());

  const maskedParts = parts.map(part => {
    // Check if this part contains an equals sign
    const equalsIndex = part.indexOf('=');

    if (equalsIndex === -1) {
      // No equals sign - this is a flag option like "HttpOnly" or "Secure"
      return part;
    }

    const name = part.slice(0, equalsIndex).trim();
    const value = part.slice(equalsIndex + 1).trim();

    // Check if this is a known cookie option (case-insensitive)
    const isOption = cookieOptions.includes(name.toLowerCase());

    if (isOption) {
      // This is an option like "Path=/", "Max-Age=604800" - don't mask
      return part;
    }

    // This is a cookie value - mask it
    if (!value) return part;

    const maskedValue = value.includes('.') ? maskJWT(value) : maskSecret(value);
    return `${name}=${maskedValue}`;
  });

  return maskedParts.join('; ');
}

/**
 * Mask authorization header (show type and partial token)
 * @param {string} authHeader - The authorization header
 * @returns {string} Masked authorization
 */
function maskAuthorization(authHeader) {
  if (!authHeader || typeof authHeader !== 'string') return '[REDACTED]';

  const parts = authHeader.split(' ');
  if (parts.length === 2) {
    // "Bearer token" format
    const [type, token] = parts;
    return `${type} ${token.includes('.') ? maskJWT(token) : maskSecret(token)}`;
  }

  return maskSecret(authHeader);
}

/**
 * Base pino logger configuration
 *
 * Features:
 * - JSON output in production, pretty-print in development
 * - Automatic redaction of sensitive fields
 * - Includes service name, environment, hostname
 * - Integrates with CLS for automatic requestId/userId inclusion
 */
const baseLoggerOptions = {
  level: logLevel,

  // Base fields included in every log entry
  base: {
    service: 'cloud-storage-api',
    environment: process.env.NODE_ENV || 'development',
    hostname: os.hostname(),
  },

  // Redact sensitive data from logs - mask instead of remove
  redact: {
    paths: [
      // Request body fields
      'req.body.password',
      'req.body.token',
      'req.body.secret',
      'req.body.access_token',
      'req.body.refresh_token',
      'req.body.accessToken',
      'req.body.refreshToken',
      'req.body.jwt',
      'req.body.apiKey',
      'req.body.api_key',
      'req.body.client_secret',
      'req.body.clientSecret',

      // Request query parameters
      'req.query.token',
      'req.query.secret',
      'req.query.key',
      'req.query.code',
      'req.query.access_token',
      'req.query.api_key',

      // Wildcard patterns for any nested fields
      '*.password',
      '*.secret',
      '*.connectionString',
      '*.DB_PASSWORD',
      '*.JWT_SECRET',
      '*.GOOGLE_CLIENT_SECRET',
      '*.ONLYOFFICE_JWT_SECRET',
    ],
    censor: '[REDACTED]', // Replace with this string
  },

  // Pretty-print logs if LOG_FORMAT=pretty (default in development)
  // Use JSON format if LOG_FORMAT=json (default in production)
  transport:
    logFormat === 'pretty'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'yyyy-mm-dd HH:MM:ss.l',
            ignore: 'pid,hostname',
            singleLine: false,
          },
        }
      : undefined,

  // Custom serializers for request/response objects with sensitive data masking
  serializers: {
    req: req => {
      const headers = { ...req.headers };

      // Mask sensitive request headers
      if (headers.authorization) {
        headers.authorization = maskAuthorization(headers.authorization);
      }
      if (headers.cookie) {
        headers.cookie = maskCookie(headers.cookie);
      }
      if (headers['x-api-key']) {
        headers['x-api-key'] = maskSecret(headers['x-api-key']);
      }
      if (headers['x-auth-token']) {
        headers['x-auth-token'] = maskSecret(headers['x-auth-token']);
      }
      if (headers['api-key']) {
        headers['api-key'] = maskSecret(headers['api-key']);
      }

      return {
        id: req.id,
        method: req.method,
        url: req.url,
        query: req.query,
        params: req.params,
        headers,
        remoteAddress: req.ip || req.socket?.remoteAddress,
        remotePort: req.socket?.remotePort,
      };
    },
    res: res => {
      const headers = res.getHeaders ? { ...res.getHeaders() } : {};

      // Mask sensitive response headers
      if (headers['set-cookie']) {
        // set-cookie can be an array or string
        if (Array.isArray(headers['set-cookie'])) {
          headers['set-cookie'] = headers['set-cookie'].map(maskCookie);
        } else {
          headers['set-cookie'] = maskCookie(headers['set-cookie']);
        }
      }
      if (headers.authorization) {
        headers.authorization = maskAuthorization(headers.authorization);
      }

      return {
        statusCode: res.statusCode,
        headers,
      };
    },
    err: pino.stdSerializers.err,
  },

  // Mix-in function to automatically include requestId and userId from CLS
  mixin() {
    const requestId = getRequestId();
    const userId = getUserId();
    const context = {};

    if (requestId) context.requestId = requestId;
    if (userId) context.userId = userId;

    return context;
  },
};

/**
 * Main application logger
 *
 * Usage:
 *   const logger = require('./config/logger').logger;
 *   logger.info('Server started');
 *   logger.error({ err }, 'Failed to process request');
 */
const logger = pino(baseLoggerOptions);

/**
 * HTTP request logger middleware (pino-http)
 *
 * Automatically logs all HTTP requests and responses with:
 * - Request method, URL, headers
 * - Response status code
 * - Request duration
 * - Automatic requestId from CLS
 *
 * Usage:
 *   app.use(httpLogger);
 */
const httpLogger = pinoHttp({
  logger,

  // Generate request ID from CLS context
  genReqId: req => req.requestId || getRequestId(),

  // Custom serializers for pino-http (overrides default serializers)
  serializers: {
    req: req => {
      const headers = { ...req.headers };

      // Mask sensitive request headers
      if (headers.authorization) {
        headers.authorization = maskAuthorization(headers.authorization);
      }
      if (headers.cookie) {
        headers.cookie = maskCookie(headers.cookie);
      }
      if (headers['x-api-key']) {
        headers['x-api-key'] = maskSecret(headers['x-api-key']);
      }
      if (headers['x-auth-token']) {
        headers['x-auth-token'] = maskSecret(headers['x-auth-token']);
      }
      if (headers['api-key']) {
        headers['api-key'] = maskSecret(headers['api-key']);
      }

      return {
        id: req.id,
        method: req.method,
        url: req.url,
        query: req.query,
        params: req.params,
        headers,
        remoteAddress: req.ip || req.socket?.remoteAddress,
        remotePort: req.socket?.remotePort,
      };
    },
    res: res => {
      const headers = res.getHeaders ? { ...res.getHeaders() } : {};

      // Mask sensitive response headers
      if (headers['set-cookie']) {
        // set-cookie can be an array or string
        if (Array.isArray(headers['set-cookie'])) {
          headers['set-cookie'] = headers['set-cookie'].map(maskCookie);
        } else {
          headers['set-cookie'] = maskCookie(headers['set-cookie']);
        }
      }
      if (headers.authorization) {
        headers.authorization = maskAuthorization(headers.authorization);
      }

      return {
        statusCode: res.statusCode,
        headers,
      };
    },
    err: pino.stdSerializers.err,
  },

  // Custom log message format
  customLogLevel: (req, res, err) => {
    if (res.statusCode >= 500 || err) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },

  // Custom success message
  customSuccessMessage: (req, res) => {
    return `${req.method} ${req.url} ${res.statusCode}`;
  },

  // Custom error message
  customErrorMessage: (req, res, err) => {
    return `${req.method} ${req.url} ${res.statusCode} - ${err.message}`;
  },

  // Additional fields to include in HTTP logs
  customAttributeKeys: {
    req: 'request',
    res: 'response',
    err: 'error',
    responseTime: 'duration',
  },

  // Don't log health checks or static assets to reduce noise
  // Note: ignore() only receives req, not res, so we can't check status codes here
  // Errors are still logged explicitly in the webhook handler (server.js)
  autoLogging: {
    ignore: req => {
      if (req.url === '/health') return true;
      if (req.url === '/favicon.ico') return true;
      if (req.url.startsWith('/assets/')) return true;
      return false;
    },
  },
});

/**
 * Create a child logger with additional context
 *
 * Usage:
 *   const logger = createRequestLogger({ component: 'file-controller', action: 'upload' });
 *   logger.info({ fileId: 'abc123' }, 'File uploaded');
 *
 * @param {Object} bindings - Additional fields to include in all logs from this logger
 * @returns {Object} A pino child logger
 */
function createRequestLogger(bindings = {}) {
  return logger.child(bindings);
}

module.exports = {
  logger,
  httpLogger,
  createRequestLogger,
  // Export masking utilities for reuse
  maskSecret,
  maskJWT,
  maskCookie,
  maskAuthorization,
};
