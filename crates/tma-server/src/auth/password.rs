//! Password hashing with bcrypt (cost 10, `$2b$`), off the async runtime.

use std::sync::OnceLock;

const COST: u32 = 10;
/// bcrypt ignores input past 72 bytes, so longer new passwords are refused.
pub const MAX_PASSWORD_BYTES: usize = 72;
pub const MIN_PASSWORD_LENGTH: usize = 8;
pub const MAX_PASSWORD_LENGTH: usize = 128;

pub async fn hash(password: &str) -> anyhow::Result<String> {
    let password = password.to_string();
    let hashed = tokio::task::spawn_blocking(move || bcrypt::hash(password, COST)).await??;
    Ok(hashed)
}

pub async fn verify(password: &str, hash: &str) -> bool {
    let (password, hash) = (password.to_string(), hash.to_string());
    tokio::task::spawn_blocking(move || bcrypt::verify(password, &hash).unwrap_or(false)).await.unwrap_or(false)
}

/// A hash of a random secret, compared against when there is no real hash so a
/// miss costs the same time as a wrong password.
pub async fn dummy_hash() -> String {
    static DUMMY: OnceLock<String> = OnceLock::new();
    if let Some(h) = DUMMY.get() {
        return h.clone();
    }
    let secret: String = crate::crypto::random_bytes::<16>().iter().map(|b| format!("{b:02x}")).collect();
    let h = hash(&secret).await.unwrap_or_default();
    DUMMY.get_or_init(|| h).clone()
}

/// The rule for a password being set (signup, change, sub-user creation).
pub fn check_new_password(password: &str, label: &str) -> Result<(), String> {
    let chars = password.chars().count();
    if !(MIN_PASSWORD_LENGTH..=MAX_PASSWORD_LENGTH).contains(&chars) {
        return Err(format!("{label} must be between {MIN_PASSWORD_LENGTH} and {MAX_PASSWORD_LENGTH} characters"));
    }
    if password.len() > MAX_PASSWORD_BYTES {
        return Err(format!("{label} must not exceed {MAX_PASSWORD_BYTES} bytes"));
    }
    Ok(())
}
