import { describe, expect, it } from 'vitest';

import { MAX_ITEM_NAME_LENGTH, isValidItemName, portableName } from '../../../utils/fileName.js';

describe('isValidItemName', () => {
  it.each([
    'report.pdf',
    'Q3: plan?.docx',
    'a*b<c>d|e"f.txt',
    'CON',
    'trailing.',
    'Standup 9_05\u202FAM.txt',
    '📁 Photos',
  ])('stores %s as the user named it', name => {
    expect(isValidItemName(name)).toBe(true);
  });

  it.each([
    ['a separator', 'a/b'],
    ['a Windows separator', 'a\\b'],
    ['a NUL byte', 'a\0b'],
    ['a newline', 'a\nb'],
    ['DEL', 'a\x7Fb'],
    ['the current directory', '.'],
    ['the parent directory', '..'],
    ['nothing but spaces', '   '],
    ['a non-string', 42],
  ])('refuses %s', (_label, name) => {
    expect(isValidItemName(name)).toBe(false);
  });

  it(`allows exactly ${MAX_ITEM_NAME_LENGTH} characters`, () => {
    expect(isValidItemName('a'.repeat(MAX_ITEM_NAME_LENGTH))).toBe(true);
    expect(isValidItemName('a'.repeat(MAX_ITEM_NAME_LENGTH + 1))).toBe(false);
  });
});

describe('portableName', () => {
  it('leaves an ordinary name alone', () => {
    expect(portableName('Résumé (final).pdf')).toBe('Résumé (final).pdf');
  });

  it('replaces what Windows cannot extract, as browsers do for downloads', () => {
    expect(portableName('Q3: plan?.docx')).toBe('Q3_ plan_.docx');
    expect(portableName('a*b<c>d|e"f.txt')).toBe('a_b_c_d_e_f.txt');
  });

  it('never yields a segment an extractor reads as a path', () => {
    expect(portableName('..\\..\\evil')).toBe('.._.._evil');
    expect(portableName('C:evil.exe')).toBe('C_evil.exe');
  });

  it('drops the trailing dots and spaces Windows would drop anyway', () => {
    expect(portableName('notes. ')).toBe('notes');
    expect(portableName('...')).toBe('_');
  });
});
