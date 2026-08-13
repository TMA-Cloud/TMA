import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { body } from 'express-validator';

import { validate } from '../../../middleware/validation.middleware.js';
import { addFolderSchema, loginSchema, signupSchema } from '../../../utils/validationSchemas.js';
import { buildApp } from '../../helpers/http.js';

/** Mount a schema behind `validate` and echo the sanitised body back. */
function appFor(schema) {
  return buildApp(app => {
    app.post('/test', schema, validate, (req, res) => res.json({ ok: true, body: req.body }));
  });
}

describe('validate', () => {
  it('passes a valid request through to the handler', async () => {
    const res = await request(appFor(addFolderSchema)).post('/test').send({ name: 'Documents' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('answers 422 with a "Validation failed" message when a rule fails', async () => {
    const res = await request(appFor(addFolderSchema)).post('/test').send({ name: '' });
    expect(res.status).toBe(422);
    expect(res.body.message).toBe('Validation failed');
  });

  it('includes a details array so the client can see how many rules failed', async () => {
    const res = await request(appFor(signupSchema)).post('/test').send({ email: 'bad', password: '123' });
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(res.body.details.length).toBeGreaterThan(0);
  });

  it('keys the details by "undefined" rather than the field name', async () => {
    // Contradicts the documented API contract. The wiki (API → Errors) promises
    //   "details": [{ "email": "Invalid email format" }]
    // and tells clients to "parse the `details` array to provide specific
    // feedback to the user" — which this makes impossible.
    //
    // Cause: express-validator v7 renamed the field to `err.path`; the
    // middleware still reads `err.param`. Pinned so the one-word fix shows up
    // here as an intentional change rather than a surprise failure.
    const res = await request(appFor(signupSchema)).post('/test').send({ email: 'bad', password: '123' });
    expect(Object.keys(res.body.details[0])).toEqual(['undefined']);
  });

  it('reports the human-readable rule message', async () => {
    const res = await request(appFor(signupSchema)).post('/test').send({ email: 'not-an-email', password: 'abcdef' });
    expect(JSON.stringify(res.body.details)).toContain('Invalid email format');
  });

  it('never invokes the handler when validation fails', async () => {
    let called = false;
    const app = buildApp(a => {
      a.post('/test', [body('n').isInt()], validate, (_req, res) => {
        called = true;
        res.json({ ok: true });
      });
    });
    await request(app).post('/test').send({ n: 'abc' });
    expect(called).toBe(false);
  });

  it('applies sanitisers before the handler runs', async () => {
    const res = await request(appFor(loginSchema))
      .post('/test')
      .send({ email: 'USER@Example.COM', password: 'secret' });
    expect(res.status).toBe(200);
    expect(res.body.body.email).toBe('user@example.com');
  });

  it('rejects an email padded with whitespace, because isEmail runs before normalizeEmail', async () => {
    // Worth knowing: a user who types a trailing space on the login form gets
    // "Invalid email format" rather than having it trimmed for them.
    const res = await request(appFor(loginSchema))
      .post('/test')
      .send({ email: '  user@example.com  ', password: 'secret' });
    expect(res.status).toBe(422);
  });

  it('escapes HTML in a submitted name, blunting stored XSS', async () => {
    const res = await request(appFor(signupSchema))
      .post('/test')
      .send({ email: 'a@b.com', password: 'secret', name: '<script>alert(1)</script>' });
    expect(res.status).toBe(200);
    expect(res.body.body.name).not.toContain('<script>');
  });
});

describe('signupSchema', () => {
  const app = appFor(signupSchema);
  const post = payload => request(app).post('/test').send(payload);

  it('accepts a well-formed signup', async () => {
    expect((await post({ email: 'a@b.com', password: 'secret1' })).status).toBe(200);
  });

  it('rejects a password shorter than 6 characters', async () => {
    expect((await post({ email: 'a@b.com', password: '12345' })).status).toBe(422);
  });

  it('accepts a 6-character password', async () => {
    expect((await post({ email: 'a@b.com', password: '123456' })).status).toBe(200);
  });

  it('rejects a password over 128 characters', async () => {
    expect((await post({ email: 'a@b.com', password: 'a'.repeat(129) })).status).toBe(422);
  });

  it('rejects a malformed email', async () => {
    expect((await post({ email: 'not-an-email', password: 'secret1' })).status).toBe(422);
  });

  it('rejects an email over 254 characters', async () => {
    const email = `${'a'.repeat(250)}@b.com`;
    expect((await post({ email, password: 'secret1' })).status).toBe(422);
  });

  it('treats the name as optional', async () => {
    expect((await post({ email: 'a@b.com', password: 'secret1' })).status).toBe(200);
  });

  it('rejects a name over 100 characters', async () => {
    expect((await post({ email: 'a@b.com', password: 'secret1', name: 'a'.repeat(101) })).status).toBe(422);
  });
});

describe('addFolderSchema', () => {
  const app = appFor(addFolderSchema);
  const post = payload => request(app).post('/test').send(payload);

  it('accepts an ordinary folder name', async () => {
    expect((await post({ name: 'My Documents' })).status).toBe(200);
  });

  it('accepts a Unicode folder name', async () => {
    expect((await post({ name: '報告書' })).status).toBe(200);
  });

  describe('the accepted character set is wider than the API docs claim', () => {
    // The wiki (API → Files) says a folder name "must contain only valid file
    // name characters (`a-zA-Z0-9_.-`)". The schema actually allows anything
    // except control characters and the Windows-reserved set, which is what
    // makes Unicode and spaced names work. A client written to the documented
    // rule would reject names the server happily accepts.
    it.each([
      ['spaces', 'My Documents'],
      ['Japanese', '報告書'],
      ['accented', 'Résumé'],
      ['emoji', '📁 Photos'],
      ['ampersand', 'R&D'],
      ['parentheses', 'Report (final)'],
      ['apostrophe', "O'Brien"],
      ['comma', 'a, b, c'],
      ['hash', '#1 Priority'],
      ['plus', 'C++'],
    ])('accepts a name with %s', async (_label, name) => {
      expect((await post({ name })).status).toBe(200);
    });

    it('still rejects the characters the schema really does forbid', async () => {
      for (const char of ['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
        expect((await post({ name: `bad${char}name` })).status).toBe(422);
      }
    });

    it('still rejects control characters', async () => {
      expect((await post({ name: `bad${String.fromCharCode(1)}name` })).status).toBe(422);
    });
  });

  it('rejects an empty name', async () => {
    expect((await post({ name: '   ' })).status).toBe(422);
  });

  it.each(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])('rejects the reserved character %s', async char => {
    expect((await post({ name: `bad${char}name` })).status).toBe(422);
  });

  it('rejects a name over 100 characters', async () => {
    expect((await post({ name: 'a'.repeat(101) })).status).toBe(422);
  });

  it('accepts a null parentId, meaning the root folder', async () => {
    expect((await post({ name: 'Docs', parentId: null })).status).toBe(200);
  });

  it('rejects a non-string parentId', async () => {
    expect((await post({ name: 'Docs', parentId: 12345 })).status).toBe(422);
  });
});
