import { describe, expect, it } from 'vitest';

import { choosePasteSource } from '../../src/contexts/app/helpers';

const copy = { ids: ['a'], action: 'copy' as const };
const cut = { ids: ['a'], action: 'cut' as const };

describe('choosePasteSource', () => {
  it('uses the cloud clipboard while it is still the newest copy', () => {
    expect(choosePasteSource({ cloud: copy, electron: true, osHasExternalFiles: false })).toBe('cloud');
  });

  it('uploads files copied in another app after the in-app copy or cut', () => {
    expect(choosePasteSource({ cloud: copy, electron: true, osHasExternalFiles: true })).toBe('os');
    expect(choosePasteSource({ cloud: cut, electron: true, osHasExternalFiles: true })).toBe('os');
  });

  it('falls back to the OS clipboard only on the desktop app', () => {
    expect(choosePasteSource({ cloud: null, electron: true, osHasExternalFiles: false })).toBe('os');
    expect(choosePasteSource({ cloud: null, electron: false, osHasExternalFiles: false })).toBe('none');
    expect(choosePasteSource({ cloud: copy, electron: false, osHasExternalFiles: true })).toBe('cloud');
  });
});
