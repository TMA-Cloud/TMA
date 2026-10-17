//! The system credential store that keeps the saved sign-in: Windows Credential
//! Manager, the macOS Keychain or the Secret Service on Linux.

/// Register this system's store, once at startup. Without one the app still works,
/// it just asks for the password again next time.
pub fn init() {
    match platform_store() {
        Ok(store) => keyring_core::set_default_store(store),
        Err(err) => log::warn!("No credential store, so the sign-in is not saved: {err}"),
    }
}

#[cfg(windows)]
fn platform_store() -> keyring_core::Result<std::sync::Arc<keyring_core::CredentialStore>> {
    Ok(windows_native_keyring_store::Store::new()?)
}

// The file-based keychain: the data protection keychain needs a signed app with a
// keychain entitlement, which these builds do not have.
#[cfg(target_os = "macos")]
fn platform_store() -> keyring_core::Result<std::sync::Arc<keyring_core::CredentialStore>> {
    Ok(apple_native_keyring_store::keychain::Store::new()?)
}

#[cfg(target_os = "linux")]
fn platform_store() -> keyring_core::Result<std::sync::Arc<keyring_core::CredentialStore>> {
    Ok(dbus_secret_service_keyring_store::Store::new()?)
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn platform_store() -> keyring_core::Result<std::sync::Arc<keyring_core::CredentialStore>> {
    Err(keyring_core::Error::NotSupportedByStore("no credential store on this system".into()))
}
