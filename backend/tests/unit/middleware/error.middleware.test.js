import { describe, expect, it } from 'vitest';

import errorHandler from '../../../middleware/error.middleware.js';
import { mockNext, mockReq, mockRes } from '../../helpers/http.js';

function handle(err, reqOverrides = {}) {
  const req = mockReq({ method: 'POST', path: '/api/files/upload', ...reqOverrides });
  const res = mockRes();
  errorHandler(err, req, res, mockNext());
  return res;
}

const withCode = (code, message = 'boom') => Object.assign(new Error(message), { code });

describe('client-aborted uploads', () => {
  it('answers 499 rather than treating a cancellation as a server error', () => {
    const res = handle(new Error('Request aborted'));
    expect(res.status).toHaveBeenCalledWith(499);
    expect(res.body).toEqual({ message: 'Upload cancelled by client', error: 'REQUEST_ABORTED' });
  });

  it('does not fail when there are no temp files to clean up', () => {
    expect(() => handle(new Error('Request aborted'))).not.toThrow();
  });
});

describe('storage limit errors', () => {
  it.each(['Storage limit exceeded. You have used 9 GB of 10 GB.', 'Upload rejected - storage limit exceeded'])(
    'maps "%s" to 413',
    message => {
      const res = handle(new Error(message));
      expect(res.status).toHaveBeenCalledWith(413);
      expect(res.body.error).toBe('STORAGE_LIMIT_EXCEEDED');
    }
  );

  it('passes the original message through so the user sees their quota', () => {
    const res = handle(new Error('Storage limit exceeded. 1.0 GB available.'));
    expect(res.body.message).toContain('1.0 GB available');
  });
});

describe('PostgreSQL errors', () => {
  it('maps a unique violation to 409', () => {
    const res = handle(withCode('23505'));
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.body).toEqual({ message: 'Resource already exists', error: 'DUPLICATE_RESOURCE' });
  });

  it('maps a foreign key violation to 400', () => {
    const res = handle(withCode('23503'));
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toBe('INVALID_REFERENCE');
  });

  it('does not leak the raw database message', () => {
    const res = handle(withCode('23505', 'duplicate key value violates constraint "users_email_key"'));
    expect(JSON.stringify(res.body)).not.toContain('users_email_key');
  });
});

describe('JWT errors', () => {
  it('maps JsonWebTokenError to 401', () => {
    const res = handle(Object.assign(new Error('jwt malformed'), { name: 'JsonWebTokenError' }));
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body.error).toBe('INVALID_TOKEN');
  });

  it('maps TokenExpiredError to 401 with a distinct code', () => {
    const res = handle(Object.assign(new Error('jwt expired'), { name: 'TokenExpiredError' }));
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body.error).toBe('TOKEN_EXPIRED');
  });
});

describe('filesystem errors', () => {
  it('maps ENOENT to 404', () => {
    const res = handle(withCode('ENOENT'));
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.body.error).toBe('FILE_NOT_FOUND');
  });

  it('maps EACCES to 403', () => {
    const res = handle(withCode('EACCES'));
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body.error).toBe('PERMISSION_DENIED');
  });

  it('does not leak the filesystem path', () => {
    const res = handle(Object.assign(withCode('ENOENT'), { path: '/srv/app/frontend/dist/index.html' }));
    expect(JSON.stringify(res.body)).not.toContain('/srv/app');
  });
});

describe('fallback', () => {
  it('defaults to 500 with an INTERNAL_ERROR code', () => {
    const res = handle(new Error('something unexpected'));
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.body.error).toBe('INTERNAL_ERROR');
  });

  it('honours an explicit status set on the error', () => {
    const res = handle(Object.assign(new Error('nope'), { status: 418 }));
    expect(res.status).toHaveBeenCalledWith(418);
  });

  it('never includes a stack trace in the response', () => {
    const err = new Error('with stack');
    const res = handle(err);
    expect(JSON.stringify(res.body)).not.toContain('at ');
    expect(res.body).not.toHaveProperty('stack');
  });

  it('handles an error object with no message', () => {
    const res = handle({});
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.body.message).toBe('Internal server error');
  });
});
