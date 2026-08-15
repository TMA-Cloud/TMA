import { describe, expect, it } from 'vitest';

import mimeTypes from '../../src/main/utils/mime-types.cjs';

const { DEFAULT_MIME, mimeForFilename, mimeForFilenameOrDefault } = mimeTypes;

describe('mimeForFilename', () => {
  it('maps the document types the desktop editing flow uploads', () => {
    expect(mimeForFilename('report.pdf')).toBe('application/pdf');
    expect(mimeForFilename('report.docx')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
    expect(mimeForFilename('sheet.xlsx')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(mimeForFilename('deck.pptx')).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    );
  });

  it('applies the pinned overrides instead of the library defaults', () => {
    expect(mimeForFilename('favicon.ico')).toBe('image/x-icon');
    expect(mimeForFilename('clip.m4v')).toBe('video/mp4');
    expect(mimeForFilename('voice.opus')).toBe('audio/opus');
    expect(mimeForFilename('song.flac')).toBe('audio/flac');
  });

  it('ignores extension case, since Windows filenames are case-insensitive', () => {
    expect(mimeForFilename('PHOTO.JPG')).toBe(mimeForFilename('photo.jpg'));
    expect(mimeForFilename('ICON.ICO')).toBe('image/x-icon');
  });

  it('reads the extension from a full path as well as a bare name', () => {
    expect(mimeForFilename('C:\\Users\\me\\Documents\\report.pdf')).toBe('application/pdf');
  });

  it('returns null for an unknown extension so callers can choose a fallback', () => {
    expect(mimeForFilename('archive.zzzzz')).toBeNull();
  });

  it('returns null when there is no extension at all', () => {
    expect(mimeForFilename('README')).toBeNull();
  });

  it('returns null for empty and non-string input rather than throwing', () => {
    expect(mimeForFilename('')).toBeNull();
    expect(mimeForFilename(null)).toBeNull();
    expect(mimeForFilename(undefined)).toBeNull();
  });

  it('treats a dotfile as having no extension', () => {
    expect(mimeForFilename('.gitignore')).toBeNull();
  });
});

describe('mimeForFilenameOrDefault', () => {
  it('falls back to a binary content type for unknown extensions', () => {
    expect(mimeForFilenameOrDefault('archive.zzzzz')).toBe(DEFAULT_MIME);
    expect(DEFAULT_MIME).toBe('application/octet-stream');
  });

  it('still returns the specific type when one is known', () => {
    expect(mimeForFilenameOrDefault('report.pdf')).toBe('application/pdf');
  });

  it('never returns null, which is what makes it safe as a Content-Type', () => {
    for (const name of ['', 'README', null, undefined, '.env']) {
      expect(typeof mimeForFilenameOrDefault(name)).toBe('string');
    }
  });
});
