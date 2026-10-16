//! Link WinFsp lazily into this package's tests and examples (the desktop app
//! does the same for itself), so they start where WinFsp is not installed.
//! These are the directives winfsp's own build helper emits for MSVC.

fn main() {
    let target = |name: &str| std::env::var(name).unwrap_or_default();
    if std::env::var_os("CARGO_FEATURE_MOUNT").is_none()
        || target("CARGO_CFG_TARGET_OS") != "windows"
        || target("CARGO_CFG_TARGET_ENV") != "msvc"
    {
        return;
    }
    let dll = match target("CARGO_CFG_TARGET_ARCH").as_str() {
        "x86" => "winfsp-x86.dll",
        "aarch64" => "winfsp-a64.dll",
        _ => "winfsp-x64.dll",
    };
    println!("cargo:rustc-link-lib=dylib=delayimp");
    println!("cargo:rustc-link-arg=/DELAYLOAD:{dll}");
    // Test binaries that never call WinFsp would warn that the delay-load is unused.
    println!("cargo:rustc-link-arg=/IGNORE:4199");
}
