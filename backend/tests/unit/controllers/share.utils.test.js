import { describe, expect, it } from 'vitest';

import { escapeHtml, renderErrorPage } from '../../../controllers/share/share.utils.js';
import { mockRes } from '../../helpers/http.js';

describe('escapeHtml', () => {
  it.each([
    ['<script>alert(1)</script>', '&lt;script&gt;alert(1)&lt;/script&gt;'],
    ['a & b', 'a &amp; b'],
    ['"quoted"', '&quot;quoted&quot;'],
    ["it's", 'it&#39;s'],
  ])('escapes %s', (input, expected) => {
    expect(escapeHtml(input)).toBe(expected);
  });

  it('leaves ordinary text untouched', () => {
    expect(escapeHtml('Quarterly report 2024')).toBe('Quarterly report 2024');
  });

  it('leaves non-ASCII text untouched', () => {
    expect(escapeHtml('報告書 — résumé')).toBe('報告書 — résumé');
  });
});

describe('renderErrorPage', () => {
  function render(status, title, message) {
    const res = mockRes();
    renderErrorPage(res, status, title, message);
    return res;
  }

  it('sends the requested status', () => {
    const res = render(404, 'Not found', 'This link no longer exists.');
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('renders a complete HTML document', () => {
    const res = render(410, 'Link expired', 'Ask the owner for a new link.');
    expect(res.body).toMatch(/^<!DOCTYPE html>/);
    expect(res.body).toContain('</html>');
  });

  it('shows the title and message', () => {
    const res = render(404, 'Link expired', 'Ask the owner for a new link.');
    expect(res.body).toContain('Link expired');
    expect(res.body).toContain('Ask the owner for a new link.');
  });

  it('escapes a title containing markup, so a share token cannot inject script', () => {
    const res = render(404, '<script>alert(1)</script>', 'ok');
    expect(res.body).not.toContain('<script>alert(1)</script>');
    expect(res.body).toContain('&lt;script&gt;');
  });

  it('escapes a message containing markup', () => {
    const res = render(404, 'Not found', '<img src=x onerror=alert(1)>');
    expect(res.body).not.toContain('<img src=x');
    expect(res.body).toContain('&lt;img');
  });

  it('escapes a value that would otherwise break out of the title tag', () => {
    const res = render(404, '</title><script>alert(1)</script>', 'ok');
    expect(res.body).not.toContain('</title><script>');
  });

  it('declares a UTF-8 charset and a mobile viewport', () => {
    const res = render(404, 'Not found', 'ok');
    expect(res.body).toContain('charset="utf-8"');
    expect(res.body).toContain('width=device-width');
  });

  it('carries no external references, so the page renders with no network access', () => {
    const res = render(404, 'Not found', 'ok');
    expect(res.body).not.toMatch(/<script\s+src=/i);
    expect(res.body).not.toMatch(/<link\s+[^>]*href=/i);
  });
});
