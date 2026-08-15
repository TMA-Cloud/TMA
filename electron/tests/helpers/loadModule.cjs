/*
 * Fresh-require helper.
 *
 * The main-process modules are CommonJS, so Node caches them and they capture
 * their dependencies (`spawn`, handler registrations, module-level state) at
 * first require. Tests that need a module to pick up a fresh spy — or to start
 * from clean module state — load it through here instead.
 */
'use strict';

const path = require('path');

const electronRoot = path.join(__dirname, '..', '..');

/**
 * Require a module by its path relative to electron/, bypassing the cache.
 * @param {string} relativePath e.g. 'src/main/clouddrive.cjs'
 */
function freshRequire(relativePath) {
  const resolved = require.resolve(path.join(electronRoot, relativePath));
  delete require.cache[resolved];
  return require(resolved);
}

module.exports = { freshRequire };
