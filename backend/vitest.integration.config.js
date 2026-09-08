import path from 'path';
import { fileURLToPath } from 'url';

import dotenv from 'dotenv';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const abs = rel => path.resolve(__dirname, rel).replace(/\\/g, '/');

// The unit suite runs against in-memory doubles. This one talks to the real
// Postgres and Redis from the project .env, so the connection details have to
// be loaded here — nothing in the module graph calls dotenv except server.js.
const { parsed = {} } = dotenv.config({ path: path.join(__dirname, '..', '.env'), processEnv: {} });

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^(?:\.\.\/)+utils\/s3Storage\.js$|^\.\/s3Storage\.js$/,
        replacement: abs('tests/mocks/storage.mock.js'),
      },
    ],
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/integration-db/**/*.test.js'],
    setupFiles: ['tests/integration-db/setup.js'],
    // One worker, one connection pool, one shared database. Tests truncate
    // between cases, so they must not interleave.
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
    restoreMocks: true,
    env: {
      ...parsed,

      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      LOG_FORMAT: 'json',

      // A database of its own, so the working dev data is never truncated.
      DB_NAME: 'tma_cloud_test',
      // A Redis database of its own, so flushing cannot clear dev sessions.
      REDIS_DB: '15',

      // Isolated bucket double; nothing is written to a real bucket.
      RUSTFS_ENDPOINT: 'http://127.0.0.1:9000',
      RUSTFS_BUCKET: 'tma-test',
      RUSTFS_ACCESS_KEY: 'test-key',
      RUSTFS_SECRET_KEY: 'test-secret',

      // Deterministic, and unrelated to the key protecting real dev files.
      FILE_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      JWT_SECRET: 'integration-test-jwt-secret',
      SESSION_IDLE_DAYS: '30',
      BACKEND_URL: 'https://cloud.test',

      // Google OAuth off, so the login controller takes the password path.
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      GOOGLE_REDIRECT_URI: '',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage-integration',
      include: ['controllers/**', 'middleware/**', 'models/**', 'services/**', 'utils/**'],
      exclude: ['**/node_modules/**', 'tests/**', 'scripts/**'],
    },
  },
});
