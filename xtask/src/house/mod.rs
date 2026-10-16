//! `cargo xtask house`: the project's own rules, which rustfmt and Clippy do not
//! cover. CLAUDE.md states them; this keeps them true.
//!
//! - No source file over `MAX_LINES` lines of code (tests, comments and blanks
//!   do not count). Split by concern instead.
//! - No block of `dupes::WINDOW` or more code lines copied between places.
//! - Interface colours only from `theme::Tokens`; no curly apostrophes.

mod dupes;
mod lines;
mod text;

use std::path::{Path, PathBuf};

pub const MAX_LINES: usize = 400;

/// Where Rust code lives. Vendored crates, build output and test files are not ours to size.
const ROOTS: &[&str] = &["crates", "apps", "xtask"];

/// Interface code, where colours must come from the theme.
fn is_interface(path: &Path) -> bool {
    let p = path.to_string_lossy().replace('\\', "/");
    (p.starts_with("crates/tma-ui/") || p.starts_with("apps/")) && !p.ends_with("/theme.rs")
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().map(|e| e.path()).collect();
    entries.sort();
    for path in entries {
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if path.is_dir() {
            // Integration tests and build output are exempt; `src`, `examples` and modules are not.
            if !matches!(name.as_str(), "target" | "tests" | "node_modules" | "dist") {
                rust_files(&path, out);
            }
        } else if name.ends_with(".rs") && name != "tests.rs" {
            out.push(path);
        }
    }
}

/// Every finding as `path:line: message`, in a stable order.
pub fn findings(root: &Path, ignore_literals: bool) -> Vec<String> {
    let mut paths = Vec::new();
    for dir in ROOTS {
        rust_files(&root.join(dir), &mut paths);
    }
    let mut out = Vec::new();
    let mut files = Vec::new();
    for path in paths {
        let Ok(source) = std::fs::read_to_string(&path) else { continue };
        let rel = path.strip_prefix(root).unwrap_or(&path).to_path_buf();
        let code = lines::code_lines(&source);
        if code.len() > MAX_LINES {
            out.push(format!(
                "{}:1: {} lines of code, over the limit of {MAX_LINES}; split it by concern",
                rel.display(),
                code.len()
            ));
        }
        for line in &code {
            if is_interface(&rel)
                && let Some(colour) = text::raw_colour(line)
            {
                out.push(format!(
                    "{}:{}: {colour}…) is a literal colour; take it from theme::Tokens",
                    rel.display(),
                    line.number
                ));
            }
            if text::smart_apostrophe(line) {
                out.push(format!("{}:{}: use the ASCII apostrophe, not U+2019", rel.display(), line.number));
            }
        }
        files.push((rel, code));
    }
    for copy in dupes::find(&files, dupes::WINDOW, ignore_literals) {
        out.push(format!(
            "{}:{}: lines {}-{} are copied from {}:{}; share one function instead",
            copy.file.display(),
            copy.lines.0,
            copy.lines.0,
            copy.lines.1,
            copy.other_file.display(),
            copy.other_line
        ));
    }
    out
}

/// The largest files by lines of code, to see what is close to the limit.
pub fn sizes(root: &Path, count: usize) {
    let mut paths = Vec::new();
    for dir in ROOTS {
        rust_files(&root.join(dir), &mut paths);
    }
    let mut sized: Vec<(usize, usize, PathBuf)> = paths
        .into_iter()
        .filter_map(|p| {
            let source = std::fs::read_to_string(&p).ok()?;
            Some((lines::real_lines(&source), source.lines().count(), p))
        })
        .collect();
    sized.sort_by(|a, b| b.cmp(a));
    for (code, total, path) in sized.into_iter().take(count) {
        println!("{code:>5} code {total:>5} total  {}", path.strip_prefix(root).unwrap_or(&path).display());
    }
}

/// Print the findings; true when there are none.
pub fn check(root: &Path, ignore_literals: bool) -> bool {
    let found = findings(root, ignore_literals);
    for finding in &found {
        println!("{finding}");
    }
    if found.is_empty() {
        println!("house rules: ok");
    } else {
        println!("house rules: {} finding(s)", found.len());
    }
    found.is_empty()
}
