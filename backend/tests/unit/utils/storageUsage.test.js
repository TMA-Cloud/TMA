import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getUserStorageLimit, getUserStorageUsage } = vi.hoisted(() => ({
  getUserStorageLimit: vi.fn(),
  getUserStorageUsage: vi.fn(),
}));
vi.mock('../../../models/user.model.js', () => ({ getUserStorageLimit, getUserStorageUsage }));

import { storageUsage } from '../../../controllers/user/user.storage.controller.js';
import { mockReq, mockRes } from '../../helpers/http.js';

beforeEach(() => getUserStorageUsage.mockResolvedValue(100));

describe('bucket quota reporting', () => {
  it.each([
    [null, { used: 100, total: null, free: null }],
    [500, { used: 100, total: 500, free: 400 }],
    [50, { used: 100, total: 50, free: 0 }],
  ])('reports quota %s independently of host disk capacity', async (limit, expected) => {
    getUserStorageLimit.mockResolvedValue(limit);
    const res = mockRes();
    await storageUsage(mockReq({ ownerId: 'owner' }), res);
    expect(res.body).toEqual(expected);
    expect(getUserStorageUsage).toHaveBeenCalledWith('owner');
    expect(getUserStorageLimit).toHaveBeenCalledWith('owner');
  });
});
