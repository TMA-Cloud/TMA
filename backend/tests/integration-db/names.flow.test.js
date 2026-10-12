/**
 * A name is stored as the user's OS wrote it. Only "/", "\" and control
 * characters are refused; what Windows alone forbids is translated where a
 * name meets Windows, here a folder ZIP.
 */

import { describe, expect, it } from 'vitest';

import pool from '../../config/db.js';
import { signUpAndLogin } from './helpers/app.js';

const NNBSP_NAME = 'Standup 9_05\u202FAM.txt';

function upload(c, name, parentId) {
  const req = c
    .post('/api/files/upload')
    .attach('file', Buffer.from('hello'), { filename: name, contentType: 'text/plain' });
  if (parentId) req.field('parentId', parentId);
  return req;
}

async function storedNames() {
  const { rows } = await pool.query('SELECT name FROM files ORDER BY name');
  return rows.map(row => row.name);
}

const binary = (res, done) => {
  const chunks = [];
  res.on('data', chunk => chunks.push(chunk));
  res.on('end', () => done(null, Buffer.concat(chunks)));
};

describe('names only Windows forbids', () => {
  it('uploads a name with a narrow no-break space intact', async () => {
    const { client: c } = await signUpAndLogin();

    expect((await upload(c, NNBSP_NAME)).status).toBeLessThan(400);
    expect(await storedNames()).toEqual([NNBSP_NAME]);
  });

  it('uploads, creates and renames names holding : ? * " < > |', async () => {
    const { client: c } = await signUpAndLogin();

    expect((await upload(c, 'Q3: plan?.docx')).status).toBeLessThan(400);
    const folder = await c.post('/api/files/folder').send({ name: 'Drafts <old> | "v2"' });
    expect(folder.status).toBeLessThan(400);
    const renamed = await c.post('/api/files/rename').send({ id: folder.body.id, name: 'CON*' });
    expect(renamed.status).toBeLessThan(400);

    expect(await storedNames()).toEqual(['CON*', 'Q3: plan?.docx']);
  });

  it('still refuses a separator in a name', async () => {
    const { client: c } = await signUpAndLogin();

    expect((await c.post('/api/files/folder').send({ name: 'a\\b' })).status).toBe(422);
    expect(await storedNames()).toEqual([]);
  });

  it('writes Windows-safe entry names into a folder ZIP', async () => {
    const { client: c } = await signUpAndLogin();
    const folder = (await c.post('/api/files/folder').send({ name: 'Q3: Reports' })).body.id;
    await upload(c, 'plan?.docx', folder);

    const res = await c.get(`/api/files/${folder}/download`).buffer(true).parse(binary);

    expect(res.status).toBe(200);
    expect(res.body.includes(Buffer.from('Q3_ Reports/plan_.docx'))).toBe(true);
    expect(res.body.includes(Buffer.from('plan?.docx'))).toBe(false);
  });
});
