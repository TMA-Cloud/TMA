import path from 'path';
import { fileURLToPath } from 'url';

import dotenv from 'dotenv';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Same credentials the app uses, read here because nothing in the module graph
// calls dotenv except server.js.
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
      LOG_FORMAT: 'json',

      FILE_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      JWT_SECRET: 'integration-test-jwt-secret',
    },
  },
});
