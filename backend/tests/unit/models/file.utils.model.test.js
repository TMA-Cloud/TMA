import { describe, expect, it } from 'vitest';

import { alwaysReturn, executedCalls, queueQueryResults } from '../../mocks/db.mock.js';
import {
  SORT_FIELDS,
  buildKeysetPage,
  buildOrderClause,
  finishKeysetPage,
  generateUniqueName,
  getUniqueDbFileName,
} from '../../../models/file/file.utils.model.js';

const USER = 'user000000000001';

describe('buildOrderClause', () => {
  it('maps each allowed sort key to its column', () => {
    expect(buildOrderClause('name', 'ASC')).toBe('ORDER BY name ASC');
    expect(buildOrderClause('size', 'ASC')).toBe(
      "ORDER BY (CASE WHEN files.type = 'folder' THEN files.aggregate_size ELSE files.size END) ASC NULLS LAST"
    );
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

describe('keyset pagination', () => {
  it('builds a stable folder-first first page with one extra row', () => {
    const page = buildKeysetPage('name', 'ASC', null, 'f', 2, 2);
    expect(page.orderClause).toBe('ORDER BY f.type DESC, f.name ASC, f.id ASC');
    expect(page.params).toEqual([3]);
    expect(page.limitParam).toBe('$2');
  });

  it('continues strictly after the last compound cursor', () => {
    const cursor = Buffer.from(JSON.stringify({ type: 'folder', value: 'Docs', id: 'f2' })).toString('base64url');
    const page = buildKeysetPage('name', 'ASC', cursor, 'f', 3, 200);
    expect(page.whereClause).toContain('f.type < $3');
    expect(page.whereClause).toContain('f.name > $4');
    expect(page.whereClause).toContain('f.id > $5');
    expect(page.limitParam).toBe('$6');
    expect(page.params).toEqual(['folder', 'Docs', 'f2', 201]);
  });

  it('emits a cursor only when an extra row proves another page exists', () => {
    const page = buildKeysetPage('modified', 'DESC', null, 'f', 1, 2);
    const result = finishKeysetPage(
      [
        { id: '3', type: 'file', modified: '2026-01-03' },
        { id: '2', type: 'file', modified: '2026-01-02' },
        { id: '1', type: 'file', modified: '2026-01-01' },
      ],
      page
    );
    expect(result.files.map(row => row.id)).toEqual(['3', '2']);
    expect(result.nextCursor).toBeTruthy();
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
    queueQueryResults({ rows: [{ name: 'report.pdf' }] });
    expect(await getUniqueDbFileName('report.pdf', null, USER)).toBe('report (1).pdf');
  });

  it('keeps incrementing while names remain taken', async () => {
    queueQueryResults({ rows: [{ name: 'report.pdf' }, { name: 'report (1).pdf' }, { name: 'report (2).pdf' }] });
    expect(await getUniqueDbFileName('report.pdf', null, USER)).toBe('report (3).pdf');
  });

  it('handles a name with no extension', async () => {
    queueQueryResults({ rows: [{ name: 'README' }] });
    expect(await getUniqueDbFileName('README', null, USER)).toBe('README (1)');
  });

  it('preserves a multi-dot base name', async () => {
    queueQueryResults({ rows: [{ name: 'backup.2024.tar.gz' }] });
    expect(await getUniqueDbFileName('backup.2024.tar.gz', null, USER)).toBe('backup.2024.tar (1).gz');
  });

  it('scopes the uniqueness check to the folder, user, type and non-deleted rows', async () => {
    alwaysReturn({ rows: [] });
    await getUniqueDbFileName('report.pdf', 'parent0000000001', USER);
    const { sql, params } = executedCalls()[0];
    expect(sql).toContain('parent_id IS NOT DISTINCT FROM');
    expect(sql).toContain('deleted_at IS NULL');
    expect(params).toEqual(['parent0000000001', USER, 'report.pdf', 'report (%).pdf']);
    expect(executedCalls()).toHaveLength(1);
  });

  it('gives up rather than looping forever after 10000 collisions', async () => {
    alwaysReturn({
      rows: [
        { name: 'report.pdf' },
        ...Array.from({ length: 10000 }, (_, index) => ({ name: `report (${index + 1}).pdf` })),
      ],
    });
    await expect(getUniqueDbFileName('report.pdf', null, USER)).rejects.toThrow(/Too many duplicate names/);
  });
});
