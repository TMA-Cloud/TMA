/**
 * A pasted or dropped folder arrives as many uploads, each naming its path
 * below the folder. They may run in parallel, so the server has to agree on a
 * single folder per path however the requests interleave.
 */

import { describe, expect, it } from 'vitest';

import pool from '../../config/db.js';
import { signUpAndLogin } from './helpers/app.js';

function uploadAt(c, relativePath, parentId) {
  const name = relativePath.split('/').pop();
  const req = c.post('/api/files/upload/bulk');
  if (parentId) req.field('parentId', parentId);
  req.field('relativePaths', relativePath);
  return req.attach('files', Buffer.from(name), { filename: name, contentType: 'text/plain' });
}

async function folders() {
  const { rows } = await pool.query(
    `SELECT f.name, p.name AS parent FROM files f LEFT JOIN files p ON p.id = f.parent_id
      WHERE f.type = 'folder' ORDER BY f.name`
  );
  return rows;
}

describe('folder trees uploaded in parallel', () => {
  it('creates each folder once when every upload races to create it', async () => {
    const { client: c } = await signUpAndLogin();

    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => uploadAt(c, `Trip/Day 1/photo-${i}.jpg`)));

    expect(results.every(res => res.status === 200)).toBe(true);
    expect(await folders()).toEqual([
      { name: 'Day 1', parent: 'Trip' },
      { name: 'Trip', parent: null },
    ]);
    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM files f JOIN files p ON p.id = f.parent_id WHERE p.name = 'Day 1'"
    );
    expect(rows[0].n).toBe(8);
  });

  it('merges into a folder that differs only in case, as Explorer does', async () => {
    const { client: c } = await signUpAndLogin();
    await uploadAt(c, 'Trip/a.txt');

    await uploadAt(c, 'trip/b.txt');

    expect(await folders()).toEqual([{ name: 'Trip', parent: null }]);
  });

  it('still refuses a parent that is not a live folder', async () => {
    const { client: c } = await signUpAndLogin();
    const doc = (await c.post('/api/files/upload').attach('file', Buffer.from('x'), 'doc.txt')).body.id;

    const res = await uploadAt(c, 'Trip/a.txt', doc);

    expect(res.status).toBe(400);
    expect(await folders()).toEqual([]);
  });
});
