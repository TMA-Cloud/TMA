import { generate } from 'otplib';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockReq, mockRes } from '../../helpers/http.js';

vi.mock('../../../models/user.model.js', () => ({
  canRegenerateBackupCodes: vi.fn(),
  claimBackupCodeRegeneration: vi.fn(),
  consumeMfaTimeStep: vi.fn(),
  deleteBackupCodes: vi.fn(),
  disableMfa: vi.fn(),
  enableMfa: vi.fn(),
  generateBackupCodes: vi.fn(),
  getMfaStatus: vi.fn(),
  getRemainingBackupCodesCount: vi.fn(),
  getUserById: vi.fn(),
  replaceBackupCodes: vi.fn(),
  setMfaSecret: vi.fn(),
  verifyAndConsumeBackupCode: vi.fn(),
}));

const models = await import('../../../models/user.model.js');
const { disableMfaController, regenerateBackupCodes, setupMfa, verifyAndEnableMfa, verifyMfaCode } =
  await import('../../../controllers/auth/auth.mfa.controller.js');

const USER = 'user000000000001';

// A secret in the format speakeasy wrote before the move to otplib: RFC 4648
// base32, uppercase, unpadded. Enrolments predating the swap must keep working.
const LEGACY_SECRET = 'MVXXQ5KOMFXTO6RZJBKGCYZWOVDU2RRTEE5WEVCYFJWHKKBTGNJQ';

// Backup codes are 8 characters from an unambiguous alphabet, so they can never
// parse as a TOTP token.
const BACKUP_CODE = 'K7QMZR4T';

async function post(handler, body) {
  const req = mockReq({ method: 'POST', body, userId: USER });
  const res = mockRes();
  await handler(req, res);
  return res;
}

const currentTimeStep = () => Math.floor(Date.now() / 1000 / 30);

beforeEach(() => {
  vi.clearAllMocks();
  models.getUserById.mockResolvedValue({ id: USER, email: 'user@example.com' });
  models.getMfaStatus.mockResolvedValue({ enabled: true, secret: LEGACY_SECRET, lastTimeStep: null });
  models.generateBackupCodes.mockResolvedValue([BACKUP_CODE]);
  models.replaceBackupCodes.mockResolvedValue([BACKUP_CODE]);
  models.verifyAndConsumeBackupCode.mockResolvedValue(false);
  // The step is unspent unless a test says otherwise.
  models.consumeMfaTimeStep.mockResolvedValue(true);
});

describe('setupMfa', () => {
  it('issues a 160-bit secret, which base32-encodes to 32 characters', async () => {
    models.getMfaStatus.mockResolvedValue({ enabled: false });
    const res = await post(setupMfa, {});
    expect(res.body.secret).toMatch(/^[A-Z2-7]{32}$/);
  });

  it('stores the secret unenabled so it only sticks once the user proves they scanned it', async () => {
    models.getMfaStatus.mockResolvedValue({ enabled: false });
    const res = await post(setupMfa, {});
    expect(models.setMfaSecret).toHaveBeenCalledWith(USER, res.body.secret, false);
  });

  it('returns a QR code the authenticator app can scan', async () => {
    models.getMfaStatus.mockResolvedValue({ enabled: false });
    const res = await post(setupMfa, {});
    expect(res.body.qrCode).toMatch(/^data:image\/png;base64,/);
  });

  it('generates a secret an authenticator app can immediately produce codes for', async () => {
    models.getMfaStatus.mockResolvedValue({ enabled: false });
    const res = await post(setupMfa, {});
    const secret = res.body.secret;

    models.getMfaStatus.mockResolvedValue({ enabled: false, secret, lastTimeStep: null });
    const enabled = await post(verifyAndEnableMfa, { code: await generate({ secret }) });
    expect(models.enableMfa).toHaveBeenCalledWith(USER);
    expect(enabled.statusCode).toBe(200);
  });
});

describe('verifyAndEnableMfa', () => {
  // Enrolment runs against a stored-but-not-yet-enabled secret.
  beforeEach(() => {
    models.getMfaStatus.mockResolvedValue({ enabled: false, secret: LEGACY_SECRET, lastTimeStep: null });
  });

  it('accepts a current code generated from a secret stored before the otplib move', async () => {
    const res = await post(verifyAndEnableMfa, { code: await generate({ secret: LEGACY_SECRET }) });
    expect(models.enableMfa).toHaveBeenCalledWith(USER);
    expect(res.statusCode).toBe(200);
  });

  it('accepts a code from the previous time step, the one step RFC 6238 §5.2 allows', async () => {
    const epoch = Math.floor(Date.now() / 1000) - 30;
    const res = await post(verifyAndEnableMfa, { code: await generate({ secret: LEGACY_SECRET, epoch }) });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a code two steps old, which the old two-step window let through', async () => {
    const epoch = Math.floor(Date.now() / 1000) - 60;
    const res = await post(verifyAndEnableMfa, { code: await generate({ secret: LEGACY_SECRET, epoch }) });
    expect(res.statusCode).toBe(400);
    expect(models.enableMfa).not.toHaveBeenCalled();
  });

  it('rejects a code from the next step, since delay only runs backwards', async () => {
    const epoch = Math.floor(Date.now() / 1000) + 30;
    const res = await post(verifyAndEnableMfa, { code: await generate({ secret: LEGACY_SECRET, epoch }) });
    expect(res.statusCode).toBe(400);
    expect(models.enableMfa).not.toHaveBeenCalled();
  });

  it('rejects a code from well outside the tolerance window', async () => {
    const epoch = Math.floor(Date.now() / 1000) - 300;
    const res = await post(verifyAndEnableMfa, { code: await generate({ secret: LEGACY_SECRET, epoch }) });
    expect(res.statusCode).toBe(400);
    expect(models.enableMfa).not.toHaveBeenCalled();
  });

  it.each([
    ['too short', '12345'],
    ['too long', '1234567'],
    ['non-numeric', 'ABCDEF'],
    ['empty', ''],
  ])('answers a %s code with a 400, not a server error', async (_label, code) => {
    const res = await post(verifyAndEnableMfa, { code });
    expect(res.statusCode).toBe(400);
  });

  it('does not enable MFA when the secret on file is unreadable', async () => {
    models.getMfaStatus.mockResolvedValue({ enabled: false, secret: 'not-valid-base32!!', lastTimeStep: null });
    const res = await post(verifyAndEnableMfa, { code: '123456' });
    expect(res.statusCode).toBe(400);
    expect(models.enableMfa).not.toHaveBeenCalled();
  });

  it('refuses to re-run on an already-enabled account, which would mint extra backup codes', async () => {
    models.getMfaStatus.mockResolvedValue({ enabled: true, secret: LEGACY_SECRET, lastTimeStep: null });

    const res = await post(verifyAndEnableMfa, { code: await generate({ secret: LEGACY_SECRET }) });

    expect(res.statusCode).toBe(400);
    expect(models.generateBackupCodes).not.toHaveBeenCalled();
  });
});

describe('verifyMfaCode', () => {
  it('accepts a valid TOTP code', async () => {
    expect(await verifyMfaCode(USER, await generate({ secret: LEGACY_SECRET }))).toBe(true);
  });

  it('falls through to the backup code, which is not a 6-digit token', async () => {
    models.verifyAndConsumeBackupCode.mockResolvedValue(true);
    expect(await verifyMfaCode(USER, BACKUP_CODE)).toBe(true);
    expect(models.verifyAndConsumeBackupCode).toHaveBeenCalledWith(USER, BACKUP_CODE);
  });

  it('rejects a wrong code without consuming a backup code', async () => {
    expect(await verifyMfaCode(USER, '000000')).toBe(false);
  });

  it('returns false rather than throwing on junk input', async () => {
    for (const code of ['', 'abc', null, undefined, 123456]) {
      expect(await verifyMfaCode(USER, code)).toBe(false);
    }
  });

  it('is false when MFA is off', async () => {
    models.getMfaStatus.mockResolvedValue({ enabled: false });
    expect(await verifyMfaCode(USER, await generate({ secret: LEGACY_SECRET }))).toBe(false);
  });
});

describe('replay protection', () => {
  it('spends the time step the accepted code belongs to', async () => {
    await verifyMfaCode(USER, await generate({ secret: LEGACY_SECRET }));
    expect(models.consumeMfaTimeStep).toHaveBeenCalledWith(USER, currentTimeStep());
  });

  it('refuses a code whose step was already spent', async () => {
    models.getMfaStatus.mockResolvedValue({
      enabled: true,
      secret: LEGACY_SECRET,
      lastTimeStep: currentTimeStep(),
    });
    expect(await verifyMfaCode(USER, await generate({ secret: LEGACY_SECRET }))).toBe(false);
  });

  it('refuses the previous step once the current one is spent', async () => {
    models.getMfaStatus.mockResolvedValue({
      enabled: true,
      secret: LEGACY_SECRET,
      lastTimeStep: currentTimeStep(),
    });
    const epoch = Math.floor(Date.now() / 1000) - 30;
    expect(await verifyMfaCode(USER, await generate({ secret: LEGACY_SECRET, epoch }))).toBe(false);
  });

  it('loses to a concurrent login that spent the same step first', async () => {
    // The DB write arbitrates the race, so its false must sink the request
    // even though the code itself verified.
    models.consumeMfaTimeStep.mockResolvedValue(false);
    expect(await verifyMfaCode(USER, await generate({ secret: LEGACY_SECRET }))).toBe(false);
  });

  it('still accepts the next step after one is spent', async () => {
    const spent = currentTimeStep() - 1;
    models.getMfaStatus.mockResolvedValue({ enabled: true, secret: LEGACY_SECRET, lastTimeStep: spent });
    expect(await verifyMfaCode(USER, await generate({ secret: LEGACY_SECRET }))).toBe(true);
  });

  it('does not spend a step when the code is wrong', async () => {
    await verifyMfaCode(USER, '000000');
    expect(models.consumeMfaTimeStep).not.toHaveBeenCalled();
  });

  it('does not spend a step for a backup code', async () => {
    models.verifyAndConsumeBackupCode.mockResolvedValue(true);
    await verifyMfaCode(USER, BACKUP_CODE);
    expect(models.consumeMfaTimeStep).not.toHaveBeenCalled();
  });

  it('lets the user in rather than locking them out when the stored step is in the future', async () => {
    // A clock moved backwards leaves a step ahead of now, which throws.
    // Treating that throw as a bad code would bar the account.
    models.getMfaStatus.mockResolvedValue({
      enabled: true,
      secret: LEGACY_SECRET,
      lastTimeStep: currentTimeStep() + 5000,
    });
    expect(await verifyMfaCode(USER, await generate({ secret: LEGACY_SECRET }))).toBe(true);
  });

  it.each([
    ['a non-integer', 1.5],
    ['a negative', -1],
    ['a string from a driver that did not cast', '12345'],
    ['undefined', undefined],
  ])('tolerates %s stored step without failing the check', async (_label, lastTimeStep) => {
    models.getMfaStatus.mockResolvedValue({ enabled: true, secret: LEGACY_SECRET, lastTimeStep });
    expect(await verifyMfaCode(USER, await generate({ secret: LEGACY_SECRET }))).toBe(true);
  });
});

describe('regenerateBackupCodes', () => {
  beforeEach(() => {
    models.claimBackupCodeRegeneration.mockResolvedValue(true);
    models.canRegenerateBackupCodes.mockResolvedValue({ allowed: true, remainingMs: 0 });
  });

  it('replaces the old codes in one call, so a failure cannot strand the user', async () => {
    const res = await post(regenerateBackupCodes, {});
    expect(models.replaceBackupCodes).toHaveBeenCalledWith(USER, 10);
    expect(models.deleteBackupCodes).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('claims the cooldown before doing any work', async () => {
    await post(regenerateBackupCodes, {});
    expect(models.claimBackupCodeRegeneration).toHaveBeenCalledWith(USER);
  });

  it('refuses when the cooldown claim is lost, and issues no codes', async () => {
    models.claimBackupCodeRegeneration.mockResolvedValue(false);
    models.canRegenerateBackupCodes.mockResolvedValue({ allowed: false, remainingMs: 90_000 });

    const res = await post(regenerateBackupCodes, {});

    expect(res.statusCode).toBe(429);
    expect(models.replaceBackupCodes).not.toHaveBeenCalled();
  });

  it('still reports a wait time when the claim is lost to a concurrent request', async () => {
    // The loser can find the cooldown already satisfied, so remainingMs may be
    // absent; the response must not read "NaN seconds".
    models.claimBackupCodeRegeneration.mockResolvedValue(false);
    models.canRegenerateBackupCodes.mockResolvedValue({ allowed: true, remainingMs: null });

    const res = await post(regenerateBackupCodes, {});

    expect(res.statusCode).toBe(429);
    expect(JSON.stringify(res.body)).not.toMatch(/NaN/);
  });

  it('does nothing when MFA is off', async () => {
    models.getMfaStatus.mockResolvedValue({ enabled: false });
    const res = await post(regenerateBackupCodes, {});
    expect(res.statusCode).toBe(400);
    expect(models.claimBackupCodeRegeneration).not.toHaveBeenCalled();
  });
});

describe('disableMfaController', () => {
  it('disables on a valid TOTP code', async () => {
    const res = await post(disableMfaController, { code: await generate({ secret: LEGACY_SECRET }) });
    expect(models.disableMfa).toHaveBeenCalledWith(USER);
    expect(res.statusCode).toBe(200);
  });

  it('disables on a backup code when the user has lost their authenticator', async () => {
    models.verifyAndConsumeBackupCode.mockResolvedValue(true);
    const res = await post(disableMfaController, { code: BACKUP_CODE });
    expect(models.disableMfa).toHaveBeenCalledWith(USER);
    expect(res.statusCode).toBe(200);
  });

  it('refuses when neither the TOTP nor the backup code matches', async () => {
    const res = await post(disableMfaController, { code: 'ZZZZZZZZ' });
    expect(res.statusCode).toBe(400);
    expect(models.disableMfa).not.toHaveBeenCalled();
  });
});
