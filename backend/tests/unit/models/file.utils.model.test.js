import { describe, expect, it } from 'vitest';

import { alwaysReturn, executedCalls, queueQueryResults } from '../../mocks/db.mock.js';
import { cacheKeys, getCache, setCache } from '../../../utils/cache.js';
import {
  SORT_FIELDS,
  buildOrderClause,
  calculateFolderSize,
  fillFolderSizes,
  generateUniqueName,
  getUniqueDbFileName,
} from '../../../models/file/file.utils.model.js';

const USER = 'user000000000001';

describe('buildOrderClause', () => {
  it('maps each allowed sort key to its column', () => {
    expect(buildOrderClause('name', 'ASC')).toBe('ORDER BY name ASC');
    expect(buildOrderClause('size', 'ASC')).toBe('ORDER BY size ASC NULLS LAST');
    expect(buildOrderClause('modified', 'DESC')).toBe('ORDER BY modified DESC');
    expect(buildOrderClause('deletedAt', 'DESC')).toBe('ORDER BY deleted_at DESC');
  });

  it('defaults to modified DESC', () => {
    expect(buildOrderClause()).toBe('ORDER BY modified DESC');
  });

  describe('SQL injection resistance', () => {
    it('falls back to the default column for an unknown sort field', () => {
      expect(buildOrderClause('name; DROP TABLE files', 'ASC')).toBe('ORDER BY modified ASC');
    });

    it('never interpolates an unmapped field name into the clause', () => {
      const clause = buildOrderClause('password FROM users --', 'ASC');
      expect(clause).not.toContain('password');
      expect(clause).not.toContain('users');
    });

    it('falls back to DESC for any direction that is not exactly ASC', () => {
      expect(buildOrderClause('name', 'ASC; DROP TABLE files')).toBe('ORDER BY name DESC');
      expect(buildOrderClause('name', 'sideways')).toBe('ORDER BY name DESC');
      expect(buildOrderClause('name', '')).toBe('ORDER BY name DESC');
      expect(buildOrderClause('name', null)).toBe('ORDER BY name DESC');
    });

    it('accepts the direction case-insensitively', () => {
      expect(buildOrderClause('name', 'asc')).toBe('ORDER BY name ASC');
      expect(buildOrderClause('name', 'AsC')).toBe('ORDER BY name ASC');
    });
  });

  it('qualifies the column with a table alias for JOIN queries', () => {
    expect(buildOrderClause('name', 'ASC', 'f')).toBe('ORDER BY f.name ASC');
  });

  it('puts NULL sizes last, so a folder with no computed size does not float to the top', () => {
    expect(buildOrderClause('size', 'ASC')).toContain('NULLS LAST');
    expect(buildOrderClause('name', 'ASC')).not.toContain('NULLS LAST');
  });

  it('exposes the field map so callers can validate against the same source', () => {
    expect(Object.keys(SORT_FIELDS).sort()).toEqual(['accessedAt', 'deletedAt', 'modified', 'name', 'size']);
  });
});

describe('generateUniqueName', () => {
  it('inserts the counter before the extension', () => {
    expect(generateUniqueName('report', '.pdf', 1)).toBe('report (1).pdf');
  });

  it('handles a name with no extension', () => {
    expect(generateUniqueName('README', '', 2)).toBe('README (2)');
  });

  it('preserves spaces and Unicode in the base name', () => {
    expect(generateUniqueName('報告 書', '.docx', 3)).toBe('報告 書 (3).docx');
  });
});

describe('getUniqueDbFileName', () => {
  it('keeps the desired name when nothing collides', async () => {
    alwaysReturn({ rows: [], rowCount: 0 });
    expect(await getUniqueDbFileName('report.pdf', null, USER)).toBe('report.pdf');
  });

  it('appends a counter on the first collision', async () => {
    queueQueryResults({ rows: [{ id: 'x' }] }, { rows: [] });
    expect(await getUniqueDbFileName('report.pdf', null, USER)).toBe('report (1).pdf');
  });

  it('keeps incrementing while names remain taken', async () => {
    queueQueryResults({ rows: [{ id: 'x' }] }, { rows: [{ id: 'y' }] }, { rows: [{ id: 'z' }] }, { rows: [] });
    expect(await getUniqueDbFileName('report.pdf', null, USER)).toBe('report (3).pdf');
  });

  it('handles a name with no extension', async () => {
    queueQueryResults({ rows: [{ id: 'x' }] }, { rows: [] });
    expect(await getUniqueDbFileName('README', null, USER)).toBe('README (1)');
  });

  it('preserves a multi-dot base name', async () => {
    queueQueryResults({ rows: [{ id: 'x' }] }, { rows: [] });
    expect(await getUniqueDbFileName('backup.2024.tar.gz', null, USER)).toBe('backup.2024.tar (1).gz');
  });

  it('scopes the uniqueness check to the folder, user, type and non-deleted rows', async () => {
    alwaysReturn({ rows: [] });
    await getUniqueDbFileName('report.pdf', 'parent0000000001', USER);
    const { sql, params } = executedCalls()[0];
    expect(sql).toContain('parent_id IS NOT DISTINCT FROM');
    expect(sql).toContain('deleted_at IS NULL');
    expect(params).toEqual(['report.pdf', 'parent0000000001', USER, 'file']);
  });

  it('gives up rather than looping forever after 10000 collisions', async () => {
    alwaysReturn({ rows: [{ id: 'taken' }] });
    await expect(getUniqueDbFileName('report.pdf', null, USER)).rejects.toThrow(/Too many duplicate names/);
  });
});

describe('calculateFolderSize', () => {
  it('sums the file sizes returned by the recursive query', async () => {
    alwaysReturn({ rows: [{ size: 4096 }] });
    expect(await calculateFolderSize('folder0000000001', USER)).toBe(4096);
  });

  it('converts a BIGINT returned as a string', async () => {
    alwaysReturn({ rows: [{ size: '9007199254740' }] });
    expect(await calculateFolderSize('folder0000000001', USER)).toBe(9007199254740);
  });

  it('treats a null sum as zero', async () => {
    alwaysReturn({ rows: [{ size: null }] });
    expect(await calculateFolderSize('folder0000000001', USER)).toBe(0);
  });

  it('treats an unparseable string as zero rather than NaN', async () => {
    alwaysReturn({ rows: [{ size: 'not-a-number' }] });
    expect(await calculateFolderSize('folder0000000001', USER)).toBe(0);
  });

  it('bounds the recursion depth, so a cyclic parent chain cannot hang the query', async () => {
    alwaysReturn({ rows: [{ size: 0 }] });
    await calculateFolderSize('folder0000000001', USER);
    const { sql, params } = executedCalls()[0];
    expect(sql).toContain('RECURSIVE');
    expect(sql).toContain('depth <');
    expect(params[2]).toBe(50);
  });

  it('scopes the recursive walk to the requesting user', async () => {
    alwaysReturn({ rows: [{ size: 0 }] });
    await calculateFolderSize('folder0000000001', USER);
    expect(executedCalls()[0].params).toContain(USER);
  });

  it('serves a cached size without querying', async () => {
    await setCache(cacheKeys.folderSize('folder0000000001', USER), 1234);
    alwaysReturn({ rows: [{ size: 9999 }] });
    expect(await calculateFolderSize('folder0000000001', USER)).toBe(1234);
    expect(executedCalls()).toHaveLength(0);
  });

  it('caches the computed size for the next call', async () => {
    alwaysReturn({ rows: [{ size: 4096 }] });
    await calculateFolderSize('folder0000000001', USER);
    expect(await getCache(cacheKeys.folderSize('folder0000000001', USER))).toBe(4096);
  });
});

describe('fillFolderSizes', () => {
  it('computes a size for every folder entry', async () => {
    alwaysReturn({ rows: [{ size: 100 }] });
    const files = [
      { id: 'a', type: 'folder' },
      { id: 'b', type: 'folder' },
    ];
    await fillFolderSizes(files, USER);
    expect(files.every(f => f.size === 100)).toBe(true);
  });

  it('leaves file entries untouched', async () => {
    alwaysReturn({ rows: [{ size: 100 }] });
    const files = [{ id: 'a', type: 'file', size: 42 }];
    await fillFolderSizes(files, USER);
    expect(files[0].size).toBe(42);
  });

  it('returns the same array it was given', async () => {
    const files = [];
    expect(await fillFolderSizes(files, USER)).toBe(files);
  });

  it('handles an empty list', async () => {
    await expect(fillFolderSizes([], USER)).resolves.toEqual([]);
  });
});
