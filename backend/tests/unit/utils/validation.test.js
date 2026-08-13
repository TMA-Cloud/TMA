import { describe, expect, it, vi } from 'vitest';

import {
  validateBoolean,
  validateEmail,
  validateFileName,
  validateFileUpload,
  validateId,
  validateIdArray,
  validateLimit,
  validateSearchQuery,
  validateSortBy,
  validateSortOrder,
  validateString,
  validateToken,
} from '../../../utils/validation.js';

describe('validateString', () => {
  it('returns the trimmed string for ordinary input', () => {
    expect(validateString('  hello  ')).toBe('hello');
  });

  it('rejects non-strings', () => {
    for (const input of [null, undefined, 42, {}, [], true]) {
      expect(validateString(input)).toBeNull();
    }
  });

  it('rejects input longer than the limit', () => {
    expect(validateString('a'.repeat(1001))).toBeNull();
    expect(validateString('a'.repeat(1000))).toBe('a'.repeat(1000));
  });

  it('honours a custom max length', () => {
    expect(validateString('abcdef', 5)).toBeNull();
    expect(validateString('abcde', 5)).toBe('abcde');
  });

  it('strips null bytes and control characters', () => {
    expect(validateString('he\x00llo')).toBe('hello');
    expect(validateString('he\x07llo')).toBe('hello');
    expect(validateString('he\x7Fllo')).toBe('hello');
  });

  it('keeps tabs, newlines and carriage returns', () => {
    expect(validateString('a\tb')).toBe('a\tb');
    expect(validateString('a\nb')).toBe('a\nb');
    expect(validateString('a\rb')).toBe('a\rb');
  });

  it('returns null when stripping leaves nothing', () => {
    expect(validateString('\x00\x01\x02')).toBeNull();
    expect(validateString('   ')).toBeNull();
    expect(validateString('')).toBeNull();
  });
});

describe('validateEmail', () => {
  it.each(['user@example.com', 'first.last@sub.domain.co.uk', 'a+tag@b.io', "o'brien@example.org"])(
    'accepts %s',
    email => {
      expect(validateEmail(email)).toBe(true);
    }
  );

  it.each([
    ['missing @', 'userexample.com'],
    ['missing domain dot', 'user@example'],
    ['leading space', ' user@example.com'],
    ['inner space', 'user name@example.com'],
    ['two @', 'a@b@c.com'],
    ['empty', ''],
  ])('rejects %s', (_label, email) => {
    expect(validateEmail(email)).toBe(false);
  });

  it('rejects non-strings and nullish values', () => {
    for (const input of [null, undefined, 42, {}, []]) {
      expect(validateEmail(input)).toBe(false);
    }
  });

  it('rejects addresses longer than 255 characters', () => {
    const long = `${'a'.repeat(250)}@example.com`;
    expect(long.length).toBeGreaterThan(255);
    expect(validateEmail(long)).toBe(false);
  });
});

describe('validateFileName', () => {
  it.each(['report.pdf', 'my file.txt', 'résumé.docx', '報告書.xlsx', 'file..name.pdf', 'a', '.hidden'])(
    'accepts %s',
    name => {
      expect(validateFileName(name)).toBe(true);
    }
  );

  it('rejects empty and whitespace-only names', () => {
    expect(validateFileName('')).toBe(false);
    expect(validateFileName('   ')).toBe(false);
    expect(validateFileName(null)).toBe(false);
    expect(validateFileName(undefined)).toBe(false);
  });

  it('rejects names longer than 255 characters after trimming', () => {
    expect(validateFileName('a'.repeat(256))).toBe(false);
    expect(validateFileName('a'.repeat(255))).toBe(true);
    expect(validateFileName(`  ${'a'.repeat(255)}  `)).toBe(true);
  });

  describe('path traversal', () => {
    it.each(['../etc/passwd', '..\\windows\\system32', 'foo/bar.txt', 'foo\\bar.txt', '/etc/passwd', 'C:\\secrets'])(
      'rejects %s',
      name => {
        expect(validateFileName(name)).toBe(false);
      }
    );

    it('rejects the bare directory references', () => {
      expect(validateFileName('.')).toBe(false);
      expect(validateFileName('..')).toBe(false);
    });

    it('allows embedded dots once separators are blocked', () => {
      expect(validateFileName('report..pdf')).toBe(true);
      expect(validateFileName('...')).toBe(true);
    });

    it('rejects drive-letter prefixes regardless of case', () => {
      expect(validateFileName('c:file.txt')).toBe(false);
      expect(validateFileName('Z:file.txt')).toBe(false);
    });
  });

  it('rejects null bytes and control characters', () => {
    expect(validateFileName('file\x00.txt')).toBe(false);
    expect(validateFileName('file\n.txt')).toBe(false);
    expect(validateFileName('file\t.txt')).toBe(false);
    expect(validateFileName('file\x7F.txt')).toBe(false);
  });

  it.each(['<', '>', ':', '"', '|', '?', '*'])('rejects the reserved character %s', char => {
    expect(validateFileName(`file${char}name.txt`)).toBe(false);
  });

  describe('Windows reserved device names', () => {
    it.each(['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'LPT9'])('rejects %s', name => {
      expect(validateFileName(name)).toBe(false);
    });

    it('rejects reserved names with an extension', () => {
      expect(validateFileName('CON.txt')).toBe(false);
      expect(validateFileName('nul.log')).toBe(false);
    });

    it('allows names that merely start with a reserved word', () => {
      expect(validateFileName('CONSOLE.txt')).toBe(true);
      expect(validateFileName('COM10.txt')).toBe(true);
      expect(validateFileName('AUXILIARY')).toBe(true);
    });
  });
});

describe('validateId', () => {
  it('accepts a 16-character alphanumeric id', () => {
    expect(validateId('abcDEF1234567890')).toBe('abcDEF1234567890');
  });

  it.each([
    ['too short', 'abc123'],
    ['too long', 'abcDEF12345678901'],
    ['contains a hyphen', 'abcDEF-234567890'],
    ['contains a dot', 'abcDEF.234567890'],
    ['SQL fragment', "' OR 1=1--......"],
    ['empty', ''],
  ])('rejects %s', (_label, id) => {
    expect(validateId(id)).toBeNull();
  });

  it('rejects non-strings', () => {
    for (const input of [null, undefined, 1234567890123456, {}, []]) {
      expect(validateId(input)).toBeNull();
    }
  });
});

describe('validateIdArray', () => {
  const id = i => String(i).padStart(16, '0');

  it('returns the array when every id is valid', () => {
    const ids = [id(1), id(2)];
    expect(validateIdArray(ids)).toEqual(ids);
  });

  it('rejects the whole array when any id is invalid — no silent filtering', () => {
    expect(validateIdArray([id(1), 'not-an-id'])).toBeNull();
  });

  it('rejects a non-array', () => {
    expect(validateIdArray(id(1))).toBeNull();
    expect(validateIdArray(null)).toBeNull();
    expect(validateIdArray({ 0: id(1) })).toBeNull();
  });

  it('rejects an empty array', () => {
    expect(validateIdArray([])).toBeNull();
  });

  it('enforces the batch ceiling', () => {
    const many = Array.from({ length: 101 }, (_, i) => id(i));
    expect(validateIdArray(many)).toBeNull();
    expect(validateIdArray(many.slice(0, 100))).toHaveLength(100);
  });

  it('honours a custom ceiling', () => {
    expect(validateIdArray([id(1), id(2), id(3)], 2)).toBeNull();
  });
});

describe('validateSortBy', () => {
  it.each(['name', 'size', 'modified', 'deletedAt'])('accepts %s', field => {
    expect(validateSortBy(field)).toBe(field);
  });

  it('rejects anything outside the allow-list, including SQL injection attempts', () => {
    expect(validateSortBy('created_at')).toBeNull();
    expect(validateSortBy('name; DROP TABLE files')).toBeNull();
    expect(validateSortBy('NAME')).toBeNull();
    expect(validateSortBy(null)).toBeNull();
    expect(validateSortBy(1)).toBeNull();
  });
});

describe('validateSortOrder', () => {
  it('normalises case', () => {
    expect(validateSortOrder('asc')).toBe('ASC');
    expect(validateSortOrder('Desc')).toBe('DESC');
    expect(validateSortOrder('ASC')).toBe('ASC');
  });

  it('rejects anything else', () => {
    expect(validateSortOrder('ascending')).toBeNull();
    expect(validateSortOrder('')).toBeNull();
    expect(validateSortOrder(null)).toBeNull();
    expect(validateSortOrder(1)).toBeNull();
  });
});

describe('validateSearchQuery', () => {
  it('trims and returns the query', () => {
    expect(validateSearchQuery('  invoice  ')).toBe('invoice');
  });

  it('strips control characters but keeps the search terms', () => {
    expect(validateSearchQuery('inv\x00oice')).toBe('invoice');
  });

  it('preserves characters a user would reasonably search for', () => {
    expect(validateSearchQuery("O'Brien & Sons (2024).pdf")).toBe("O'Brien & Sons (2024).pdf");
  });

  it('rejects empty, whitespace-only and nullish queries', () => {
    expect(validateSearchQuery('')).toBeNull();
    expect(validateSearchQuery('   ')).toBeNull();
    expect(validateSearchQuery(null)).toBeNull();
    expect(validateSearchQuery(undefined)).toBeNull();
    expect(validateSearchQuery(123)).toBeNull();
  });

  it('rejects queries over the length limit', () => {
    expect(validateSearchQuery('a'.repeat(201))).toBeNull();
    expect(validateSearchQuery('a'.repeat(200))).toHaveLength(200);
  });

  it('honours a custom limit', () => {
    expect(validateSearchQuery('abcdef', 5)).toBeNull();
  });
});

describe('validateLimit', () => {
  it('parses numeric strings', () => {
    expect(validateLimit('50')).toBe(50);
    expect(validateLimit(50)).toBe(50);
  });

  it('rejects values outside 1..maxLimit', () => {
    expect(validateLimit(0)).toBeNull();
    expect(validateLimit(-1)).toBeNull();
    expect(validateLimit(1001)).toBeNull();
    expect(validateLimit(1000)).toBe(1000);
  });

  it('honours a custom ceiling', () => {
    expect(validateLimit(51, 50)).toBeNull();
    expect(validateLimit(50, 50)).toBe(50);
  });

  it('rejects non-numeric input', () => {
    expect(validateLimit('abc')).toBeNull();
    expect(validateLimit(null)).toBeNull();
    expect(validateLimit(undefined)).toBeNull();
    expect(validateLimit({})).toBeNull();
  });

  it('truncates a float to its integer part', () => {
    expect(validateLimit('10.9')).toBe(10);
  });
});

describe('validateBoolean', () => {
  it('passes real booleans through', () => {
    expect(validateBoolean(true)).toBe(true);
    expect(validateBoolean(false)).toBe(false);
  });

  it('parses string booleans case-insensitively', () => {
    expect(validateBoolean('true')).toBe(true);
    expect(validateBoolean('TRUE')).toBe(true);
    expect(validateBoolean('False')).toBe(false);
  });

  it('rejects everything else', () => {
    expect(validateBoolean('yes')).toBeNull();
    expect(validateBoolean(1)).toBeNull();
    expect(validateBoolean(0)).toBeNull();
    expect(validateBoolean(null)).toBeNull();
    expect(validateBoolean('')).toBeNull();
  });
});

describe('validateToken', () => {
  it('accepts a 16-character alphanumeric share token', () => {
    expect(validateToken('AbC123xyz789QWer')).toBe('AbC123xyz789QWer');
  });

  it('rejects wrong lengths and non-alphanumeric characters', () => {
    expect(validateToken('short')).toBeNull();
    expect(validateToken('AbC123xyz789QWer1')).toBeNull();
    expect(validateToken('AbC123xyz789QW-r')).toBeNull();
    expect(validateToken('../../etc/passwd')).toBeNull();
    expect(validateToken(null)).toBeNull();
  });
});

describe('validateFileUpload', () => {
  it('allows every file type — cloud storage does not gatekeep by extension', () => {
    expect(validateFileUpload('application/pdf', 'doc.pdf').valid).toBe(true);
    expect(validateFileUpload('application/x-msdownload', 'virus.exe').valid).toBe(true);
    expect(validateFileUpload(null, 'noext').valid).toBe(true);
  });

  it.each(['.exe', '.dll', '.bat', '.cmd', '.ps1', '.sh', '.jar', '.msi', '.html', '.htm', '.svg', '.js'])(
    'forces %s to download rather than render inline',
    ext => {
      expect(validateFileUpload('application/octet-stream', `payload${ext}`).requiresDownload).toBe(true);
    }
  );

  it('does not force a download for ordinary documents and images', () => {
    expect(validateFileUpload('application/pdf', 'report.pdf').requiresDownload).toBe(false);
    expect(validateFileUpload('image/png', 'photo.png').requiresDownload).toBe(false);
  });

  it('matches the extension case-insensitively', () => {
    expect(validateFileUpload('application/octet-stream', 'PAYLOAD.EXE').requiresDownload).toBe(true);
  });

  it('reports a falsy requiresDownload for a file with no extension', () => {
    // The implementation short-circuits on the empty extension string, so this
    // is '' rather than false. Callers must treat it as a boolean.
    expect(validateFileUpload('application/octet-stream', 'README')).toMatchObject({ valid: true });
    expect(validateFileUpload('application/octet-stream', 'README').requiresDownload).toBeFalsy();
  });

  describe('MIME/extension spoofing detection', () => {
    it('invokes the onSpoofing hook when the declared MIME contradicts the extension', () => {
      const onSpoofing = vi.fn();
      validateFileUpload('image/png', 'payload.exe', { suppressSpoofingWarning: true, onSpoofing });
      expect(onSpoofing).toHaveBeenCalledWith({
        mimeType: 'image/png',
        fileExtension: '.exe',
        filename: 'payload.exe',
      });
    });

    it('stays quiet when the MIME and extension agree', () => {
      const onSpoofing = vi.fn();
      validateFileUpload('image/jpeg', 'photo.jpeg', { suppressSpoofingWarning: true, onSpoofing });
      validateFileUpload('image/jpeg', 'photo.jpg', { suppressSpoofingWarning: true, onSpoofing });
      expect(onSpoofing).not.toHaveBeenCalled();
    });

    it('normalises the declared MIME case before comparing', () => {
      const onSpoofing = vi.fn();
      validateFileUpload('IMAGE/PNG', 'photo.png', { suppressSpoofingWarning: true, onSpoofing });
      expect(onSpoofing).not.toHaveBeenCalled();
    });

    it('stays quiet for MIME types that are not in the map', () => {
      const onSpoofing = vi.fn();
      validateFileUpload('application/octet-stream', 'anything.xyz', { suppressSpoofingWarning: true, onSpoofing });
      expect(onSpoofing).not.toHaveBeenCalled();
    });

    it('still reports the upload as valid — spoofing is a warning, not a rejection', () => {
      const result = validateFileUpload('image/png', 'payload.exe', { suppressSpoofingWarning: true });
      expect(result.valid).toBe(true);
      expect(result.error).toBeNull();
    });
  });
});
