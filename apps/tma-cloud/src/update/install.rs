//! Putting a downloaded release in place, in two steps. `prepare` runs while the app
//! is open: on Linux and macOS it swaps the new copy in (the running one keeps its
//! open files). `launch` starts the new version: on Windows the installer, after the
//! app has exited; on Linux and macOS a shell that waits for the app to exit before
//! starting the new copy, so the two never fight over Cloud Drive (nothing else keeps
//! two copies from running there).

use std::path::Path;
use std::process::{Command, Stdio};

use super::target::Target;

/// Waits for the process in $1 to exit, then runs the rest of the arguments.
const RELAUNCH: &str = r#"while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; shift; exec "$@""#;

/// Put `download` in place where that can happen while the app runs.
pub fn prepare(target: &Target, download: &Path) -> Result<(), String> {
    match target {
        Target::Installer => Ok(()),
        Target::AppImage(path) => replace_appimage(download, path),
        Target::Bundle(bundle) => replace_bundle(download, bundle),
    }
}

/// Whether `launch` must wait until the app has exited. The Windows installer must, or it
/// finds the app still closing and gives up; the relaunch shell waits by itself, and on
/// macOS nothing runs after the window closes, since the app ends the process there.
pub fn after_exit(target: &Target) -> bool {
    matches!(target, Target::Installer)
}

/// Start the new version: the silent installer (/R starts the app when it is done),
/// or the swapped-in copy once this process has exited.
pub fn launch(target: &Target, download: &Path) -> Result<(), String> {
    match target {
        Target::Installer => Command::new(download)
            .args(["/S", "/R"])
            .spawn()
            .map(drop)
            .map_err(|e| format!("cannot start the installer: {e}")),
        Target::AppImage(path) => relaunch(&[path.as_os_str()]),
        Target::Bundle(bundle) => relaunch(&["open".as_ref(), bundle.as_os_str()]),
    }
}

/// The download sits beside the AppImage, so the rename is atomic; the running copy keeps its old file.
fn replace_appimage(download: &Path, path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(download, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("cannot make the new AppImage executable: {e}"))?;
    }
    std::fs::rename(download, path).map_err(|e| format!("cannot replace {}: {e}", path.display()))
}

/// Copy the bundle out of the DMG beside the running one, then swap the two folders.
fn replace_bundle(dmg: &Path, bundle: &Path) -> Result<(), String> {
    let parent = bundle.parent().ok_or("the app has no parent folder")?;
    let name = bundle.file_name().ok_or("the app has no name")?.to_string_lossy().to_string();
    let mount = std::env::temp_dir().join(format!("tma-cloud-update-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&mount);
    // The disk image carries the license as an agreement: hdiutil pages it to PAGER and
    // reads the answer from stdin, and without one it cancels the mount.
    let mut attach = Command::new("hdiutil");
    attach.args(["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint"]).arg(&mount).arg(dmg);
    run_answering(attach.env("PAGER", "/bin/cat"), b"Y\n")?;
    let swapped = (|| {
        let app = std::fs::read_dir(&mount)
            .map_err(|e| e.to_string())?
            .flatten()
            .map(|e| e.path())
            .find(|p| p.extension().is_some_and(|x| x == "app"))
            .ok_or("the disk image has no app")?;
        let staged = parent.join(format!(".{name}.new"));
        let old = parent.join(format!(".{name}.old"));
        let _ = std::fs::remove_dir_all(&staged);
        let _ = std::fs::remove_dir_all(&old);
        run(Command::new("ditto").arg(&app).arg(&staged))?;
        std::fs::rename(bundle, &old).map_err(|e| format!("cannot move the old app aside: {e}"))?;
        if let Err(e) = std::fs::rename(&staged, bundle) {
            let _ = std::fs::rename(&old, bundle);
            return Err(format!("cannot put the new app in place: {e}"));
        }
        // The running copy keeps its open files, so its folder can go now.
        let _ = std::fs::remove_dir_all(&old);
        Ok(())
    })();
    let _ = run(Command::new("hdiutil").args(["detach", "-force"]).arg(&mount));
    let _ = std::fs::remove_dir(&mount);
    swapped
}

fn run(command: &mut Command) -> Result<(), String> {
    run_answering(command, b"")
}

/// Run `command` with `answer` on its stdin, failing with its error output.
fn run_answering(command: &mut Command, answer: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(answer);
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_string()) }
}

/// Start `launch` once this process has exited, in its own process group so it outlives the app.
fn relaunch(launch: &[&std::ffi::OsStr]) -> Result<(), String> {
    let mut command = Command::new("/bin/sh");
    command.arg("-c").arg(RELAUNCH).arg("sh").arg(std::process::id().to_string()).args(launch);
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command.spawn().map(drop).map_err(|e| format!("the update is installed; restart TMA Cloud to use it ({e})"))
}
