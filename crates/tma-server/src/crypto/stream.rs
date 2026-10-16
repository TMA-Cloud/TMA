//! The streaming AEAD wire format, interoperable with Tink's StreamingAead:
//!
//! ```text
//! header     = headerLength(1) || salt(32) || noncePrefix(7)       40 bytes
//! segment_i  = AES256-GCM(derivedKey, nonce_i, plaintext_i) || tag(16)
//! nonce_i    = noncePrefix(7) || uint32BE(i) || lastFlag(1)
//! derivedKey = HKDF-SHA256(ikm = data key, salt, info = "")
//! ```
//!
//! Segment 0 holds less plaintext so header || segment_0 fills one 1 MiB
//! segment; the layout is a bijection, so sizes convert exactly both ways.

use anyhow::{Result, anyhow, bail};
use bytes::{Bytes, BytesMut};
use ring::aead::{AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey};

pub const TAG_LENGTH: usize = 16;
const SALT_LENGTH: usize = 32;
const NONCE_PREFIX_LENGTH: usize = 7;
pub const HEADER_LENGTH: usize = 1 + SALT_LENGTH + NONCE_PREFIX_LENGTH;
pub const CIPHERTEXT_SEGMENT_SIZE: usize = 1024 * 1024;
pub const PLAINTEXT_FIRST_SEGMENT_MAX: usize = CIPHERTEXT_SEGMENT_SIZE - HEADER_LENGTH - TAG_LENGTH;
pub const PLAINTEXT_SEGMENT_MAX: usize = CIPHERTEXT_SEGMENT_SIZE - TAG_LENGTH;
const FIRST_CIPHERTEXT_CAP: usize = CIPHERTEXT_SEGMENT_SIZE - HEADER_LENGTH;

fn segment_key(ikm: &[u8; 32], salt: &[u8]) -> Result<LessSafeKey> {
    let derived = super::hkdf_sha256(ikm, salt, &[]);
    let unbound = UnboundKey::new(&AES_256_GCM, &derived).map_err(|_| anyhow!("Invalid derived key"))?;
    Ok(LessSafeKey::new(unbound))
}

fn segment_nonce(prefix: &[u8; NONCE_PREFIX_LENGTH], index: u32, last: bool) -> Nonce {
    let mut nonce = [0u8; 12];
    nonce[..NONCE_PREFIX_LENGTH].copy_from_slice(prefix);
    nonce[NONCE_PREFIX_LENGTH..NONCE_PREFIX_LENGTH + 4].copy_from_slice(&index.to_be_bytes());
    nonce[11] = u8::from(last);
    Nonce::assume_unique_for_key(nonce)
}

/// Total segments a plaintext of `len` bytes is split into.
pub fn total_segments(len: u64) -> u64 {
    let first = PLAINTEXT_FIRST_SEGMENT_MAX as u64;
    if len <= first { 1 } else { 1 + (len - first).div_ceil(PLAINTEXT_SEGMENT_MAX as u64) }
}

fn plaintext_offset_at(i: u64) -> u64 {
    if i == 0 { 0 } else { PLAINTEXT_FIRST_SEGMENT_MAX as u64 + (i - 1) * PLAINTEXT_SEGMENT_MAX as u64 }
}

fn plaintext_segment_length(i: u64, len: u64) -> u64 {
    let total = total_segments(len);
    if i >= total {
        return 0;
    }
    if i < total - 1 {
        return if i == 0 { PLAINTEXT_FIRST_SEGMENT_MAX as u64 } else { PLAINTEXT_SEGMENT_MAX as u64 };
    }
    len - plaintext_offset_at(i)
}

fn ciphertext_offset_at(i: u64) -> u64 {
    if i == 0 { HEADER_LENGTH as u64 } else { i * CIPHERTEXT_SEGMENT_SIZE as u64 }
}

fn segment_index_for_offset(p: u64) -> u64 {
    let first = PLAINTEXT_FIRST_SEGMENT_MAX as u64;
    if p < first { 0 } else { 1 + (p - first) / PLAINTEXT_SEGMENT_MAX as u64 }
}

/// Exact stored size for a plaintext length.
pub fn plaintext_size_to_ciphertext_size(len: u64) -> u64 {
    HEADER_LENGTH as u64 + len + total_segments(len) * TAG_LENGTH as u64
}

/// Plaintext length recovered from the stored object size.
pub fn ciphertext_size_to_plaintext_size(size: u64) -> Result<u64> {
    if size < (HEADER_LENGTH + TAG_LENGTH) as u64 {
        bail!("Invalid ciphertext size: {size}");
    }
    let body = size - HEADER_LENGTH as u64;
    let first_cap = FIRST_CIPHERTEXT_CAP as u64;
    if body <= first_cap {
        return Ok(body - TAG_LENGTH as u64);
    }
    let rem = body - first_cap;
    let seg = CIPHERTEXT_SEGMENT_SIZE as u64;
    let full_middle = rem / seg;
    let last = rem - full_middle * seg;
    let base = PLAINTEXT_FIRST_SEGMENT_MAX as u64 + full_middle * PLAINTEXT_SEGMENT_MAX as u64;
    if last == 0 {
        Ok(base)
    } else if last < TAG_LENGTH as u64 {
        bail!("Invalid ciphertext size: {size}")
    } else {
        Ok(base + last - TAG_LENGTH as u64)
    }
}

/// Encrypts a byte stream chunk by chunk; holds back one segment so the final
/// segment's nonce can be flagged as last.
pub struct Encryptor {
    key: LessSafeKey,
    prefix: [u8; NONCE_PREFIX_LENGTH],
    header: Option<Bytes>,
    pending: BytesMut,
    index: u32,
    plaintext_len: u64,
}

impl Encryptor {
    pub fn new(ikm: &[u8; 32]) -> Result<Self> {
        let salt: [u8; SALT_LENGTH] = super::random_bytes();
        let prefix: [u8; NONCE_PREFIX_LENGTH] = super::random_bytes();
        let mut header = BytesMut::with_capacity(HEADER_LENGTH);
        header.extend_from_slice(&[HEADER_LENGTH as u8]);
        header.extend_from_slice(&salt);
        header.extend_from_slice(&prefix);
        Ok(Self {
            key: segment_key(ikm, &salt)?,
            prefix,
            header: Some(header.freeze()),
            pending: BytesMut::with_capacity(CIPHERTEXT_SEGMENT_SIZE),
            index: 0,
            plaintext_len: 0,
        })
    }

    fn cap(&self) -> usize {
        if self.index == 0 { PLAINTEXT_FIRST_SEGMENT_MAX } else { PLAINTEXT_SEGMENT_MAX }
    }

    fn seal(&mut self, mut segment: BytesMut, last: bool) -> Result<Bytes> {
        let tag = self
            .key
            .seal_in_place_separate_tag(segment_nonce(&self.prefix, self.index, last), Aad::empty(), &mut segment)
            .map_err(|_| anyhow!("Encryption failed"))?;
        segment.extend_from_slice(tag.as_ref());
        self.index = self.index.checked_add(1).ok_or_else(|| anyhow!("File has too many segments"))?;
        Ok(segment.freeze())
    }

    /// Ciphertext ready after feeding `data` (possibly empty).
    pub fn push(&mut self, data: &[u8]) -> Result<Vec<Bytes>> {
        let mut out = Vec::new();
        if let Some(header) = self.header.take() {
            out.push(header);
        }
        self.plaintext_len += data.len() as u64;
        self.pending.extend_from_slice(data);
        // Emit only when more data follows, so the remainder can become the last segment.
        while self.pending.len() > self.cap() {
            let cap = self.cap();
            let segment = self.pending.split_to(cap);
            out.push(self.seal(segment, false)?);
        }
        Ok(out)
    }

    /// The final segment (an empty file yields a segment that is just the tag).
    pub fn finish(mut self) -> Result<Vec<Bytes>> {
        let mut out = Vec::new();
        if let Some(header) = self.header.take() {
            out.push(header);
        }
        let rest = std::mem::take(&mut self.pending);
        out.push(self.seal(rest, true)?);
        Ok(out)
    }

    /// Plaintext bytes fed so far.
    pub fn plaintext_len(&self) -> u64 {
        self.plaintext_len
    }
}

/// Decrypts a full object in order, reading one segment ahead so the final
/// segment is recognised without knowing the length up front.
pub struct Decryptor {
    ikm: [u8; 32],
    key: Option<LessSafeKey>,
    prefix: [u8; NONCE_PREFIX_LENGTH],
    buf: BytesMut,
    index: u32,
}

fn parse_header(buf: &[u8]) -> Result<([u8; SALT_LENGTH], [u8; NONCE_PREFIX_LENGTH])> {
    if buf.len() < HEADER_LENGTH {
        bail!("Invalid encrypted stream: header too short");
    }
    if buf[0] as usize != HEADER_LENGTH {
        bail!("Unsupported encryption header length: {}", buf[0]);
    }
    let mut salt = [0u8; SALT_LENGTH];
    salt.copy_from_slice(&buf[1..1 + SALT_LENGTH]);
    let mut prefix = [0u8; NONCE_PREFIX_LENGTH];
    prefix.copy_from_slice(&buf[1 + SALT_LENGTH..HEADER_LENGTH]);
    Ok((salt, prefix))
}

fn open(
    key: &LessSafeKey,
    prefix: &[u8; NONCE_PREFIX_LENGTH],
    index: u32,
    last: bool,
    mut ct: BytesMut,
) -> Result<Bytes> {
    if ct.len() < TAG_LENGTH {
        bail!("Invalid encrypted segment: shorter than the authentication tag");
    }
    let len = key
        .open_in_place(segment_nonce(prefix, index, last), Aad::empty(), &mut ct)
        .map_err(|_| anyhow!("Error decrypting file: authentication failed"))?
        .len();
    ct.truncate(len);
    Ok(ct.freeze())
}

impl Decryptor {
    pub fn new(ikm: [u8; 32]) -> Self {
        Self { ikm, key: None, prefix: [0; NONCE_PREFIX_LENGTH], buf: BytesMut::new(), index: 0 }
    }

    fn cap(&self) -> usize {
        if self.index == 0 { FIRST_CIPHERTEXT_CAP } else { CIPHERTEXT_SEGMENT_SIZE }
    }

    pub fn push(&mut self, data: &[u8]) -> Result<Vec<Bytes>> {
        self.buf.extend_from_slice(data);
        if self.key.is_none() {
            if self.buf.len() < HEADER_LENGTH {
                return Ok(Vec::new());
            }
            let header = self.buf.split_to(HEADER_LENGTH);
            let (salt, prefix) = parse_header(&header)?;
            self.key = Some(segment_key(&self.ikm, &salt)?);
            self.prefix = prefix;
        }
        let mut out = Vec::new();
        while self.buf.len() > self.cap() {
            let cap = self.cap();
            let ct = self.buf.split_to(cap);
            let key = self.key.as_ref().ok_or_else(|| anyhow!("missing key"))?;
            out.push(open(key, &self.prefix, self.index, false, ct)?);
            self.index += 1;
        }
        Ok(out)
    }

    pub fn finish(mut self) -> Result<Bytes> {
        let key = self.key.take().ok_or_else(|| anyhow!("Invalid encrypted stream: missing header"))?;
        let rest = std::mem::take(&mut self.buf);
        if rest.len() < TAG_LENGTH {
            bail!("Invalid encrypted stream: truncated final segment");
        }
        open(&key, &self.prefix, self.index, true, rest)
    }
}

/// Which ciphertext bytes serve a plaintext range, and how to trim the result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RangePlan {
    pub first_segment: u64,
    pub last_segment: u64,
    pub total_segments: u64,
    pub ciphertext_start: u64,
    pub ciphertext_end: u64,
    pub front_trim: u64,
    pub wanted: u64,
    pub plaintext_size: u64,
}

impl RangePlan {
    /// Plan the inclusive plaintext range `[start, end]` of a file of `plaintext_size` bytes.
    pub fn new(plaintext_size: u64, start: u64, end: u64) -> Self {
        let first_segment = segment_index_for_offset(start);
        let last_segment = segment_index_for_offset(end);
        Self {
            first_segment,
            last_segment,
            total_segments: total_segments(plaintext_size),
            ciphertext_start: ciphertext_offset_at(first_segment),
            ciphertext_end: ciphertext_offset_at(last_segment)
                + plaintext_segment_length(last_segment, plaintext_size)
                + TAG_LENGTH as u64
                - 1,
            front_trim: start - plaintext_offset_at(first_segment),
            wanted: end - start + 1,
            plaintext_size,
        }
    }

    /// Ciphertext length of segment `i`, tag included.
    pub fn segment_ciphertext_len(&self, i: u64) -> usize {
        (plaintext_segment_length(i, self.plaintext_size) + TAG_LENGTH as u64) as usize
    }

    /// A decryptor for this range, keyed from the object's 40-byte header.
    pub fn decryptor(&self, ikm: &[u8; 32], header: &[u8]) -> Result<RangeDecryptor> {
        let (salt, prefix) = parse_header(header)?;
        Ok(RangeDecryptor {
            key: segment_key(ikm, &salt)?,
            prefix,
            plan: *self,
            segment: self.first_segment,
            emitted: 0,
            buf: BytesMut::new(),
        })
    }
}

/// Decrypts the segments a [`RangePlan`] selected and trims them to the range.
pub struct RangeDecryptor {
    key: LessSafeKey,
    prefix: [u8; NONCE_PREFIX_LENGTH],
    plan: RangePlan,
    segment: u64,
    emitted: u64,
    buf: BytesMut,
}

impl RangeDecryptor {
    pub fn push(&mut self, data: &[u8]) -> Result<Vec<Bytes>> {
        self.buf.extend_from_slice(data);
        let mut out = Vec::new();
        while self.segment <= self.plan.last_segment && self.emitted < self.plan.wanted {
            let need = self.plan.segment_ciphertext_len(self.segment);
            if self.buf.len() < need {
                break;
            }
            let ct = self.buf.split_to(need);
            let last = self.segment == self.plan.total_segments - 1;
            let index = u32::try_from(self.segment).map_err(|_| anyhow!("segment index overflow"))?;
            let mut pt = open(&self.key, &self.prefix, index, last, ct)?;
            if self.segment == self.plan.first_segment && self.plan.front_trim > 0 {
                pt = pt.slice(self.plan.front_trim as usize..);
            }
            let remaining = (self.plan.wanted - self.emitted) as usize;
            if pt.len() > remaining {
                pt.truncate(remaining);
            }
            self.emitted += pt.len() as u64;
            self.segment += 1;
            if !pt.is_empty() {
                out.push(pt);
            }
        }
        Ok(out)
    }

    pub fn is_done(&self) -> bool {
        self.emitted >= self.plan.wanted
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encrypt_all(ikm: &[u8; 32], data: &[u8], chunk: usize) -> Vec<u8> {
        let mut enc = Encryptor::new(ikm).unwrap_or_else(|_| unreachable!());
        let mut out = Vec::new();
        for part in data.chunks(chunk.max(1)) {
            for b in enc.push(part).unwrap_or_default() {
                out.extend_from_slice(&b);
            }
        }
        for b in enc.finish().unwrap_or_default() {
            out.extend_from_slice(&b);
        }
        out
    }

    #[test]
    fn round_trip_and_sizes() {
        let ikm = [7u8; 32];
        for len in
            [0usize, 1, PLAINTEXT_FIRST_SEGMENT_MAX, PLAINTEXT_FIRST_SEGMENT_MAX + 1, 3 * CIPHERTEXT_SEGMENT_SIZE + 17]
        {
            let data: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
            let ct = encrypt_all(&ikm, &data, 65_536);
            assert_eq!(ct.len() as u64, plaintext_size_to_ciphertext_size(len as u64));
            assert_eq!(ciphertext_size_to_plaintext_size(ct.len() as u64).ok(), Some(len as u64));
            let mut dec = Decryptor::new(ikm);
            let mut pt = Vec::new();
            for part in ct.chunks(77_777) {
                for b in dec.push(part).unwrap_or_default() {
                    pt.extend_from_slice(&b);
                }
            }
            pt.extend_from_slice(&dec.finish().unwrap_or_default());
            assert_eq!(pt, data);
        }
    }

    #[test]
    fn range_decrypt() {
        let ikm = [9u8; 32];
        let len = 2 * CIPHERTEXT_SEGMENT_SIZE + 5000;
        let data: Vec<u8> = (0..len).map(|i| (i % 253) as u8).collect();
        let ct = encrypt_all(&ikm, &data, 1 << 20);
        for (start, end) in [
            (0u64, 10u64),
            (PLAINTEXT_FIRST_SEGMENT_MAX as u64 - 3, PLAINTEXT_FIRST_SEGMENT_MAX as u64 + 3),
            (len as u64 - 100, len as u64 - 1),
        ] {
            let plan = RangePlan::new(len as u64, start, end);
            let mut dec = plan.decryptor(&ikm, &ct[..HEADER_LENGTH]).unwrap_or_else(|_| unreachable!());
            let slice = &ct[plan.ciphertext_start as usize..=plan.ciphertext_end as usize];
            let mut pt = Vec::new();
            for b in dec.push(slice).unwrap_or_default() {
                pt.extend_from_slice(&b);
            }
            assert_eq!(pt, &data[start as usize..=end as usize]);
        }
    }

    #[test]
    fn tamper_detected() {
        let ikm = [1u8; 32];
        let mut ct = encrypt_all(&ikm, b"hello world", 4);
        let last = ct.len() - 1;
        ct[last] ^= 1;
        let mut dec = Decryptor::new(ikm);
        let _ = dec.push(&ct);
        assert!(dec.finish().is_err());
    }
}
