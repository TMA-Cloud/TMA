import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createMimeSniffStream,
  detectMimeTypeFromContent,
  validateMimeType,
  validateOnlyOfficeMimeType,
} from '../../../utils/mimeTypeDetection.js';

/* ------------------------------------------------------------------ *
 * Fixtures: real magic bytes, padded so the detector has enough to
 * sniff.
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

const PLAIN_TEXT = pad(Buffer.from('just some plain text, nothing magic here\n'));

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

describe('createMimeSniffStream', () => {
  it('reports the type detected from content and passes the bytes through unchanged', async () => {
    let detected;
    const out = await collect(Readable.from([PDF]).pipe(createMimeSniffStream(mime => (detected = mime))));
    expect(detected).toBe('application/pdf');
    expect(out.equals(PDF)).toBe(true);
  });

  it('reports null when the content is not recognisable, leaving the fallback to the caller', async () => {
    let detected = 'unset';
    const out = await collect(Readable.from([PLAIN_TEXT]).pipe(createMimeSniffStream(mime => (detected = mime))));
    expect(detected).toBeNull();
    expect(out.equals(PLAIN_TEXT)).toBe(true);
  });

  it('reassembles content split across many small chunks before sniffing', async () => {
    const chunks = [];
    for (let i = 0; i < PDF.length; i += 32) chunks.push(PDF.subarray(i, i + 32));
    let detected;
    const out = await collect(Readable.from(chunks).pipe(createMimeSniffStream(mime => (detected = mime))));
    expect(detected).toBe('application/pdf');
    expect(out.equals(PDF)).toBe(true);
  });

  it('passes a large file through in full', async () => {
    const large = Buffer.concat([PDF, Buffer.alloc(100_000, 0x41)]);
    const out = await collect(Readable.from([large]).pipe(createMimeSniffStream(() => {})));
    expect(out).toHaveLength(large.length);
  });

  it('handles an empty stream without error', async () => {
    let detected = 'unset';
    const out = await collect(Readable.from([]).pipe(createMimeSniffStream(mime => (detected = mime))));
    expect(out).toHaveLength(0);
    expect(detected).toBeNull();
  });
});
