/**
 * Storage utility functions
 */

/**
 * Storage unit type
 */
export type StorageUnit = 'MB' | 'GB' | 'TB';

/**
 * Storage multipliers in bytes
 */
const STORAGE_MULTIPLIERS: Record<StorageUnit, number> = {
  MB: 1024 * 1024,
  GB: 1024 * 1024 * 1024,
  TB: 1024 * 1024 * 1024 * 1024,
};

/**
 * Convert bytes to number and unit (MB/GB/TB)
 * Returns the number and unit for editing
 */
export function bytesToNumberAndUnit(bytes: number | string | null | undefined): { number: string; unit: StorageUnit } {
  if (bytes === null || bytes === undefined) {
    return { number: '', unit: 'GB' };
  }

  const numBytes = typeof bytes === 'string' ? Number(bytes) : bytes;
  if (isNaN(numBytes) || numBytes <= 0) {
    return { number: '', unit: 'GB' };
  }

  // Determine best unit to display
  let unit: StorageUnit = 'GB';
  if (numBytes >= STORAGE_MULTIPLIERS.TB) {
    unit = 'TB';
  } else if (numBytes >= STORAGE_MULTIPLIERS.GB) {
    unit = 'GB';
  } else if (numBytes >= STORAGE_MULTIPLIERS.MB) {
    unit = 'MB';
  }

  const number = (numBytes / STORAGE_MULTIPLIERS[unit]).toFixed(2);
  // Remove trailing zeros and decimal point if not needed
  const cleanNumber = parseFloat(number).toString();

  return { number: cleanNumber, unit };
}

/**
 * Convert number and unit to bytes
 * Returns null if invalid, otherwise returns bytes as integer
 */
export function numberAndUnitToBytes(number: string, unit: StorageUnit): number | null {
  const trimmed = number.trim();
  if (!trimmed) return null;

  const value = parseFloat(trimmed);
  // Validate: must be finite, positive, and reasonable
  if (!Number.isFinite(value) || value <= 0 || value > 1e15) {
    return null;
  }

  const result = value * STORAGE_MULTIPLIERS[unit];

  // Final validation: result must be a safe integer and positive
  if (!Number.isFinite(result) || result <= 0 || result > Number.MAX_SAFE_INTEGER) {
    return null;
  }

  return Math.floor(result);
}
