import { describe, expect, it, vi } from 'vitest';

import { checkStorageLimit } from '../../../middleware/storageLimit.middleware.js';
import { mockNext, mockReq, mockRes } from '../../helpers/http.js';

vi.mock('../../../models/user.model.js', () => ({
  getUserStorageUsage: vi.fn(async () => 0),
  getUserStorageLimit: vi.fn(async () => null),
}));

const { getUserStorageLimit, getUserStorageUsage } = await import('../../../models/user.model.js');

const GB = 1024 * 1024 * 1024;

async function run(contentLength, { used = 0, limit = null } = {}) {
  getUserStorageUsage.mockResolvedValue(used);
  getUserStorageLimit.mockResolvedValue(limit);

  const req = mockReq({
    method: 'POST',
    path: '/api/files/upload',
    userId: 'user000000000001',
    ownerId: 'owner00000000001',
    headers: contentLength === undefined ? {} : { 'content-length': String(contentLength) },
  });
  const res = mockRes();
  const next = mockNext();
  await checkStorageLimit(req, res, next);
  return { res, next };
}

describe('checkStorageLimit', () => {
  it('allows an upload that fits within the quota', async () => {
    const { next, res } = await run(1 * GB, { used: 1 * GB, limit: 10 * GB });
    expect(next).toHaveBeenCalled();
    expect(res.sent).toBe(false);
  });

  it('allows any upload when the account has no quota', async () => {
    const { next } = await run(500 * GB, { used: 900 * GB, limit: null });
    expect(next).toHaveBeenCalled();
  });

  it('rejects an oversized upload with 413 before stream upload middleware ever runs', async () => {
    const { next, res } = await run(5 * GB, { used: 9 * GB, limit: 10 * GB });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.body.error).toBe('STORAGE_LIMIT_EXCEEDED');
  });

  it('explains the quota in the rejection message', async () => {
    const { res } = await run(5 * GB, { used: 9 * GB, limit: 10 * GB });
    expect(res.body.message).toContain('Storage limit exceeded');
    expect(res.body.message).toContain('available');
  });

  it('checks the quota against the account owner, not the acting sub-user', async () => {
    await run(1, { used: 0, limit: 10 * GB });
    expect(getUserStorageUsage).toHaveBeenCalledWith('owner00000000001');
    expect(getUserStorageLimit).toHaveBeenCalledWith('owner00000000001');
  });

  it('subtracts multipart overhead from Content-Length before comparing', async () => {
    // 400 bytes of body sits below the 500-byte overhead allowance, so the
    // estimate floors at zero and an at-quota account can still receive it.
    const { next } = await run(400, { used: 10 * GB, limit: 10 * GB });
    expect(next).toHaveBeenCalled();
  });

  it('lets stream upload middleware decide when Content-Length is missing', async () => {
    const { next } = await run(undefined, { used: 10 * GB, limit: 10 * GB });
    expect(next).toHaveBeenCalled();
  });

  it('lets stream upload middleware decide when Content-Length is not a number', async () => {
    const { next } = await run('not-a-number', { used: 10 * GB, limit: 10 * GB });
    expect(next).toHaveBeenCalled();
  });

  it('lets stream upload middleware decide when Content-Length is zero', async () => {
    const { next } = await run(0, { used: 10 * GB, limit: 10 * GB });
    expect(next).toHaveBeenCalled();
  });

  describe('fail-safe behaviour', () => {
    it('blocks the upload with 500 when usage cannot be read', async () => {
      getUserStorageUsage.mockRejectedValue(new Error('database unreachable'));
      getUserStorageLimit.mockResolvedValue(10 * GB);

      const req = mockReq({ headers: { 'content-length': '1000' }, ownerId: 'o1' });
      const res = mockRes();
      const next = mockNext();
      await checkStorageLimit(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.body.error).toBe('STORAGE_CHECK_FAILED');
    });

    it('blocks the upload when the limit cannot be read', async () => {
      getUserStorageUsage.mockResolvedValue(0);
      getUserStorageLimit.mockRejectedValue(new Error('database unreachable'));

      const req = mockReq({ headers: { 'content-length': '1000' }, ownerId: 'o1' });
      const res = mockRes();
      const next = mockNext();
      await checkStorageLimit(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });
});
