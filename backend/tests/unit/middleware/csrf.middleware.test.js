import { describe, expect, it } from 'vitest';

import { csrfProtection } from '../../../middleware/csrf.middleware.js';
import { mockNext, mockReq, mockRes } from '../../helpers/http.js';

function run(method, headers = {}) {
  const req = mockReq({ method, headers });
  const res = mockRes();
  const next = mockNext();
  csrfProtection(req, res, next);
  return { res, next };
}

describe('csrfProtection', () => {
  describe('safe methods', () => {
    it.each(['GET', 'HEAD', 'OPTIONS'])('lets %s through without any header', method => {
      const { next, res } = run(method);
      expect(next).toHaveBeenCalled();
      expect(res.sent).toBe(false);
    });
  });

  describe('state-changing methods', () => {
    it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('blocks %s with no CSRF header', method => {
      const { next, res } = run(method);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.body).toEqual({ message: 'Forbidden: missing CSRF header' });
    });

    it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('allows %s with the XHR header', method => {
      const { next } = run(method, { 'X-Requested-With': 'XMLHttpRequest' });
      expect(next).toHaveBeenCalled();
    });

    it('allows a request carrying the Electron desktop header', () => {
      const { next } = run('POST', { 'X-TMA-Desktop-Client': 'tma-electron-client-v1' });
      expect(next).toHaveBeenCalled();
    });

    it('accepts any truthy value for the desktop header', () => {
      const { next } = run('POST', { 'X-TMA-Desktop-Client': 'anything' });
      expect(next).toHaveBeenCalled();
    });

    it('requires the XHR header value to match exactly', () => {
      expect(run('POST', { 'X-Requested-With': 'xmlhttprequest' }).next).not.toHaveBeenCalled();
      expect(run('POST', { 'X-Requested-With': 'fetch' }).next).not.toHaveBeenCalled();
      expect(run('POST', { 'X-Requested-With': '' }).next).not.toHaveBeenCalled();
    });

    it('is not satisfied by an Origin or Referer header alone', () => {
      const { next } = run('POST', { Origin: 'https://cloud.example.com', Referer: 'https://cloud.example.com/' });
      expect(next).not.toHaveBeenCalled();
    });

    it('blocks an unknown verb, since only the safe list is exempt', () => {
      const { next } = run('TRACE');
      expect(next).not.toHaveBeenCalled();
    });
  });
});
