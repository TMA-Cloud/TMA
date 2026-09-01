/**
 * The failure paths matter more than the happy path here: a rejected file (too
 * large, storage down) used to leave the S3 put waiting on a stream that would
 * never end, so the request never answered and the client's upload sat there
 * forever. Content that merely contradicts its extension is not a rejection —
 * the store keeps it — so those tests assert it is uploaded, not refused.
 */
import { PassThrough } from 'stream';

import { describe, expect, it, vi, beforeEach } from 'vitest';

const { getMaxUploadSizeSettings } = vi.hoisted(() => ({
  getMaxUploadSizeSettings: vi.fn(async () => ({ maxBytes: 10 * 1024 * 1024 })),
}));

vi.mock('../../../models/user.model.js', () => ({ getMaxUploadSizeSettings }));

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

function partHeader(field, filename, contentType = 'application/octet-stream') {
  return Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`
  );
}

function multipartBody(files) {
  const parts = [];
  for (const { field = 'files', filename, content, contentType } of files) {
    parts.push(partHeader(field, filename, contentType), content, Buffer.from('\r\n'));
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
  it('stores a bulk file whose content does not match its extension', async () => {
    const { err, req } = await run('bulk', [{ filename: 'clip.mp4', content: pdfBytes() }]);

    expect(err).toBeUndefined();
    expect(req.streamedUploadFailures).toEqual([]);
    expect(req.streamedUploads.map(u => u.name)).toEqual(['clip.mp4']);
  });

  it('stores the type detected from content, not the extension or the declared header', async () => {
    // PDF bytes, a .mp4 name, and a declared type that is neither: the stored
    // type comes from the content.
    const { req } = await run('single', [
      { field: 'file', filename: 'clip.mp4', content: pdfBytes(), contentType: 'video/mp4' },
    ]);

    expect(req.streamedUpload.mimeType).toBe('application/pdf');
  });

  it('falls back to the declared type when the content is not recognisable', async () => {
    const { req } = await run('single', [
      { field: 'file', filename: 'notes.txt', content: Buffer.alloc(600, 0x20), contentType: 'text/plain' },
    ]);

    expect(req.streamedUpload.mimeType).toBe('text/plain');
  });

  it('keeps every file in a batch, mismatched or not, in part order', async () => {
    const { err, req } = await run('bulk', [
      { filename: 'clip.mp4', content: pdfBytes() },
      { filename: 'doc.pdf', content: pdfBytes() },
    ]);

    expect(err).toBeUndefined();
    expect(req.streamedUploadFailures).toEqual([]);
    // Both keep the ordinal of the part they arrived on. The controller reads
    // the folder and timestamp fields by that ordinal, so the order must hold.
    expect(req.streamedUploads.map(u => u.name)).toEqual(['clip.mp4', 'doc.pdf']);
    expect(req.streamedUploads.map(u => u.index)).toEqual([0, 1]);
  });

  it('stores a single upload whose content does not match its extension', async () => {
    const { err, req } = await run('single', [{ field: 'file', filename: 'clip.mp4', content: pdfBytes() }]);

    expect(err).toBeUndefined();
    expect(req.streamedUpload).toMatchObject({ name: 'clip.mp4', index: 0 });
  });

  it('aborts a too-large single upload without reading the rest of the body', async () => {
    getMaxUploadSizeSettings.mockResolvedValueOnce({ maxBytes: 1024 });

    const req = new PassThrough();
    req.headers = { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` };
    const res = new PassThrough();
    res.statusCode = 200;

    const done = new Promise(resolve => {
      streamUploadToS3('single')(req, res, resolve);
    });

    // Open the part and pour in more than the limit, with no end to it. The
    // size guard settles as soon as the ceiling is crossed, which is what a
    // client halfway through a huge file looks like.
    req.write(partHeader('file', 'big.bin'));
    req.write(Buffer.alloc(4 * 1024, 0x20));

    const err = await done;
    expect(err.status).toBe(413);

    // What the client is still sending now piles up unread. Node closes a
    // connection whose request never completed, and that close is what stops a
    // 6GB upload that was decided in its first few KB.
    req.write(Buffer.alloc(256 * 1024));
    await new Promise(resolve => {
      setImmediate(resolve);
    });
    expect(req.readableLength + req.writableLength).toBeGreaterThan(0);
  });

  /**
   * When the destination dies it destroys the body it was reading, and the
   * chain reports that teardown as an abort. Reporting the abort would answer
   * 400 — "your request was bad" — for an outage the client had no part in, and
   * bury the reason behind "The operation was aborted".
   */
  describe('when storage itself fails mid-upload', () => {
    /** Rejects the way the S3 SDK does, after destroying the body it was reading. */
    function storageOutage() {
      putStream.mockImplementationOnce((_key, stream) => {
        const err = Object.assign(new Error('The service is unavailable. Please retry.'), {
          name: 'ServiceUnavailable',
          $fault: 'server',
          $metadata: { httpStatusCode: 503 },
        });
        stream.destroy(Object.assign(new Error('The operation was aborted'), { code: 'ABORT_ERR' }));
        return Promise.reject(err);
      });
    }

    it('answers 503 and names the storage, not the abort', async () => {
      storageOutage();
      const { err } = await run('single', [{ field: 'file', filename: 'doc.pdf', content: pdfBytes() }]);

      expect(err.message).toBe('Storage is temporarily unavailable. Please try again.');
      expect(err.status).toBe(503);
    });

    it('reports the same reason per file in a batch', async () => {
      storageOutage();
      const { req } = await run('bulk', [{ filename: 'doc.pdf', content: pdfBytes() }]);

      expect(req.streamedUploads).toEqual([]);
      expect(req.streamedUploadFailures).toEqual([
        { fileName: 'doc.pdf', error: 'Storage is temporarily unavailable. Please try again.', index: 0 },
      ]);
    });
  });

  it('does not record an upload whose body stopped early', async () => {
    // A put that calls a truncated body a success would otherwise be written to
    // the database as a complete file.
    putStream.mockImplementationOnce((_key, stream) => {
      stream.destroy(Object.assign(new Error('The operation was aborted'), { code: 'ABORT_ERR' }));
      return Promise.resolve();
    });

    const { req } = await run('bulk', [{ filename: 'doc.pdf', content: pdfBytes() }]);

    expect(req.streamedUploads).toEqual([]);
    expect(req.streamedUploadFailures.map(f => f.error)).toEqual(['Upload failed']);
    expect(deleteObject).toHaveBeenCalled();
  });

  /**
   * Cancelling is the user's decision, not a fault. Nobody is left to read an
   * answer, and every error the teardown raises names the hangup rather than
   * anything wrong with the file.
   */
  it('records nothing and answers nobody when the client hangs up', async () => {
    const req = new PassThrough();
    req.headers = { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` };
    const res = new PassThrough();
    res.statusCode = 200;

    const handedOff = vi.fn();
    streamUploadToS3('single')(req, res, handedOff);

    req.write(partHeader('file', 'doc.pdf'));
    req.write(Buffer.concat([pdfBytes(), Buffer.alloc(16 * 1024, 0x20)]));
    await new Promise(resolve => {
      setImmediate(resolve);
    });

    req.emit('aborted');
    await new Promise(resolve => {
      setTimeout(resolve, 20);
    });

    expect(handedOff).not.toHaveBeenCalled();
    expect(req.streamedUploadFailures).toBeUndefined();
  });

  it('sweeps what a cancelled upload had already written', async () => {
    const req = new PassThrough();
    req.headers = { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` };
    const res = new PassThrough();
    res.statusCode = 200;

    streamUploadToS3('bulk')(req, res, () => {});
    await new Promise(resolve => {
      setImmediate(resolve);
    });

    // A sibling that finished before the cancel: the response never finishes, so
    // the listener that normally sweeps these never runs.
    req._s3UploadedKeys.push('already-there.pdf');
    req.emit('aborted');

    expect(deleteObject).toHaveBeenCalledWith('already-there.pdf');
    expect(req._s3UploadedKeys).toEqual([]);
  });

  it('passes a file whose content matches its extension', async () => {
    const { err, req } = await run('single', [{ field: 'file', filename: 'doc.pdf', content: pdfBytes() }]);

    expect(err).toBeUndefined();
    expect(req.streamedUpload).toMatchObject({ name: 'doc.pdf', size: 609 });
  });
});
