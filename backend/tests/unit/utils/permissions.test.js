import { describe, expect, it } from 'vitest';

import {
  ALL_PERMISSIONS,
  FULL_ACCESS_PERMISSIONS,
  PERMISSIONS,
  PERMISSION_CATALOG,
  VIEW_ONLY_PERMISSIONS,
  arePermissionsValid,
  hasPermission,
  normalizePermissions,
} from '../../../utils/permissions.js';

describe('permission catalog', () => {
  it('exposes every canonical key exactly once', () => {
    const catalogKeys = PERMISSION_CATALOG.map(p => p.key);
    expect(new Set(catalogKeys).size).toBe(catalogKeys.length);
    expect(new Set(catalogKeys)).toEqual(new Set(Object.values(PERMISSIONS)));
  });

  it('gives every entry a label and description for the UI checklist', () => {
    for (const entry of PERMISSION_CATALOG) {
      expect(entry.label).toBeTruthy();
      expect(entry.description).toBeTruthy();
    }
  });

  it('orders the catalog from least to most destructive', () => {
    const keys = PERMISSION_CATALOG.map(p => p.key);
    expect(keys.indexOf(PERMISSIONS.DOWNLOAD)).toBeLessThan(keys.indexOf(PERMISSIONS.DELETE));
    expect(keys.indexOf(PERMISSIONS.DELETE)).toBeLessThan(keys.indexOf(PERMISSIONS.TRASH));
  });

  it('keeps ALL_PERMISSIONS in catalog order', () => {
    expect(ALL_PERMISSIONS).toEqual(PERMISSION_CATALOG.map(p => p.key));
  });

  it('uses a dotted namespace for every key so new areas stay unambiguous', () => {
    for (const key of ALL_PERMISSIONS) {
      expect(key).toMatch(/^[a-z]+\.[a-z]+$/);
    }
  });
});

describe('presets', () => {
  it('full access grants everything', () => {
    expect(new Set(FULL_ACCESS_PERMISSIONS)).toEqual(new Set(ALL_PERMISSIONS));
  });

  it('full access is a copy, so mutating it cannot corrupt the catalog', () => {
    const before = [...ALL_PERMISSIONS];
    const preset = [...FULL_ACCESS_PERMISSIONS];
    preset.push('files.nonsense');
    expect(ALL_PERMISSIONS).toEqual(before);
  });

  it('view only grants download and nothing else', () => {
    expect(VIEW_ONLY_PERMISSIONS).toEqual([PERMISSIONS.DOWNLOAD]);
  });
});

describe('normalizePermissions', () => {
  it('drops unknown keys', () => {
    expect(normalizePermissions([PERMISSIONS.DOWNLOAD, 'files.launch_missiles'])).toEqual([PERMISSIONS.DOWNLOAD]);
  });

  it('removes duplicates', () => {
    expect(normalizePermissions([PERMISSIONS.UPLOAD, PERMISSIONS.UPLOAD])).toEqual([PERMISSIONS.UPLOAD]);
  });

  it('returns keys in catalog order regardless of input order', () => {
    const scrambled = [PERMISSIONS.TRASH, PERMISSIONS.DOWNLOAD, PERMISSIONS.SHARE];
    expect(normalizePermissions(scrambled)).toEqual([PERMISSIONS.DOWNLOAD, PERMISSIONS.SHARE, PERMISSIONS.TRASH]);
  });

  it('produces comparable output for equivalent inputs, so stored rows can be diffed', () => {
    const a = normalizePermissions([PERMISSIONS.DELETE, PERMISSIONS.UPLOAD]);
    const b = normalizePermissions([PERMISSIONS.UPLOAD, PERMISSIONS.DELETE, PERMISSIONS.UPLOAD]);
    expect(a).toEqual(b);
  });

  it('ignores non-string entries', () => {
    expect(normalizePermissions([PERMISSIONS.EDIT, null, 42, {}, undefined])).toEqual([PERMISSIONS.EDIT]);
  });

  it('returns an empty array for non-array input', () => {
    for (const input of [null, undefined, 'files.download', {}, 42]) {
      expect(normalizePermissions(input)).toEqual([]);
    }
  });

  it('returns an empty array for an empty list', () => {
    expect(normalizePermissions([])).toEqual([]);
  });
});

describe('arePermissionsValid', () => {
  it('accepts a list drawn entirely from the catalog', () => {
    expect(arePermissionsValid(ALL_PERMISSIONS)).toBe(true);
    expect(arePermissionsValid([])).toBe(true);
  });

  it('rejects a list containing an unknown key', () => {
    expect(arePermissionsValid([PERMISSIONS.DOWNLOAD, 'files.admin'])).toBe(false);
  });

  it('rejects non-string entries', () => {
    expect(arePermissionsValid([PERMISSIONS.DOWNLOAD, 123])).toBe(false);
    expect(arePermissionsValid([null])).toBe(false);
  });

  it('rejects non-arrays', () => {
    expect(arePermissionsValid('files.download')).toBe(false);
    expect(arePermissionsValid(null)).toBe(false);
    expect(arePermissionsValid(undefined)).toBe(false);
  });
});

describe('hasPermission', () => {
  it('grants everything to an account owner without consulting the list', () => {
    const owner = { isSubUser: false, permissions: [] };
    for (const key of ALL_PERMISSIONS) {
      expect(hasPermission(owner, key)).toBe(true);
    }
  });

  it('treats a request with no sub-user flag as an owner', () => {
    expect(hasPermission({}, PERMISSIONS.DELETE)).toBe(true);
  });

  it('treats a missing request as an owner rather than throwing', () => {
    expect(hasPermission(null, PERMISSIONS.DELETE)).toBe(true);
    expect(hasPermission(undefined, PERMISSIONS.DELETE)).toBe(true);
  });

  it('grants a sub-user only what it was given', () => {
    const req = { isSubUser: true, permissions: [PERMISSIONS.DOWNLOAD, PERMISSIONS.UPLOAD] };
    expect(hasPermission(req, PERMISSIONS.DOWNLOAD)).toBe(true);
    expect(hasPermission(req, PERMISSIONS.UPLOAD)).toBe(true);
    expect(hasPermission(req, PERMISSIONS.DELETE)).toBe(false);
    expect(hasPermission(req, PERMISSIONS.SHARE)).toBe(false);
  });

  it('denies a sub-user whose permissions are missing or malformed', () => {
    expect(hasPermission({ isSubUser: true, permissions: null }, PERMISSIONS.DOWNLOAD)).toBe(false);
    expect(hasPermission({ isSubUser: true }, PERMISSIONS.DOWNLOAD)).toBe(false);
    expect(hasPermission({ isSubUser: true, permissions: 'files.download' }, PERMISSIONS.DOWNLOAD)).toBe(false);
  });

  it('denies a sub-user with an empty grant list', () => {
    const req = { isSubUser: true, permissions: [] };
    for (const key of ALL_PERMISSIONS) {
      expect(hasPermission(req, key)).toBe(false);
    }
  });

  it('does not treat a permission prefix as a match', () => {
    const req = { isSubUser: true, permissions: ['files.download'] };
    expect(hasPermission(req, 'files.down')).toBe(false);
    expect(hasPermission(req, 'files')).toBe(false);
  });
});
