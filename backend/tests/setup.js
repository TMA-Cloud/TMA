/**
 * Global test setup: runs before every test file's module graph is loaded.
 */

import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach } from 'vitest';

import { resetDbMock } from './mocks/db.mock.js';
import { resetRedisMock } from './mocks/redis.mock.js';

// config/paths.js reads UPLOAD_DIR at import time, so the directory has to
// exist before any storage module is touched.
const uploadDir = process.env.UPLOAD_DIR || path.join(process.cwd(), 'tests', '.tmp', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

beforeEach(() => {
  resetDbMock();
  resetRedisMock();
});

afterEach(() => {
  resetDbMock();
  resetRedisMock();
});
