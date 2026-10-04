import { describe, expect, it } from 'vitest';

import { canUseClipboardAction, choosePasteSource } from '../../src/contexts/app/helpers';
import type { AccountPermission } from '../../src/contexts/AuthContext';

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

describe('canUseClipboardAction', () => {
  const grants =
    (...granted: AccountPermission[]) =>
    (permission: AccountPermission) =>
      granted.includes(permission);
  const all = grants('files.upload', 'files.edit');

  it('allows nothing in the trash', () => {
    for (const action of ['copy', 'cut', 'paste'] as const) {
      expect(canUseClipboardAction(action, { view: 'Trash', can: all, clipboard: copy })).toBe(false);
    }
  });

  it('pastes only into My Files, where there is a current folder', () => {
    expect(canUseClipboardAction('paste', { view: 'My Files', can: all, clipboard: copy })).toBe(true);
    expect(canUseClipboardAction('paste', { view: 'Starred', can: all, clipboard: copy })).toBe(false);
    expect(canUseClipboardAction('paste', { view: 'Shared', can: all, clipboard: cut })).toBe(false);
  });

  it('copies and cuts from any other view', () => {
    expect(canUseClipboardAction('copy', { view: 'Starred', can: all, clipboard: null })).toBe(true);
    expect(canUseClipboardAction('cut', { view: 'Shared', can: all, clipboard: null })).toBe(true);
  });

  it('follows the grants the context menu uses', () => {
    const uploadOnly = grants('files.upload');
    expect(canUseClipboardAction('copy', { view: 'My Files', can: uploadOnly, clipboard: null })).toBe(true);
    expect(canUseClipboardAction('cut', { view: 'My Files', can: uploadOnly, clipboard: null })).toBe(false);
    expect(canUseClipboardAction('paste', { view: 'My Files', can: uploadOnly, clipboard: cut })).toBe(false);
    expect(canUseClipboardAction('paste', { view: 'My Files', can: uploadOnly, clipboard: copy })).toBe(true);
    expect(canUseClipboardAction('copy', { view: 'My Files', can: grants('files.edit'), clipboard: null })).toBe(false);
  });
});
