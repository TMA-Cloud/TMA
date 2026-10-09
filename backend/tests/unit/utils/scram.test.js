import { describe, expect, it } from 'vitest';

import { scramSha256Verifier } from '../../../utils/scram.js';

// Stored by PostgreSQL 18 for CREATE ROLE ... PASSWORD 'pencil password 0123456789'.
const SERVER_VERIFIER =
  'SCRAM-SHA-256$4096:gx49RhGjpk5Vn44Q5wzWFw==$yijh08e4EFK7zfcSR55G270VhZiTfPhPEUIBrMgMFFk=:0Ju1x1ULJJSjIPl19yfErjQwffcIt6OZ60cneHgv+30=';

describe('scramSha256Verifier', () => {
  it('matches the verifier PostgreSQL computes for the same salt', () => {
    const salt = Buffer.from('gx49RhGjpk5Vn44Q5wzWFw==', 'base64');
    expect(scramSha256Verifier('pencil password 0123456789', { salt })).toBe(SERVER_VERIFIER);
  });

  it('uses a new random salt each time', () => {
    const a = scramSha256Verifier('same-password-123');
    const b = scramSha256Verifier('same-password-123');
    expect(a).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}:[A-Za-z0-9+/=]{44}$/);
    expect(a).not.toBe(b);
  });

  it('does not contain the password', () => {
    expect(scramSha256Verifier('visible-password-xyz')).not.toContain('visible-password-xyz');
  });

  it('rejects characters SASLprep would change', () => {
    expect(() => scramSha256Verifier('pässword-longer-than-16')).toThrow(/printable ASCII/);
    expect(() => scramSha256Verifier('tab\tinside-password')).toThrow(/printable ASCII/);
  });
});
