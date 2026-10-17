//! Give the Windows .exe its icon and version details for Explorer, the
//! taskbar and installer shortcuts.

fn main() {
    #[cfg(windows)]
    {
        println!("cargo:rerun-if-changed=assets/icons/icon.ico");
        let mut res = winresource::WindowsResource::new();
        res.set_icon("assets/icons/icon.ico")
            .set("ProductName", "TMA Cloud")
            .set("FileDescription", "TMA Cloud")
            .set("CompanyName", "TMA Cloud")
            .set("LegalCopyright", "Copyright (c) 2025 Zinadin Zidan")
            .set("OriginalFilename", "tma-cloud.exe")
            .set("InternalName", "tma-cloud");
        // A missing resource compiler only costs the icon, not the build.
        if let Err(err) = res.compile() {
            println!("cargo:warning=No icon embedded in the .exe: {err}");
        }
    }
}
