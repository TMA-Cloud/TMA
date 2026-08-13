import { describe, expect, it } from 'vitest';

import { mockRes } from '../../helpers/http.js';
import { sendError, sendSuccess } from '../../../utils/response.js';

describe('sendError', () => {
  it('sends the status and a message body', () => {
    const res = mockRes();
    sendError(res, 404, 'File not found');
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.body).toEqual({ message: 'File not found' });
  });

  it('merges extra data alongside the message', () => {
    const res = mockRes();
    sendError(res, 413, 'Too big', null, { error: 'STORAGE_LIMIT_EXCEEDED', limit: 100 });
    expect(res.body).toEqual({ message: 'Too big', error: 'STORAGE_LIMIT_EXCEEDED', limit: 100 });
  });

  it('lets extra data override the message when a caller insists', () => {
    const res = mockRes();
    sendError(res, 400, 'original', null, { message: 'override' });
    expect(res.body.message).toBe('override');
  });

  it('never puts the Error object into the response body', () => {
    const res = mockRes();
    const err = new Error('connect ECONNREFUSED 10.0.0.5:5432');
    sendError(res, 500, 'Internal server error', err);
    expect(res.body).toEqual({ message: 'Internal server error' });
    expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
  });

  it('works without an error or data argument', () => {
    const res = mockRes();
    expect(() => sendError(res, 401, 'Unauthorized')).not.toThrow();
    expect(res.body).toEqual({ message: 'Unauthorized' });
  });
});

describe('sendSuccess', () => {
  it('defaults to 200', () => {
    const res = mockRes();
    sendSuccess(res, { ok: true });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('honours an explicit status such as 201', () => {
    const res = mockRes();
    sendSuccess(res, { id: 'abc' }, 201);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.body).toEqual({ id: 'abc' });
  });

  it('passes arrays through unchanged', () => {
    const res = mockRes();
    sendSuccess(res, [1, 2, 3]);
    expect(res.body).toEqual([1, 2, 3]);
  });

  it('passes null through', () => {
    const res = mockRes();
    sendSuccess(res, null);
    expect(res.body).toBeNull();
  });
});
