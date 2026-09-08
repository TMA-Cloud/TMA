import path from 'path';
import { fileURLToPath } from 'url';

import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path with forward slashes, which is what Vite's resolver wants on Windows. */
const abs = rel => path.resolve(__dirname, rel).replace(/\\/g, '/');

export default defineConfig({
  resolve: {
    // Infrastructure modules open a real pg pool / Redis socket the moment they
    // are imported. Swap them for in-memory doubles across the whole module
    // graph so importing a controller never touches the network.
    //
    // The patterns match every relative depth a module might use
    // ('../config/db.js', '../../config/db.js', ...).
    alias: [
      { find: /^(?:\.\.\/)+config\/db\.js$/, replacement: abs('tests/mocks/db.mock.js') },
      { find: /^(?:\.\.\/)+config\/redis\.js$/, replacement: abs('tests/mocks/redis.mock.js') },
    ],
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.js'],
    // These talk to a real database, cache and object store, and have their own
    // configs (vitest.integration.config.js, vitest.s3.config.js). Running them
    // here would point them at the in-memory doubles.
    exclude: ['tests/integration-db/**', 'tests/integration-s3/**', '**/node_modules/**'],
    setupFiles: ['tests/setup.js'],
    // A handful of suites drive real streams and crypto; give them room without
    // letting a genuinely hung test block the run forever.
    testTimeout: 15000,
    hookTimeout: 15000,
    restoreMocks: true,
    clearMocks: true,
    // Env is applied before any module in the graph is evaluated, which matters
    // because several modules read process.env at import time (JWT_SECRET,
    // storage configuration, SESSION_IDLE_DAYS).
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      LOG_FORMAT: 'json',
      JWT_SECRET: 'test-jwt-secret-do-not-use-in-production',
      // 64 hex chars = a 32-byte key, taking the hex branch of getEncryptionKey().
      FILE_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      SESSION_IDLE_DAYS: '30',
      RUSTFS_ENDPOINT: 'http://127.0.0.1:9000',
      RUSTFS_BUCKET: 'tma-test',
      RUSTFS_ACCESS_KEY: 'test-key',
      RUSTFS_SECRET_KEY: 'test-secret',
      BACKEND_URL: 'https://cloud.example.com',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['controllers/**', 'middleware/**', 'models/**', 'services/**', 'utils/**'],
      exclude: ['**/node_modules/**', 'tests/**', 'scripts/**'],
    },
  },
});
