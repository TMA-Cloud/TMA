/**
 * Route-level wiring for /api/user, with the controllers stubbed.
 *
 * The thing being pinned here is which endpoints are owner-only — that guard is
 * what stops a sub-user from creating sub-users of its own — and that the
 * request schemas reject malformed input before a handler sees it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

import { ALL_PERMISSIONS, PERMISSIONS } from '../../utils/permissions.js';
import { buildApp } from '../helpers/http.js';

const identity = { userId: 'user000000000001', ownerId: 'user000000000001', isSubUser: false, permissions: null };

vi.mock('../../middleware/auth.middleware.js', () => ({
  default: (req, _res, next) => {
    Object.assign(req, identity);
    next();
  },
}));

vi.mock('../../services/auditLogger.js', () => ({ logAuditEvent: vi.fn(async () => {}) }));

const handlerNames = [
  'checkOnlyOfficeConfigured',
  'clientHeartbeat',
  'createSubUser',
  'deleteOrphans',
  'deleteSubUser',
  'getActiveClients',
  'getElectronOnlyAccessConfig',
  'getHideFileExtensionsConfig',
  'getMaxUploadSizeConfig',
  'getKnownProxiesConfig',
  'getOnlyOfficeConfig',
  'getOrphans',
  'getPasswordChangeConfig',
  'getShareBaseUrlConfig',
  'getSignupStatus',
  'listSubUsers',
  'listUsers',
  'storageUsage',
  'toggleSignup',
  'updateElectronOnlyAccessConfig',
  'updateHideFileExtensionsConfig',
  'updateMaxUploadSizeConfig',
  'updateKnownProxiesConfig',
  'updateOnlyOfficeConfig',
  'updatePasswordChangeConfig',
  'updateShareBaseUrlConfig',
  'updateSubUser',
  'updateUserStorageLimit',
];

vi.mock('../../controllers/user.controller.js', () => {
  const handlers = {};
  for (const name of handlerNames) {
    handlers[name] = (_req, res) => res.json({ handler: name });
  }
  return handlers;
});

const userRoutes = (await import('../../routes/user.routes.js')).default;
const app = buildApp(a => a.use('/api/user', userRoutes));

const SUB_ID = 'sub00000000000001';

const asOwner = () => Object.assign(identity, { isSubUser: false, permissions: null });
const asSubUser = (permissions = ALL_PERMISSIONS) =>
  Object.assign(identity, { isSubUser: true, permissions, ownerId: 'owner00000000001' });

beforeEach(asOwner);

describe('sub-user management is owner-only', () => {
  const subUserRoutes = [
    ['list', 'get', '/api/user/sub-users', null],
    [
      'create',
      'post',
      '/api/user/sub-users',
      { email: 'a@b.com', password: 'secret123', name: 'Sub', permissions: [] },
    ],
    ['update', 'put', `/api/user/sub-users/${SUB_ID}`, { permissions: [] }],
    ['delete', 'delete', `/api/user/sub-users/${SUB_ID}`, null],
  ];

  it.each(subUserRoutes)('%s is allowed for the account owner', async (_label, method, path, body) => {
    expect(
      (
        await request(app)
          [method](path)
          .send(body ?? undefined)
      ).status
    ).toBe(200);
  });

  it.each(subUserRoutes)(
    '%s is refused for a sub-user, even one holding every capability',
    async (_label, method, path, body) => {
      asSubUser(ALL_PERMISSIONS);
      const res = await request(app)
        [method](path)
        .send(body ?? undefined);
      expect(res.status).toBe(403);
      expect(res.body.message).toBe('Only the account owner can perform this action.');
    }
  );

  it('checks ownership before validating the body, so a sub-user learns nothing about the schema', async () => {
    asSubUser(ALL_PERMISSIONS);
    const res = await request(app).post('/api/user/sub-users').send({ nonsense: true });
    expect(res.status).toBe(403);
  });
});

describe('createSubUser validation', () => {
  const post = body => request(app).post('/api/user/sub-users').send(body);
  const valid = { email: 'a@b.com', password: 'secret123', name: 'Sub User', permissions: [PERMISSIONS.DOWNLOAD] };

  it('accepts a well-formed request', async () => {
    expect((await post(valid)).status).toBe(200);
  });

  it('rejects a malformed email', async () => {
    expect((await post({ ...valid, email: 'nope' })).status).toBe(422);
  });

  it('rejects a password under 8 characters', async () => {
    expect((await post({ ...valid, password: '1234567' })).status).toBe(422);
  });

  it('requires a non-empty name', async () => {
    expect((await post({ ...valid, name: '   ' })).status).toBe(422);
    expect((await post({ ...valid, name: undefined })).status).toBe(422);
  });

  it('rejects an unknown permission key', async () => {
    expect((await post({ ...valid, permissions: ['files.launch_missiles'] })).status).toBe(422);
  });

  it('rejects permissions sent as anything but an array', async () => {
    expect((await post({ ...valid, permissions: 'files.download' })).status).toBe(422);
    expect((await post({ ...valid, permissions: undefined })).status).toBe(422);
  });

  it('accepts an empty permission list, which is a browse-only sub-user', async () => {
    expect((await post({ ...valid, permissions: [] })).status).toBe(200);
  });

  it('accepts the full set of capabilities', async () => {
    expect((await post({ ...valid, permissions: ALL_PERMISSIONS })).status).toBe(200);
  });

  it('rejects a list longer than the catalog, blocking duplicate-key padding', async () => {
    const padded = [...ALL_PERMISSIONS, PERMISSIONS.DOWNLOAD];
    expect((await post({ ...valid, permissions: padded })).status).toBe(422);
  });
});

describe('updateSubUser validation', () => {
  it('accepts a valid permission list', async () => {
    const res = await request(app)
      .put(`/api/user/sub-users/${SUB_ID}`)
      .send({ permissions: [PERMISSIONS.EDIT] });
    expect(res.status).toBe(200);
  });

  it('rejects an unknown permission key', async () => {
    const res = await request(app)
      .put(`/api/user/sub-users/${SUB_ID}`)
      .send({ permissions: ['files.admin'] });
    expect(res.status).toBe(422);
  });
});

describe('storage limit updates', () => {
  const put = body => request(app).put('/api/user/storage-limit').send(body);

  it('accepts a positive integer limit', async () => {
    expect((await put({ targetUserId: 'user000000000002', storageLimit: 10737418240 })).status).toBe(200);
  });

  it('accepts null, meaning unlimited', async () => {
    expect((await put({ targetUserId: 'user000000000002', storageLimit: null })).status).toBe(200);
  });

  it('rejects a zero or negative limit', async () => {
    expect((await put({ targetUserId: 'user000000000002', storageLimit: 0 })).status).toBe(422);
    expect((await put({ targetUserId: 'user000000000002', storageLimit: -1 })).status).toBe(422);
  });

  it('rejects a non-integer limit', async () => {
    expect((await put({ targetUserId: 'user000000000002', storageLimit: 1.5 })).status).toBe(422);
    expect((await put({ targetUserId: 'user000000000002', storageLimit: 'lots' })).status).toBe(422);
  });

  it('requires a target user', async () => {
    expect((await put({ storageLimit: 100 })).status).toBe(422);
  });
});

describe('max upload size updates', () => {
  const put = maxBytes => request(app).put('/api/user/max-upload-size-config').send({ maxBytes });

  it('accepts a value inside the 1 MB to 100 GB range', async () => {
    expect((await put(1048576)).status).toBe(200);
    expect((await put(107374182400)).status).toBe(200);
  });

  it('rejects a value below 1 MB', async () => {
    expect((await put(1048575)).status).toBe(422);
  });

  it('rejects a value above 100 GB', async () => {
    expect((await put(107374182401)).status).toBe(422);
  });

  it('rejects a non-integer', async () => {
    expect((await put('big')).status).toBe(422);
  });
});

describe('orphan scanning', () => {
  it('accepts a grace window inside the allowed range', async () => {
    expect((await request(app).get('/api/user/orphans?graceMinutes=60')).status).toBe(200);
    expect((await request(app).get('/api/user/orphans?graceMinutes=525600')).status).toBe(200);
  });

  it('rejects a grace window under the one-hour floor that protects in-flight uploads', async () => {
    expect((await request(app).get('/api/user/orphans?graceMinutes=59')).status).toBe(422);
    expect((await request(app).get('/api/user/orphans?graceMinutes=0')).status).toBe(422);
  });

  it('rejects a grace window over one year', async () => {
    expect((await request(app).get('/api/user/orphans?graceMinutes=525601')).status).toBe(422);
  });

  it('treats the grace window as optional', async () => {
    expect((await request(app).get('/api/user/orphans')).status).toBe(200);
  });

  it('caps a deletion batch at 500 keys', async () => {
    const tooMany = Array.from({ length: 501 }, (_, i) => `key-${i}`);
    const res = await request(app).post('/api/user/orphans/delete').send({ storageKeys: tooMany, graceMinutes: 60 });
    expect(res.status).toBe(422);
  });

  it('accepts a batch at the cap', async () => {
    const atCap = Array.from({ length: 500 }, (_, i) => `key-${i}`);
    const res = await request(app).post('/api/user/orphans/delete').send({ storageKeys: atCap, graceMinutes: 60 });
    expect(res.status).toBe(200);
  });
});

describe('boolean config toggles', () => {
  const toggles = [
    ['signup', 'post', '/api/user/signup-toggle', 'enabled'],
    ['hide file extensions', 'put', '/api/user/hide-file-extensions-config', 'hidden'],
    ['desktop-only access', 'put', '/api/user/electron-only-access-config', 'enabled'],
    ['password change', 'put', '/api/user/password-change-config', 'enabled'],
  ];

  it.each(toggles)('%s accepts a real boolean', async (_label, method, path, field) => {
    expect(
      (
        await request(app)
          [method](path)
          .send({ [field]: true })
      ).status
    ).toBe(200);
    expect(
      (
        await request(app)
          [method](path)
          .send({ [field]: false })
      ).status
    ).toBe(200);
  });

  it.each(toggles)('%s rejects a non-boolean', async (_label, method, path, field) => {
    expect(
      (
        await request(app)
          [method](path)
          .send({ [field]: 'yes' })
      ).status
    ).toBe(422);
    expect((await request(app)[method](path).send({})).status).toBe(422);
  });
});

describe('URL config endpoints', () => {
  it('accepts a valid share base URL', async () => {
    const res = await request(app).put('/api/user/share-base-url-config').send({ url: 'https://share.example.com' });
    expect(res.status).toBe(200);
  });

  it('rejects a malformed share base URL', async () => {
    expect((await request(app).put('/api/user/share-base-url-config').send({ url: 'not a url' })).status).toBe(422);
  });

  it('accepts null to clear the share base URL', async () => {
    expect((await request(app).put('/api/user/share-base-url-config').send({ url: null })).status).toBe(200);
  });

  it('validates the OnlyOffice URL the same way', async () => {
    expect((await request(app).put('/api/user/onlyoffice-config').send({ url: 'nope' })).status).toBe(422);
    expect(
      (await request(app).put('/api/user/onlyoffice-config').send({ url: 'https://oo.example.com', jwtSecret: 's' }))
        .status
    ).toBe(200);
  });
});

describe('known proxy config validation', () => {
  it('accepts a list of proxy identities and an empty list', async () => {
    expect(
      (
        await request(app)
          .put('/api/user/known-proxies-config')
          .send({ knownProxies: ['10.1.2.100', '172.18.0.0/16', 'proxy.example.com'] })
      ).status
    ).toBe(200);
    expect((await request(app).put('/api/user/known-proxies-config').send({ knownProxies: [] })).status).toBe(200);
  });

  it('rejects missing, non-array, and non-string values', async () => {
    expect((await request(app).put('/api/user/known-proxies-config').send({})).status).toBe(422);
    expect((await request(app).put('/api/user/known-proxies-config').send({ knownProxies: '10.0.0.1' })).status).toBe(
      422
    );
    expect(
      (
        await request(app)
          .put('/api/user/known-proxies-config')
          .send({ knownProxies: [123] })
      ).status
    ).toBe(422);
  });

  it('rejects malformed IP addresses and hostnames', async () => {
    expect(
      (
        await request(app)
          .put('/api/user/known-proxies-config')
          .send({ knownProxies: ['999.1.1.1'] })
      ).status
    ).toBe(422);
    expect(
      (
        await request(app)
          .put('/api/user/known-proxies-config')
          .send({ knownProxies: ['not a hostname'] })
      ).status
    ).toBe(422);
  });
});

describe('routes open to sub-users', () => {
  it.each([
    ['signup status', '/api/user/signup-status'],
    ['storage usage', '/api/user/storage'],
    ['OnlyOffice availability', '/api/user/onlyoffice-configured'],
    ['hide file extensions setting', '/api/user/hide-file-extensions-config'],
  ])('%s is readable by a sub-user with no permissions', async (_label, path) => {
    asSubUser([]);
    expect((await request(app).get(path)).status).toBe(200);
  });
});
