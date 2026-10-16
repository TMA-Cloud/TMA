//! Master keys (KEKs) and per-file data keys (DEKs).
//!
//! `FILE_ENCRYPTION_KEY` (or `_FILE`) holds a keyring of `version:key` lines;
//! the highest version wraps new data keys, older ones unwrap what has not been
//! rewrapped yet. A wrapped DEK is `iv(12) || AES-256-GCM(DEK)(32) || tag(16)`.

use std::collections::BTreeMap;
use std::num::NonZeroU32;

use anyhow::{Result, anyhow, bail};
use base64::Engine as _;
use ring::aead::{AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey};

pub const DEK_LENGTH: usize = 32;
pub const WRAPPED_DEK_LENGTH: usize = 12 + DEK_LENGTH + 16;
const DEV_PASSPHRASE: &str = "development-key-change-in-production";
const CHECK_INFO: &[u8] = b"tma-cloud/kek-check/v1";
const CHECK_LABEL: &[u8] = b"tma-cloud key check";

/// Decode a 32-byte key written as base64 (either alphabet) or 64 hex characters.
fn decode_key(raw: &str) -> Option<[u8; 32]> {
    let raw = raw.trim();
    let engines = [base64::engine::general_purpose::STANDARD_NO_PAD, base64::engine::general_purpose::URL_SAFE_NO_PAD];
    for engine in engines {
        if let Ok(bytes) = engine.decode(raw.trim_end_matches('='))
            && let Ok(key) = <[u8; 32]>::try_from(bytes.as_slice())
        {
            return Some(key);
        }
    }
    if raw.len() == 64 && raw.chars().all(|c| c.is_ascii_hexdigit()) {
        let mut key = [0u8; 32];
        for (i, chunk) in raw.as_bytes().chunks(2).enumerate() {
            let pair = std::str::from_utf8(chunk).ok()?;
            key[i] = u8::from_str_radix(pair, 16).ok()?;
        }
        return Some(key);
    }
    None
}

/// The 32-byte key for a raw value: used directly when it is a random key,
/// otherwise stretched with PBKDF2 (only ever kept to rotate away from).
fn derive_key(raw: &str) -> [u8; 32] {
    if let Some(key) = decode_key(raw) {
        return key;
    }
    let mut out = [0u8; 32];
    let rounds = NonZeroU32::new(100_000).unwrap_or(NonZeroU32::MIN);
    ring::pbkdf2::derive(ring::pbkdf2::PBKDF2_HMAC_SHA256, rounds, b"file-encryption-salt", raw.as_bytes(), &mut out);
    out
}

/// True for a full-strength random key (64 hex chars, or base64 of 32 bytes) rather than a passphrase.
pub fn is_random_key(raw: &str) -> bool {
    let raw = raw.trim();
    if raw.len() == 64 && raw.chars().all(|c| c.is_ascii_hexdigit()) {
        return true;
    }
    let body = raw.strip_suffix('=').unwrap_or(raw);
    let standard = body.chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/');
    let url = body.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    body.len() == 43 && (standard || url) && decode_key(raw).is_some()
}

/// A new master key in the format the app expects.
pub fn generate_key() -> String {
    base64::engine::general_purpose::STANDARD.encode(super::random_bytes::<32>())
}

/// Parse a keyring: `version:key` entries split by newlines or commas, `#` comments.
/// A single entry without a version is version 1.
pub fn parse_keyring(text: &str) -> Result<BTreeMap<u32, String>> {
    let entries: Vec<&str> = text
        .lines()
        .filter(|line| !line.trim_start().starts_with('#'))
        .flat_map(|line| line.split(','))
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .collect();
    if entries.is_empty() {
        bail!("FILE_ENCRYPTION_KEY has no keys");
    }
    let versioned = |e: &str| -> Option<(u32, String)> {
        let (v, k) = e.split_once(':')?;
        let version: u32 = v.parse().ok()?;
        (!k.trim().is_empty()).then(|| (version, k.trim().to_string()))
    };
    if entries.len() == 1 && versioned(entries[0]).is_none() {
        return Ok(BTreeMap::from([(1, entries[0].to_string())]));
    }
    let mut keys = BTreeMap::new();
    for entry in entries {
        let (version, key) = versioned(entry)
            .ok_or_else(|| anyhow!("FILE_ENCRYPTION_KEY lists several keys, so each needs a \"version:\" prefix"))?;
        if version < 1 {
            bail!("FILE_ENCRYPTION_KEY has an invalid key version: {version}");
        }
        if keys.insert(version, key).is_some() {
            bail!("FILE_ENCRYPTION_KEY lists key version {version} twice");
        }
    }
    Ok(keys)
}

/// Serialise a keyring for FILE_ENCRYPTION_KEY_FILE, oldest first.
pub fn format_keyring(keys: &BTreeMap<u32, String>) -> String {
    let mut out = String::from(
        "# TMA Cloud file encryption keys, one \"version:key\" per line.\n\
         # The highest version encrypts new data. Older lines decrypt data not yet\n\
         # rewrapped and data in older backups, so keep them with those backups.\n",
    );
    for (version, key) in keys {
        out.push_str(&format!("{version}:{key}\n"));
    }
    out
}

/// The loaded master keys.
#[derive(Clone)]
pub struct Keyring {
    raw: BTreeMap<u32, String>,
    keys: BTreeMap<u32, [u8; 32]>,
    primary: u32,
}

impl std::fmt::Debug for Keyring {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Keyring")
            .field("versions", &self.keys.keys().collect::<Vec<_>>())
            .field("primary", &self.primary)
            .finish()
    }
}

/// A DEK sealed under one KEK version.
#[derive(Debug, Clone)]
pub struct WrappedDek {
    pub dek: [u8; 32],
    pub wrapped: Vec<u8>,
    pub kek_version: i32,
}

impl Keyring {
    /// Read the configured keyring. Production refuses a missing key and a passphrase primary.
    pub fn from_env(production: bool, allow_passphrase_primary: bool) -> Result<Self> {
        match crate::config::read_secret("FILE_ENCRYPTION_KEY")? {
            Some(text) => Self::from_text(&text, production && !allow_passphrase_primary),
            None if production => bail!(
                "FILE_ENCRYPTION_KEY (or FILE_ENCRYPTION_KEY_FILE) is required in production. Generate one with \"tma-server key generate\"."
            ),
            None => {
                tracing::warn!("[Encryption] FILE_ENCRYPTION_KEY not set, using development default key");
                Self::from_text(DEV_PASSPHRASE, false)
            }
        }
    }

    pub fn from_text(text: &str, require_random_primary: bool) -> Result<Self> {
        let raw = parse_keyring(text)?;
        let primary = *raw.keys().next_back().ok_or_else(|| anyhow!("FILE_ENCRYPTION_KEY has no keys"))?;
        if require_random_primary && !raw.get(&primary).is_some_and(|k| is_random_key(k)) {
            bail!(
                "FILE_ENCRYPTION_KEY must be a random 32-byte key in production (base64 or 64 hex characters), not a passphrase. \
                 Add a random key by rotating: ./rotate.sh key on Docker, or \"tma-server rotate key\"."
            );
        }
        let keys = raw.iter().map(|(v, k)| (*v, derive_key(k))).collect();
        Ok(Self { raw, keys, primary })
    }

    pub fn primary_version(&self) -> i32 {
        self.primary as i32
    }

    pub fn versions(&self) -> Vec<i32> {
        self.keys.keys().map(|v| *v as i32).collect()
    }

    pub fn raw(&self) -> &BTreeMap<u32, String> {
        &self.raw
    }

    /// The KEK for a version, or an error naming the missing version.
    pub fn kek(&self, version: i32) -> Result<&[u8; 32]> {
        u32::try_from(version).ok().and_then(|v| self.keys.get(&v)).ok_or_else(|| {
            anyhow!("FILE_ENCRYPTION_KEY has no key version {version}. Restore the key file that contains it.")
        })
    }

    pub fn primary_kek(&self) -> Result<&[u8; 32]> {
        self.kek(self.primary_version())
    }

    /// A fresh DEK wrapped under the primary KEK, for a new upload.
    pub fn new_dek(&self) -> Result<WrappedDek> {
        let dek: [u8; 32] = super::random_bytes();
        let wrapped = wrap_dek(&dek, self.primary_kek()?)?;
        Ok(WrappedDek { dek, wrapped, kek_version: self.primary_version() })
    }

    /// The streaming key for a stored file from its wrapped DEK.
    pub fn resolve_ikm(&self, wrapped: Option<&[u8]>, kek_version: Option<i32>) -> Result<[u8; 32]> {
        let wrapped = wrapped.ok_or_else(|| anyhow!("Encrypted file has no wrapped DEK"))?;
        let version =
            kek_version.ok_or_else(|| anyhow!("File has a wrapped DEK but no KEK version; cannot resolve its key."))?;
        unwrap_dek(wrapped, self.kek(version)?)
    }

    /// Rewrap a DEK under the primary KEK; `None` when it already is.
    pub fn rewrap_to_primary(&self, wrapped: &[u8], from_version: i32) -> Result<Option<(Vec<u8>, i32)>> {
        if from_version == self.primary_version() {
            return Ok(None);
        }
        let dek = unwrap_dek(wrapped, self.kek(from_version)?)?;
        Ok(Some((wrap_dek(&dek, self.primary_kek()?)?, self.primary_version())))
    }
}

fn aead_key(kek: &[u8; 32]) -> Result<LessSafeKey> {
    Ok(LessSafeKey::new(UnboundKey::new(&AES_256_GCM, kek).map_err(|_| anyhow!("Invalid key"))?))
}

/// Seal a DEK under a KEK (AES-256-GCM).
pub fn wrap_dek(dek: &[u8; 32], kek: &[u8; 32]) -> Result<Vec<u8>> {
    let iv: [u8; 12] = super::random_bytes();
    let mut buf = dek.to_vec();
    let tag = aead_key(kek)?
        .seal_in_place_separate_tag(Nonce::assume_unique_for_key(iv), Aad::empty(), &mut buf)
        .map_err(|_| anyhow!("wrapDek failed"))?;
    let mut out = Vec::with_capacity(WRAPPED_DEK_LENGTH);
    out.extend_from_slice(&iv);
    out.extend_from_slice(&buf);
    out.extend_from_slice(tag.as_ref());
    Ok(out)
}

/// Open a wrapped DEK; fails if the KEK is wrong or the blob was tampered with.
pub fn unwrap_dek(wrapped: &[u8], kek: &[u8; 32]) -> Result<[u8; 32]> {
    if wrapped.len() != WRAPPED_DEK_LENGTH {
        bail!("unwrapDek: wrapped DEK must be {WRAPPED_DEK_LENGTH} bytes");
    }
    let mut iv = [0u8; 12];
    iv.copy_from_slice(&wrapped[..12]);
    let mut buf = wrapped[12..].to_vec();
    let plain = aead_key(kek)?
        .open_in_place(Nonce::assume_unique_for_key(iv), Aad::empty(), &mut buf)
        .map_err(|_| anyhow!("Unsupported state or unable to authenticate data"))?;
    <[u8; 32]>::try_from(&plain[..]).map_err(|_| anyhow!("unwrapDek: bad DEK length"))
}

/// Key check value: HMAC of a fixed label under a subkey of the KEK. Proves a
/// process holds the same key without storing anything that reveals it.
pub fn kek_check_value(kek: &[u8; 32]) -> Vec<u8> {
    let subkey = super::hkdf_sha256(kek, &[], CHECK_INFO);
    super::hmac_sha256(&subkey, CHECK_LABEL)
}

pub fn kek_check_matches(kek: &[u8; 32], stored: &[u8]) -> bool {
    super::constant_time_eq(&kek_check_value(kek), stored)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keyring_parsing() {
        let ring = parse_keyring("# c\n1:abc\n2:def").unwrap_or_default();
        assert_eq!(ring.len(), 2);
        assert_eq!(parse_keyring("plainkey").unwrap_or_default().get(&1).map(String::as_str), Some("plainkey"));
        assert!(parse_keyring("1:a\nb").is_err());
        assert!(parse_keyring("1:a\n1:b").is_err());
    }

    #[test]
    fn wrap_round_trip() {
        let key = generate_key();
        assert!(is_random_key(&key));
        assert!(!is_random_key("correct horse battery staple"));
        let ring = Keyring::from_text(&key, true).unwrap_or_else(|_| unreachable!());
        let dek = ring.new_dek().unwrap_or_else(|_| unreachable!());
        let ikm = ring.resolve_ikm(Some(&dek.wrapped), Some(dek.kek_version)).unwrap_or_else(|_| unreachable!());
        assert_eq!(ikm, dek.dek);
    }
}
