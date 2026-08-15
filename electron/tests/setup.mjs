/*
 * Shared setup.
 *
 * The main process is CommonJS and reaches Electron through `require('electron')`,
 * which Node resolves to the real package (a path to the binary) outside an
 * Electron runtime — every destructured API would be undefined. Patching
 * Module._load is what makes those requires land on the double instead; a Vite
 * alias cannot do it because Vite never rewrites CommonJS require calls.
 *
 * The double is also reset before every test so registrations, routes and
 * dialog results never leak between cases.
 */
import Module from 'module';

import { afterEach, beforeEach } from 'vitest';

import electron from './mocks/electron.mock.mjs';
import tempDirs from './helpers/tempDirs.cjs';
import platform from './helpers/platform.cjs';

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return electron;
  return originalLoad.call(this, request, parent, isMain);
};

beforeEach(() => {
  electron.__mock.reset();
});

afterEach(() => {
  platform.restorePlatform();
  tempDirs.removeAllTempDirs();
});
