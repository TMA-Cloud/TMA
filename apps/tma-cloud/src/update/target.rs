//! What kind of install this copy of the app is, and which release asset updates it.

use std::path::{Path, PathBuf};

/// A copy of the app the updater can replace by itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    /// Windows: the NSIS installer runs silently over the installed app.
    Installer,
    /// Linux: the AppImage file the app runs from, replaced in place.
    AppImage(PathBuf),
    /// macOS: the `.app` bundle the app runs from, replaced from the DMG.
    Bundle(PathBuf),
}

impl Target {
    /// The release asset that updates this copy, as `cargo xtask package` names it.
    pub fn asset(&self, version: &str) -> String {
        match self {
            Target::Installer => format!("tma-cloud_{version}_x64-setup.exe"),
            Target::AppImage(_) => format!("tma-cloud_{version}_x86_64.AppImage"),
            Target::Bundle(_) => format!("tma-cloud_{version}_aarch64.dmg"),
        }
    }
}

/// This copy's target, or `None` when it is updated by hand: a .deb or other system
/// install, a folder the user cannot write, or a system the releases have no build for
/// (they are built on x86_64 Linux and Apple Silicon).
pub fn detect() -> Option<Target> {
    if cfg!(windows) {
        return Some(Target::Installer);
    }
    if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        // The AppImage runtime names the file it started from; a .deb install has no such variable.
        let path = PathBuf::from(std::env::var_os("APPIMAGE")?);
        return (path.is_file() && writable(path.parent()?)).then_some(Target::AppImage(path));
    }
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        // A bundle macOS runs from a read-only translocated copy fails the write check.
        let bundle = bundle_of(&std::env::current_exe().ok()?)?;
        return writable(bundle.parent()?).then_some(Target::Bundle(bundle));
    }
    None
}

/// The `.app` bundle an executable sits in (`Name.app/Contents/MacOS/binary`).
pub fn bundle_of(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    let shaped = macos.file_name()? == "MacOS" && contents.file_name()? == "Contents" && bundle.extension()? == "app";
    shaped.then(|| bundle.to_path_buf())
}

/// Whether files can be created in `dir`, where the new copy is staged before the swap.
pub fn writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".tma-cloud-write-test-{}", std::process::id()));
    let created = std::fs::File::create(&probe).is_ok();
    let _ = std::fs::remove_file(&probe);
    created
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_names_match_the_packaged_files() {
        assert_eq!(Target::Installer.asset("4.1.0"), "tma-cloud_4.1.0_x64-setup.exe");
        assert_eq!(Target::AppImage("/x".into()).asset("4.1.0"), "tma-cloud_4.1.0_x86_64.AppImage");
        assert_eq!(Target::Bundle("/x".into()).asset("4.1.0"), "tma-cloud_4.1.0_aarch64.dmg");
    }

    #[test]
    fn finds_the_bundle_of_an_app_binary() {
        let exe = Path::new("/Applications/TMA Cloud.app/Contents/MacOS/tma-cloud");
        assert_eq!(bundle_of(exe), Some(PathBuf::from("/Applications/TMA Cloud.app")));
        assert_eq!(bundle_of(Path::new("/usr/bin/tma-cloud")), None);
        assert_eq!(bundle_of(Path::new("/opt/TMA Cloud/Contents/MacOS/tma-cloud")), None);
    }

    #[test]
    fn write_check_needs_an_existing_folder() {
        assert!(writable(&std::env::temp_dir()));
        assert!(!writable(&std::env::temp_dir().join("tma-cloud-missing-folder/nested")));
    }
}
