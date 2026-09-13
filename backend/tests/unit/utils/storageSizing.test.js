import { describe, expect, it } from 'vitest';

import {
  DEFAULT_COPY_PART_SIZE,
  DEFAULT_UPLOAD_PART_SIZE,
  MAX_MULTIPART_PARTS,
  MAX_MULTIPART_PART_SIZE,
  MAX_PORTABLE_OBJECT_SIZE,
  MAX_SINGLE_REQUEST_BYTES,
  multipartPartSizeFor,
  requiresMultipart,
} from '../../../utils/storageSizing.js';

describe('portable S3/R2 multipart sizing', () => {
  it('keeps the shared single-request boundary in decimal bytes', () => {
    expect(MAX_SINGLE_REQUEST_BYTES).toBe(5_000_000_000);
    expect(requiresMultipart(MAX_SINGLE_REQUEST_BYTES)).toBe(false);
    expect(requiresMultipart(MAX_SINGLE_REQUEST_BYTES + 1)).toBe(true);
  });

  it('uses the efficient upload floor for the application maximum', () => {
    const maximumEncryptedUpload = 100 * 1024 ** 3 + 2 * 1024 ** 2;
    const partSize = multipartPartSizeFor(maximumEncryptedUpload, DEFAULT_UPLOAD_PART_SIZE);

    expect(partSize).toBe(16 * 1024 ** 2);
    expect(Math.ceil(maximumEncryptedUpload / partSize)).toBeLessThanOrEqual(MAX_MULTIPART_PARTS);
  });

  it('grows copy parts to represent the portable maximum object', () => {
    const partSize = multipartPartSizeFor(MAX_PORTABLE_OBJECT_SIZE, DEFAULT_COPY_PART_SIZE);

    expect(partSize).toBeGreaterThan(DEFAULT_COPY_PART_SIZE);
    expect(partSize).toBeLessThanOrEqual(MAX_MULTIPART_PART_SIZE);
    expect(Math.ceil(MAX_PORTABLE_OBJECT_SIZE / partSize)).toBeLessThanOrEqual(MAX_MULTIPART_PARTS);
  });

  it('rejects objects beyond the shared R2/S3 contract', () => {
    expect(() => multipartPartSizeFor(MAX_PORTABLE_OBJECT_SIZE + 1)).toThrow(/portable S3\/R2 maximum/);
  });
});
