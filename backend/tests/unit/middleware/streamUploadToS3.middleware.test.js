/**
 * The failure paths matter more than the happy path here: a file the magic-byte
 * check refuses used to leave the S3 put waiting on a stream that would never
 * end, so the request never answered and the client's upload sat there forever.
 */
import { PassThrough } from 'stream';

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../../models/user.model.js', () => ({
  getMaxUploadSizeSettings: vi.fn(async () => ({ maxBytes: 10 * 1024 * 1024 })),
}));

vi.mock('../../../utils/fileEncryption.js', () => ({
  createEncryptStream: () => new PassThrough(),
  createByteCountStream: () => {
    let byteCount = 0;
    const stream = new PassThrough();
    stream.on('data', chunk => {
      byteCount += chunk.length;
    });
    return { stream, getByteCount: () => byteCount };
  },
}));

const putStream = vi.fn(
  (_key, stream) =>
    new Promise((resolve, reject) => {
      stream.on('data', () => {});
      stream.on('end', resolve);
      stream.on('error', reject);
    })
);
const deleteObject = vi.fn(async () => {});

vi.mock('../../../utils/storageDriver.js', () => ({
  default: {
    putStream: (...args) => putStream(...args),
    deleteObject: (...args) => deleteObject(...args),
  },
}));

const { streamUploadToS3 } = await import('../../../middleware/streamUploadToS3.middleware.js');

const BOUNDARY = 'testboundary';

/** A PDF header padded past the 256-byte floor the detector needs to judge content. */
function pdfBytes() {
  return Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(600, 0x20)]);
}

function multipartBody(files) {
  const parts = [];
  for (const { field = 'files', filename, content } of files) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
          'Content-Type: application/octet-stream\r\n\r\n'
      ),
      content,
      Buffer.from('\r\n')
    );
  }
  parts.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(parts);
}

/**
 * Runs the middleware over a synthetic multipart request and resolves with
 * whatever it hands on. A middleware that never calls next fails by timeout,
 * which is exactly the stuck-upload bug.
 */
function run(mode, files) {
  const req = new PassThrough();
  req.headers = { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` };
  const res = new PassThrough();
  res.statusCode = 200;

  const done = new Promise(resolve => {
    streamUploadToS3(mode)(req, res, err => resolve({ err, req }));
  });

  req.end(multipartBody(files));
  return done;
}

beforeEach(() => {
  putStream.mockClear();
  deleteObject.mockClear();
});

describe('streamUploadToS3', () => {
  it('answers instead of hanging when a bulk file fails the MIME check', async () => {
    const { err, req } = await run('bulk', [{ filename: 'clip.mp4', content: pdfBytes() }]);

    expect(err).toBeUndefined();
    expect(req.streamedUploads).toEqual([]);
    expect(req.streamedUploadFailures).toEqual([
      { fileName: 'clip.mp4', error: 'File content does not match extension .mp4', index: 0 },
    ]);
  });

  it('still uploads the good files in a batch that contains a rejected one', async () => {
    const { err, req } = await run('bulk', [
      { filename: 'clip.mp4', content: pdfBytes() },
      { filename: 'doc.pdf', content: pdfBytes() },
    ]);

    expect(err).toBeUndefined();
    expect(req.streamedUploads.map(u => u.name)).toEqual(['doc.pdf']);
    expect(req.streamedUploadFailures.map(f => f.fileName)).toEqual(['clip.mp4']);
    // Both keep the ordinal of the part they arrived on. The controller reads
    // the folder and timestamp fields by that ordinal, so a rejected file must
    // not renumber the ones behind it.
    expect(req.streamedUploads[0].index).toBe(1);
    expect(req.streamedUploadFailures[0].index).toBe(0);
  });

  it('rejects a single upload with the reason and a client-error status', async () => {
    const { err } = await run('single', [{ field: 'file', filename: 'clip.mp4', content: pdfBytes() }]);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('File content does not match extension .mp4');
    expect(err.status).toBe(415);
  });

  it('passes a file whose content matches its extension', async () => {
    const { err, req } = await run('single', [{ field: 'file', filename: 'doc.pdf', content: pdfBytes() }]);

    expect(err).toBeUndefined();
    expect(req.streamedUpload).toMatchObject({ name: 'doc.pdf', size: 609 });
  });
});
