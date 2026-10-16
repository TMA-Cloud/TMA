//! Developer tasks: `cargo xtask ci` runs the same checks as CI; `cargo xtask
//! package` builds the desktop installers.
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::PathBuf;
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
