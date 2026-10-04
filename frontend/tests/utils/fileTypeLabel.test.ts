import { describe, expect, it } from 'vitest';

import { getFileTypeLabel } from '../../src/utils/fileTypeLabel';

describe('getFileTypeLabel', () => {
  it.each([
    ['Contacts.csv', 'CSV spreadsheet'],
    ['Report.DOCX', 'DOCX document'],
    ['Brand Guidelines.pdf', 'PDF document'],
    ['Launch Deck.pptx', 'PPTX presentation'],
    ['photo.png', 'PNG image'],
    ['comp.psd', 'PSD design file'],
    ['clip.mkv', 'MKV video'],
    ['song.flac', 'FLAC audio'],
    ['backup.tar.gz', 'GZ archive'],
    ['index.ts', 'TS source file'],
    ['data.sqlite', 'SQLITE database'],
    ['README.md', 'MD text document'],
    ['setup.exe', 'EXE application'],
    ['Inter.woff2', 'WOFF2 font'],
  ])('describes %s as %s', (name, label) => {
    expect(getFileTypeLabel(name)).toBe(label);
  });

  it('places extensions outside its own tables through mime-db', () => {
    expect(getFileTypeLabel('photo.jxl')).toBe('JXL image');
    expect(getFileTypeLabel('clip.3g2')).toBe('3G2 video');
    expect(getFileTypeLabel('track.mka')).toBe('MKA audio');
    expect(getFileTypeLabel('part.stl')).toBe('STL file');
  });

  it('names an unknown extension after itself, whatever the MIME type says', () => {
    expect(getFileTypeLabel('mystery.xyz')).toBe('XYZ file');
    expect(getFileTypeLabel('blob.bin', 'application/pdf')).toBe('BIN file');
  });

  it('falls back to the MIME type when there is no extension', () => {
    expect(getFileTypeLabel('scan', 'image/png')).toBe('Image');
    expect(getFileTypeLabel('scan', 'application/pdf')).toBe('PDF document');
    expect(getFileTypeLabel('.env', 'text/plain')).toBe('Text document');
  });

  it('calls a file with nothing to go on just a file', () => {
    expect(getFileTypeLabel('no-extension')).toBe('File');
    expect(getFileTypeLabel('.gitignore')).toBe('File');
  });
});
