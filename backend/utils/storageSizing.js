/**
 * Common-denominator limits for AWS S3 and Cloudflare R2.
 *
 * AWS limits one atomic CopyObject/PutObject request to 5 GB. R2 permits a
 * slightly larger single request, so the AWS value is the portable boundary.
 * R2's maximum request/part size is 5 GiB minus 5 MiB, which is stricter than
 * S3's 5 GiB multipart-part limit.
 */
const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const TIB = 1024 ** 4;
const MAX_MULTIPART_PARTS = 10_000;
const MIN_MULTIPART_PART_SIZE = 5 * MIB;
const MAX_MULTIPART_PART_SIZE = 5 * GIB - 5 * MIB;
const MAX_PORTABLE_OBJECT_SIZE = 5 * TIB - 5 * GIB;
const MAX_SINGLE_REQUEST_BYTES = 5_000_000_000;
const DEFAULT_UPLOAD_PART_SIZE = 16 * MIB;
const DEFAULT_COPY_PART_SIZE = 256 * MIB;

function requiresMultipart(sizeInBytes) {
  const size = Number(sizeInBytes);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new TypeError('Object size must be a non-negative safe integer');
  }
  return size > MAX_SINGLE_REQUEST_BYTES;
}

/**
 * Choose equal-sized multipart chunks that cannot exceed the 10,000-part cap.
 * The last part may be smaller. MiB rounding keeps ranges predictable across
 * providers and avoids tiny changes in a size hint changing every boundary.
 */
function multipartPartSizeFor(maximumObjectSize, preferredPartSize = MIN_MULTIPART_PART_SIZE) {
  const size = Number(maximumObjectSize);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new TypeError('Maximum object size must be a non-negative safe integer');
  }
  if (size > MAX_PORTABLE_OBJECT_SIZE) {
    throw new RangeError('Object exceeds the portable S3/R2 maximum size');
  }

  const preferred = Number(preferredPartSize);
  if (!Number.isSafeInteger(preferred) || preferred < MIN_MULTIPART_PART_SIZE) {
    throw new TypeError(`Preferred multipart part size must be at least ${MIN_MULTIPART_PART_SIZE} bytes`);
  }

  const required = Math.ceil(size / MAX_MULTIPART_PARTS);
  const roundedRequired = Math.ceil(required / MIB) * MIB;
  const partSize = Math.max(MIN_MULTIPART_PART_SIZE, preferred, roundedRequired);
  if (partSize > MAX_MULTIPART_PART_SIZE) {
    throw new RangeError('No portable S3/R2 multipart plan can represent this object');
  }
  return partSize;
}

export {
  DEFAULT_COPY_PART_SIZE,
  DEFAULT_UPLOAD_PART_SIZE,
  MAX_MULTIPART_PARTS,
  MAX_MULTIPART_PART_SIZE,
  MAX_PORTABLE_OBJECT_SIZE,
  MAX_SINGLE_REQUEST_BYTES,
  MIN_MULTIPART_PART_SIZE,
  multipartPartSizeFor,
  requiresMultipart,
};
