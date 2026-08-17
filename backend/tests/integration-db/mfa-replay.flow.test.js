/**
 * TOTP replay protection against real rows.
 *
 * The claim worth proving is atomicity: a read-then-write version of
 * `consumeMfaTimeStep` passes every mocked test and still lets concurrent
 * logins reuse one code, so the race only means something against real pg.
 */

import { describe, expect, it, vi } from 'vitest';

import pool from '../../config/db.js';
import * as idUtil from '../../utils/id.js';
import {
  claimBackupCodeRegeneration,
  consumeMfaTimeStep,
  disableMfa,
  generateBackupCodes,
  getMfaStatus,
  getRemainingBackupCodesCount,
  replaceBackupCodes,
  setMfaSecret,
  verifyAndConsumeBackupCode,
} from '../../models/user.model.js';
import { ensureOwner } from './helpers/app.js';

const SECRET = 'MVXXQ5KOMFXTO6RZJBKGCYZWOVDU2RRTEE5WEVCYFJWHKKBTGNJQ';

async function storedStep(userId) {
  const { rows } = await pool.query('SELECT mfa_last_time_step FROM users WHERE id = $1', [userId]);
  return rows[0].mfa_last_time_step === null ? null : Number(rows[0].mfa_last_time_step);
}

/**
 * Open every pooled connection before a race starts. Without this the test
 * proves nothing: pg connects lazily, and the handshake delay lets each caller
 * finish before the next begins. A read-then-write impl survives a cold-pool
 * race and loses a warm one every time.
 */
async function warmPool(size = 10) {
  const clients = await Promise.all(Array.from({ length: size }, () => pool.connect()));
  clients.forEach(client => client.release());
}

/** A user with MFA enrolled and no step spent yet. */
async function enrolledUser() {
  const { user } = await ensureOwner();
  await setMfaSecret(user.id, SECRET, true);
  return user.id;
}

describe('consumeMfaTimeStep', () => {
  it('accepts a step the user has not spent', async () => {
    const userId = await enrolledUser();
    expect(await consumeMfaTimeStep(userId, 59566760)).toBe(true);
    expect(await storedStep(userId)).toBe(59566760);
  });

  it('refuses the same step twice, which is the replay it exists to stop', async () => {
    const userId = await enrolledUser();
    await consumeMfaTimeStep(userId, 59566760);
    expect(await consumeMfaTimeStep(userId, 59566760)).toBe(false);
  });

  it('refuses an earlier step, so an older code cannot be walked back', async () => {
    const userId = await enrolledUser();
    await consumeMfaTimeStep(userId, 59566760);
    expect(await consumeMfaTimeStep(userId, 59566759)).toBe(false);
    expect(await storedStep(userId)).toBe(59566760);
  });

  it('accepts the next step, so normal logins keep working', async () => {
    const userId = await enrolledUser();
    await consumeMfaTimeStep(userId, 59566760);
    expect(await consumeMfaTimeStep(userId, 59566761)).toBe(true);
    expect(await storedStep(userId)).toBe(59566761);
  });

  it('lets exactly one of ten concurrent claims on the same step win', async () => {
    const userId = await enrolledUser();
    await warmPool();

    const results = await Promise.all(Array.from({ length: 10 }, () => consumeMfaTimeStep(userId, 59566760)));

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await storedStep(userId)).toBe(59566760);
  });

  it('does not touch other users', async () => {
    const userId = await enrolledUser();
    const otherId = await enrolledUser();

    await consumeMfaTimeStep(userId, 59566760);

    expect(await storedStep(otherId)).toBeNull();
    expect(await consumeMfaTimeStep(otherId, 59566760)).toBe(true);
  });
});

describe('secret lifecycle', () => {
  it('clears the spent step when a new secret is stored, so re-enrolment is not blocked', async () => {
    const userId = await enrolledUser();
    await consumeMfaTimeStep(userId, 59566760);

    await setMfaSecret(userId, SECRET, false);

    expect(await storedStep(userId)).toBeNull();
    // Claimable again: the step belongs to a different secret now.
    expect(await consumeMfaTimeStep(userId, 59566759)).toBe(true);
  });

  it('clears the spent step when MFA is disabled', async () => {
    const userId = await enrolledUser();
    await consumeMfaTimeStep(userId, 59566760);

    await disableMfa(userId);

    expect(await storedStep(userId)).toBeNull();
  });

  it('reports the spent step to callers as a number, not a driver string', async () => {
    const userId = await enrolledUser();
    await consumeMfaTimeStep(userId, 59566760);

    const status = await getMfaStatus(userId);
    expect(status.lastTimeStep).toBe(59566760);
  });

  it('reports null before any code has been accepted', async () => {
    const userId = await enrolledUser();
    expect((await getMfaStatus(userId)).lastTimeStep).toBeNull();
  });
});

describe('backup codes', () => {
  it('consumes a valid code once', async () => {
    const userId = await enrolledUser();
    const [code] = await generateBackupCodes(userId, 3);

    expect(await verifyAndConsumeBackupCode(userId, code)).toBe(true);
    expect(await getRemainingBackupCodesCount(userId)).toBe(2);
  });

  it('refuses the same code a second time', async () => {
    const userId = await enrolledUser();
    const [code] = await generateBackupCodes(userId, 3);

    await verifyAndConsumeBackupCode(userId, code);
    expect(await verifyAndConsumeBackupCode(userId, code)).toBe(false);
  });

  it('lets exactly one of five concurrent uses of one code win', async () => {
    const userId = await enrolledUser();
    const [code] = await generateBackupCodes(userId, 3);
    await warmPool();

    const results = await Promise.all(Array.from({ length: 5 }, () => verifyAndConsumeBackupCode(userId, code)));

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await getRemainingBackupCodesCount(userId)).toBe(2);
  });

  it('rejects a code belonging to another user', async () => {
    const userId = await enrolledUser();
    const otherId = await enrolledUser();
    const [code] = await generateBackupCodes(otherId, 3);

    expect(await verifyAndConsumeBackupCode(userId, code)).toBe(false);
    expect(await getRemainingBackupCodesCount(otherId)).toBe(3);
  });
});

describe('replaceBackupCodes', () => {
  it('swaps the old set for a new one', async () => {
    const userId = await enrolledUser();
    const [oldCode] = await generateBackupCodes(userId, 3);

    const fresh = await replaceBackupCodes(userId, 4);

    expect(await getRemainingBackupCodesCount(userId)).toBe(4);
    expect(await verifyAndConsumeBackupCode(userId, oldCode)).toBe(false);
    expect(await verifyAndConsumeBackupCode(userId, fresh[0])).toBe(true);
  });

  it('keeps the old codes when the insert fails partway', async () => {
    const userId = await enrolledUser();
    const [oldCode] = await generateBackupCodes(userId, 3);

    // Force a duplicate primary key on the second insert: without a shared
    // transaction the delete would already have committed, leaving no codes.
    const ids = vi.spyOn(idUtil, 'generateId').mockReturnValue('duplicate-id');
    await expect(replaceBackupCodes(userId, 3)).rejects.toThrow();
    ids.mockRestore();

    expect(await getRemainingBackupCodesCount(userId)).toBe(3);
    expect(await verifyAndConsumeBackupCode(userId, oldCode)).toBe(true);
  });
});

describe('regeneration cooldown', () => {
  it('allows the first claim and blocks the next', async () => {
    const userId = await enrolledUser();

    expect(await claimBackupCodeRegeneration(userId)).toBe(true);
    expect(await claimBackupCodeRegeneration(userId)).toBe(false);
  });

  it('allows a claim again once the cooldown has passed', async () => {
    const userId = await enrolledUser();
    await claimBackupCodeRegeneration(userId);

    await pool.query("UPDATE users SET last_backup_code_regeneration = NOW() - INTERVAL '6 minutes' WHERE id = $1", [
      userId,
    ]);

    expect(await claimBackupCodeRegeneration(userId)).toBe(true);
  });

  it('lets exactly one of five concurrent claims win', async () => {
    const userId = await enrolledUser();
    await warmPool();

    const results = await Promise.all(Array.from({ length: 5 }, () => claimBackupCodeRegeneration(userId)));

    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
