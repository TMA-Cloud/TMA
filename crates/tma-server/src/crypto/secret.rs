//! AES-256-GCM sealing for secrets kept in `app_settings` (the bucket secret).
//! Each purpose gets its own HKDF subkey of the master key, and the AAD binds a secret to the identifier stored beside it.
//! Layout: `format(1) || iv(12) || ciphertext || tag(16)`.

use anyhow::{Result, anyhow, bail};
use ring::aead::{AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey};

const FORMAT_VERSION: u8 = 1;

#[derive(Debug, Clone, Copy)]
pub struct SecretPurpose {
    pub key_info: &'static str,
    pub aad_prefix: &'static str,
    pub label: &'static str,
}

/// The access key ID is the binding, so a secret cannot move onto another key's row.
pub const STORAGE_SECRET: SecretPurpose = SecretPurpose {
    key_info: "tma-cloud/storage-credentials/v1",
    aad_prefix: "tma-cloud:storage-secret",
    label: "storage secret",
};

fn subkey(kek: &[u8; 32], purpose: &SecretPurpose) -> Result<LessSafeKey> {
    let key = super::hkdf_sha256(kek, &[], purpose.key_info.as_bytes());
    Ok(LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &key).map_err(|_| anyhow!("invalid subkey"))?))
}

fn aad(purpose: &SecretPurpose, binding: &str) -> Vec<u8> {
    format!("{}:{binding}", purpose.aad_prefix).into_bytes()
}

pub fn seal_secret(secret: &str, purpose: &SecretPurpose, binding: &str, kek: &[u8; 32]) -> Result<Vec<u8>> {
    let iv: [u8; 12] = super::random_bytes();
    let mut buf = secret.as_bytes().to_vec();
    let tag = subkey(kek, purpose)?
        .seal_in_place_separate_tag(Nonce::assume_unique_for_key(iv), Aad::from(aad(purpose, binding)), &mut buf)
        .map_err(|_| anyhow!("Could not seal {}", purpose.label))?;
    let mut out = Vec::with_capacity(1 + 12 + buf.len() + 16);
    out.push(FORMAT_VERSION);
    out.extend_from_slice(&iv);
    out.extend_from_slice(&buf);
    out.extend_from_slice(tag.as_ref());
    Ok(out)
}

pub fn open_secret(blob: &[u8], purpose: &SecretPurpose, binding: &str, kek: &[u8; 32]) -> Result<String> {
    if blob.len() <= 1 + 12 + 16 || blob[0] != FORMAT_VERSION {
        bail!("Stored {} has an unknown format", purpose.label);
    }
    let mut iv = [0u8; 12];
    iv.copy_from_slice(&blob[1..13]);
    let mut buf = blob[13..].to_vec();
    let plain = subkey(kek, purpose)?
        .open_in_place(Nonce::assume_unique_for_key(iv), Aad::from(aad(purpose, binding)), &mut buf)
        .map_err(|_| anyhow!("Stored {} could not be decrypted", purpose.label))?;
    String::from_utf8(plain.to_vec()).map_err(|_| anyhow!("Stored {} is not text", purpose.label))
}

/// The secret sealed again under the primary KEK, or None when it already is.
pub fn reseal(
    sealed: &[u8],
    purpose: &SecretPurpose,
    binding: &str,
    version: i32,
    keyring: &super::Keyring,
) -> Result<Option<Vec<u8>>> {
    if version == keyring.primary_version() {
        return Ok(None);
    }
    let secret = open_secret(sealed, purpose, binding, keyring.kek(version)?)?;
    Ok(Some(seal_secret(&secret, purpose, binding, keyring.primary_kek()?)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binding_is_enforced() {
        let kek = [3u8; 32];
        let sealed = seal_secret("s3cr3t", &STORAGE_SECRET, "AKID", &kek).unwrap_or_default();
        assert_eq!(open_secret(&sealed, &STORAGE_SECRET, "AKID", &kek).ok().as_deref(), Some("s3cr3t"));
        assert!(open_secret(&sealed, &STORAGE_SECRET, "OTHER", &kek).is_err());
        // Another purpose derives another subkey, so it cannot open the secret either.
        let other = SecretPurpose { key_info: "tma-cloud/other/v1", aad_prefix: "tma-cloud:other", label: "other" };
        assert!(open_secret(&sealed, &other, "AKID", &kek).is_err());
    }
}
