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

      // A database of its own, so the working dev data is never truncated.
      DB_NAME: 'tma_cloud_test',
      // A Redis database of its own, so flushing cannot clear dev sessions.
      REDIS_DB: '15',

      // Deterministic, and unrelated to the key protecting real dev files.
      FILE_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      // Cleared so a key file named in .env cannot clash with the test key above.
      FILE_ENCRYPTION_KEY_FILE: '',
      JWT_SECRET: 'integration-test-jwt-secret',
      BACKEND_URL: 'https://cloud.test',
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
