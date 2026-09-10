import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ONLYOFFICE_EXTS,
  formatDate,
  formatFileSize,
  formatShareTimeRemaining,
  describeShareTimeRemaining,
  getDisplayFileName,
  getExt,
  getFileIcon,
  getFullNameForRename,
  isOnlyOfficeSupported,
  validateOnlyOfficeMimeType,
  mapFileResponse,
} from '../../src/utils/fileUtils';
import type { FileItem } from '../../src/contexts/AppContext';

const item = (overrides: Partial<FileItem> = {}) =>
  ({ id: 'f1', name: 'file.txt', type: 'file', ...overrides }) as FileItem;

describe('mapFileResponse', () => {
  it('parses the shared timestamp for icon and Get Info rendering', () => {
    const mapped = mapFileResponse({
      id: 'f1',
      name: 'file.txt',
      type: 'file',
      modified: '2026-09-11T08:00:00.000Z',
      shared: true,
      sharedAt: '2026-09-11T09:15:00.000Z',
    });

    expect(mapped.sharedAt).toBeInstanceOf(Date);
    expect(mapped.sharedAt?.toISOString()).toBe('2026-09-11T09:15:00.000Z');
  });
});

describe('getFileIcon', () => {
  it('returns the folder icon for a folder regardless of MIME type', () => {
    const folder = getFileIcon(item({ type: 'folder', mimeType: 'image/png' }));
    expect(folder).toBe(getFileIcon(item({ type: 'folder' })));
  });

  it('distinguishes the major media families', () => {
    const image = getFileIcon(item({ mimeType: 'image/png' }));
    const video = getFileIcon(item({ mimeType: 'video/mp4' }));
    const audio = getFileIcon(item({ mimeType: 'audio/mpeg' }));
    expect(new Set([image, video, audio]).size).toBe(3);
  });

  it('matches the MIME type case-insensitively', () => {
    expect(getFileIcon(item({ mimeType: 'IMAGE/PNG' }))).toBe(getFileIcon(item({ mimeType: 'image/png' })));
  });

  it('falls back to a generic icon when the MIME type is missing or unknown', () => {
    const generic = getFileIcon(item({ mimeType: undefined }));
    expect(getFileIcon(item({ mimeType: 'application/x-unheard-of' }))).toBe(generic);
  });

  it('gives spreadsheets and presentations distinct icons', () => {
    const sheet = getFileIcon(item({ mimeType: 'application/vnd.ms-excel' }));
    const deck = getFileIcon(item({ mimeType: 'application/vnd.ms-powerpoint' }));
    expect(sheet).not.toBe(deck);
  });
});

describe('formatFileSize', () => {
  it('renders zero explicitly', () => {
    expect(formatFileSize(0)).toBe('0 B');
  });

  it('renders common sizes', () => {
    expect(formatFileSize(1024)).toBe('1KB');
    expect(formatFileSize(1536)).toBe('1.5KB');
    expect(formatFileSize(1024 * 1024)).toBe('1MB');
  });

  it('accepts a numeric string', () => {
    expect(formatFileSize('1048576')).toBe('1MB');
  });

  it('returns an empty string for missing or invalid input', () => {
    expect(formatFileSize(null)).toBe('');
    expect(formatFileSize(undefined)).toBe('');
    expect(formatFileSize(-1)).toBe('');
    expect(formatFileSize('not a number')).toBe('');
    expect(formatFileSize(Infinity)).toBe('');
  });
});

describe('formatDate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-13T15:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a time of day for today', () => {
    const today = new Date();
    today.setHours(14, 30, 0, 0);
    expect(formatDate(today)).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
  });

  it('shows "Yesterday" for yesterday', () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    expect(formatDate(yesterday)).toBe('Yesterday');
  });

  it('shows relative time within the past week', () => {
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    expect(formatDate(threeDaysAgo)).toMatch(/ago$/);
  });

  it('shows an absolute date beyond a week', () => {
    const longAgo = new Date();
    longAgo.setDate(longAgo.getDate() - 30);
    expect(formatDate(longAgo)).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
  });

  it('returns an empty string for an invalid date rather than "Invalid Date"', () => {
    expect(formatDate(new Date('nonsense'))).toBe('');
  });
});

describe('share time remaining', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('distinguishes seven-day, thirty-day, and non-expiring shares on the icon', () => {
    expect(formatShareTimeRemaining(new Date('2026-09-18T10:00:00.000Z'))).toBe('7d');
    expect(formatShareTimeRemaining(new Date('2026-10-11T10:00:00.000Z'))).toBe('30d');
    expect(formatShareTimeRemaining(null)).toBe('∞');
  });

  it('counts down in hours and minutes near expiry', () => {
    expect(formatShareTimeRemaining(new Date('2026-09-11T19:30:00.000Z'))).toBe('10h');
    expect(formatShareTimeRemaining(new Date('2026-09-11T10:25:00.000Z'))).toBe('25m');
  });

  it('describes the remaining time for Get Info', () => {
    expect(describeShareTimeRemaining(new Date('2026-09-13T15:00:00.000Z'))).toBe('2 days, 5 hours remaining');
    expect(describeShareTimeRemaining(null)).toBe('Never expires');
    expect(describeShareTimeRemaining(new Date('2026-09-11T09:00:00.000Z'))).toBe('Expired');
  });
});

describe('getExt', () => {
  it('returns the lowercase extension including the dot', () => {
    expect(getExt('Report.PDF')).toBe('.pdf');
  });

  it('uses only the final extension', () => {
    expect(getExt('backup.tar.gz')).toBe('.gz');
  });

  it('returns an empty string when there is no extension', () => {
    expect(getExt('README')).toBe('');
    expect(getExt('')).toBe('');
    expect(getExt(undefined)).toBe('');
  });

  it('treats a leading dot as the extension of a dotfile', () => {
    expect(getExt('.gitignore')).toBe('.gitignore');
  });
});

describe('getDisplayFileName', () => {
  it('hides the extension for a file when the setting is on', () => {
    expect(getDisplayFileName('report.pdf', true, true)).toBe('report');
  });

  it('shows the full name when the setting is off', () => {
    expect(getDisplayFileName('report.pdf', true, false)).toBe('report.pdf');
  });

  it('never trims a folder name, since a dot there is part of the name', () => {
    expect(getDisplayFileName('v1.2 archive', false, true)).toBe('v1.2 archive');
  });

  it('leaves a file with no extension alone', () => {
    expect(getDisplayFileName('README', true, true)).toBe('README');
  });

  it('only removes the final extension', () => {
    expect(getDisplayFileName('backup.tar.gz', true, true)).toBe('backup.tar');
  });

  it('returns an empty string for an empty name', () => {
    expect(getDisplayFileName('', true, true)).toBe('');
  });
});

describe('getFullNameForRename', () => {
  it('reattaches the original extension to the edited base name', () => {
    expect(getFullNameForRename('quarterly report', 'report.pdf')).toBe('quarterly report.pdf');
  });

  it('trims whitespace the user left around the base name', () => {
    expect(getFullNameForRename('  renamed  ', 'report.pdf')).toBe('renamed.pdf');
  });

  it('returns the trimmed name when the original had no extension', () => {
    expect(getFullNameForRename('  renamed  ', 'README')).toBe('renamed');
  });

  it('round-trips with getDisplayFileName', () => {
    const original = 'Quarterly Report.xlsx';
    const shown = getDisplayFileName(original, true, true);
    expect(getFullNameForRename(shown, original)).toBe(original);
  });
});

describe('isOnlyOfficeSupported', () => {
  it.each(['report.docx', 'sheet.xlsx', 'deck.pptx', 'data.csv', 'manual.pdf', 'notes.odt'])('accepts %s', name => {
    expect(isOnlyOfficeSupported(name)).toBe(true);
  });

  it.each(['photo.png', 'archive.zip', 'video.mp4', 'README'])('rejects %s', name => {
    expect(isOnlyOfficeSupported(name)).toBe(false);
  });

  it('matches case-insensitively', () => {
    expect(isOnlyOfficeSupported('REPORT.DOCX')).toBe(true);
  });

  it('handles a missing name', () => {
    expect(isOnlyOfficeSupported(undefined)).toBe(false);
  });

  it('lists every extension with a leading dot, in lowercase', () => {
    for (const ext of ONLYOFFICE_EXTS) {
      expect(ext).toMatch(/^\.[a-z]+$/);
    }
  });
});

describe('validateOnlyOfficeMimeType', () => {
  it('accepts a matching MIME type', () => {
    expect(
      validateOnlyOfficeMimeType(
        'report.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      )
    ).toBe(true);
  });

  it('ignores MIME parameters such as charset', () => {
    expect(validateOnlyOfficeMimeType('doc.pdf', 'application/pdf; charset=binary')).toBe(true);
  });

  it('compares case-insensitively', () => {
    expect(validateOnlyOfficeMimeType('doc.pdf', 'APPLICATION/PDF')).toBe(true);
  });

  it('rejects a contradicting MIME type', () => {
    expect(validateOnlyOfficeMimeType('report.docx', 'image/png')).toBe(false);
  });

  it('accepts either accepted MIME type for a CSV', () => {
    expect(validateOnlyOfficeMimeType('data.csv', 'text/plain')).toBe(true);
    expect(validateOnlyOfficeMimeType('data.csv', 'application/csv')).toBe(true);
    expect(validateOnlyOfficeMimeType('data.csv', 'image/png')).toBe(false);
  });

  it('rejects when the MIME type is missing', () => {
    expect(validateOnlyOfficeMimeType('report.docx', null)).toBe(false);
    expect(validateOnlyOfficeMimeType('report.docx', undefined)).toBe(false);
    expect(validateOnlyOfficeMimeType('report.docx', '')).toBe(false);
  });

  it('rejects an extension with no known MIME type', () => {
    expect(validateOnlyOfficeMimeType('file.zzzz', 'application/octet-stream')).toBe(false);
  });
});
