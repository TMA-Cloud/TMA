import { describe, expect, it } from 'vitest';

import { extensionOf, getFileKind } from '../../../utils/fileKind.js';

describe('getFileKind', () => {
  it.each([
    ['Report.docx', 'document'],
    ['Brand Guidelines.pdf', 'pdf'],
    ['budget.XLSX', 'spreadsheet'],
    ['Launch Deck.pptx', 'presentation'],
    ['photo.HEIC', 'image'],
    ['comp.psd', 'design'],
    ['Product Teaser.mp4', 'video'],
    ['song.flac', 'audio'],
    ['backup.tar.gz', 'archive'],
    ['index.ts', 'code'],
    ['data.sqlite', 'database'],
    ['README.md', 'text'],
    ['setup.exe', 'executable'],
    ['Inter.woff2', 'font'],
  ])('sorts %s as %s', (name, kind) => {
    expect(getFileKind(name)).toBe(kind);
  });

  it('trusts the extension over a stored MIME type that disagrees', () => {
    expect(getFileKind('index.ts', 'video/mp2t')).toBe('code');
    expect(getFileKind('notes.pdf', 'application/octet-stream')).toBe('pdf');
    expect(getFileKind('intro.lottie', 'application/zip+dotlottie')).toBe('design');
  });

  it('looks up an extension outside its table in mime-db', () => {
    expect(getFileKind('photo.jfif')).toBe('image');
    expect(getFileKind('clip.3g2')).toBe('video');
    expect(getFileKind('mystery.xyz', 'application/pdf')).toBe('generic');
  });

  it('falls back to the stored MIME type only when there is no extension', () => {
    expect(getFileKind('scan', 'image/png')).toBe('image');
    expect(getFileKind('.env', 'text/plain; charset=utf-8')).toBe('text');
    expect(getFileKind('no-extension')).toBe('generic');
  });

  it('reads a MIME type by its whole subtype, ignoring the structured suffix', () => {
    expect(getFileKind('movie', 'application/x-shockwave-flash')).toBe('generic');
    expect(getFileKind('feed', 'application/atom+xml')).toBe('generic');
    expect(getFileKind('logo', 'image/svg+xml')).toBe('image');
  });
});

describe('extensionOf', () => {
  it('returns the final extension in lowercase, without the dot', () => {
    expect(extensionOf('Backup.TAR.GZ')).toBe('gz');
  });

  it('reads a leading dot as part of the name', () => {
    expect(extensionOf('.txt')).toBe('');
    expect(extensionOf('.env.local')).toBe('local');
  });

  it('tolerates a missing name', () => {
    expect(extensionOf(undefined)).toBe('');
  });
});
