//! Unused dependencies: a crate listed in a member's `Cargo.toml` whose name
//! never appears in that member's code. A dependency needed only for a feature
//! or for linking is listed under `[package.metadata.cargo-machete] ignored`,
//! the key cargo-machete reads, so either tool agrees.

use std::path::{Path, PathBuf};

use super::lines::without_comments;

/// The dependency names a manifest declares, and the ones it says to ignore.
pub fn declared(manifest: &str) -> (Vec<String>, Vec<String>) {
    let mut names = Vec::new();
    let mut ignored = Vec::new();
    let mut in_deps = false;
    for raw in manifest.lines() {
        let line = raw.trim();
        if line.starts_with('[') {
            let header = line.trim_matches(|c| c == '[' || c == ']');
            in_deps = header.ends_with("dependencies");
            // `[dependencies.name]` declares one by its header.
            if let Some((_, name)) = header.split_once("dependencies.") {
                names.push(name.trim_matches('"').to_string());
            }
            continue;
        }
        if line.starts_with("ignored") {
            ignored.extend(line.split('"').skip(1).step_by(2).map(String::from));
        }
        if !in_deps || line.starts_with('#') {
            continue;
        }
        let name: String = line.chars().take_while(|c| c.is_alphanumeric() || *c == '-' || *c == '_').collect();
        let rest = line[name.len()..].trim_start();
        if !name.is_empty() && (rest.starts_with('=') || rest.starts_with('.')) {
            names.push(name);
        }
    }
    names.sort();
    names.dedup();
    (names, ignored)
}

/// Whether `ident` appears as a whole word in `code`.
fn mentions(code: &str, ident: &str) -> bool {
    let word = |c: char| c.is_alphanumeric() || c == '_';
    code.match_indices(ident).any(|(at, _)| {
        let before = code[..at].chars().next_back();
        let after = code[at + ident.len()..].chars().next();
        !before.is_some_and(word) && !after.is_some_and(word)
    })
}

fn rust_sources(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for path in entries.flatten().map(|e| e.path()) {
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if path.is_dir() && !matches!(name.as_str(), "target" | "node_modules" | "dist") {
            rust_sources(&path, out);
        } else if name.ends_with(".rs") {
            out.push(path);
        }
    }
}

/// `(manifest, dependency)` for every dependency its crate never names.
pub fn unused(member: &Path) -> Vec<(PathBuf, String)> {
    let manifest = member.join("Cargo.toml");
    let Ok(text) = std::fs::read_to_string(&manifest) else { return Vec::new() };
    let (names, ignored) = declared(&text);
    let mut files = Vec::new();
    rust_sources(member, &mut files);
    let code: String =
        files.iter().filter_map(|f| std::fs::read_to_string(f).ok()).map(|s| without_comments(&s)).collect();
    names
        .into_iter()
        .filter(|n| !ignored.contains(n) && !mentions(&code, &n.replace('-', "_")))
        .map(|n| (manifest.clone(), n))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_every_kind_of_dependency_line() {
        let manifest = "[package]\nname = \"x\"\n\n[dependencies]\nserde = { workspace = true }\negui.workspace = true\n\
            tokio = { version = \"1\", features = [\n  \"rt\",\n] }\n# old = \"1\"\n\n[target.'cfg(windows)'.dependencies]\nwindows = \"0.61\"\n\n\
            [dev-dependencies]\nreqwest-middleware = \"0.4\"\n\n[dependencies.cloud-filter]\npath = \"vendor\"\n\n\
            [package.metadata.cargo-machete]\nignored = [\"getrandom\"]\n";
        let (names, ignored) = declared(manifest);
        assert_eq!(names, ["cloud-filter", "egui", "reqwest-middleware", "serde", "tokio", "windows"]);
        assert_eq!(ignored, ["getrandom"]);
    }

    #[test]
    fn a_name_counts_only_as_a_whole_word() {
        assert!(mentions("use egui::Ui;", "egui"));
        assert!(!mentions("use egui_phosphor::regular;", "egui"));
        assert!(mentions("serde_json::json!({})", "serde_json"));
    }
}
