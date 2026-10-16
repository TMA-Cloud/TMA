//! Common-denominator limits for AWS S3 and Cloudflare R2. AWS caps one atomic
//! CopyObject/PutObject at 5 GB; R2 caps a part at 5 GiB minus 5 MiB.

const MIB: u64 = 1024 * 1024;
const GIB: u64 = 1024 * MIB;
const TIB: u64 = 1024 * GIB;
pub const MAX_MULTIPART_PARTS: u64 = 10_000;
pub const MIN_PART_SIZE: u64 = 5 * MIB;
pub const MAX_PART_SIZE: u64 = 5 * GIB - 5 * MIB;
pub const MAX_PORTABLE_OBJECT_SIZE: u64 = 5 * TIB - 5 * GIB;
pub const MAX_SINGLE_REQUEST_BYTES: u64 = 5_000_000_000;
pub const DEFAULT_UPLOAD_PART_SIZE: u64 = 16 * MIB;
pub const DEFAULT_COPY_PART_SIZE: u64 = 256 * MIB;

pub fn requires_multipart(size: u64) -> bool {
    size > MAX_SINGLE_REQUEST_BYTES
}

/// Equal parts that cannot exceed the 10,000-part cap; the last may be smaller.
/// MiB rounding keeps ranges predictable across providers.
pub fn part_size_for(maximum_object_size: u64, preferred: u64) -> Result<u64, String> {
    if maximum_object_size > MAX_PORTABLE_OBJECT_SIZE {
        return Err("Object exceeds the portable S3/R2 maximum size".into());
    }
    let required = maximum_object_size.div_ceil(MAX_MULTIPART_PARTS);
    let rounded = required.div_ceil(MIB) * MIB;
    let size = MIN_PART_SIZE.max(preferred).max(rounded);
    if size > MAX_PART_SIZE {
        return Err("No portable S3/R2 multipart plan can represent this object".into());
    }
    Ok(size)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizing() {
        assert_eq!(part_size_for(10 * GIB, DEFAULT_UPLOAD_PART_SIZE), Ok(16 * MIB));
        assert_eq!(part_size_for(4 * TIB, DEFAULT_UPLOAD_PART_SIZE), Ok(420 * MIB));
        assert!(part_size_for(6 * TIB, DEFAULT_UPLOAD_PART_SIZE).is_err());
        assert!(!requires_multipart(5_000_000_000));
        assert!(requires_multipart(5_000_000_001));
    }
}
