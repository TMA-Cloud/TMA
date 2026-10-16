//! Embeds every `migrations/NNN_name.sql` in the binary, in order, so a
//! release is one self-contained executable.

use std::fmt::Write as _;
use std::path::Path;

fn main() {
    let dir = Path::new("migrations");
    println!("cargo:rerun-if-changed=migrations");
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.ends_with(".sql"))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    let mut out = String::from(
        "/// (version, sql) for every migration, oldest first.\npub static MIGRATIONS: &[(&str, &str)] = &[\n",
    );
    for name in &names {
        let version = name.trim_end_matches(".sql");
        let path = dir.join(name).canonicalize().unwrap_or_else(|_| dir.join(name));
        let _ = writeln!(out, "    ({version:?}, include_str!({:?})),", path.display().to_string());
    }
    out.push_str("];\n");
    let target = Path::new(&std::env::var("OUT_DIR").unwrap_or_else(|_| ".".into())).join("migrations.rs");
    if let Err(err) = std::fs::write(&target, out) {
        println!("cargo:warning=could not write {}: {err}", target.display());
    }
}
