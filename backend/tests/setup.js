/**
 * Global test setup: runs before every test file's module graph is loaded.
 */

import { afterEach, beforeEach } from 'vitest';

import { resetDbMock } from './mocks/db.mock.js';
import { resetRedisMock } from './mocks/redis.mock.js';

beforeEach(() => {
  resetDbMock();
  resetRedisMock();
});

afterEach(() => {
  resetDbMock();
  resetRedisMock();
});
