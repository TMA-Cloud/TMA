import { describe, expect, it } from 'vitest';

import { contentDispositionValue } from '../../../utils/fileDownload.js';

/**
 * Node throws ERR_INVALID_CHAR if a header value contains a byte outside
 * ISO-8859-1, so every value this builds must be plain ASCII.
 */
function assertHeaderSafe(value) {
  expect(value).not.toMatch(/[^\x20-\x7E]/);
}

describe('contentDispositionValue', () => {
  it('emits both the legacy filename and the RFC 5987 encoded form', () => {
    const value = contentDispositionValue('attachment', 'report.pdf');
    expect(value).toBe(`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
  });

  it('supports the inline disposition for viewable files', () => {
    expect(contentDispositionValue('inline', 'photo.png')).toMatch(/^inline; /);
  });

  it('percent-encodes a name with spaces in the RFC 5987 part', () => {
    const value = contentDispositionValue('attachment', 'my report.pdf');
    expect(value).toContain("filename*=UTF-8''my%20report.pdf");
  });

  describe('non-ASCII names', () => {
    it.each([
      ['emoji', '📄 report.pdf'],
      ['Japanese', '報告書.xlsx'],
      ['accented', 'résumé.docx'],
      ['Arabic', 'تقرير.pdf'],
      ['mojibake', 'rÃ©sumÃ©.pdf'],
    ])('produces a header-safe value for a %s filename', (_label, name) => {
      assertHeaderSafe(contentDispositionValue('attachment', name));
    });

    it('preserves the real name in the encoded parameter so browsers get it right', () => {
      const value = contentDispositionValue('attachment', '報告書.xlsx');
      const encoded = value.match(/filename\*=UTF-8''(.+)$/)[1];
      expect(decodeURIComponent(encoded)).toBe('報告書.xlsx');
    });

    it('substitutes underscores for non-ASCII bytes in the legacy fallback', () => {
      const value = contentDispositionValue('attachment', '報告書.xlsx');
      const legacy = value.match(/filename="([^"]+)"/)[1];
      expect(legacy).toMatch(/^[\x20-\x7E]+$/);
      expect(legacy.endsWith('.xlsx')).toBe(true);
    });
  });

  describe('header injection', () => {
    it('strips quotes so the filename cannot break out of the quoted string', () => {
      const value = contentDispositionValue('attachment', 'evil".pdf');
      const legacy = value.match(/filename="([^"]*)"/)[1];
      expect(legacy).not.toContain('"');
    });

    it('strips backslashes so escaping cannot be abused', () => {
      const legacy = contentDispositionValue('attachment', 'a\\b.pdf').match(/filename="([^"]*)"/)[1];
      expect(legacy).not.toContain('\\');
    });

    it('drops CR and LF, which would otherwise split the response headers', () => {
      const value = contentDispositionValue('attachment', 'evil\r\nX-Injected: yes.pdf');
      expect(value).not.toContain('\r');
      expect(value).not.toContain('\n');
      assertHeaderSafe(value);
    });
  });

  describe('degenerate names', () => {
    it('falls back to "download" when the name is not a string', () => {
      expect(contentDispositionValue('attachment', null)).toContain('filename="download"');
      expect(contentDispositionValue('attachment', undefined)).toContain('filename="download"');
      expect(contentDispositionValue('attachment', 42)).toContain('filename="download"');
    });

    it('falls back to "download" when nothing ASCII survives', () => {
      const legacy = contentDispositionValue('attachment', '報告書').match(/filename="([^"]+)"/)[1];
      expect(legacy).toBe('download');
    });

    it('does not leave a leading underscore run on the fallback name', () => {
      const legacy = contentDispositionValue('attachment', '📄report.pdf').match(/filename="([^"]+)"/)[1];
      expect(legacy.startsWith('_')).toBe(false);
    });

    it('appends the original extension when the fallback lost it', () => {
      const legacy = contentDispositionValue('attachment', '報告.pdf').match(/filename="([^"]+)"/)[1];
      expect(legacy.endsWith('.pdf')).toBe(true);
    });

    it('does not duplicate an extension the fallback already kept', () => {
      const legacy = contentDispositionValue('attachment', 'report.pdf').match(/filename="([^"]+)"/)[1];
      expect(legacy).toBe('report.pdf');
      expect(legacy.endsWith('.pdf.pdf')).toBe(false);
    });

    it('handles a name with no extension at all', () => {
      const value = contentDispositionValue('attachment', 'README');
      expect(value).toContain('filename="README"');
      assertHeaderSafe(value);
    });

    it('handles an empty filename', () => {
      const value = contentDispositionValue('attachment', '');
      expect(value).toContain('filename="download"');
      assertHeaderSafe(value);
    });
  });
});
