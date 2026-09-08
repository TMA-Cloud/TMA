/**
 * Route-level wiring for /api/files.
 *
 * The controllers are stubbed; what is under test is the middleware chain the
 * router builds around them — which capability each endpoint demands, and that
 * a guard runs before any body-parsing middleware. A missing `canDelete` on a
 * destructive route is exactly the kind of regression this catches.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

import { PERMISSIONS } from '../../utils/permissions.js';
import { buildApp } from '../helpers/http.js';

/** Mutated per test to change who the auth middleware says is calling. */
const identity = {
  userId: 'user000000000001',
  ownerId: 'user000000000001',
  isSubUser: false,
  permissions: null,
};

vi.mock('../../middleware/auth.middleware.js', () => ({
  default: (req, _res, next) => {
    Object.assign(req, identity);
    next();
  },
}));

vi.mock('../../services/auditLogger.js', () => ({ logAuditEvent: vi.fn(async () => {}) }));

/** Every handler simply echoes which one ran. */
const handlerNames = [
  'addFolder',
  'checkUploadStorage',
  'copyFiles',
  'deleteFiles',
  'deleteForever',
  'downloadFile',
  'downloadFilesBulk',
  'emptyTrash',
  'getFileInfo',
  'getFileStats',
  'getShareLinks',
  'linkParentShare',
  'listFiles',
  'listRecent',
  'listShared',
  'listStarred',
  'listTrash',
  'moveFiles',
  'renameFile',
  'replaceFileContents',
  'restoreFiles',
  'searchFiles',
  'shareFiles',
  'starFiles',
  'uploadDerivedFile',
  'uploadFile',
  'uploadFilesBulk',
];

vi.mock('../../controllers/file.controller.js', () => {
  const handlers = {};
  for (const name of handlerNames) {
    handlers[name] = (_req, res) => res.json({ handler: name });
  }
  return handlers;
});

vi.mock('../../controllers/file/file.events.controller.js', () => ({
  streamFileEvents: (_req, res) => res.json({ handler: 'streamFileEvents' }),
}));

// Upload middleware would otherwise try to parse multipart bodies and read the
// max-upload-size setting; a pass-through keeps the focus on the guards.

vi.mock('../../middleware/streamUploadToS3.middleware.js', () => ({
  streamUploadToS3: () => (_req, _res, next) => next(),
}));

// Quota enforcement has its own unit suite; here it would only add a database
// round trip between the guard and the handler.
vi.mock('../../middleware/storageLimit.middleware.js', () => ({
  checkStorageLimit: (_req, _res, next) => next(),
}));

const fileRoutes = (await import('../../routes/file.routes.js')).default;

const app = buildApp(a => a.use('/api/files', fileRoutes));

const ID = 'abcDEF1234567890';
const ID2 = 'zyxWVU0987654321';

function asOwner() {
  Object.assign(identity, { isSubUser: false, permissions: null });
}

function asSubUser(permissions) {
  Object.assign(identity, { isSubUser: true, permissions, ownerId: 'owner00000000001' });
}

beforeEach(asOwner);

/* ------------------------------------------------------------------ *
 * Routes that need no explicit grant
 * ------------------------------------------------------------------ */

describe('browse routes are open to every member of the account', () => {
  const browseRoutes = [
    ['get', '/api/files/'],
    ['get', '/api/files/stats'],
    ['get', '/api/files/search'],
    ['get', '/api/files/starred'],
    ['get', '/api/files/shared'],
    ['get', '/api/files/trash'],
    ['get', `/api/files/${ID}/info`],
    ['get', '/api/files/events'],
  ];

  it.each(browseRoutes)('%s %s is reachable by an owner', async (method, path) => {
    expect((await request(app)[method](path)).status).toBe(200);
  });

  it.each(browseRoutes)('%s %s is reachable by a sub-user with no permissions at all', async (method, path) => {
    asSubUser([]);
    expect((await request(app)[method](path)).status).toBe(200);
  });
});

/* ------------------------------------------------------------------ *
 * The permission matrix
 * ------------------------------------------------------------------ */

/** [description, method, path, body, required permission] */
const guardedRoutes = [
  ['bulk download', 'post', '/api/files/download/bulk', { ids: [ID] }, PERMISSIONS.DOWNLOAD],
  ['single download', 'get', `/api/files/${ID}/download`, null, PERMISSIONS.DOWNLOAD],

  ['create folder', 'post', '/api/files/folder', { name: 'Docs' }, PERMISSIONS.UPLOAD],
  ['pre-upload check', 'post', '/api/files/upload/check', { fileSize: 100 }, PERMISSIONS.UPLOAD],
  ['upload', 'post', '/api/files/upload', {}, PERMISSIONS.UPLOAD],
  ['bulk upload', 'post', '/api/files/upload/bulk', {}, PERMISSIONS.UPLOAD],
  ['copy', 'post', '/api/files/copy', { ids: [ID] }, PERMISSIONS.UPLOAD],
  ['derived upload', 'post', `/api/files/${ID}/derived`, {}, PERMISSIONS.UPLOAD],

  ['move', 'post', '/api/files/move', { ids: [ID] }, PERMISSIONS.EDIT],
  ['rename', 'post', '/api/files/rename', { id: ID, name: 'new.txt' }, PERMISSIONS.EDIT],
  ['star', 'post', '/api/files/star', { ids: [ID], starred: true }, PERMISSIONS.EDIT],
  ['replace contents', 'post', `/api/files/${ID}/replace`, {}, PERMISSIONS.EDIT],

  ['share', 'post', '/api/files/share', { ids: [ID] }, PERMISSIONS.SHARE],
  ['link parent share', 'post', '/api/files/link-parent-share', { ids: [ID] }, PERMISSIONS.SHARE],
  ['read share links', 'post', '/api/files/share/links', { ids: [ID] }, PERMISSIONS.SHARE],

  ['move to trash', 'post', '/api/files/delete', { ids: [ID] }, PERMISSIONS.DELETE],

  ['restore from trash', 'post', '/api/files/trash/restore', { ids: [ID] }, PERMISSIONS.TRASH],
  ['delete forever', 'post', '/api/files/trash/delete', { ids: [ID] }, PERMISSIONS.TRASH],
  ['empty trash', 'post', '/api/files/trash/empty', {}, PERMISSIONS.TRASH],
];

describe('capability guards', () => {
  it.each(guardedRoutes)('%s is allowed for an owner', async (_label, method, path, body) => {
    const res = await request(app)
      [method](path)
      .send(body ?? undefined);
    expect(res.status).toBe(200);
  });

  it.each(guardedRoutes)(
    '%s is allowed for a sub-user holding just its own permission',
    async (_label, method, path, body, permission) => {
      asSubUser([permission]);
      const res = await request(app)
        [method](path)
        .send(body ?? undefined);
      expect(res.status).toBe(200);
    }
  );

  it.each(guardedRoutes)(
    '%s is refused with 403 for a sub-user with no permissions',
    async (_label, method, path, body) => {
      asSubUser([]);
      const res = await request(app)
        [method](path)
        .send(body ?? undefined);
      expect(res.status).toBe(403);
    }
  );

  it.each(guardedRoutes)(
    '%s is refused for a sub-user holding every *other* permission',
    async (_label, method, path, body, permission) => {
      asSubUser(Object.values(PERMISSIONS).filter(p => p !== permission));
      const res = await request(app)
        [method](path)
        .send(body ?? undefined);
      expect(res.status).toBe(403);
    }
  );
});

describe('guard ordering', () => {
  it('rejects an unpermitted upload before any body is parsed', async () => {
    asSubUser([]);
    const res = await request(app)
      .post('/api/files/upload')
      .set('Content-Type', 'multipart/form-data; boundary=----x')
      .send('------x\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\nhi\r\n------x--');
    expect(res.status).toBe(403);
  });

  it('rejects an unpermitted request before validation, so the reply is 403 not 422', async () => {
    asSubUser([]);
    const res = await request(app).post('/api/files/delete').send({ ids: 'not-an-array' });
    expect(res.status).toBe(403);
  });

  it('validates the body once the caller is permitted', async () => {
    asSubUser([PERMISSIONS.DELETE]);
    const res = await request(app).post('/api/files/delete').send({ ids: [] });
    expect(res.status).toBe(422);
  });
});

describe('routing', () => {
  it('dispatches to the expected handler', async () => {
    expect((await request(app).get('/api/files/')).body.handler).toBe('listFiles');
    expect((await request(app).get('/api/files/stats')).body.handler).toBe('getFileStats');
    expect((await request(app).post('/api/files/folder').send({ name: 'x' })).body.handler).toBe('addFolder');
  });

  it('routes /recent to the recent-files handler', async () => {
    expect((await request(app).get('/api/files/recent')).body.handler).toBe('listRecent');
  });

  it('does not confuse /trash with an :id/info lookup', async () => {
    expect((await request(app).get('/api/files/trash')).body.handler).toBe('listTrash');
  });

  it('routes /:id/info to the info handler', async () => {
    expect((await request(app).get(`/api/files/${ID2}/info`)).body.handler).toBe('getFileInfo');
  });

  it('returns 404 for an unknown path', async () => {
    expect((await request(app).get('/api/files/does-not-exist')).status).toBe(404);
  });
});
