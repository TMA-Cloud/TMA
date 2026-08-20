import { describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';

import { mockReq } from '../../helpers/http.js';

vi.mock('../../../models/user.model.js', () => ({
  getOnlyOfficeSettings: vi.fn(async () => ({ jwtSecret: 'oo-secret', url: 'https://oo.example.com' })),
  getUserById: vi.fn(async () => ({ name: 'Ada Lovelace', email: 'ada@example.com' })),
}));

const { getOnlyOfficeSettings, getUserById } = await import('../../../models/user.model.js');
const {
  buildOnlyofficeConfig,
  buildOnlyofficeUrls,
  buildSignedFileToken,
  getCallbackToken,
  getFileTypeFromName,
  getOnlyofficeJsUrl,
  getUserName,
  isMobileDevice,
  isOnlyOfficeSupported,
  resolveUiTheme,
  signConfigToken,
  verifyCallbackToken,
} = await import('../../../controllers/onlyoffice/onlyoffice.utils.js');

describe('isOnlyOfficeSupported', () => {
  it.each(['report.docx', 'sheet.xlsx', 'deck.pptx', 'legacy.doc', 'data.csv', 'notes.odt', 'manual.pdf'])(
    'accepts %s',
    name => {
      expect(isOnlyOfficeSupported(name)).toBe(true);
    }
  );

  it.each(['photo.png', 'archive.zip', 'video.mp4', 'script.js', 'README'])('rejects %s', name => {
    expect(isOnlyOfficeSupported(name)).toBe(false);
  });

  it('matches the extension case-insensitively', () => {
    expect(isOnlyOfficeSupported('REPORT.DOCX')).toBe(true);
  });

  it('uses only the final extension', () => {
    expect(isOnlyOfficeSupported('archive.docx.zip')).toBe(false);
    expect(isOnlyOfficeSupported('archive.zip.docx')).toBe(true);
  });

  it('handles missing names without throwing', () => {
    expect(isOnlyOfficeSupported('')).toBe(false);
    expect(isOnlyOfficeSupported(null)).toBe(false);
    expect(isOnlyOfficeSupported(undefined)).toBe(false);
  });
});

describe('getFileTypeFromName', () => {
  it('returns the lowercase extension without the dot', () => {
    expect(getFileTypeFromName('Report.DOCX')).toBe('docx');
  });

  it('falls back to docx when there is no extension', () => {
    expect(getFileTypeFromName('README')).toBe('docx');
    expect(getFileTypeFromName('')).toBe('docx');
    expect(getFileTypeFromName(null)).toBe('docx');
  });

  it('uses the final extension of a multi-dot name', () => {
    expect(getFileTypeFromName('backup.2024.xlsx')).toBe('xlsx');
  });
});

describe('getCallbackToken', () => {
  it('reads the token from the request body', () => {
    expect(getCallbackToken({ body: { token: 'abc' }, headers: {} })).toBe('abc');
  });

  it('falls back to the Bearer header', () => {
    expect(getCallbackToken({ body: {}, headers: { authorization: 'Bearer xyz' } })).toBe('xyz');
  });

  it('prefers the body token when both are present', () => {
    expect(getCallbackToken({ body: { token: 'body' }, headers: { authorization: 'Bearer header' } })).toBe('body');
  });

  it('returns null when neither carries a token', () => {
    expect(getCallbackToken({ body: {}, headers: {} })).toBeNull();
  });

  it('ignores a non-Bearer Authorization scheme', () => {
    expect(getCallbackToken({ body: {}, headers: { authorization: 'Basic dXNlcjpwYXNz' } })).toBeNull();
  });

  it('returns null for a Bearer header with nothing after the scheme', () => {
    expect(getCallbackToken({ body: {}, headers: { authorization: 'Bearer   ' } })).toBeNull();
  });

  it('ignores a non-string body token', () => {
    expect(getCallbackToken({ body: { token: 12345 }, headers: {} })).toBeNull();
  });
});

describe('verifyCallbackToken', () => {
  const SECRET = 'oo-secret';

  it('returns the payload for a validly signed callback', () => {
    const token = jwt.sign({ status: 2, key: 'owner-file-123' }, SECRET, { algorithm: 'HS256' });
    expect(verifyCallbackToken({ body: { token }, headers: {} }, SECRET)).toMatchObject({ status: 2 });
  });

  it('unwraps the nested payload used by header-mode tokens', () => {
    const token = jwt.sign({ payload: { status: 2, url: 'https://oo/x' } }, SECRET, { algorithm: 'HS256' });
    const decoded = verifyCallbackToken({ body: {}, headers: { authorization: `Bearer ${token}` } }, SECRET);
    expect(decoded).toMatchObject({ status: 2, url: 'https://oo/x' });
  });

  it('rejects a token signed with the wrong secret', () => {
    const forged = jwt.sign({ status: 2 }, 'attacker-secret', { algorithm: 'HS256' });
    expect(verifyCallbackToken({ body: { token: forged }, headers: {} }, SECRET)).toBeNull();
  });

  it('rejects an unsigned "alg: none" token', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ status: 2 })).toString('base64url');
    expect(verifyCallbackToken({ body: { token: `${header}.${body}.` }, headers: {} }, SECRET)).toBeNull();
  });

  it('rejects an expired token', () => {
    const token = jwt.sign({ status: 2 }, SECRET, { algorithm: 'HS256', expiresIn: -60 });
    expect(verifyCallbackToken({ body: { token }, headers: {} }, SECRET)).toBeNull();
  });

  it('returns null when there is no token at all', () => {
    expect(verifyCallbackToken({ body: {}, headers: {} }, SECRET)).toBeNull();
  });

  it('returns null for malformed input rather than throwing', () => {
    expect(verifyCallbackToken({ body: { token: 'garbage' }, headers: {} }, SECRET)).toBeNull();
  });
});

describe('buildSignedFileToken', () => {
  it('binds the token to both the file and the user', async () => {
    getOnlyOfficeSettings.mockResolvedValue({ jwtSecret: 'oo-secret', url: 'https://oo.example.com' });
    const token = await buildSignedFileToken('file000000000001', 'user000000000001');
    expect(jwt.verify(token, 'oo-secret', { algorithms: ['HS256'] })).toMatchObject({
      fileId: 'file000000000001',
      userId: 'user000000000001',
    });
  });

  it('expires quickly, since it is only needed for one document fetch', async () => {
    getOnlyOfficeSettings.mockResolvedValue({ jwtSecret: 'oo-secret', url: null });
    const decoded = jwt.decode(await buildSignedFileToken('f1', 'u1'));
    expect(decoded.exp - decoded.iat).toBe(600);
  });

  it('signs with HS256 only', async () => {
    getOnlyOfficeSettings.mockResolvedValue({ jwtSecret: 'oo-secret', url: null });
    const token = await buildSignedFileToken('f1', 'u1');
    expect(JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString()).alg).toBe('HS256');
  });

  it('returns null when OnlyOffice has no configured secret', async () => {
    getOnlyOfficeSettings.mockResolvedValue({ jwtSecret: null, url: null });
    expect(await buildSignedFileToken('f1', 'u1')).toBeNull();
  });
});

describe('signConfigToken', () => {
  it('signs the editor config with the configured secret', async () => {
    getOnlyOfficeSettings.mockResolvedValue({ jwtSecret: 'oo-secret', url: null });
    const token = await signConfigToken({ document: { title: 'x' } });
    expect(jwt.verify(token, 'oo-secret', { algorithms: ['HS256'] })).toMatchObject({ document: { title: 'x' } });
  });

  it('returns null when no secret is configured', async () => {
    getOnlyOfficeSettings.mockResolvedValue({ jwtSecret: '', url: null });
    expect(await signConfigToken({})).toBeNull();
  });
});

describe('getOnlyofficeJsUrl', () => {
  it('builds the API script URL from the configured server', async () => {
    getOnlyOfficeSettings.mockResolvedValue({ jwtSecret: 's', url: 'https://oo.example.com' });
    expect(await getOnlyofficeJsUrl()).toBe('https://oo.example.com/web-apps/apps/api/documents/api.js');
  });

  it('falls back to localhost when nothing is configured', async () => {
    getOnlyOfficeSettings.mockResolvedValue({ jwtSecret: 's', url: null });
    expect(await getOnlyofficeJsUrl()).toBe('http://localhost/web-apps/apps/api/documents/api.js');
  });

  it('repairs a legacy scheme-less server URL into an absolute api.js URL', async () => {
    // A bare host stored before validation existed would otherwise resolve
    // relative to the app origin in the browser and fetch index.html.
    getOnlyOfficeSettings.mockResolvedValue({ jwtSecret: 's', url: '192.168.1.1' });
    expect(await getOnlyofficeJsUrl()).toBe('http://192.168.1.1/web-apps/apps/api/documents/api.js');
  });

  it('strips a trailing slash before appending the api.js path', async () => {
    getOnlyOfficeSettings.mockResolvedValue({ jwtSecret: 's', url: 'https://oo.example.com/' });
    expect(await getOnlyofficeJsUrl()).toBe('https://oo.example.com/web-apps/apps/api/documents/api.js');
  });
});

describe('getUserName', () => {
  it('prefers the display name', async () => {
    getUserById.mockResolvedValue({ name: 'Ada Lovelace', email: 'ada@example.com' });
    expect(await getUserName('u1')).toBe('Ada Lovelace');
  });

  it('falls back to the email when there is no name', async () => {
    getUserById.mockResolvedValue({ name: null, email: 'ada@example.com' });
    expect(await getUserName('u1')).toBe('ada@example.com');
  });

  it('falls back to "User" when the account cannot be read', async () => {
    getUserById.mockResolvedValue(null);
    expect(await getUserName('u1')).toBe('User');
  });
});

describe('isMobileDevice', () => {
  it.each([
    ['iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'],
    ['Android', 'Mozilla/5.0 (Linux; Android 14; Pixel 8)'],
    ['iPad', 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)'],
  ])('detects %s', (_label, ua) => {
    expect(isMobileDevice({ headers: { 'user-agent': ua } })).toBe(true);
  });

  it('reports false for a desktop browser', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120';
    expect(isMobileDevice({ headers: { 'user-agent': ua } })).toBe(false);
  });

  it('reports false when there is no user agent', () => {
    expect(isMobileDevice({ headers: {} })).toBe(false);
    expect(isMobileDevice({})).toBe(false);
    expect(isMobileDevice(null)).toBe(false);
  });
});

describe('buildOnlyofficeUrls', () => {
  it('uses BACKEND_URL when it is configured', () => {
    const { downloadUrl, callbackUrl } = buildOnlyofficeUrls(mockReq(), 'file1', 'tok');
    expect(downloadUrl).toBe('https://cloud.example.com/api/onlyoffice/file/file1?t=tok');
    expect(callbackUrl).toBe('https://cloud.example.com/api/onlyoffice/callback');
  });

  it('URL-encodes the access token', () => {
    const { downloadUrl } = buildOnlyofficeUrls(mockReq(), 'file1', 'a b&c=d');
    expect(downloadUrl).toContain('?t=a%20b%26c%3Dd');
  });

  it('omits the token parameter when there is none', () => {
    expect(buildOnlyofficeUrls(mockReq(), 'file1', null).downloadUrl).not.toContain('?t=');
  });
});

describe('buildOnlyofficeConfig', () => {
  const file = { id: 'file000000000001', name: 'report.docx' };
  const actor = { id: 'sub00000000000001', name: 'Ada' };
  const build = (overrides = {}) =>
    buildOnlyofficeConfig(
      overrides.file || file,
      overrides.ownerId || 'owner00000000001',
      overrides.actor || actor,
      'https://dl',
      'https://cb',
      overrides.isMobile ?? false,
      overrides.canWrite ?? true,
      overrides.uiTheme
    );

  it('derives the editor file type from the name', () => {
    expect(build().document.fileType).toBe('docx');
  });

  it('keys the document by the account owner, not the acting sub-user', () => {
    // The unauthenticated save callback parses this key to locate and
    // re-encrypt the file, so it has to name the owning account.
    expect(build().document.key.startsWith('owner00000000001-file000000000001-')).toBe(true);
  });

  it('changes the document key per session so OnlyOffice does not serve a stale cache', () => {
    expect(build().document.key).not.toBe(build().document.key.replace(/\d+$/, '0'));
    expect(build().document.key).toMatch(/-\d{10,}$/);
  });

  it('reports the acting identity so co-editing shows the individual, not the account', () => {
    expect(build().editorConfig.user).toEqual({ id: 'sub00000000000001', name: 'Ada' });
  });

  it('opens in edit mode for a writable document', () => {
    const config = build();
    expect(config.editorConfig.mode).toBe('edit');
    expect(config.editorConfig.customization.autosave).toBe(true);
    expect(config.editorConfig.customization.forcesave).toBe(true);
  });

  it('forces view mode for a read-only member, since the save callback is unauthenticated', () => {
    const config = build({ canWrite: false });
    expect(config.editorConfig.mode).toBe('view');
    expect(config.editorConfig.customization.autosave).toBe(false);
    expect(config.editorConfig.customization.forcesave).toBe(false);
  });

  it('always opens a PDF read-only', () => {
    expect(build({ file: { id: 'f1', name: 'manual.pdf' } }).editorConfig.mode).toBe('view');
  });

  it('switches the editor type for mobile clients', () => {
    expect(build({ isMobile: true }).type).toBe('mobile');
    expect(build({ isMobile: false }).type).toBe('desktop');
  });

  it('carries the download and callback URLs through', () => {
    const config = build();
    expect(config.document.url).toBe('https://dl');
    expect(config.editorConfig.callbackUrl).toBe('https://cb');
  });

  it('signs the app theme into the editor customization when one is given', () => {
    expect(build({ uiTheme: 'theme-dark' }).editorConfig.customization.uiTheme).toBe('theme-dark');
    expect(build({ uiTheme: 'theme-light' }).editorConfig.customization.uiTheme).toBe('theme-light');
  });

  it('omits uiTheme entirely when none is given, so OnlyOffice keeps its own default', () => {
    expect('uiTheme' in build().editorConfig.customization).toBe(false);
  });
});

describe('resolveUiTheme', () => {
  it('maps the app toggle to OnlyOffice theme names', () => {
    expect(resolveUiTheme('dark')).toBe('theme-dark');
    expect(resolveUiTheme('light')).toBe('theme-light');
  });

  it('returns undefined for anything else so the document server default wins', () => {
    expect(resolveUiTheme(undefined)).toBeUndefined();
    expect(resolveUiTheme('')).toBeUndefined();
    expect(resolveUiTheme('system')).toBeUndefined();
    expect(resolveUiTheme('theme-dark')).toBeUndefined();
  });
});
