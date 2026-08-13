import crypto from 'crypto';
import fs from 'fs/promises';
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
  decryptFile,
  encryptFile,
  getEncryptionKey,
  isFileEncrypted,
  readEncryptionMetadata,
} from '../../../utils/fileEncryption.js';

const IV_LENGTH = 16;
const TAG_LENGTH = 16;

let tmpDir;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tma-enc-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

let counter = 0;
const tmp = (suffix = '') => path.join(tmpDir, `f${counter++}${suffix}`);

/** Write plaintext to a temp file and return its path. */
async function writePlain(content) {
  const p = tmp('.plain');
  await fs.writeFile(p, content);
  return p;
}

/** Drain a readable into a Buffer. */
async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

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
    const src = await writePlain(plain);
    const enc = tmp('.enc');
    const dec = tmp('.dec');

    await encryptFile(src, enc);
    await decryptFile(enc, dec);

    expect(await fs.readFile(dec, 'utf8')).toBe(plain);
  });

  it('removes the plaintext source after encrypting', async () => {
    const src = await writePlain('secret');
    const enc = tmp('.enc');
    await encryptFile(src, enc);
    await expect(fs.access(src)).rejects.toThrow();
  });

  it('writes [IV][ciphertext][TAG], so the file grows by exactly 32 bytes', async () => {
    const content = Buffer.alloc(1000, 7);
    const src = await writePlain(content);
    const enc = tmp('.enc');
    await encryptFile(src, enc);
    expect((await fs.stat(enc)).size).toBe(1000 + IV_LENGTH + TAG_LENGTH);
  });

  it('never leaves the plaintext visible in the ciphertext', async () => {
    const marker = 'SUPER-SECRET-MARKER-STRING';
    const src = await writePlain(marker);
    const enc = tmp('.enc');
    await encryptFile(src, enc);
    expect((await fs.readFile(enc)).toString('latin1')).not.toContain(marker);
  });

  it('uses a fresh IV each time, so identical inputs give different ciphertext', async () => {
    const a = tmp('.enc');
    const b = tmp('.enc');
    await encryptFile(await writePlain('same content'), a);
    await encryptFile(await writePlain('same content'), b);
    expect((await fs.readFile(a)).equals(await fs.readFile(b))).toBe(false);
  });

  it('round-trips an empty file', async () => {
    const src = await writePlain('');
    const enc = tmp('.enc');
    const dec = tmp('.dec');
    await encryptFile(src, enc);
    expect((await fs.stat(enc)).size).toBe(IV_LENGTH + TAG_LENGTH);
    await decryptFile(enc, dec);
    expect((await fs.stat(dec)).size).toBe(0);
  });

  it('round-trips binary content byte for byte', async () => {
    const binary = crypto.randomBytes(64 * 1024);
    const src = await writePlain(binary);
    const enc = tmp('.enc');
    const dec = tmp('.dec');
    await encryptFile(src, enc);
    await decryptFile(enc, dec);
    expect((await fs.readFile(dec)).equals(binary)).toBe(true);
  });

  it('round-trips content larger than the stream chunk size', async () => {
    const big = crypto.randomBytes(1024 * 1024);
    const src = await writePlain(big);
    const enc = tmp('.enc');
    const dec = tmp('.dec');
    await encryptFile(src, enc);
    await decryptFile(enc, dec);
    expect((await fs.readFile(dec)).equals(big)).toBe(true);
  });

  it('round-trips UTF-8 text with multi-byte characters', async () => {
    const text = '報告書 — résumé — 📄';
    const src = await writePlain(text);
    const enc = tmp('.enc');
    const dec = tmp('.dec');
    await encryptFile(src, enc);
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
    const enc = await makeEncrypted('authentic content');
    const bytes = await fs.readFile(enc);
    bytes[IV_LENGTH + 2] ^= 0xff;
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

  it('rejects a modified IV', async () => {
    const enc = await makeEncrypted();
    const bytes = await fs.readFile(enc);
    bytes[0] ^= 0xff;
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

  it('rejects a file too short to hold an IV and tag', async () => {
    const truncated = tmp('.enc');
    await fs.writeFile(truncated, Buffer.alloc(20));
    await expect(readEncryptionMetadata(truncated)).rejects.toThrow(/too small/i);
  });
});

describe('readEncryptionMetadata', () => {
  it('reads the IV from the head and the tag from the tail', async () => {
    const enc = tmp('.enc');
    await encryptFile(await writePlain('hello'), enc);

    const { iv, tag, fileSize } = await readEncryptionMetadata(enc);
    const raw = await fs.readFile(enc);

    expect(iv).toHaveLength(IV_LENGTH);
    expect(tag).toHaveLength(TAG_LENGTH);
    expect(iv.equals(raw.subarray(0, IV_LENGTH))).toBe(true);
    expect(tag.equals(raw.subarray(raw.length - TAG_LENGTH))).toBe(true);
    expect(fileSize).toBe(raw.length);
  });

  it('accepts a file that holds nothing but an IV and a tag', async () => {
    const enc = tmp('.enc');
    await encryptFile(await writePlain(''), enc);
    await expect(readEncryptionMetadata(enc)).resolves.toBeDefined();
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
    bytes[IV_LENGTH] ^= 0xff;
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

describe('createEncryptStream (used for direct-to-S3 upload)', () => {
  it('produces output that decryptFile can read back', async () => {
    const plain = crypto.randomBytes(50_000);
    const enc = tmp('.enc');
    const dec = tmp('.dec');

    await pipeline(Readable.from([plain]), createEncryptStream(), (await import('fs')).createWriteStream(enc));
    await decryptFile(enc, dec);

    expect((await fs.readFile(dec)).equals(plain)).toBe(true);
  });

  it('emits the IV first, before any ciphertext', async () => {
    const out = await collect(Readable.from([Buffer.from('payload')]).pipe(createEncryptStream()));
    const { iv } = await (async () => {
      const enc = tmp('.enc');
      await fs.writeFile(enc, out);
      return readEncryptionMetadata(enc);
    })();
    expect(out.subarray(0, IV_LENGTH).equals(iv)).toBe(true);
  });

  it('still emits a valid IV+tag envelope for an empty input', async () => {
    const out = await collect(Readable.from([]).pipe(createEncryptStream()));
    expect(out).toHaveLength(IV_LENGTH + TAG_LENGTH);
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

describe('createDecryptStreamFromStream (used for S3 reads)', () => {
  it('decrypts content arriving as a stream', async () => {
    const plain = 'content that came from object storage'.repeat(100);
    const enc = tmp('.enc');
    await encryptFile(await writePlain(plain), enc);

    const encrypted = Readable.from([await fs.readFile(enc)]);
    const { stream } = await createDecryptStreamFromStream(encrypted);

    expect((await collect(stream)).toString('utf8')).toBe(plain);
  });

  it('reassembles the IV even when it is split across chunks', async () => {
    const plain = 'chunked delivery';
    const enc = tmp('.enc');
    await encryptFile(await writePlain(plain), enc);
    const raw = await fs.readFile(enc);

    const chunks = [];
    for (let i = 0; i < raw.length; i += 5) chunks.push(raw.subarray(i, i + 5));

    const { stream } = await createDecryptStreamFromStream(Readable.from(chunks));
    expect((await collect(stream)).toString('utf8')).toBe(plain);
  });

  it('rejects a stream too short to contain an IV', async () => {
    await expect(createDecryptStreamFromStream(Readable.from([Buffer.alloc(4)]))).rejects.toThrow(/too short for IV/);
  });

  it('errors on a tampered stream instead of returning garbage', async () => {
    const enc = tmp('.enc');
    await encryptFile(await writePlain('authentic'), enc);
    const raw = await fs.readFile(enc);
    raw[raw.length - 3] ^= 0xff;

    const { stream } = await createDecryptStreamFromStream(Readable.from([raw]));
    await expect(collect(stream)).rejects.toThrow();
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

  it('re-encrypts under a new IV rather than copying bytes', async () => {
    const src = tmp('.enc');
    const dst = tmp('.enc');
    await encryptFile(await writePlain('copy me'), src);
    await copyEncryptedFile(src, dst);

    const a = await fs.readFile(src);
    const b = await fs.readFile(dst);
    expect(a.equals(b)).toBe(false);
    expect(a.subarray(0, IV_LENGTH).equals(b.subarray(0, IV_LENGTH))).toBe(false);
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
    bytes[IV_LENGTH + 1] ^= 0xff;
    await fs.writeFile(src, bytes);

    await expect(copyEncryptedFile(src, tmp('.enc'))).rejects.toThrow();
  });
});

describe('copyEncryptedFileStreams (S3 to S3 copy)', () => {
  it('re-encrypts a stream into a writable and stays decryptable', async () => {
    const plain = 'stream copy payload'.repeat(200);
    const src = tmp('.enc');
    await encryptFile(await writePlain(plain), src);

    const dst = tmp('.enc');
    const { createWriteStream } = await import('fs');
    await copyEncryptedFileStreams(Readable.from([await fs.readFile(src)]), createWriteStream(dst));

    const dec = tmp('.dec');
    await decryptFile(dst, dec);
    expect(await fs.readFile(dec, 'utf8')).toBe(plain);
  });
});

describe('isFileEncrypted', () => {
  it('reports true for a real encrypted file', async () => {
    const enc = tmp('.enc');
    await encryptFile(await writePlain('content'), enc);
    expect(await isFileEncrypted(enc)).toBe(true);
  });

  it('reports false for a file smaller than the IV+tag envelope', async () => {
    const small = tmp('.bin');
    await fs.writeFile(small, Buffer.alloc(10));
    expect(await isFileEncrypted(small)).toBe(false);
  });

  it('reports false for a missing file rather than throwing', async () => {
    expect(await isFileEncrypted(path.join(tmpDir, 'does-not-exist'))).toBe(false);
  });

  it('only checks size, so a large plaintext file also reports true', async () => {
    // This is a structural check, not a cryptographic one — the codebase relies
    // on isFilePathEncrypted() for the real answer.
    const plain = tmp('.txt');
    await fs.writeFile(plain, Buffer.alloc(100, 65));
    expect(await isFileEncrypted(plain)).toBe(true);
  });
});
