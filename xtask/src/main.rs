//! Developer tasks: `cargo xtask ci` runs the same checks as CI; `cargo xtask
//! package` builds the desktop installers.
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

fn run(program: &str, args: &[&str]) -> bool {
    println!("$ {program} {}", args.join(" "));
    Command::new(program).args(args).status().map(|s| s.success()).unwrap_or(false)
}

fn ci() -> bool {
    run("cargo", &["fmt", "--all", "--check"])
        && run("cargo", &["clippy", "--workspace", "--all-targets", "--", "-D", "warnings"])
        && run("cargo", &["test", "--workspace"])
        && wasm()
}

fn wasm() -> bool {
    run(
        "cargo",
        &[
            "clippy",
            "-p",
            "tma-cloud-web",
            "-p",
            "tma-ui",
            "-p",
            "tma-client",
            "--target",
            "wasm32-unknown-unknown",
            "--",
            "-D",
            "warnings",
        ],
    )
}

/// The WinFsp release the Windows installer bundles for Cloud Drive, pinned by hash.
const WINFSP_MSI: &str = "winfsp-2.1.25156.msi";
const WINFSP_URL: &str = "https://github.com/winfsp/winfsp/releases/download/v2.1/winfsp-2.1.25156.msi";
const WINFSP_SHA256: &str = "073a70e00f77423e34bed98b86e600def93393ba5822204fac57a29324db9f7a";

fn sha256_hex(path: &Path) -> Option<String> {
    use sha2::{Digest, Sha256};
    let bytes = std::fs::read(path).ok()?;
    Some(Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect())
}

/// A verified copy of the WinFsp MSI under `target/`, downloaded once.
fn winfsp_msi(target: &Path) -> Option<PathBuf> {
    let path = target.join("packager-cache").join(WINFSP_MSI);
    if sha256_hex(&path).as_deref() != Some(WINFSP_SHA256) {
        std::fs::create_dir_all(path.parent()?).ok()?;
        let dest = path.to_string_lossy().to_string();
        if !run("curl", &["--fail", "--location", "--silent", "--show-error", "-o", &dest, WINFSP_URL]) {
            return None;
        }
        if sha256_hex(&path).as_deref() != Some(WINFSP_SHA256) {
            eprintln!("{WINFSP_MSI} does not match its pinned hash; refusing to bundle it");
            let _ = std::fs::remove_file(&path);
            return None;
        }
    }
    Some(path)
}

/// Build the desktop app in release mode and package its installers into target/packages.
fn package() -> bool {
    let target = PathBuf::from("target");
    let mut packager = Command::new("cargo");
    // The packager resolves relative paths from the package folder, so pass an absolute one.
    let out = std::path::absolute(target.join("packages")).unwrap_or_else(|_| target.join("packages"));
    packager.args(["packager", "--release", "-p", "tma-cloud", "-o"]).arg(&out);
    if cfg!(windows) {
        let Some(msi) = winfsp_msi(&target) else { return false };
        let msi = std::path::absolute(&msi).unwrap_or(msi);
        // The NSIS script reads this at compile time ($%TMA_WINFSP_MSI%).
        packager.env("TMA_WINFSP_MSI", msi);
    }
    if !run("cargo", &["build", "--release", "-p", "tma-cloud"]) {
        return false;
    }
    println!("$ cargo packager --release -p tma-cloud -o {}", out.display());
    packager.status().map(|s| s.success()).unwrap_or(false)
}

fn main() -> ExitCode {
    let task = std::env::args().nth(1).unwrap_or_default();
    let ok = match task.as_str() {
        "ci" => ci(),
        "wasm" => wasm(),
        "package" => package(),
        _ => {
            eprintln!("usage: cargo xtask <ci|wasm|package>");
            false
        }
    };
    if ok { ExitCode::SUCCESS } else { ExitCode::FAILURE }
}
