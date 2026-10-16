//! Encryption at rest. File bodies use Tink's AES-GCM-HKDF-STREAMING format
//! (AES256_GCM_HKDF_1MB) under a per-file data key; data keys and settings
//! secrets are sealed with the versioned master key.

mod keys;
mod secret;
mod stream;

pub use keys::{
    DEK_LENGTH, Keyring, WRAPPED_DEK_LENGTH, WrappedDek, format_keyring, generate_key, is_random_key,
    kek_check_matches, kek_check_value, parse_keyring, unwrap_dek, wrap_dek,
};
pub use secret::{GOOGLE_SECRET, STORAGE_SECRET, SecretPurpose, open_secret, reseal, seal_secret};
pub use stream::{
    CIPHERTEXT_SEGMENT_SIZE, Decryptor, Encryptor, HEADER_LENGTH, PLAINTEXT_FIRST_SEGMENT_MAX, PLAINTEXT_SEGMENT_MAX,
    RangePlan, TAG_LENGTH, ciphertext_size_to_plaintext_size, plaintext_size_to_ciphertext_size,
};

use ring::hmac;
use ring::rand::{SecureRandom, SystemRandom};

/// Cryptographically secure random bytes.
pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    // SystemRandom only fails when the OS has no entropy source at all.
    if SystemRandom::new().fill(&mut out).is_err() {
        use rand::RngCore;
        rand::rngs::OsRng.fill_bytes(&mut out);
    }
    out
}

/// HKDF-SHA256 producing 32 bytes (RFC 5869); an empty salt means HashLen zeros.
pub fn hkdf_sha256(ikm: &[u8], salt: &[u8], info: &[u8]) -> [u8; 32] {
    let prk = hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, salt), ikm);
    let key = hmac::Key::new(hmac::HMAC_SHA256, prk.as_ref());
    let mut ctx = hmac::Context::with_key(&key);
    ctx.update(info);
    ctx.update(&[1u8]);
    let tag = ctx.sign();
    let mut out = [0u8; 32];
    out.copy_from_slice(&tag.as_ref()[..32]);
    out
}

/// HMAC-SHA256 of `data` under `key`.
pub fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), data).as_ref().to_vec()
}

/// SHA-256 digest.
pub fn sha256(data: &[u8]) -> [u8; 32] {
    let digest = ring::digest::digest(&ring::digest::SHA256, data);
    let mut out = [0u8; 32];
    out.copy_from_slice(digest.as_ref());
    out
}

/// Equality that takes the same time however early the inputs differ.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    use subtle::ConstantTimeEq;
    a.len() == b.len() && bool::from(a.ct_eq(b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hkdf_rfc5869_case_1() {
        let ikm = [0x0bu8; 22];
        let salt: Vec<u8> = (0x00..=0x0c).collect();
        let info: Vec<u8> = (0xf0..=0xf9).collect();
        let okm = hkdf_sha256(&ikm, &salt, &info);
        let expected = "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf";
        let hex: String = okm.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, expected);
    }
}
