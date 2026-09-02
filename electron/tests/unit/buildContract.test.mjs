/*
 * Packaging contract.
 *
 * The installer is built by prepare-client-build.js (copy src/, patch the two
 * embedded URLs) and electron-builder configs that name specific directories.
 * Nothing at runtime catches a rename or a changed literal — the app just ships
 * with an empty server URL or a missing filesystem host. These tests pin the
 * couple of strings and paths that the build steps agree on.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const electronDir = path.join(import.meta.dirname, '..', '..');

const read = relative => fs.readFileSync(path.join(electronDir, relative), 'utf8');
const readJson = relative => JSON.parse(read(relative));

const packageJson = readJson('package.json');
const prepareScript = read('scripts/prepare-client-build.js');
const configSource = read('src/main/config.cjs');

describe('URL embedding', () => {
  it('leaves both embedded URLs blank in source, so a dev build reads build-config.json', () => {
    expect(configSource).toContain("const EMBEDDED_SERVER_URL = '';");
    expect(configSource).toContain("const EMBEDDED_UPDATOR_URL = '';");
  });

  it('patches exactly the declarations the source still contains', () => {
    const patterns = [/const EMBEDDED_SERVER_URL = '';/, /const EMBEDDED_UPDATOR_URL = '';/];
    for (const pattern of patterns) {
      expect(prepareScript).toContain(pattern.source.replace(/\\/g, ''));
      expect(pattern.test(configSource)).toBe(true);
    }
  });

  it('stages the main process and preload into dist-electron', () => {
    expect(prepareScript).toContain("path.join(distDir, 'main')");
    expect(prepareScript).toContain("path.join(distDir, 'preload')");
    expect(prepareScript).toContain("path.join(distDir, 'main', 'config.cjs')");
  });

  it('keeps a build-config example so the URL is never guessed', () => {
    const example = readJson('src/config/build-config.example.json');
    expect(Object.keys(example).sort()).toEqual(['serverUrl', 'updatorUrl']);
  });
});

describe('entry points', () => {
  it('points package.json at a main process file that exists', () => {
    expect(packageJson.main).toBe('src/main/index.cjs');
    expect(fs.existsSync(path.join(electronDir, packageJson.main))).toBe(true);
  });

  it('ships the preload script the main process loads', () => {
    expect(fs.existsSync(path.join(electronDir, 'src', 'preload', 'index.cjs'))).toBe(true);
  });

  it('declares the runtime dependency the MIME table needs', () => {
    expect(packageJson.dependencies).toHaveProperty('mime-types');
  });
});

describe('electron-builder configuration', () => {
  const configs = [
    'src/build/electron-builder.client.json',
    'src/build/electron-builder.client.portable.json',
    'src/build/electron-builder.client.unpacked.json',
  ];

  it.each(configs)('%s packages the staged output and points main at it', name => {
    const config = readJson(name);
    expect(config.files).toContain('dist-electron/**/*');
    expect(config.extraMetadata.main).toBe('dist-electron/main/index.cjs');
  });

  it.each(configs)('%s bundles the cloud drive host as an extra resource', name => {
    const config = readJson(name);
    expect(config.extraResources).toContainEqual({ from: 'clouddrive-dist', to: 'clouddrive' });
  });

  it.each(configs)('%s keeps the stable application id that owns the user data folder', name => {
    expect(readJson(name).appId).toBe('com.tmacloud.app');
  });

  it('stages the host where the packaged app looks for it', () => {
    const buildScript = read('scripts/build-clouddrive.js');
    expect(buildScript).toContain("path.join(electronDir, 'clouddrive-dist')");
    expect(buildScript).toContain('TmaCloudFs.exe');
    // The runtime resolves resources/clouddrive/TmaCloudFs.exe (in the host locator).
    expect(read('src/main/clouddrive/locate.cjs')).toContain(
      "path.join(process.resourcesPath, 'clouddrive', 'TmaCloudFs.exe')"
    );
  });

  it('verifies the WinFsp download against a pinned hash before bundling it', () => {
    const buildScript = read('scripts/build-clouddrive.js');
    expect(buildScript).toMatch(/sha256:\s*'[0-9a-f]{64}'/);
    expect(buildScript).toContain('WinFsp MSI hash mismatch');
  });

  it('installs WinFsp from the location the build stages it to', () => {
    const installer = read('src/build/installer.nsh');
    expect(installer).toContain('$INSTDIR\\resources\\clouddrive\\winfsp.msi');
  });
});

describe('scripts', () => {
  it('runs staging, the cloud drive build and electron-builder in that order', () => {
    expect(packageJson.scripts['build:client']).toMatch(
      /prepare-client-build\.js.*build-clouddrive\.js.*electron-builder/
    );
  });

  it('exposes the test commands the CI workflow calls', () => {
    expect(packageJson.scripts.test).toBe('vitest run');
    expect(packageJson.scripts['test:coverage']).toBe('vitest run --coverage');
    expect(packageJson.scripts.lint).toBe('eslint .');
    expect(packageJson.scripts['format:check']).toBe('prettier --check .');
  });
});
