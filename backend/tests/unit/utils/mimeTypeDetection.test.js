import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createMimeCheckStream,
  detectMimeTypeFromContent,
  validateMimeType,
  validateMimeTypeFromBuffer,
  validateOnlyOfficeMimeType,
} from '../../../utils/mimeTypeDetection.js';

/* ------------------------------------------------------------------ *
 * Fixtures: real magic bytes, padded past the 256-byte floor that
 * validateMimeTypeFromBuffer uses before it bothers sniffing.
 * ------------------------------------------------------------------ */

const pad = (head, size = 1024) => Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length), 0x20)]);

const PNG = pad(
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0x00, 0x00, 0x00, 0x0d]),
    Buffer.from('IHDR'),
    Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
  ])
);

const JPEG = pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]));

const PDF = pad(Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n'));

const ZIP = pad(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(26), Buffer.from('some.txt')]));

/** A ZIP that carries the OOXML markers the validator looks for. */
const DOCX_LIKE = pad(
  Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.alloc(26),
    Buffer.from('[Content_Types].xml'),
    Buffer.from('word/document.xml'),
  ]),
  2048
);

const PLAIN_TEXT = pad(Buffer.from('just some plain text, nothing magic here\n'));

/** EBML header with a DocType, which is all that separates Matroska from WebM. */
const ebml = docType =>
  pad(
    Buffer.concat([
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80 | (19 + docType.length)]),
      Buffer.from('\x42\x86\x81\x01\x42\xF7\x81\x01\x42\xF2\x81\x04\x42\xF3\x81\x08\x42\x82', 'binary'),
      Buffer.from([0x80 | docType.length]),
      Buffer.from(docType),
    ])
  );

const MATROSKA = ebml('matroska');
const WEBM = ebml('webm');
const FLAC = pad(Buffer.from('fLaC'));

let tmpDir;
beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tma-mime-'));
});
afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

let counter = 0;
async function writeFixture(buffer, name = `f${counter++}.bin`) {
  const p = path.join(tmpDir, name);
  await fs.writeFile(p, buffer);
  return p;
}

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

describe('detectMimeTypeFromContent', () => {
  it('identifies a PNG from its magic bytes', async () => {
    expect(await detectMimeTypeFromContent(await writeFixture(PNG))).toBe('image/png');
  });

  it('identifies a JPEG', async () => {
    expect(await detectMimeTypeFromContent(await writeFixture(JPEG))).toBe('image/jpeg');
  });

  it('identifies a PDF', async () => {
    expect(await detectMimeTypeFromContent(await writeFixture(PDF))).toBe('application/pdf');
  });

  it('returns null for content with no recognisable signature', async () => {
    expect(await detectMimeTypeFromContent(await writeFixture(PLAIN_TEXT))).toBeNull();
  });

  it('returns null instead of throwing when the file is missing', async () => {
    expect(await detectMimeTypeFromContent(path.join(tmpDir, 'nope.bin'))).toBeNull();
  });
});

describe('validateMimeType', () => {
  it('prefers the detected type over the one the client declared', async () => {
    const result = await validateMimeType(await writeFixture(PNG), 'image/jpeg', 'photo.png', {
      suppressMismatchWarning: true,
    });
    expect(result.actualMimeType).toBe('image/png');
    expect(result.valid).toBe(true);
  });

  it('reports a mismatch through the hook so callers can audit it', async () => {
    const onMismatch = vi.fn();
    await validateMimeType(await writeFixture(PNG), 'application/pdf', 'doc.pdf', {
      suppressMismatchWarning: true,
      onMismatch,
    });
    expect(onMismatch).toHaveBeenCalledWith(
      expect.objectContaining({ declaredMimeType: 'application/pdf', actualMimeType: 'image/png' })
    );
  });

  it('stays quiet when the declared type is the generic octet-stream', async () => {
    const onMismatch = vi.fn();
    await validateMimeType(await writeFixture(PNG), 'application/octet-stream', 'photo.png', {
      suppressMismatchWarning: true,
      onMismatch,
    });
    expect(onMismatch).not.toHaveBeenCalled();
  });

  it('ignores MIME parameters such as charset when comparing', async () => {
    const onMismatch = vi.fn();
    await validateMimeType(await writeFixture(PNG), 'image/png; charset=binary', 'photo.png', {
      suppressMismatchWarning: true,
      onMismatch,
    });
    expect(onMismatch).not.toHaveBeenCalled();
  });

  it('falls back to the declared type when nothing can be detected', async () => {
    const onFallback = vi.fn();
    const result = await validateMimeType(await writeFixture(PLAIN_TEXT), 'text/plain', 'notes.txt', {
      suppressFallbackWarning: true,
      onFallback,
    });
    expect(result).toMatchObject({ valid: true, actualMimeType: 'text/plain', usedDeclaredFallback: true });
    expect(onFallback).toHaveBeenCalled();
  });

  it('never rejects an upload — it only reports what the content actually is', async () => {
    const result = await validateMimeType(await writeFixture(PNG), 'application/pdf', 'x.pdf', {
      suppressMismatchWarning: true,
    });
    expect(result.valid).toBe(true);
    expect(result.error).toBeNull();
  });
});

describe('validateMimeTypeFromBuffer', () => {
  it('accepts content that matches its extension', async () => {
    expect(await validateMimeTypeFromBuffer(PNG, 'photo.png')).toEqual({ valid: true, error: null });
    expect(await validateMimeTypeFromBuffer(PDF, 'doc.pdf')).toEqual({ valid: true, error: null });
  });

  it('rejects an executable disguised with an image extension', async () => {
    const exe = pad(Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)]));
    const result = await validateMimeTypeFromBuffer(exe, 'harmless.jpg');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/does not match extension \.jpg/);
  });

  it('rejects a PNG renamed to .pdf', async () => {
    expect((await validateMimeTypeFromBuffer(PNG, 'invoice.pdf')).valid).toBe(false);
  });

  it('accepts .jpg and .jpeg for the same content', async () => {
    expect((await validateMimeTypeFromBuffer(JPEG, 'a.jpg')).valid).toBe(true);
    expect((await validateMimeTypeFromBuffer(JPEG, 'a.jpeg')).valid).toBe(true);
  });

  it('matches the extension case-insensitively', async () => {
    expect((await validateMimeTypeFromBuffer(PNG, 'PHOTO.PNG')).valid).toBe(true);
  });

  it('skips validation for a buffer smaller than 256 bytes', async () => {
    expect(await validateMimeTypeFromBuffer(Buffer.from('tiny'), 'x.png')).toEqual({ valid: true, error: null });
  });

  it('skips validation when the buffer is missing', async () => {
    expect(await validateMimeTypeFromBuffer(null, 'x.png')).toEqual({ valid: true, error: null });
  });

  it('allows content whose signature is unrecognisable', async () => {
    expect((await validateMimeTypeFromBuffer(PLAIN_TEXT, 'notes.txt')).valid).toBe(true);
  });

  it('allows any content for an extension nobody has registered', async () => {
    expect((await validateMimeTypeFromBuffer(PNG, 'data.zzzz')).valid).toBe(true);
  });

  /**
   * The detector answers with both an extension and a MIME type, and its MIME
   * type frequently has no place in mime-db's extension index — Matroska sniffs
   * as video/matroska, which mime-db registers with no extensions at all while
   * listing video/x-matroska for .mkv. Comparing MIME strings alone therefore
   * refused ordinary media files.
   */
  describe('formats whose detected MIME type mime-db does not map to an extension', () => {
    it('accepts a Matroska video named .mkv', async () => {
      expect(await validateMimeTypeFromBuffer(MATROSKA, 'movie.mkv')).toEqual({ valid: true, error: null });
    });

    it('accepts a FLAC file named .flac', async () => {
      expect((await validateMimeTypeFromBuffer(FLAC, 'song.flac')).valid).toBe(true);
    });

    it('accepts either name for the container the two share', async () => {
      expect((await validateMimeTypeFromBuffer(MATROSKA, 'movie.webm')).valid).toBe(true);
      expect((await validateMimeTypeFromBuffer(WEBM, 'clip.mkv')).valid).toBe(true);
    });

    it('still refuses a program renamed to .mkv', async () => {
      const exe = pad(Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)]));
      expect((await validateMimeTypeFromBuffer(exe, 'movie.mkv')).valid).toBe(false);
    });

    it('still refuses content from an unrelated family', async () => {
      expect((await validateMimeTypeFromBuffer(MATROSKA, 'movie.mp4')).valid).toBe(false);
      expect((await validateMimeTypeFromBuffer(FLAC, 'song.mp3')).valid).toBe(false);
    });
  });

  describe('Office Open XML documents that sniff as plain ZIP', () => {
    it.each(['report.docx', 'sheet.xlsx', 'deck.pptx'])('accepts %s carrying OOXML markers', async name => {
      expect((await validateMimeTypeFromBuffer(DOCX_LIKE, name)).valid).toBe(true);
    });

    it('rejects a plain ZIP renamed to .docx', async () => {
      expect((await validateMimeTypeFromBuffer(ZIP, 'notreally.docx')).valid).toBe(false);
    });

    it('still accepts a genuine .zip', async () => {
      expect((await validateMimeTypeFromBuffer(ZIP, 'archive.zip')).valid).toBe(true);
    });
  });
});

describe('createMimeCheckStream', () => {
  it('passes matching content straight through, unchanged', async () => {
    const out = await collect(Readable.from([PNG]).pipe(createMimeCheckStream('photo.png')));
    expect(out.equals(PNG)).toBe(true);
  });

  it('destroys the stream when the content contradicts the extension', async () => {
    const exe = pad(Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)]), 16384);
    const stream = Readable.from([exe]).pipe(createMimeCheckStream('harmless.jpg'));
    await expect(collect(stream)).rejects.toThrow(/does not match extension/);
  });

  it('validates on flush when the file never reaches the buffer threshold', async () => {
    const stream = Readable.from([PNG]).pipe(createMimeCheckStream('invoice.pdf'));
    await expect(collect(stream)).rejects.toThrow(/does not match extension/);
  });

  it('reassembles content split across many small chunks', async () => {
    const chunks = [];
    for (let i = 0; i < PNG.length; i += 64) chunks.push(PNG.subarray(i, i + 64));
    const out = await collect(Readable.from(chunks).pipe(createMimeCheckStream('photo.png')));
    expect(out.equals(PNG)).toBe(true);
  });

  it('passes a large matching file through in full', async () => {
    const large = Buffer.concat([PNG, Buffer.alloc(100_000, 0x41)]);
    const out = await collect(Readable.from([large]).pipe(createMimeCheckStream('photo.png')));
    expect(out).toHaveLength(large.length);
  });

  it('handles an empty stream without error', async () => {
    expect(await collect(Readable.from([]).pipe(createMimeCheckStream('x.png')))).toHaveLength(0);
  });
});

describe('validateOnlyOfficeMimeType', () => {
  describe('encrypted files (stored MIME only)', () => {
    const check = (name, stored) => validateOnlyOfficeMimeType('/irrelevant', name, stored, true);

    it('accepts a docx with the OOXML word MIME', async () => {
      const result = await check(
        'report.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      );
      expect(result.valid).toBe(true);
    });

    it('accepts an xlsx with the OOXML spreadsheet MIME', async () => {
      const result = await check('sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      expect(result.valid).toBe(true);
    });

    it('accepts a legacy .doc reported as CFB/OLE', async () => {
      expect((await check('legacy.doc', 'application/x-cfb')).valid).toBe(true);
    });

    it('accepts a CSV declared as text/plain', async () => {
      expect((await check('data.csv', 'text/plain')).valid).toBe(true);
    });

    it('accepts a PDF', async () => {
      expect((await check('doc.pdf', 'application/pdf')).valid).toBe(true);
    });

    it('ignores MIME parameters', async () => {
      expect((await check('data.csv', 'text/plain; charset=utf-8')).valid).toBe(true);
    });

    it('rejects a stored MIME that contradicts the extension', async () => {
      const result = await check('report.docx', 'image/png');
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/type mismatch/i);
    });

    it('rejects when no MIME type was stored at all', async () => {
      const result = await check('report.docx', null);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/MIME type not available/i);
    });

    it('rejects an extension OnlyOffice does not handle', async () => {
      const result = await check('archive.zzzz', 'application/octet-stream');
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/not recognized or not supported/i);
    });

    it('reports the stored MIME back to the caller on success', async () => {
      const result = await check('doc.pdf', 'application/pdf');
      expect(result.actualMimeType).toBe('application/pdf');
    });
  });

  describe('S3 files (content detection skipped)', () => {
    it('validates against the stored MIME because the path is an object key', async () => {
      const result = await validateOnlyOfficeMimeType('objects/abc123', 'doc.pdf', 'application/pdf', false, true);
      expect(result.valid).toBe(true);
    });

    it('still rejects a contradiction', async () => {
      const result = await validateOnlyOfficeMimeType('objects/abc123', 'doc.pdf', 'image/png', false, true);
      expect(result.valid).toBe(false);
    });
  });

  describe('unencrypted local files (content is sniffed)', () => {
    it('accepts a real PDF on disk', async () => {
      const p = await writeFixture(PDF, 'real.pdf');
      const result = await validateOnlyOfficeMimeType(p, 'real.pdf', 'application/pdf', false, false);
      expect(result.valid).toBe(true);
      expect(result.actualMimeType).toBe('application/pdf');
    });

    it('rejects a PNG masquerading as a PDF', async () => {
      const p = await writeFixture(PNG, 'fake.pdf');
      const result = await validateOnlyOfficeMimeType(p, 'fake.pdf', 'application/pdf', false, false);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/type mismatch/i);
    });

    it('falls back to the stored MIME when detection fails but the stored type fits', async () => {
      const p = await writeFixture(PLAIN_TEXT, 'notes.csv');
      const result = await validateOnlyOfficeMimeType(p, 'notes.csv', 'text/csv', false, false);
      expect(result.valid).toBe(true);
    });

    it('rejects when detection fails and the stored type does not fit either', async () => {
      const p = await writeFixture(PLAIN_TEXT, 'suspect.docx');
      const result = await validateOnlyOfficeMimeType(p, 'suspect.docx', 'image/png', false, false);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/Unable to verify file type/i);
    });
  });
});
