import crypto from 'crypto';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  copyEncryptedFile,
  copyEncryptedFileStreams,
  createByteCountStream,
  createDecryptStream,
  createDecryptStreamFromStream,
  createEncryptStream,
  createRangeDecryptStream,
  ciphertextSizeToPlaintextSize,
  decryptFile,
  encryptFile,
  getEncryptionKey,
  HEADER_LENGTH,
  TAG_LENGTH,
  PLAINTEXT_FIRST_SEGMENT_MAX,
  PLAINTEXT_SEGMENT_MAX,
} from '../../../utils/fileEncryption.js';

// Ciphertext overhead for a file that fits in a single segment.
const SINGLE_SEGMENT_OVERHEAD = HEADER_LENGTH + TAG_LENGTH; // 56

let tmpDir;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tma-enc-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

let counter = 0;
const tmp = (suffix = '') => path.join(tmpDir, `f${counter++}${suffix}`);

async function writePlain(content) {
  const p = tmp('.plain');
  await fs.writeFile(p, content);
  return p;
}

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Encrypt a Buffer to a Buffer via the streaming transform. */
async function encryptBuffer(plain) {
  return collect(Readable.from([plain]).pipe(createEncryptStream()));
}

/** A readRange backed by an in-memory ciphertext buffer (inclusive bounds). */
const rangeReaderFor = buf => (start, end) => Promise.resolve(Readable.from([buf.subarray(start, end + 1)]));

describe('getEncryptionKey', () => {
  const original = process.env.FILE_ENCRYPTION_KEY;

  afterEach(() => {
    process.env.FILE_ENCRYPTION_KEY = original;
  });

  it('always returns a 32-byte key', () => {
    expect(getEncryptionKey()).toHaveLength(32);
  });

  it('is deterministic, or previously encrypted files would be unreadable', () => {
    expect(getEncryptionKey().equals(getEncryptionKey())).toBe(true);
  });

  it('decodes a 64-character hex key directly', () => {
    process.env.FILE_ENCRYPTION_KEY = 'ab'.repeat(32);
    expect(getEncryptionKey()).toEqual(Buffer.from('ab'.repeat(32), 'hex'));
  });

  it('decodes a base64 key that is exactly 32 bytes', () => {
    const raw = crypto.randomBytes(32);
    process.env.FILE_ENCRYPTION_KEY = raw.toString('base64');
    expect(getEncryptionKey()).toEqual(raw);
  });

  it('derives a key with PBKDF2 from an arbitrary passphrase', () => {
    process.env.FILE_ENCRYPTION_KEY = 'a short passphrase';
    const derived = getEncryptionKey();
    expect(derived).toHaveLength(32);
    expect(derived).toEqual(crypto.pbkdf2Sync('a short passphrase', 'file-encryption-salt', 100000, 32, 'sha256'));
  });

  it('produces different keys for different passphrases', () => {
    process.env.FILE_ENCRYPTION_KEY = 'passphrase-one';
    const a = getEncryptionKey();
    process.env.FILE_ENCRYPTION_KEY = 'passphrase-two';
    expect(getEncryptionKey().equals(a)).toBe(false);
  });

  it('refuses to fall back to a development key in production', () => {
    delete process.env.FILE_ENCRYPTION_KEY;
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => getEncryptionKey()).toThrow(/FILE_ENCRYPTION_KEY is required in production/);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('falls back to a development key outside production', () => {
    delete process.env.FILE_ENCRYPTION_KEY;
    expect(getEncryptionKey()).toHaveLength(32);
  });
});

describe('encryptFile / decryptFile', () => {
  it('round-trips content unchanged', async () => {
    const plain = 'The quick brown fox jumps over the lazy dog.';
    const enc = tmp('.enc');
    const dec = tmp('.dec');

    await encryptFile(await writePlain(plain), enc);
    await decryptFile(enc, dec);

    expect(await fs.readFile(dec, 'utf8')).toBe(plain);
  });

  it('removes the plaintext source after encrypting', async () => {
    const src = await writePlain('secret');
    await encryptFile(src, tmp('.enc'));
    await expect(fs.access(src)).rejects.toThrow();
  });

  it('writes header + ciphertext + tag, so a single-segment file grows by 56 bytes', async () => {
    const enc = tmp('.enc');
    await encryptFile(await writePlain(Buffer.alloc(1000, 7)), enc);
    expect((await fs.stat(enc)).size).toBe(1000 + SINGLE_SEGMENT_OVERHEAD);
  });

  it('starts every object with the 40-byte streaming header', async () => {
    const enc = tmp('.enc');
    await encryptFile(await writePlain('hello'), enc);
    const raw = await fs.readFile(enc);
    expect(raw[0]).toBe(HEADER_LENGTH);
  });

  it('never leaves the plaintext visible in the ciphertext', async () => {
    const marker = 'SUPER-SECRET-MARKER-STRING';
    const enc = tmp('.enc');
    await encryptFile(await writePlain(marker), enc);
    expect((await fs.readFile(enc)).toString('latin1')).not.toContain(marker);
  });

  it('uses a fresh salt each time, so identical inputs give different ciphertext', async () => {
    const a = tmp('.enc');
    const b = tmp('.enc');
    await encryptFile(await writePlain('same content'), a);
    await encryptFile(await writePlain('same content'), b);
    expect((await fs.readFile(a)).equals(await fs.readFile(b))).toBe(false);
  });

  it('round-trips an empty file', async () => {
    const enc = tmp('.enc');
    const dec = tmp('.dec');
    await encryptFile(await writePlain(''), enc);
    expect((await fs.stat(enc)).size).toBe(SINGLE_SEGMENT_OVERHEAD);
    await decryptFile(enc, dec);
    expect((await fs.stat(dec)).size).toBe(0);
  });

  it('round-trips binary content byte for byte', async () => {
    const binary = crypto.randomBytes(64 * 1024);
    const enc = tmp('.enc');
    const dec = tmp('.dec');
    await encryptFile(await writePlain(binary), enc);
    await decryptFile(enc, dec);
    expect((await fs.readFile(dec)).equals(binary)).toBe(true);
  });

  it('round-trips content spanning multiple 1 MiB segments', async () => {
    const big = crypto.randomBytes(PLAINTEXT_FIRST_SEGMENT_MAX + PLAINTEXT_SEGMENT_MAX + 4096);
    const enc = tmp('.enc');
    const dec = tmp('.dec');
    await encryptFile(await writePlain(big), enc);
    await decryptFile(enc, dec);
    expect((await fs.readFile(dec)).equals(big)).toBe(true);
  });

  it('round-trips UTF-8 text with multi-byte characters', async () => {
    const text = '報告書 — résumé — 📄';
    const enc = tmp('.enc');
    const dec = tmp('.dec');
    await encryptFile(await writePlain(text), enc);
    await decryptFile(enc, dec);
    expect(await fs.readFile(dec, 'utf8')).toBe(text);
  });
});

describe('tamper detection', () => {
  async function makeEncrypted(content = 'authentic content') {
    const enc = tmp('.enc');
    await encryptFile(await writePlain(content), enc);
    return enc;
  }

  it('rejects a modified ciphertext body', async () => {
    const enc = await makeEncrypted();
    const bytes = await fs.readFile(enc);
    bytes[HEADER_LENGTH + 2] ^= 0xff;
    await fs.writeFile(enc, bytes);
    await expect(decryptFile(enc, tmp('.dec'))).rejects.toThrow();
  });

  it('rejects a modified authentication tag', async () => {
    const enc = await makeEncrypted();
    const bytes = await fs.readFile(enc);
    bytes[bytes.length - 1] ^= 0xff;
    await fs.writeFile(enc, bytes);
    await expect(decryptFile(enc, tmp('.dec'))).rejects.toThrow();
  });

  it('rejects a modified header (salt)', async () => {
    const enc = await makeEncrypted();
    const bytes = await fs.readFile(enc);
    bytes[1] ^= 0xff; // first salt byte
    await fs.writeFile(enc, bytes);
    await expect(decryptFile(enc, tmp('.dec'))).rejects.toThrow();
  });

  it('rejects a file signed with a different key', async () => {
    const original = process.env.FILE_ENCRYPTION_KEY;
    const enc = await makeEncrypted();
    process.env.FILE_ENCRYPTION_KEY = 'ff'.repeat(32);
    try {
      await expect(decryptFile(enc, tmp('.dec'))).rejects.toThrow();
    } finally {
      process.env.FILE_ENCRYPTION_KEY = original;
    }
  });

  it('rejects a file too short to hold a header', async () => {
    const truncated = tmp('.enc');
    await fs.writeFile(truncated, Buffer.alloc(20));
    await expect(decryptFile(truncated, tmp('.dec'))).rejects.toThrow();
  });
});

describe('createDecryptStream', () => {
  it('streams the original content back', async () => {
    const plain = 'streamed content that is reasonably long'.repeat(50);
    const enc = tmp('.enc');
    await encryptFile(await writePlain(plain), enc);
    const { stream } = await createDecryptStream(enc);
    expect((await collect(stream)).toString('utf8')).toBe(plain);
  });

  it('emits an error rather than silently truncating when the tag does not verify', async () => {
    const enc = tmp('.enc');
    await encryptFile(await writePlain('content'), enc);
    const bytes = await fs.readFile(enc);
    bytes[HEADER_LENGTH] ^= 0xff;
    await fs.writeFile(enc, bytes);
    const { stream } = await createDecryptStream(enc);
    await expect(collect(stream)).rejects.toThrow();
  });

  it('yields nothing for an empty encrypted file', async () => {
    const enc = tmp('.enc');
    await encryptFile(await writePlain(''), enc);
    const { stream } = await createDecryptStream(enc);
    expect(await collect(stream)).toHaveLength(0);
  });

  it('exposes a cleanup function that can be called safely', async () => {
    const enc = tmp('.enc');
    await encryptFile(await writePlain('x'), enc);
    const { cleanup } = await createDecryptStream(enc);
    expect(() => {
      cleanup();
      cleanup();
    }).not.toThrow();
  });
});

describe('createEncryptStream', () => {
  it('produces output that decryptFile can read back', async () => {
    const plain = crypto.randomBytes(50_000);
    const enc = tmp('.enc');
    const dec = tmp('.dec');
    await pipeline(Readable.from([plain]), createEncryptStream(), createWriteStream(enc));
    await decryptFile(enc, dec);
    expect((await fs.readFile(dec)).equals(plain)).toBe(true);
  });

  it('emits the header first, before any ciphertext', async () => {
    const out = await collect(Readable.from([Buffer.from('payload')]).pipe(createEncryptStream()));
    expect(out[0]).toBe(HEADER_LENGTH);
    expect(out.length).toBeGreaterThanOrEqual(HEADER_LENGTH);
  });

  it('still emits a valid header+tag envelope for an empty input', async () => {
    const out = await collect(Readable.from([]).pipe(createEncryptStream()));
    expect(out).toHaveLength(SINGLE_SEGMENT_OVERHEAD);
  });
});

describe('createByteCountStream', () => {
  it('counts every byte that passes through', async () => {
    const { stream, getByteCount } = createByteCountStream();
    const payload = Buffer.alloc(12345, 1);
    const out = await collect(Readable.from([payload]).pipe(stream));
    expect(getByteCount()).toBe(12345);
    expect(out.equals(payload)).toBe(true);
  });

  it('sums across multiple chunks', async () => {
    const { stream, getByteCount } = createByteCountStream();
    await collect(Readable.from([Buffer.alloc(10), Buffer.alloc(20), Buffer.alloc(30)]).pipe(stream));
    expect(getByteCount()).toBe(60);
  });

  it('reports zero for an empty stream', async () => {
    const { stream, getByteCount } = createByteCountStream();
    await collect(Readable.from([]).pipe(stream));
    expect(getByteCount()).toBe(0);
  });
});

describe('createDecryptStreamFromStream', () => {
  it('decrypts content arriving as a stream', async () => {
    const plain = 'content that came from object storage'.repeat(100);
    const enc = await encryptBuffer(Buffer.from(plain));
    const { stream } = await createDecryptStreamFromStream(Readable.from([enc]));
    expect((await collect(stream)).toString('utf8')).toBe(plain);
  });

  it('reassembles the header even when it is split across tiny chunks', async () => {
    const plain = 'chunked delivery';
    const enc = await encryptBuffer(Buffer.from(plain));
    const chunks = [];
    for (let i = 0; i < enc.length; i += 5) chunks.push(enc.subarray(i, i + 5));
    const { stream } = await createDecryptStreamFromStream(Readable.from(chunks));
    expect((await collect(stream)).toString('utf8')).toBe(plain);
  });

  it('errors on a stream too short to contain a header', async () => {
    const { stream } = await createDecryptStreamFromStream(Readable.from([Buffer.alloc(4)]));
    await expect(collect(stream)).rejects.toThrow();
  });

  it('errors on a tampered stream instead of returning garbage', async () => {
    const enc = await encryptBuffer(Buffer.from('authentic'));
    enc[enc.length - 3] ^= 0xff;
    const { stream } = await createDecryptStreamFromStream(Readable.from([enc]));
    await expect(collect(stream)).rejects.toThrow();
  });
});

describe('ciphertextSizeToPlaintextSize', () => {
  it('recovers the plaintext length from the ciphertext size for many sizes', async () => {
    const sizes = [
      0,
      1,
      1000,
      PLAINTEXT_FIRST_SEGMENT_MAX - 1,
      PLAINTEXT_FIRST_SEGMENT_MAX,
      PLAINTEXT_FIRST_SEGMENT_MAX + 1,
      PLAINTEXT_FIRST_SEGMENT_MAX + PLAINTEXT_SEGMENT_MAX,
      PLAINTEXT_FIRST_SEGMENT_MAX + PLAINTEXT_SEGMENT_MAX + 12345,
    ];
    for (const size of sizes) {
      const enc = await encryptBuffer(crypto.randomBytes(size));
      expect(ciphertextSizeToPlaintextSize(enc.length)).toBe(size);
    }
  });

  it('throws on an impossibly small ciphertext', () => {
    expect(() => ciphertextSizeToPlaintextSize(HEADER_LENGTH)).toThrow();
  });
});

describe('createRangeDecryptStream', () => {
  const plain = crypto.randomBytes(PLAINTEXT_FIRST_SEGMENT_MAX + PLAINTEXT_SEGMENT_MAX + 20000);
  let enc;
  let plaintextSize;

  beforeAll(async () => {
    enc = await encryptBuffer(plain);
    plaintextSize = plain.length;
  });

  async function readRange(start, end) {
    const { stream } = await createRangeDecryptStream({
      readRange: rangeReaderFor(enc),
      plaintextSize,
      start,
      end,
    });
    return collect(stream);
  }

  it('returns a small range at the very start', async () => {
    const out = await readRange(0, 9);
    expect(out.equals(plain.subarray(0, 10))).toBe(true);
  });

  it('returns a range that spans the segment-0/segment-1 boundary', async () => {
    const start = PLAINTEXT_FIRST_SEGMENT_MAX - 100;
    const end = PLAINTEXT_FIRST_SEGMENT_MAX + 100;
    const out = await readRange(start, end);
    expect(out.equals(plain.subarray(start, end + 1))).toBe(true);
  });

  it('returns a range fully inside a middle segment', async () => {
    const start = PLAINTEXT_FIRST_SEGMENT_MAX + 500;
    const end = PLAINTEXT_FIRST_SEGMENT_MAX + 1500;
    const out = await readRange(start, end);
    expect(out.equals(plain.subarray(start, end + 1))).toBe(true);
  });

  it('returns the final byte', async () => {
    const out = await readRange(plaintextSize - 1, plaintextSize - 1);
    expect(out.equals(plain.subarray(plaintextSize - 1))).toBe(true);
  });

  it('returns the entire file when the range covers everything', async () => {
    const out = await readRange(0, plaintextSize - 1);
    expect(out.equals(plain)).toBe(true);
  });
});

describe('copyEncryptedFile', () => {
  it('produces an independently decryptable copy', async () => {
    const plain = 'copy me';
    const src = tmp('.enc');
    const dst = tmp('.enc');
    const dec = tmp('.dec');
    await encryptFile(await writePlain(plain), src);
    await copyEncryptedFile(src, dst);
    await decryptFile(dst, dec);
    expect(await fs.readFile(dec, 'utf8')).toBe(plain);
  });

  it('re-encrypts under a new header rather than copying bytes', async () => {
    const src = tmp('.enc');
    const dst = tmp('.enc');
    await encryptFile(await writePlain('copy me'), src);
    await copyEncryptedFile(src, dst);
    const a = await fs.readFile(src);
    const b = await fs.readFile(dst);
    expect(a.equals(b)).toBe(false);
    expect(a.subarray(0, HEADER_LENGTH).equals(b.subarray(0, HEADER_LENGTH))).toBe(false);
    expect(b).toHaveLength(a.length);
  });

  it('leaves the source intact', async () => {
    const src = tmp('.enc');
    const dst = tmp('.enc');
    await encryptFile(await writePlain('original'), src);
    const before = await fs.readFile(src);
    await copyEncryptedFile(src, dst);
    expect((await fs.readFile(src)).equals(before)).toBe(true);
  });

  it('copies an empty file', async () => {
    const src = tmp('.enc');
    const dst = tmp('.enc');
    const dec = tmp('.dec');
    await encryptFile(await writePlain(''), src);
    await copyEncryptedFile(src, dst);
    await decryptFile(dst, dec);
    expect((await fs.stat(dec)).size).toBe(0);
  });

  it('refuses to copy a tampered source', async () => {
    const src = tmp('.enc');
    await encryptFile(await writePlain('content'), src);
    const bytes = await fs.readFile(src);
    bytes[HEADER_LENGTH + 1] ^= 0xff;
    await fs.writeFile(src, bytes);
    await expect(copyEncryptedFile(src, tmp('.enc'))).rejects.toThrow();
  });
});

describe('copyEncryptedFileStreams', () => {
  it('re-encrypts a stream into a writable and stays decryptable', async () => {
    const plain = 'stream copy payload'.repeat(200);
    const src = tmp('.enc');
    await encryptFile(await writePlain(plain), src);

    const dst = tmp('.enc');
    await copyEncryptedFileStreams(Readable.from([await fs.readFile(src)]), createWriteStream(dst));

    const dec = tmp('.dec');
    await decryptFile(dst, dec);
    expect(await fs.readFile(dec, 'utf8')).toBe(plain);
  });
});
