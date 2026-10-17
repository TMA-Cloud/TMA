//! Developer tasks:
//!
//! - `cargo xtask ci`: everything CI checks.
//! - `cargo xtask fmt [--check]`: rustfmt for Rust, Prettier for Markdown, YAML,
//!   JSON, HTML and CSS.
//! - `cargo xtask house [--near | --sizes]`: the project's own rules (file size,
//!   copied code, theme colours); `--near` also matches copies that differ only in
//!   literals, `--sizes` lists the largest files.
//! - `cargo xtask package`: the desktop installers.
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod house;

use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

/// Pinned, so every machine and CI format the same way (the wiki uses the same release).
const PRETTIER: &str = "prettier@3.9.9";

fn run(program: &str, args: &[&str]) -> bool {
    println!("$ {program} {}", args.join(" "));
    Command::new(program).args(args).status().map(|s| s.success()).unwrap_or(false)
}

/// Prettier through npx; without Node.js only the Rust half is checked, with a note.
fn prettier(check: bool) -> bool {
    let npx = if cfg!(windows) { "npx.cmd" } else { "npx" };
    if Command::new(npx).arg("--version").output().is_err() {
        println!("Prettier skipped: Node.js (npx) is not installed. CI still checks it.");
        return true;
    }
    run(npx, &["--yes", PRETTIER, if check { "--check" } else { "--write" }, "--log-level", "warn", "."])
}

fn fmt(check: bool) -> bool {
    let rust = if check { run("cargo", &["fmt", "--all", "--check"]) } else { run("cargo", &["fmt", "--all"]) };
    rust && prettier(check)
}

fn ci() -> bool {
    fmt(true)
        && house::check(Path::new("."), false)
        && run("cargo", &["clippy", "--workspace", "--all-targets", "--", "-D", "warnings"])
        && run("cargo", &["test", "--workspace"])
        && wasm()
}

fn wasm() -> bool {
    let crates = ["-p", "tma-cloud-web", "-p", "tma-ui", "-p", "tma-client"];
    let mut args = vec!["clippy"];
    args.extend(crates);
    args.extend(["--target", "wasm32-unknown-unknown", "--", "-D", "warnings"]);
    run("cargo", &args)
}

/// Build the desktop app in release mode and package its installers into target/packages.
fn package() -> bool {
    let target = PathBuf::from("target");
    let mut packager = Command::new("cargo");
    // The packager resolves relative paths from the package folder, so pass an absolute one.
    let out = std::path::absolute(target.join("packages")).unwrap_or_else(|_| target.join("packages"));
    packager.args(["packager", "--release", "-p", "tma-cloud", "-o"]).arg(&out);
    if !run("cargo", &["build", "--release", "-p", "tma-cloud"]) {
        return false;
    }
    println!("$ cargo packager --release -p tma-cloud -o {}", out.display());
    if !packager.status().map(|s| s.success()).unwrap_or(false) {
        return false;
    }
    // GitHub rewrites spaces in asset names, and the updater asks for one fixed name.
    for entry in std::fs::read_dir(&out).into_iter().flatten().flatten() {
        if let Some(name) = release_name(&entry.file_name().to_string_lossy()) {
            let _ = std::fs::rename(entry.path(), out.join(&name));
            println!("renamed to {name}");
        }
    }
    true
}

/// The release name of a packaged file whose name the packager takes from the product name.
fn release_name(file: &str) -> Option<String> {
    file.strip_prefix("TMA Cloud_").filter(|rest| rest.ends_with(".dmg")).map(|rest| format!("tma-cloud_{rest}"))
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = args.get(1).map(String::as_str);
    let ok = match args.first().map(String::as_str).unwrap_or_default() {
        "ci" => ci(),
        "fmt" => fmt(flag == Some("--check")),
        "house" if flag == Some("--sizes") => {
            house::sizes(Path::new("."), 25);
            true
        }
        "house" => house::check(Path::new("."), flag == Some("--near")),
        "wasm" => wasm(),
        "package" => package(),
        _ => {
            eprintln!("usage: cargo xtask <ci|fmt [--check]|house [--near|--sizes]|wasm|package>");
            false
        }
    };
    if ok { ExitCode::SUCCESS } else { ExitCode::FAILURE }
}

#[cfg(test)]
mod tests {
    use super::release_name;

    #[test]
    fn dmg_gets_the_release_name() {
        assert_eq!(release_name("TMA Cloud_4.1.0_aarch64.dmg").as_deref(), Some("tma-cloud_4.1.0_aarch64.dmg"));
        assert_eq!(release_name("tma-cloud_4.1.0_x64-setup.exe"), None);
        assert_eq!(release_name("TMA Cloud.app"), None);
    }
}
