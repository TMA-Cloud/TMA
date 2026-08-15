import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PERMISSIONS, PERMISSION_CATALOG } from '../../../utils/permissions.js';
import { mockReq, mockRes } from '../../helpers/http.js';

vi.mock('../../../models/user.model.js', () => ({
  createSubUser: vi.fn(),
  deleteSubUser: vi.fn(),
  getSubUser: vi.fn(),
  getUserByEmail: vi.fn(),
  listSubUsers: vi.fn(),
  updateSubUserPermissions: vi.fn(),
}));

vi.mock('../../../models/session.model.js', () => ({ deleteAllUserSessions: vi.fn(async () => {}) }));
vi.mock('../../../models/clientHeartbeat.model.js', () => ({ deleteAllHeartbeatsForUser: vi.fn(async () => {}) }));
vi.mock('../../../services/auditLogger.js', () => ({ logAuditEvent: vi.fn(async () => {}) }));

const models = await import('../../../models/user.model.js');
const { deleteAllUserSessions } = await import('../../../models/session.model.js');
const { deleteAllHeartbeatsForUser } = await import('../../../models/clientHeartbeat.model.js');
const { logAuditEvent } = await import('../../../services/auditLogger.js');
const controller = await import('../../../controllers/user/user.subusers.controller.js');

const OWNER = 'owner00000000001';
const SUB = 'sub00000000000001';

const subUserRow = (overrides = {}) => ({
  id: SUB,
  email: 'sub@example.com',
  name: 'Sub User',
  permissions: [PERMISSIONS.DOWNLOAD],
  created_at: '2026-01-01T00:00:00.000Z',
  mfa_enabled: false,
  ...overrides,
});

async function call(handler, reqOverrides = {}) {
  const req = mockReq({ userId: OWNER, ownerId: OWNER, isSubUser: false, ...reqOverrides });
  const res = mockRes();
  await handler(req, res);
  return { req, res };
}

beforeEach(() => {
  models.listSubUsers.mockResolvedValue([]);
  models.getUserByEmail.mockResolvedValue(undefined);
  models.createSubUser.mockResolvedValue(subUserRow());
  models.updateSubUserPermissions.mockResolvedValue(subUserRow());
  models.getSubUser.mockResolvedValue(subUserRow());
  models.deleteSubUser.mockResolvedValue(subUserRow());
  deleteAllUserSessions.mockResolvedValue(undefined);
  deleteAllHeartbeatsForUser.mockResolvedValue(undefined);
  logAuditEvent.mockResolvedValue(undefined);
});

describe('listSubUsers', () => {
  it("returns the account's sub-users", async () => {
    models.listSubUsers.mockResolvedValue([subUserRow()]);
    const { res } = await call(controller.listSubUsers);
    expect(res.body.subUsers).toHaveLength(1);
  });

  it('lists them for the acting owner', async () => {
    await call(controller.listSubUsers);
    expect(models.listSubUsers).toHaveBeenCalledWith(OWNER);
  });

  it('ships the permission catalog so the UI cannot drift from the server', async () => {
    const { res } = await call(controller.listSubUsers);
    expect(res.body.availablePermissions).toEqual(PERMISSION_CATALOG);
  });

  it('never exposes the password hash', async () => {
    models.listSubUsers.mockResolvedValue([subUserRow({ password: '$2b$10$secret' })]);
    const { res } = await call(controller.listSubUsers);
    expect(JSON.stringify(res.body)).not.toContain('$2b$10$secret');
    expect(res.body.subUsers[0]).not.toHaveProperty('password');
  });

  it('normalises stored grants before returning them', async () => {
    models.listSubUsers.mockResolvedValue([subUserRow({ permissions: ['files.retired', PERMISSIONS.DOWNLOAD] })]);
    const { res } = await call(controller.listSubUsers);
    expect(res.body.subUsers[0].permissions).toEqual([PERMISSIONS.DOWNLOAD]);
  });

  it('defaults mfaEnabled to false when the column is null', async () => {
    models.listSubUsers.mockResolvedValue([subUserRow({ mfa_enabled: null })]);
    const { res } = await call(controller.listSubUsers);
    expect(res.body.subUsers[0].mfaEnabled).toBe(false);
  });

  it('answers 500 when the lookup fails', async () => {
    models.listSubUsers.mockRejectedValue(new Error('database down'));
    const { res } = await call(controller.listSubUsers);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.body.message).toBe('Server error');
  });
});

describe('createSubUser', () => {
  const body = {
    email: 'sub@example.com',
    password: 'secret123',
    name: 'Sub User',
    permissions: [PERMISSIONS.DOWNLOAD],
  };

  it('creates the sub-user and answers 201', async () => {
    const { res } = await call(controller.createSubUser, { body });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.body.subUser.id).toBe(SUB);
  });

  it('parents the new login to the acting owner', async () => {
    await call(controller.createSubUser, { body });
    expect(models.createSubUser).toHaveBeenCalledWith(expect.objectContaining({ ownerId: OWNER }));
  });

  it('hashes the password before it reaches the model', async () => {
    await call(controller.createSubUser, { body });
    const { hashedPassword } = models.createSubUser.mock.calls[0][0];
    expect(hashedPassword).not.toBe('secret123');
    expect(hashedPassword).toMatch(/^\$2[aby]\$/);
  });

  it('never returns the password hash', async () => {
    const { res } = await call(controller.createSubUser, { body });
    expect(res.body.subUser).not.toHaveProperty('password');
  });

  it('rejects an email that already belongs to any account', async () => {
    models.getUserByEmail.mockResolvedValue({ id: 'someone-else' });
    const { res } = await call(controller.createSubUser, { body });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.body.message).toBe('Email already in use');
    expect(models.createSubUser).not.toHaveBeenCalled();
  });

  it('audits a rejected duplicate email', async () => {
    models.getUserByEmail.mockResolvedValue({ id: 'someone-else' });
    await call(controller.createSubUser, { body });
    expect(logAuditEvent).toHaveBeenCalledWith(
      'account.sub_user.create',
      expect.objectContaining({
        status: 'failure',
        metadata: expect.objectContaining({ reason: 'email_already_in_use' }),
      }),
      expect.anything()
    );
  });

  it('audits a successful creation', async () => {
    await call(controller.createSubUser, { body });
    expect(logAuditEvent).toHaveBeenCalledWith(
      'account.sub_user.create',
      expect.objectContaining({ status: 'success', resourceId: SUB }),
      expect.anything()
    );
  });

  describe('model errors mapped to status codes', () => {
    it.each([
      ['Sub-users cannot create sub-users', 403],
      ['Owner account not found', 404],
      ['Invalid sub-user permissions', 400],
      ['Sub-user name is required', 400],
    ])('maps "%s" to %i', async (message, status) => {
      models.createSubUser.mockRejectedValue(new Error(message));
      const { res } = await call(controller.createSubUser, { body });
      expect(res.status).toHaveBeenCalledWith(status);
      expect(res.body.message).toBe(message);
    });

    it('maps a unique violation to 409, covering a race with a concurrent signup', async () => {
      models.createSubUser.mockRejectedValue(Object.assign(new Error('duplicate key'), { code: '23505' }));
      const { res } = await call(controller.createSubUser, { body });
      expect(res.status).toHaveBeenCalledWith(409);
    });

    it('maps the database nesting guard to the same 403 as the up-front check', async () => {
      models.createSubUser.mockRejectedValue(
        Object.assign(new Error('violates check constraint "no_nested_sub-user"'), { code: '23514' })
      );
      const { res } = await call(controller.createSubUser, { body });
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.body.message).toBe('Sub-users cannot create sub-users');
    });

    it('falls back to 500 for an unrecognised failure', async () => {
      models.createSubUser.mockRejectedValue(new Error('disk on fire'));
      const { res } = await call(controller.createSubUser, { body });
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.body.message).toBe('Server error');
    });

    it('does not leak the raw failure message to the client', async () => {
      models.createSubUser.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432'));
      const { res } = await call(controller.createSubUser, { body });
      expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
    });
  });
});

describe('updateSubUser', () => {
  const params = { id: SUB };
  const body = { permissions: [PERMISSIONS.EDIT] };

  it('replaces the grants and returns the updated member', async () => {
    models.updateSubUserPermissions.mockResolvedValue(subUserRow({ permissions: [PERMISSIONS.EDIT] }));
    const { res } = await call(controller.updateSubUser, { params, body });
    expect(res.body.subUser.permissions).toEqual([PERMISSIONS.EDIT]);
  });

  it('scopes the update to the acting owner', async () => {
    await call(controller.updateSubUser, { params, body });
    expect(models.updateSubUserPermissions).toHaveBeenCalledWith(OWNER, SUB, [PERMISSIONS.EDIT]);
  });

  it('answers 404 when the sub-user belongs to someone else', async () => {
    models.updateSubUserPermissions.mockResolvedValue(undefined);
    const { res } = await call(controller.updateSubUser, { params, body });
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.body.message).toBe('Sub-user not found');
  });

  it('does not audit a failed update', async () => {
    models.updateSubUserPermissions.mockResolvedValue(undefined);
    await call(controller.updateSubUser, { params, body });
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it('audits a successful update', async () => {
    await call(controller.updateSubUser, { params, body });
    expect(logAuditEvent).toHaveBeenCalledWith(
      'account.sub_user.update',
      expect.objectContaining({ status: 'success', resourceId: SUB }),
      expect.anything()
    );
  });

  it('answers 500 when the update throws', async () => {
    models.updateSubUserPermissions.mockRejectedValue(new Error('database down'));
    const { res } = await call(controller.updateSubUser, { params, body });
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('deleteSubUser', () => {
  const params = { id: SUB };

  it('removes the sub-user', async () => {
    const { res } = await call(controller.deleteSubUser, { params });
    expect(models.deleteSubUser).toHaveBeenCalledWith(OWNER, SUB);
    expect(res.body.message).toBe('Sub-user removed');
  });

  it('answers 404 without touching sessions when the sub-user is not in this account', async () => {
    models.getSubUser.mockResolvedValue(undefined);
    const { res } = await call(controller.deleteSubUser, { params });
    expect(res.status).toHaveBeenCalledWith(404);
    expect(deleteAllUserSessions).not.toHaveBeenCalled();
    expect(models.deleteSubUser).not.toHaveBeenCalled();
  });

  it('revokes sessions before deleting the row, so the login stops working immediately', async () => {
    const order = [];
    deleteAllUserSessions.mockImplementation(async () => void order.push('sessions'));
    models.deleteSubUser.mockImplementation(async () => {
      order.push('delete');
      return subUserRow();
    });

    await call(controller.deleteSubUser, { params });

    expect(order).toEqual(['sessions', 'delete']);
  });

  it('clears desktop client heartbeats too', async () => {
    await call(controller.deleteSubUser, { params });
    expect(deleteAllHeartbeatsForUser).toHaveBeenCalledWith(SUB);
  });

  it('audits the removal with the email that was freed up', async () => {
    await call(controller.deleteSubUser, { params });
    expect(logAuditEvent).toHaveBeenCalledWith(
      'account.sub_user.delete',
      expect.objectContaining({ metadata: expect.objectContaining({ email: 'sub@example.com' }) }),
      expect.anything()
    );
  });

  it('answers 500 when the deletion throws', async () => {
    models.deleteSubUser.mockRejectedValue(new Error('database down'));
    const { res } = await call(controller.deleteSubUser, { params });
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
