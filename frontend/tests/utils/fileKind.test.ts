import { describe, expect, it } from 'vitest';

import { getFileKind } from '../../src/utils/fileKind';

describe('getFileKind', () => {
  it.each([
    ['Report.docx', 'document'],
    ['Brand Guidelines.pdf', 'pdf'],
    ['budget.XLSX', 'spreadsheet'],
    ['export.csv', 'spreadsheet'],
    ['Launch Deck.pptx', 'presentation'],
    ['photo.HEIC', 'image'],
    ['logo.svg', 'image'],
    ['Artwork 1.ai', 'design'],
    ['comp.psd', 'design'],
    ['mockup.fig', 'design'],
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

  it('trusts the extension over a generic upload MIME type', () => {
    expect(getFileKind('notes.pdf', 'application/octet-stream')).toBe('pdf');
    expect(getFileKind('clip.mov', 'application/octet-stream')).toBe('video');
  });

  it('falls back to the MIME type when the extension says nothing', () => {
    expect(getFileKind('scan', 'image/png')).toBe('image');
    expect(getFileKind('blob.bin', 'application/pdf')).toBe('pdf');
    expect(getFileKind('sheet', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe(
      'spreadsheet'
    );
    expect(getFileKind('notes', 'TEXT/PLAIN')).toBe('text');
    expect(getFileKind('layers', 'image/vnd.adobe.photoshop')).toBe('design');
  });

  it('reads a leading dot as part of the name, not an extension', () => {
    expect(getFileKind('.pdf')).toBe('generic');
    expect(getFileKind('.env', 'text/plain')).toBe('text');
  });

  it('calls anything it cannot place generic', () => {
    expect(getFileKind('mystery.xyz')).toBe('generic');
    expect(getFileKind('no-extension')).toBe('generic');
    expect(getFileKind('mystery.xyz', 'application/x-unheard-of')).toBe('generic');
  });
});
