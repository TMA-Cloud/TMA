/*
 * Build-config fixture helper.
 *
 * config.cjs reads <appPath>/src/config/build-config.json on every call, so a
 * test can control the configured server by writing a fixture and pointing the
 * electron double's app path at it. Without this the suite would silently pick
 * up the developer's own build-config.json.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// Goes through the same require('electron') hook the main process uses, so the
// helper and the code under test share one instance of the double.
const { __mock } = require('electron');
const { createTempRoot } = require('./tempDirs.cjs');

/**
 * Install a build-config.json and make app.getAppPath() resolve to it.
 * Pass `null` to install no config file at all.
 * @param {{serverUrl?: string, updatorUrl?: string} | null} config
 * @returns {string} the app root that was installed
 */
function useBuildConfig(config) {
  const appRoot = createTempRoot('tma-cloud-approot-');
  if (config !== null) {
    const dir = path.join(appRoot, 'src', 'config');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'build-config.json'), JSON.stringify(config));
  }
  __mock.setAppPath(appRoot);
  return appRoot;
}

/** Install a build-config.json whose contents are not valid JSON. */
function useCorruptBuildConfig() {
  const appRoot = createTempRoot('tma-cloud-approot-');
  const dir = path.join(appRoot, 'src', 'config');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'build-config.json'), '{ not json');
  __mock.setAppPath(appRoot);
  return appRoot;
}

const SERVER_URL = 'https://cloud.example.com';

module.exports = { useBuildConfig, useCorruptBuildConfig, SERVER_URL };
