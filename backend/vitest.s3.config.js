import path from 'path';
import { fileURLToPath } from 'url';

import dotenv from 'dotenv';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The database connection from .env, read here because nothing in the module
// graph calls dotenv except server.js. The bucket is the one saved in Settings.
const { parsed = {} } = dotenv.config({ path: path.join(__dirname, '..', '.env'), processEnv: {} });

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/integration-s3/**/*.test.js'],
    // Object storage is a network round trip per operation.
    testTimeout: 60000,
    hookTimeout: 60000,
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
    env: {
      ...parsed,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',

      // FILE_ENCRYPTION_KEY stays the real one: it decrypts the saved bucket secret.
      JWT_SECRET: 'integration-test-jwt-secret',
    },
  },
});
