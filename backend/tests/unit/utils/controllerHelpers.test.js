import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/auditLogger.js', () => ({ logAuditEvent: vi.fn() }));
vi.mock('../../../config/logger.js', () => ({ logger: { error: vi.fn(), info: vi.fn() } }));

const { logAuditEvent } = await import('../../../services/auditLogger.js');

import {
  logBulkFileAudit,
  streamBulkProgress,
  validateFileIds,
  validateParentId,
  validateSingleId,
  wantsProgressStream,
} from '../../../utils/controllerHelpers.js';

/** Minimal Express response stub that records the NDJSON lines written. */
function fakeRes() {
  const res = {
    headers: null,
    ended: false,
    lines: [],
    writeHead(status, headers) {
      res.status = status;
      res.headers = headers;
    },
    write(chunk) {
      String(chunk)
        .split('\n')
        .filter(Boolean)
        .forEach(l => res.lines.push(JSON.parse(l)));
    },
    end() {
      res.ended = true;
    },
  };
  return res;
}

const ID = 'abcDEF1234567890';
const ID2 = 'zyxWVU0987654321';
const req = { userId: 'u1' };

beforeEach(() => {
  logAuditEvent.mockClear();
});

describe('validateParentId', () => {
  it('treats a missing parent as the root folder', () => {
    expect(validateParentId({ body: {} })).toEqual({ valid: true, parentId: null, error: null });
  });

  it('treats an explicit null parent as the root folder', () => {
    expect(validateParentId({ body: { parentId: null } })).toEqual({ valid: true, parentId: null, error: null });
  });

  it('treats an empty-string parent as the root folder', () => {
    expect(validateParentId({ body: { parentId: '' } }).parentId).toBeNull();
  });

  it('returns a valid parent id unchanged', () => {
    expect(validateParentId({ body: { parentId: ID } })).toEqual({ valid: true, parentId: ID, error: null });
  });

  it('rejects a malformed parent id', () => {
    const result = validateParentId({ body: { parentId: 'nope' } });
    expect(result).toEqual({ valid: false, parentId: null, error: 'Invalid parent ID' });
  });

  it('reads from the query string when asked', () => {
    const req = { body: { parentId: ID }, query: { parentId: ID2 } };
    expect(validateParentId(req, 'query').parentId).toBe(ID2);
  });

  it('defaults to the body when the source is not "query"', () => {
    const req = { body: { parentId: ID }, query: { parentId: ID2 } };
    expect(validateParentId(req, 'body').parentId).toBe(ID);
    expect(validateParentId(req).parentId).toBe(ID);
  });
});

describe('validateFileIds', () => {
  it('returns a validated list', () => {
    expect(validateFileIds({ body: { ids: [ID, ID2] } })).toEqual({ valid: true, ids: [ID, ID2], error: null });
  });

  it('rejects an empty list', () => {
    expect(validateFileIds({ body: { ids: [] } })).toEqual({ valid: false, ids: null, error: 'Invalid ids array' });
  });

  it('rejects a missing ids field', () => {
    expect(validateFileIds({ body: {} }).valid).toBe(false);
  });

  it('rejects the whole batch if any id is malformed', () => {
    expect(validateFileIds({ body: { ids: [ID, '../../etc/passwd'] } }).valid).toBe(false);
  });

  it('rejects a single id sent outside an array', () => {
    expect(validateFileIds({ body: { ids: ID } }).valid).toBe(false);
  });
});

describe('validateSingleId', () => {
  it('reads the id route param by default', () => {
    expect(validateSingleId({ params: { id: ID } })).toEqual({ valid: true, id: ID, error: null });
  });

  it('reads a named param', () => {
    const req = { params: { fileId: ID } };
    expect(validateSingleId(req, 'fileId').id).toBe(ID);
  });

  it('reads from the body when asked', () => {
    const req = { params: {}, body: { id: ID } };
    expect(validateSingleId(req, 'id', 'body').id).toBe(ID);
  });

  it('names the offending parameter in the error', () => {
    const result = validateSingleId({ params: { fileId: 'bad' } }, 'fileId');
    expect(result).toEqual({ valid: false, id: null, error: 'Invalid fileId' });
  });

  it('rejects a missing param', () => {
    expect(validateSingleId({ params: {} }).valid).toBe(false);
  });
});

describe('logBulkFileAudit', () => {
  it('attributes the batch to its first item and lists the whole batch in metadata', async () => {
    await logBulkFileAudit(
      'file.move',
      {
        ids: [ID, ID2],
        fileNames: ['a.txt', 'photos'],
        fileTypes: ['file', 'folder'],
        metadata: { targetParentId: null, targetFolderName: 'Home' },
      },
      req
    );

    expect(logAuditEvent).toHaveBeenCalledWith(
      'file.move',
      {
        status: 'success',
        resourceType: 'file',
        resourceId: ID,
        metadata: {
          fileCount: 2,
          fileIds: [ID, ID2],
          fileNames: ['a.txt', 'photos'],
          fileTypes: ['file', 'folder'],
          targetParentId: null,
          targetFolderName: 'Home',
        },
      },
      req
    );
  });

  it('reports a folder-led batch as a folder resource', async () => {
    await logBulkFileAudit('file.restore', { ids: [ID], fileNames: ['docs'], fileTypes: ['folder'] }, req);

    expect(logAuditEvent.mock.calls[0][1].resourceType).toBe('folder');
  });

  it('falls back to a file resource when the batch carries no types', async () => {
    await logBulkFileAudit('file.delete', { ids: [ID], fileNames: ['a.txt'], fileTypes: [] }, req);

    expect(logAuditEvent.mock.calls[0][1].resourceType).toBe('file');
  });
});

describe('wantsProgressStream', () => {
  it('is true only when the client opts into NDJSON', () => {
    expect(wantsProgressStream({ headers: { accept: 'application/x-ndjson' } })).toBe(true);
    expect(wantsProgressStream({ headers: { accept: 'application/json' } })).toBe(false);
    expect(wantsProgressStream({ headers: {} })).toBe(false);
    expect(wantsProgressStream({})).toBe(false);
  });
});

describe('streamBulkProgress', () => {
  it('streams a progress line per batch, tied to real completion, then a done line', async () => {
    const res = fakeRes();
    const processed = [];
    await streamBulkProgress(res, {
      ids: ['a', 'b', 'c', 'd', 'e'],
      chunkSize: 2,
      processChunk: async chunk => {
        processed.push(...chunk);
      },
      finalize: async () => ({ message: 'done' }),
    });

    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toContain('application/x-ndjson');
    expect(res.ended).toBe(true);
    // Every id was actually processed.
    expect(processed).toEqual(['a', 'b', 'c', 'd', 'e']);
    // Initial 0, then after each of the 3 batches (2+2+1), then the done line.
    expect(res.lines).toEqual([
      { type: 'progress', done: 0, total: 5 },
      { type: 'progress', done: 2, total: 5 },
      { type: 'progress', done: 4, total: 5 },
      { type: 'progress', done: 5, total: 5 },
      { type: 'done', message: 'done' },
    ]);
  });

  it('keeps a small selection to one fast batch (bar jumps 0→100)', async () => {
    const res = fakeRes();
    let batches = 0;
    await streamBulkProgress(res, {
      ids: Array.from({ length: 10 }, (_, i) => `id${i}`),
      processChunk: async () => {
        batches += 1;
      },
      finalize: async () => ({ message: 'ok' }),
    });

    expect(batches).toBe(1); // below MIN_BATCH_SIZE, so a single operation
    expect(res.lines).toEqual([
      { type: 'progress', done: 0, total: 10 },
      { type: 'progress', done: 10, total: 10 },
      { type: 'done', message: 'ok' },
    ]);
  });

  it('bounds the number of progress steps for a large selection', async () => {
    const res = fakeRes();
    let batches = 0;
    await streamBulkProgress(res, {
      ids: Array.from({ length: 1000 }, (_, i) => `id${i}`),
      processChunk: async () => {
        batches += 1;
      },
    });

    // 1000 / 20 steps = 50 per batch → exactly 20 batches, never one-per-item.
    expect(batches).toBe(20);
    const progressLines = res.lines.filter(l => l.type === 'progress');
    expect(progressLines).toHaveLength(21); // initial 0 + one per batch
    expect(progressLines.at(-1)).toEqual({ type: 'progress', done: 1000, total: 1000 });
  });

  it('reports a mid-flight failure as a trailing error line and never throws', async () => {
    const res = fakeRes();
    await expect(
      streamBulkProgress(res, {
        ids: ['a', 'b'],
        chunkSize: 1,
        processChunk: async chunk => {
          if (chunk[0] === 'b') throw new Error('boom');
        },
        finalize: async () => ({ message: 'unreached' }),
      })
    ).resolves.toBeUndefined();

    expect(res.ended).toBe(true);
    expect(res.lines).toEqual([
      { type: 'progress', done: 0, total: 2 },
      { type: 'progress', done: 1, total: 2 },
      { type: 'error', message: 'boom' },
    ]);
  });
});
