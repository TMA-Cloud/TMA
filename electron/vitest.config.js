const path = require('path');

const { defineConfig } = require('vitest/config');

/** Absolute path with forward slashes, which is what Vite's resolver wants on Windows. */
const abs = rel => path.resolve(__dirname, rel).replace(/\\/g, '/');

module.exports = defineConfig({
  resolve: {
    // The main process modules `require('electron')` at import time, which only
    // resolves inside a real Electron runtime. Swap it for an in-memory double
    // across the whole module graph so the suite runs under plain Node.
    alias: [{ find: /^electron$/, replacement: abs('tests/mocks/electron.mock.mjs') }],
  },
  test: {
    environment: 'node',
    globals: false,
    // Test files are ESM (.mjs) because Vitest's API cannot be require()d,
    // while the modules under test stay CommonJS as the Electron main process
    // needs them.
    include: ['tests/**/*.test.mjs'],
    exclude: ['**/node_modules/**'],
    setupFiles: ['tests/setup.mjs'],
    restoreMocks: true,
    clearMocks: true,
    // A few suites drive real temp-directory I/O and child processes.
    testTimeout: 15000,
    hookTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/main/**', 'src/preload/**'],
      exclude: ['**/node_modules/**', 'tests/**', 'scripts/**'],
    },
  },
});
