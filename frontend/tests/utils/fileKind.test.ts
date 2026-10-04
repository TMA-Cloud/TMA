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

  it('knows formats newer than mime-db', () => {
    expect(getFileKind('IMG_0001.CR3')).toBe('image');
    expect(getFileKind('sketch.procreate')).toBe('design');
    expect(getFileKind('main.zig')).toBe('code');
    expect(getFileKind('events.arrow')).toBe('database');
    expect(getFileKind('Tool.AppImage')).toBe('executable');
    expect(getFileKind('scan.dcm')).toBe('image');
  });

  it('overrides mime-db where it is wrong', () => {
    // mime-db registers .lottie backwards as zip+dotlottie (jshttp/mime-db#427).
    expect(getFileKind('intro.lottie', 'application/zip+dotlottie')).toBe('design');
    expect(getFileKind('index.ts', 'video/mp2t')).toBe('code');
  });

  it('reads a MIME type by its whole subtype, ignoring the structured suffix', () => {
    expect(getFileKind('movie', 'application/x-shockwave-flash')).toBe('generic');
    expect(getFileKind('feed', 'application/atom+xml')).toBe('generic');
    expect(getFileKind('model', 'model/vnd.usdz+zip')).toBe('generic');
    expect(getFileKind('logo', 'image/svg+xml')).toBe('image');
    expect(getFileKind('page', 'application/xhtml+xml')).toBe('code');
    expect(getFileKind('run', 'application/x-sh; charset=utf-8')).toBe('code');
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
