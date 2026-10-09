import crypto from 'crypto';
import { Readable } from 'stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createDecryptStreamFromStream,
  createEncryptStream,
  DEK_LENGTH,
  WRAPPED_DEK_LENGTH,
  generateDek,
  kekForVersion,
  newWrappedDek,
  primaryKekVersion,
  resolveIkm,
  rewrapDekToPrimary,
  unwrapDek,
  wrapDek,
} from '../../../utils/fileEncryption.js';

// A distinct, valid 64-hex KEK per version so we can exercise real rotation.
const KEK_V1 = 'a'.repeat(64);
const KEK_V2 = 'b'.repeat(64);

// The keyring after one rotation: v2 encrypts, v1 still unwraps.
const ROTATED = `1:${KEK_V1}
2:${KEK_V2}`;

const ENV_KEYS = ['FILE_ENCRYPTION_KEY'];
let saved;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  // Default posture: a plain key, which is version 1.
  process.env.FILE_ENCRYPTION_KEY = KEK_V1;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

describe('primaryKekVersion', () => {
  it('is 1 for a plain key', () => {
    expect(primaryKekVersion()).toBe(1);
  });

  it('is the highest version in the keyring, whatever the order', () => {
    process.env.FILE_ENCRYPTION_KEY = `7:${KEK_V2},3:${KEK_V1}`;
    expect(primaryKekVersion()).toBe(7);
  });

  it('is 1 in development without a key', () => {
    delete process.env.FILE_ENCRYPTION_KEY;
    expect(primaryKekVersion()).toBe(1);
  });
});

describe('wrapDek / unwrapDek', () => {
  it('round-trips a DEK through the wrap', () => {
    const kek = crypto.randomBytes(32);
    const dek = generateDek();
    const wrapped = wrapDek(dek, kek);
    expect(wrapped).toHaveLength(WRAPPED_DEK_LENGTH);
    expect(unwrapDek(wrapped, kek).equals(dek)).toBe(true);
  });

  it('never exposes the DEK in the wrapped blob', () => {
    const kek = crypto.randomBytes(32);
    const dek = generateDek();
    const wrapped = wrapDek(dek, kek);
    expect(wrapped.subarray(12, 44).equals(dek)).toBe(false); // ciphertext != plaintext
  });

  it('fails to unwrap with the wrong KEK', () => {
    const dek = generateDek();
    const wrapped = wrapDek(dek, crypto.randomBytes(32));
    expect(() => unwrapDek(wrapped, crypto.randomBytes(32))).toThrow();
  });

  it('fails to unwrap a tampered blob', () => {
    const kek = crypto.randomBytes(32);
    const wrapped = wrapDek(generateDek(), kek);
    wrapped[wrapped.length - 1] ^= 0xff; // corrupt the tag
    expect(() => unwrapDek(wrapped, kek)).toThrow();
  });

  it('rejects a DEK of the wrong size', () => {
    expect(() => wrapDek(crypto.randomBytes(16), crypto.randomBytes(32))).toThrow(/32-byte/);
  });

  it('rejects a wrapped blob of the wrong size', () => {
    expect(() => unwrapDek(crypto.randomBytes(10), crypto.randomBytes(32))).toThrow(/bytes/);
  });
});

describe('kekForVersion', () => {
  it('resolves the primary version through the master key', () => {
    expect(kekForVersion(1).equals(Buffer.from(KEK_V1, 'hex'))).toBe(true);
  });

  it('resolves every version in the keyring', () => {
    process.env.FILE_ENCRYPTION_KEY = ROTATED;
    expect(kekForVersion(1).equals(Buffer.from(KEK_V1, 'hex'))).toBe(true);
    expect(kekForVersion(2).equals(Buffer.from(KEK_V2, 'hex'))).toBe(true);
  });

  it('throws a clear error when the keyring lacks a version', () => {
    process.env.FILE_ENCRYPTION_KEY = `2:${KEK_V2}`;
    expect(() => kekForVersion(1)).toThrow(/has no key version 1/);
  });
});

describe('newWrappedDek', () => {
  it('mints a DEK wrapped under the current primary version', () => {
    const { dek, dekWrapped, kekVersion } = newWrappedDek();
    expect(dek).toHaveLength(DEK_LENGTH);
    expect(kekVersion).toBe(1);
    expect(unwrapDek(dekWrapped, kekForVersion(1)).equals(dek)).toBe(true);
  });
});

describe('resolveIkm', () => {
  it('throws for a row with no wrapped DEK (envelope is mandatory)', () => {
    expect(() => resolveIkm({ dekWrapped: null })).toThrow(/no wrapped DEK/);
    expect(() => resolveIkm({})).toThrow(/no wrapped DEK/);
  });

  it('unwraps the stored DEK for an envelope row', () => {
    const { dek, dekWrapped, kekVersion } = newWrappedDek();
    expect(resolveIkm({ dekWrapped, dekKekVersion: kekVersion }).equals(dek)).toBe(true);
  });

  it('accepts a wrapped DEK that arrives as a non-Buffer (e.g. a pg bytea)', () => {
    const { dek, dekWrapped, kekVersion } = newWrappedDek();
    const asUint8 = Uint8Array.from(dekWrapped);
    expect(resolveIkm({ dekWrapped: asUint8, dekKekVersion: kekVersion }).equals(dek)).toBe(true);
  });

  it('throws when a wrapped DEK has no version', () => {
    const { dekWrapped } = newWrappedDek();
    expect(() => resolveIkm({ dekWrapped, dekKekVersion: null })).toThrow(/KEK version/);
  });
});

describe('rewrapDekToPrimary (a key rotation, per file)', () => {
  it('rewraps a v1 DEK to the new primary v2 without changing the DEK', () => {
    // Start on v1 and mint a file.
    const original = newWrappedDek();

    // Operator rotates: v2 is now primary, v1 kept for unwrapping.
    process.env.FILE_ENCRYPTION_KEY = ROTATED;

    const rewrapped = rewrapDekToPrimary(original.dekWrapped, original.kekVersion);
    expect(rewrapped.kekVersion).toBe(2);
    // Same underlying DEK, so the file body still decrypts — only the wrap changed.
    expect(unwrapDek(rewrapped.dekWrapped, kekForVersion(2)).equals(original.dek)).toBe(true);
    // And the old KEK can no longer unwrap the new blob.
    expect(() => unwrapDek(rewrapped.dekWrapped, kekForVersion(1))).toThrow();
  });

  it('returns null when the DEK is already wrapped under the primary', () => {
    const { dekWrapped, kekVersion } = newWrappedDek();
    expect(rewrapDekToPrimary(dekWrapped, kekVersion)).toBe(null);
  });
});

describe('end-to-end: body encrypted under a wrapped DEK survives KEK rotation', () => {
  it('decrypts with the rewrapped DEK after the master key changes', async () => {
    const plaintext = crypto.randomBytes(200_000);

    // Encrypt the body under a fresh DEK (as an envelope upload would).
    const { dek, dekWrapped, kekVersion } = newWrappedDek();
    const ciphertext = await collect(Readable.from([plaintext]).pipe(createEncryptStream(dek)));

    // Rotate the master key v1 -> v2 and rewrap the DEK (no body rewrite).
    process.env.FILE_ENCRYPTION_KEY = ROTATED;
    const rotated = rewrapDekToPrimary(dekWrapped, kekVersion);

    // The body (never touched) decrypts via the ikm resolved from the new wrap.
    const ikm = resolveIkm({ dekWrapped: rotated.dekWrapped, dekKekVersion: rotated.kekVersion });
    const { stream } = await createDecryptStreamFromStream(Readable.from([ciphertext]), ikm);
    const out = await collect(stream);
    expect(out.equals(plaintext)).toBe(true);
  });
});
