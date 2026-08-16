import { describe, expect, it } from 'vitest';

import config from '../../src/main/config.cjs';
import { useBuildConfig, useCorruptBuildConfig } from '../helpers/buildConfig.cjs';

const { getServerUrl, getUpdatorUrl, noServerUrlPage, loadingPage, serverErrorPage, themeBackground } = config;

/** The pages are data: URLs; tests read the document back out of them. */
const html = dataUrl => decodeURIComponent(dataUrl.split(',').slice(1).join(','));

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
    expect(noServerUrlPage('dark').startsWith('data:text/html;charset=utf-8,')).toBe(true);
    expect(html(noServerUrlPage('dark'))).toContain('Server URL not configured');
  });

  it('serves the loading splash as a self-contained data URL', () => {
    expect(loadingPage('dark').startsWith('data:text/html;charset=utf-8,')).toBe(true);
    expect(html(loadingPage('dark'))).toContain('TMA Cloud');
  });

  it('shows the configured server on the connection error page', () => {
    const doc = html(serverErrorPage('https://cloud.example.com', 'dark'));
    expect(doc).toContain('Could not connect to the server');
    expect(doc).toContain('https://cloud.example.com');
  });

  it('escapes the characters that could open a tag or break out of an attribute', () => {
    const doc = html(serverErrorPage('https://evil"<script>alert(1)</script>', 'dark'));
    // Escaping "<" is what makes the payload inert; the trailing ">" is left
    // alone because it cannot start a tag on its own.
    expect(doc).not.toContain('<script>');
    expect(doc).toContain('&lt;script>');
    expect(doc).toContain('&quot;');
  });
});

describe('chrome theming', () => {
  // The values these assert are the frontend's own tokens (frontend/src/index.css):
  // --canvas / --label / --accent in each theme.
  it('paints the dark chrome on the app canvas, not a blue-grey of its own', () => {
    const doc = html(loadingPage('dark'));
    expect(doc).toContain('background:#1b1b19');
    expect(doc).toContain('color:#f5f4f1');
    expect(doc).toContain('#0a84ff');
    expect(doc).toContain('color-scheme" content="dark');
  });

  it('paints the light chrome when that is the theme the app was last in', () => {
    const doc = html(loadingPage('light'));
    expect(doc).toContain('background:#f3f3f0');
    expect(doc).toContain('color:#131313');
    expect(doc).toContain('#007aff');
    expect(doc).toContain('color-scheme" content="light');
  });

  it('themes the error page too, so a failed launch still looks like the app', () => {
    expect(html(serverErrorPage('https://cloud.example.com', 'light'))).toContain('background:#f3f3f0');
    expect(html(serverErrorPage('https://cloud.example.com', 'dark'))).toContain('background:#1b1b19');
  });

  it('falls back to dark for an unknown theme, matching the web app default', () => {
    expect(themeBackground(undefined)).toBe('#1b1b19');
    expect(themeBackground('nonsense')).toBe('#1b1b19');
    expect(themeBackground('light')).toBe('#f3f3f0');
  });
});
