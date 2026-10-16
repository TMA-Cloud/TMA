//! Link WinFsp lazily on Windows, so the app starts (without Cloud Drive)
//! on machines where WinFsp is not installed, and give the .exe its icon and
//! version details for Explorer, the taskbar and installer shortcuts.

fn main() {
    #[cfg(windows)]
    {
        winfsp::build::winfsp_link_delayload();
        // The test binary never calls WinFsp and would warn that the delay-load is unused.
        if std::env::var("CARGO_CFG_TARGET_ENV").is_ok_and(|e| e == "msvc") {
            println!("cargo:rustc-link-arg=/IGNORE:4199");
        }
        println!("cargo:rerun-if-changed=assets/icons/icon.ico");
        let mut res = winresource::WindowsResource::new();
        res.set_icon("assets/icons/icon.ico")
            .set("ProductName", "TMA Cloud")
            .set("FileDescription", "TMA Cloud")
            .set("CompanyName", "TMA Cloud")
            .set("LegalCopyright", "MIT License");
        // A missing resource compiler only costs the icon, not the build.
        if let Err(err) = res.compile() {
            println!("cargo:warning=No icon embedded in the .exe: {err}");
        }
    }
}
