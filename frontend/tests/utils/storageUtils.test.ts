import { describe, expect, it } from 'vitest';

import {
  BYTES_PER_GB,
  BYTES_PER_MB,
  BYTES_PER_TB,
  bytesToNumberAndUnit,
  formatBytes,
  numberAndUnitToBytes,
} from '../../src/utils/storageUtils';

describe('bytesToNumberAndUnit', () => {
  it('picks the largest unit the value fills', () => {
    expect(bytesToNumberAndUnit(5 * BYTES_PER_MB)).toEqual({ number: '5', unit: 'MB' });
    expect(bytesToNumberAndUnit(10 * BYTES_PER_GB)).toEqual({ number: '10', unit: 'GB' });
    expect(bytesToNumberAndUnit(2 * BYTES_PER_TB)).toEqual({ number: '2', unit: 'TB' });
  });

  it('switches unit exactly at each boundary', () => {
    expect(bytesToNumberAndUnit(BYTES_PER_GB - 1).unit).toBe('MB');
    expect(bytesToNumberAndUnit(BYTES_PER_GB).unit).toBe('GB');
    expect(bytesToNumberAndUnit(BYTES_PER_TB - 1).unit).toBe('GB');
    expect(bytesToNumberAndUnit(BYTES_PER_TB).unit).toBe('TB');
  });

  it('drops trailing zeros so the input field reads cleanly', () => {
    expect(bytesToNumberAndUnit(1.5 * BYTES_PER_GB).number).toBe('1.5');
    expect(bytesToNumberAndUnit(2 * BYTES_PER_GB).number).toBe('2');
  });

  it('rounds to two decimal places', () => {
    expect(bytesToNumberAndUnit(1234567890).number).toBe('1.15');
  });

  it('reports an empty field with a GB default for no limit', () => {
    expect(bytesToNumberAndUnit(null)).toEqual({ number: '', unit: 'GB' });
    expect(bytesToNumberAndUnit(undefined)).toEqual({ number: '', unit: 'GB' });
  });

  it('reports an empty field for zero, negative or unparseable input', () => {
    expect(bytesToNumberAndUnit(0).number).toBe('');
    expect(bytesToNumberAndUnit(-100).number).toBe('');
    expect(bytesToNumberAndUnit('not a number').number).toBe('');
  });

  it('accepts a numeric string, as a BIGINT arrives from the API', () => {
    expect(bytesToNumberAndUnit(String(10 * BYTES_PER_GB))).toEqual({ number: '10', unit: 'GB' });
  });

  it('defaults to GB for a value below one megabyte', () => {
    expect(bytesToNumberAndUnit(1024).unit).toBe('GB');
  });
});

describe('numberAndUnitToBytes', () => {
  it('multiplies by the unit', () => {
    expect(numberAndUnitToBytes('5', 'MB')).toBe(5 * BYTES_PER_MB);
    expect(numberAndUnitToBytes('10', 'GB')).toBe(10 * BYTES_PER_GB);
    expect(numberAndUnitToBytes('2', 'TB')).toBe(2 * BYTES_PER_TB);
  });

  it('accepts a fractional value', () => {
    expect(numberAndUnitToBytes('1.5', 'GB')).toBe(1.5 * BYTES_PER_GB);
  });

  it('floors to a whole number of bytes', () => {
    expect(Number.isInteger(numberAndUnitToBytes('1.333', 'GB'))).toBe(true);
  });

  it('trims surrounding whitespace', () => {
    expect(numberAndUnitToBytes('  10  ', 'GB')).toBe(10 * BYTES_PER_GB);
  });

  it('rejects an empty field', () => {
    expect(numberAndUnitToBytes('', 'GB')).toBeNull();
    expect(numberAndUnitToBytes('   ', 'GB')).toBeNull();
  });

  it('rejects zero and negative values', () => {
    expect(numberAndUnitToBytes('0', 'GB')).toBeNull();
    expect(numberAndUnitToBytes('-5', 'GB')).toBeNull();
  });

  it('rejects unparseable input', () => {
    expect(numberAndUnitToBytes('abc', 'GB')).toBeNull();
    expect(numberAndUnitToBytes('Infinity', 'GB')).toBeNull();
    expect(numberAndUnitToBytes('NaN', 'GB')).toBeNull();
  });

  it('rejects a value whose byte count would exceed MAX_SAFE_INTEGER', () => {
    expect(numberAndUnitToBytes('1e14', 'TB')).toBeNull();
  });

  it('round-trips with bytesToNumberAndUnit', () => {
    const original = 10 * BYTES_PER_GB;
    const { number, unit } = bytesToNumberAndUnit(original);
    expect(numberAndUnitToBytes(number, unit)).toBe(original);
  });
});

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1023, '1023 B'],
    [1024, '1 KB'],
    [1536, '1.5 KB'],
    [BYTES_PER_MB, '1 MB'],
    [BYTES_PER_GB, '1 GB'],
    [BYTES_PER_TB, '1 TB'],
  ])('formats %i as %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  it('caps at TB rather than inventing a larger unit', () => {
    expect(formatBytes(5000 * BYTES_PER_TB)).toMatch(/TB$/);
  });

  it('trims trailing zeros', () => {
    expect(formatBytes(2 * BYTES_PER_GB)).toBe('2 GB');
    expect(formatBytes(2.5 * BYTES_PER_GB)).toBe('2.5 GB');
  });

  it('shows an em dash for missing or invalid values', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes('nonsense')).toBe('—');
    expect(formatBytes(Infinity)).toBe('—');
  });

  it('accepts a numeric string from the API', () => {
    expect(formatBytes('1073741824')).toBe('1 GB');
  });
});
