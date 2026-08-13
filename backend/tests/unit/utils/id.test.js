import { describe, expect, it } from 'vitest';

import { generateId } from '../../../utils/id.js';

// Base58-style alphabet: no 0/O/I/l, so ids stay unambiguous when read aloud.
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

describe('generateId', () => {
  it('defaults to 16 characters, matching what the validators expect', () => {
    expect(generateId()).toHaveLength(16);
  });

  it('produces ids that pass the API id format check', () => {
    expect(generateId()).toMatch(/^[a-zA-Z0-9]{16}$/);
  });

  it('honours a requested length', () => {
    expect(generateId(8)).toHaveLength(8);
    expect(generateId(32)).toHaveLength(32);
    expect(generateId(1)).toHaveLength(1);
  });

  it('only ever uses the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) {
      for (const char of generateId()) {
        expect(ALPHABET).toContain(char);
      }
    }
  });

  it('never emits the visually confusable characters 0, O, I or l', () => {
    const sample = Array.from({ length: 500 }, () => generateId()).join('');
    expect(sample).not.toMatch(/[0OIl]/);
  });

  it('does not collide across a large sample', () => {
    const ids = new Set(Array.from({ length: 20000 }, () => generateId()));
    expect(ids.size).toBe(20000);
  });
});
