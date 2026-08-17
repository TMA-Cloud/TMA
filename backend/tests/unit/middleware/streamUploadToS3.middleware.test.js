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

function partHeader(field, filename) {
  return Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n'
  );
}

function multipartBody(files) {
  const parts = [];
  for (const { field = 'files', filename, content } of files) {
    parts.push(partHeader(field, filename), content, Buffer.from('\r\n'));
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

  it('answers a refused single upload without reading the rest of the body', async () => {
    const req = new PassThrough();
    req.headers = { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` };
    const res = new PassThrough();
    res.statusCode = 200;

    const done = new Promise(resolve => {
      streamUploadToS3('single')(req, res, resolve);
    });

    // Only the opening of the body, and no end to the part. The check settles
    // as soon as it has buffered enough to judge, which is what a client
    // halfway through a huge file looks like.
    req.write(partHeader('file', 'clip.mp4'));
    req.write(Buffer.concat([pdfBytes(), Buffer.alloc(16 * 1024, 0x20)]));

    const err = await done;
    expect(err.status).toBe(415);

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
