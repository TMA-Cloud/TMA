import { describe, expect, it } from 'vitest';

import config from '../../src/main/config.cjs';
import { useBuildConfig, useCorruptBuildConfig } from '../helpers/buildConfig.cjs';

const { getServerUrl, getUpdatorUrl, NO_SERVER_URL_PAGE, LOADING_PAGE, serverErrorPage } = config;

describe('getServerUrl', () => {
  it('reads serverUrl from build-config.json when nothing is embedded', () => {
    useBuildConfig({ serverUrl: 'https://cloud.example.com' });
    expect(getServerUrl()).toBe('https://cloud.example.com');
  });

  it('returns null when no build config exists, so the app shows the setup page', () => {
    useBuildConfig(null);
    expect(getServerUrl()).toBeNull();
  });

  it('returns null instead of throwing when the config file is corrupt', () => {
    useCorruptBuildConfig();
    expect(getServerUrl()).toBeNull();
  });

  it('treats an empty serverUrl as unconfigured', () => {
    useBuildConfig({ serverUrl: '' });
    expect(getServerUrl()).toBeNull();
  });

  it('picks up a config change without restarting, since it is read per call', () => {
    useBuildConfig({ serverUrl: 'https://first.example.com' });
    expect(getServerUrl()).toBe('https://first.example.com');
    useBuildConfig({ serverUrl: 'https://second.example.com' });
    expect(getServerUrl()).toBe('https://second.example.com');
  });
});

describe('getUpdatorUrl', () => {
  it('trims surrounding whitespace so the installer URL joins cleanly', () => {
    useBuildConfig({ serverUrl: 'https://cloud.example.com', updatorUrl: '  https://updates.example.com  ' });
    expect(getUpdatorUrl()).toBe('https://updates.example.com');
  });

  it('returns null when updatorUrl is absent, which disables in-app updates', () => {
    useBuildConfig({ serverUrl: 'https://cloud.example.com' });
    expect(getUpdatorUrl()).toBeNull();
  });

  it('returns null when updatorUrl is not a string', () => {
    useBuildConfig({ serverUrl: 'https://cloud.example.com', updatorUrl: 42 });
    expect(getUpdatorUrl()).toBeNull();
  });

  it('returns null when there is no build config at all', () => {
    useBuildConfig(null);
    expect(getUpdatorUrl()).toBeNull();
  });
});

describe('built-in pages', () => {
  it('serves the setup notice as a self-contained data URL', () => {
    expect(NO_SERVER_URL_PAGE.startsWith('data:text/html')).toBe(true);
    expect(NO_SERVER_URL_PAGE).toContain('Server URL not configured');
  });

  it('serves the loading splash as a self-contained data URL', () => {
    expect(LOADING_PAGE.startsWith('data:text/html;charset=utf-8,')).toBe(true);
    expect(decodeURIComponent(LOADING_PAGE.split(',')[1])).toContain('TMA Cloud');
  });

  it('shows the configured server on the connection error page', () => {
    const html = decodeURIComponent(serverErrorPage('https://cloud.example.com').split(',')[1]);
    expect(html).toContain('Could not connect to the server');
    expect(html).toContain('https://cloud.example.com');
  });

  it('escapes the characters that could open a tag or break out of an attribute', () => {
    const html = decodeURIComponent(serverErrorPage('https://evil"<script>alert(1)</script>').split(',')[1]);
    // Escaping "<" is what makes the payload inert; the trailing ">" is left
    // alone because it cannot start a tag on its own.
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script>');
    expect(html).toContain('&quot;');
  });
});
