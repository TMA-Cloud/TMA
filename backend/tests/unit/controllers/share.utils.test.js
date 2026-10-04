import { describe, expect, it } from 'vitest';

import { renderErrorPage, renderFilePage } from '../../../controllers/share/share.utils.js';
import { mockRes } from '../../helpers/http.js';

describe('renderFilePage', () => {
  const render = (name, mimeType) => renderFilePage({ id: 'f1', name, mimeType, size: 2048 }, 'tok');

  it.each([
    [
      'Deck.pptx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'PPTX · Presentation',
      'i-slides',
    ],
    ['index.ts', 'video/mp2t', 'TS · Code', 'i-code'],
    ['comp.psd', 'application/octet-stream', 'PSD · Design file', 'i-image'],
    ['.txt', 'text/plain', 'Text', 'i-doc'],
  ])('describes %s by its extension first', (name, mimeType, label, iconId) => {
    const html = render(name, mimeType);
    expect(html).toContain(`2.0 KB · ${label}`);
    expect(html).toContain(`href="#${iconId}"`);
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
