import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockReq, mockRes } from '../../helpers/http.js';

vi.mock('../../../models/user.model.js', () => ({
  isFirstUser: vi.fn(async () => true),
  getCloudDriveSaveOnly: vi.fn(async () => true),
  setCloudDriveSaveOnly: vi.fn(async () => {}),
}));
vi.mock('../../../services/auditLogger.js', () => ({ logAuditEvent: vi.fn(async () => {}) }));

const { isFirstUser, getCloudDriveSaveOnly, setCloudDriveSaveOnly } = await import('../../../models/user.model.js');
const { logAuditEvent } = await import('../../../services/auditLogger.js');
const { getCloudDriveConfig, updateCloudDriveConfig } =
  await import('../../../controllers/user/user.admin.clouddrive.controller.js');

beforeEach(() => {
  vi.mocked(isFirstUser).mockResolvedValue(true);
  vi.mocked(getCloudDriveSaveOnly).mockResolvedValue(true);
  vi.mocked(setCloudDriveSaveOnly).mockClear();
  vi.mocked(logAuditEvent).mockClear();
});

describe('getCloudDriveConfig', () => {
  it('tells any signed-in user the mode, and that only the first user may change it', async () => {
    vi.mocked(isFirstUser).mockResolvedValue(false);
    const res = mockRes();
    await getCloudDriveConfig(mockReq({ userId: 'user-2' }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ saveOnly: true, canConfigure: false });
  });
});

describe('updateCloudDriveConfig', () => {
  it("saves the first user's choice and audits it", async () => {
    vi.mocked(getCloudDriveSaveOnly).mockResolvedValue(false);
    const res = mockRes();
    await updateCloudDriveConfig(mockReq({ userId: 'admin', body: { saveOnly: false } }), res);

    expect(setCloudDriveSaveOnly).toHaveBeenCalledWith(false, 'admin');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ saveOnly: false, canConfigure: true });
    expect(logAuditEvent).toHaveBeenCalledWith(
      'admin.settings.update',
      expect.objectContaining({ status: 'success', metadata: { setting: 'cloud_drive_save_only', saveOnly: false } }),
      expect.anything()
    );
  });

  it('refuses anyone else and records the attempt', async () => {
    vi.mocked(isFirstUser).mockResolvedValue(false);
    const res = mockRes();
    await updateCloudDriveConfig(mockReq({ userId: 'user-2', body: { saveOnly: false } }), res);

    expect(res.statusCode).toBe(403);
    expect(setCloudDriveSaveOnly).not.toHaveBeenCalled();
    expect(logAuditEvent).toHaveBeenCalledWith(
      'admin.settings.update',
      expect.objectContaining({ status: 'failure' }),
      expect.anything()
    );
  });

  it('answers 403 when the first user changes during the save', async () => {
    vi.mocked(setCloudDriveSaveOnly).mockRejectedValueOnce(
      new Error('Only the first user can configure the Cloud Drive mode')
    );
    const res = mockRes();
    await updateCloudDriveConfig(mockReq({ userId: 'admin', body: { saveOnly: false } }), res);

    expect(res.statusCode).toBe(403);
  });
});
