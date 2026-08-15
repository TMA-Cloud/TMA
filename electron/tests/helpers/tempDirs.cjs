/*
 * Temp-directory helpers.
 *
 * The main process writes staging, paste and edit directories under
 * os.tmpdir(). Pointing os.tmpdir() at a per-test sandbox keeps those writes
 * out of the real temp folder and makes cleanup assertions deterministic.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const created = new Set();

/** Create an isolated directory that afterEach will remove. */
function createTempRoot(prefix = 'tma-cloud-tests-') {
  const dir = path.join(os.tmpdir(), `${prefix}${crypto.randomBytes(8).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  created.add(dir);
  return dir;
}

/**
 * Point os.tmpdir() at a fresh sandbox for the duration of the test.
 * @param {import('vitest').VitestUtils} vi
 * @returns {string} the sandbox path
 */
function redirectTmpdir(vi) {
  const root = createTempRoot();
  vi.spyOn(os, 'tmpdir').mockReturnValue(root);
  return root;
}

/** Write a file (creating parents) and return its path. */
function writeFile(dir, name, contents = 'x') {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, contents);
  return filePath;
}

function removeAllTempDirs() {
  for (const dir of created) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a handle may still be open on Windows; the OS reclaims it later */
    }
  }
  created.clear();
}

module.exports = { createTempRoot, redirectTmpdir, writeFile, removeAllTempDirs };
