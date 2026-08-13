import { describe, expect, it, vi } from 'vitest';

import { requireAccountOwner, requirePermission } from '../../../middleware/accountRole.middleware.js';
import { ALL_PERMISSIONS, PERMISSIONS } from '../../../utils/permissions.js';
import { mockNext, mockReq, mockRes } from '../../helpers/http.js';

vi.mock('../../../services/auditLogger.js', () => ({
  logAuditEvent: vi.fn(async () => {}),
}));

const { logAuditEvent } = await import('../../../services/auditLogger.js');

async function run(middleware, reqOverrides) {
  const req = mockReq({ method: 'POST', path: '/api/files/delete', ...reqOverrides });
  const res = mockRes();
  const next = mockNext();
  await middleware(req, res, next);
  return { req, res, next };
}

describe('requirePermission', () => {
  const guard = requirePermission(PERMISSIONS.DELETE);

  it('lets an account owner through regardless of the permission list', async () => {
    const { next, res } = await run(guard, { isSubUser: false, permissions: [] });
    expect(next).toHaveBeenCalled();
    expect(res.sent).toBe(false);
  });

  it('lets a sub-user through when the capability was granted', async () => {
    const { next } = await run(guard, { isSubUser: true, permissions: [PERMISSIONS.DELETE] });
    expect(next).toHaveBeenCalled();
  });

  it('blocks a sub-user without the capability', async () => {
    const { next, res } = await run(guard, { isSubUser: true, permissions: [PERMISSIONS.DOWNLOAD] });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('names the human-readable capability in the message, not the raw key', async () => {
    const { res } = await run(guard, { isSubUser: true, permissions: [] });
    expect(res.body.message).toContain('Move to trash');
    expect(res.body.message).not.toContain('files.delete');
  });

  it('records a denial in the audit trail', async () => {
    logAuditEvent.mockClear();
    await run(guard, { isSubUser: true, permissions: [] });
    expect(logAuditEvent).toHaveBeenCalledWith(
      'account.permission_denied',
      expect.objectContaining({
        status: 'failure',
        resourceType: 'account',
        metadata: expect.objectContaining({ permission: PERMISSIONS.DELETE }),
      }),
      expect.anything()
    );
  });

  it('does not audit a permitted request', async () => {
    logAuditEvent.mockClear();
    await run(guard, { isSubUser: true, permissions: [PERMISSIONS.DELETE] });
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it('builds an independent guard per capability', async () => {
    const req = { isSubUser: true, permissions: [PERMISSIONS.UPLOAD] };
    expect((await run(requirePermission(PERMISSIONS.UPLOAD), req)).next).toHaveBeenCalled();
    expect((await run(requirePermission(PERMISSIONS.SHARE), req)).next).not.toHaveBeenCalled();
  });

  it.each(ALL_PERMISSIONS)('denies %s to a sub-user with an empty grant list', async permission => {
    const { res } = await run(requirePermission(permission), { isSubUser: true, permissions: [] });
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('falls back to the raw key when a permission has no catalog entry', async () => {
    const { res } = await run(requirePermission('files.unknown'), { isSubUser: true, permissions: [] });
    expect(res.body.message).toContain('files.unknown');
  });
});

describe('requireAccountOwner', () => {
  it('lets an owner through', async () => {
    const { next, res } = await run(requireAccountOwner, { isSubUser: false });
    expect(next).toHaveBeenCalled();
    expect(res.sent).toBe(false);
  });

  it('blocks a sub-user, which is what stops nested sub-user management', async () => {
    const { next, res } = await run(requireAccountOwner, { isSubUser: true, permissions: ALL_PERMISSIONS });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body.message).toBe('Only the account owner can perform this action.');
  });

  it('blocks a sub-user even with every capability granted', async () => {
    const { res } = await run(requireAccountOwner, { isSubUser: true, permissions: ALL_PERMISSIONS });
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('records the denial in the audit trail', async () => {
    logAuditEvent.mockClear();
    await run(requireAccountOwner, { isSubUser: true });
    expect(logAuditEvent).toHaveBeenCalledWith(
      'account.owner_action_denied',
      expect.objectContaining({ metadata: expect.objectContaining({ reason: 'sub_user' }) }),
      expect.anything()
    );
  });
});
