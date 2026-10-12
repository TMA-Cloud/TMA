/**
 * Connection URLs for Postgres (DATABASE_URL) and Redis (REDIS_URL).
 *
 * Postgres URLs are read with libpq's sslmode meanings, so the app, psql and
 * pg_dump all treat one URL the same way.
 */

import { parse, toClientConfig } from 'pg-connection-string';

/**
 * @param {string} name
 * @param {string | undefined} value
 * @returns {string}
 */
function requireUrl(name, value) {
  if (!value) throw new Error(`${name} is not set. See .env.example for the format.`);
  return value;
}

/**
 * A pg client config from a postgres:// URL, keeping every parameter pg knows
 * (sslmode, sslrootcert, application_name, options, connect_timeout, ...).
 * @param {string | undefined} url
 * @returns {import('pg').ClientConfig}
 */
function parseDatabaseUrl(url) {
  requireUrl('DATABASE_URL', url);
  // pg refuses the option and the URL parameter together, so the URL wins.
  const useLibpqCompat = !/[?&]uselibpqcompat=/i.test(url);
  const config = toClientConfig(parse(url, { useLibpqCompat }));
  if (!config.database) {
    throw new Error('DATABASE_URL must name a database: postgresql://user:password@host:5432/tma_cloud_storage');
  }
  return config;
}

/**
 * The Redis database index in a redis:// URL; 0 when the path is empty.
 * @param {string | undefined} url
 * @returns {number}
 */
function redisDatabase(url) {
  const index = new URL(requireUrl('REDIS_URL', url)).pathname.slice(1);
  return index ? Number(index) : 0;
}

/**
 * The same URL with another database: a name for Postgres, an index for Redis.
 * @param {string} url
 * @param {string} database
 * @returns {string}
 */
function withDatabase(url, database) {
  const parsed = new URL(url);
  parsed.pathname = `/${encodeURIComponent(database)}`;
  return parsed.toString();
}

/**
 * The same URL with another password, percent-encoded as the URL needs.
 * @param {string} url
 * @param {string} password
 * @returns {string}
 */
function withPassword(url, password) {
  const parsed = new URL(url);
  parsed.password = encodeURIComponent(password);
  return parsed.toString();
}

export { requireUrl, parseDatabaseUrl, redisDatabase, withDatabase, withPassword };
