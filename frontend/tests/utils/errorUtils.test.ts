import { describe, expect, it } from 'vitest';

import {
  ApiError,
  extractResponseError,
  extractXhrErrorMessage,
  getErrorMessage,
  isAuthError,
} from '../../src/utils/errorUtils';

const xhr = (overrides: Partial<XMLHttpRequest>) => overrides as XMLHttpRequest;

describe('ApiError', () => {
  it('carries the status alongside the message', () => {
    const error = new ApiError('Not found', 404);
    expect(error.message).toBe('Not found');
    expect(error.status).toBe(404);
    expect(error.name).toBe('ApiError');
  });

  it('is a real Error, so instanceof checks and try/catch work', () => {
    expect(new ApiError('x', 500)).toBeInstanceOf(Error);
  });

  it('can carry structured extra data', () => {
    expect(new ApiError('Too big', 413, { limit: 100 }).data).toEqual({ limit: 100 });
  });
});

describe('getErrorMessage', () => {
  it('reads the message from an Error', () => {
    expect(getErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('passes a string through', () => {
    expect(getErrorMessage('plain failure')).toBe('plain failure');
  });

  it('falls back for anything else', () => {
    expect(getErrorMessage(null)).toBe('An error occurred');
    expect(getErrorMessage(undefined)).toBe('An error occurred');
    expect(getErrorMessage({ message: 'not an Error' })).toBe('An error occurred');
    expect(getErrorMessage(42)).toBe('An error occurred');
  });

  it('honours a custom fallback', () => {
    expect(getErrorMessage(null, 'Upload failed')).toBe('Upload failed');
  });
});

describe('isAuthError', () => {
  it('recognises a 401 ApiError', () => {
    expect(isAuthError(new ApiError('Unauthorized', 401))).toBe(true);
  });

  it('recognises a plain object carrying status 401', () => {
    expect(isAuthError({ status: 401 })).toBe(true);
  });

  it('rejects other statuses', () => {
    expect(isAuthError(new ApiError('Forbidden', 403))).toBe(false);
    expect(isAuthError({ status: 500 })).toBe(false);
  });

  it('rejects values with no status at all', () => {
    expect(isAuthError(new Error('network'))).toBe(false);
    expect(isAuthError(null)).toBe(false);
    expect(isAuthError('401')).toBe(false);
  });

  it('requires the status to be the number 401, not the string', () => {
    expect(isAuthError({ status: '401' })).toBe(false);
  });
});

describe('extractXhrErrorMessage', () => {
  it('prefers the message field from a JSON body', () => {
    const message = extractXhrErrorMessage(
      xhr({ status: 400, statusText: 'Bad Request', responseText: '{"message":"Invalid file"}' })
    );
    expect(message).toBe('Invalid file');
  });

  it('falls back through error and msg fields', () => {
    expect(extractXhrErrorMessage(xhr({ status: 400, statusText: 'x', responseText: '{"error":"E1"}' }))).toBe('E1');
    expect(extractXhrErrorMessage(xhr({ status: 400, statusText: 'x', responseText: '{"msg":"M1"}' }))).toBe('M1');
  });

  it('uses a short non-JSON body as the message', () => {
    expect(extractXhrErrorMessage(xhr({ status: 500, statusText: 'x', responseText: 'Server exploded' }))).toBe(
      'Server exploded'
    );
  });

  it('does not dump a huge non-JSON body into the toast', () => {
    const html = `<html>${'x'.repeat(600)}</html>`;
    expect(extractXhrErrorMessage(xhr({ status: 500, statusText: 'Server Error', responseText: html }))).toBe(
      'Upload failed: Server Error'
    );
  });

  it('falls back to the status text for an empty body', () => {
    expect(extractXhrErrorMessage(xhr({ status: 500, statusText: 'Server Error', responseText: '' }))).toBe(
      'Upload failed: Server Error'
    );
  });

  describe('413 responses', () => {
    it('explains the storage limit rather than showing raw status text', () => {
      expect(extractXhrErrorMessage(xhr({ status: 413, statusText: 'Payload Too Large', responseText: '' }))).toBe(
        'File too large or storage limit exceeded.'
      );
    });

    it('still prefers a specific server message when there is one', () => {
      const message = extractXhrErrorMessage(
        xhr({ status: 413, statusText: 'Payload Too Large', responseText: '{"message":"You have used 9 of 10 GB."}' })
      );
      expect(message).toBe('You have used 9 of 10 GB.');
    });
  });

  it('ignores a non-string message field', () => {
    expect(extractXhrErrorMessage(xhr({ status: 400, statusText: 'Bad', responseText: '{"message":42}' }))).toBe(
      'Upload failed: Bad'
    );
  });
});

describe('extractResponseError', () => {
  const response = (body: string, init: { status?: number; statusText?: string } = {}) =>
    ({
      status: init.status ?? 400,
      statusText: init.statusText ?? 'Bad Request',
      text: async () => body,
    }) as Response;

  it('prefers the message field', async () => {
    expect(await extractResponseError(response('{"message":"Invalid ids array"}'))).toBe('Invalid ids array');
  });

  it('falls back to the error field', async () => {
    expect(await extractResponseError(response('{"error":"STORAGE_LIMIT_EXCEEDED"}'))).toBe('STORAGE_LIMIT_EXCEEDED');
  });

  it('falls back to the status text when the JSON carries neither', async () => {
    expect(await extractResponseError(response('{"other":1}', { statusText: 'Conflict' }))).toBe('Conflict');
  });

  it('flags an empty body explicitly', async () => {
    expect(await extractResponseError(response('', { statusText: 'Bad Gateway' }))).toBe(
      'Bad Gateway (empty response body)'
    );
  });

  it('returns a short non-JSON body verbatim', async () => {
    expect(await extractResponseError(response('  Not Found  '))).toBe('Not Found');
  });

  it('summarises a long non-JSON body instead of dumping it', async () => {
    const html = `<html>${'x'.repeat(600)}</html>`;
    expect(await extractResponseError(response(html, { statusText: 'Server Error' }))).toBe(
      'Server Error (non-JSON response)'
    );
  });

  it('falls back to the status when the body cannot be read at all', async () => {
    const broken = {
      status: 502,
      statusText: '',
      text: async () => {
        throw new Error('stream closed');
      },
    } as unknown as Response;
    expect(await extractResponseError(broken)).toBe('HTTP 502');
  });
});
