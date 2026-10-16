//! Copied code: the same run of code lines in two places. Each window of
//! `WINDOW` consecutive significant lines is keyed by its normalised text, as
//! PMD's CPD and jscpd do; windows found more than once mark their lines, and
//! marked lines merge into blocks reported with one place they repeat.

use std::collections::HashMap;
use std::path::PathBuf;

use super::lines::Line;

/// Shorter repeats are usually a pattern (a builder chain, a match arm), not a copy.
pub const WINDOW: usize = 10;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Copy {
    pub file: PathBuf,
    /// First and last line numbers of the block.
    pub lines: (usize, usize),
    pub other_file: PathBuf,
    pub other_line: usize,
}

/// Lines too generic to count: closing brackets, imports, attributes.
fn significant(line: &Line) -> bool {
    let t = line.text.as_str();
    let only_punctuation = t.chars().all(|c| "{}()[];,.?&|=> ".contains(c));
    !(only_punctuation
        || t == "} else {"
        || t.starts_with("use ")
        || t.starts_with("pub use ")
        || t.starts_with("mod ")
        || t.starts_with("pub mod ")
        || t.starts_with("#["))
}

/// A line with its string and number literals masked, so copies that differ only
/// in a label or a number still match (CPD's "ignore literals").
pub fn mask_literals(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '"' {
            while let Some(n) = chars.next() {
                if n == '\\' {
                    chars.next();
                } else if n == '"' {
                    break;
                }
            }
            out.push_str("$s");
        } else if c.is_ascii_digit() && !out.ends_with(|p: char| p.is_alphanumeric() || p == '_') {
            while chars.peek().is_some_and(|n| n.is_ascii_alphanumeric() || *n == '.' || *n == '_') {
                chars.next();
            }
            out.push_str("$n");
        } else {
            out.push(c);
        }
    }
    out
}

pub fn find(files: &[(PathBuf, Vec<Line>)], window: usize, ignore_literals: bool) -> Vec<Copy> {
    let code: Vec<Vec<&Line>> =
        files.iter().map(|(_, lines)| lines.iter().filter(|l| significant(l)).collect()).collect();
    // Normalised window text → every (file, first line index) it starts at.
    let mut seen: HashMap<String, Vec<(usize, usize)>> = HashMap::new();
    for (f, lines) in code.iter().enumerate() {
        for start in 0..lines.len().saturating_sub(window - 1) {
            let key = lines[start..start + window]
                .iter()
                .map(|l| if ignore_literals { mask_literals(&l.text) } else { l.text.clone() })
                .collect::<Vec<_>>()
                .join("\n");
            seen.entry(key).or_default().push((f, start));
        }
    }
    // For each marked line, one other place the same window starts.
    let mut partner: Vec<Vec<Option<(usize, usize)>>> = code.iter().map(|l| vec![None; l.len()]).collect();
    for places in seen.values().filter(|p| p.len() > 1) {
        for &(f, start) in places {
            // A window overlapping itself in one file is a repeated pattern, not a copy.
            let other = places.iter().find(|&&(g, s)| g != f || s.abs_diff(start) >= window);
            if let Some(&other) = other {
                for (i, slot) in partner[f][start..start + window].iter_mut().enumerate() {
                    slot.get_or_insert((other.0, other.1 + i));
                }
            }
        }
    }
    let mut out = Vec::new();
    for (f, marks) in partner.iter().enumerate() {
        let mut i = 0;
        while i < marks.len() {
            let Some((g, at)) = marks[i] else {
                i += 1;
                continue;
            };
            let start = i;
            while i < marks.len() && marks[i].is_some() {
                i += 1;
            }
            out.push(Copy {
                file: files[f].0.clone(),
                lines: (code[f][start].number, code[f][i - 1].number),
                other_file: files[g].0.clone(),
                other_line: code[g][at].number,
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::house::lines::code_lines;

    fn file(name: &str, body: &str) -> (PathBuf, Vec<Line>) {
        (PathBuf::from(name), code_lines(body))
    }

    #[test]
    fn finds_a_block_copied_between_files_and_merges_its_windows() {
        let block: String = (0..12).map(|i| format!("let v{i} = compute({i});\n")).collect();
        let a = file("a.rs", &format!("fn a() {{\n{block}}}\n"));
        let b = file("b.rs", &format!("fn b() {{\nlet other = 1;\n{block}}}\n"));
        let copies = find(&[a, b], 10, false);
        assert_eq!(copies.len(), 2, "one block in each file: {copies:?}");
        assert_eq!(copies[0].lines, (2, 13));
        assert_eq!(copies[0].other_file, PathBuf::from("b.rs"));
        assert_eq!(copies[0].other_line, 3);
    }

    #[test]
    fn masking_literals_matches_copies_that_differ_in_labels() {
        assert_eq!(mask_literals("label(\"Save\", 12.5, v2)"), "label($s, $n, v2)");
        assert_eq!(mask_literals("x == \"a\\\"b\" + 3"), "x == $s + $n");
    }

    #[test]
    fn near_mode_finds_copies_that_differ_only_in_literals() {
        let make =
            |label: &str| -> String { (0..12).map(|i| format!("let v{i} = compute(\"{label}\", {i});\n")).collect() };
        let a = file("a.rs", &format!("fn a() {{\n{}}}\n", make("first")));
        let b = file("b.rs", &format!("fn b() {{\n{}}}\n", make("second")));
        assert!(find(&[a.clone(), b.clone()], 10, false).is_empty());
        assert_eq!(find(&[a, b], 10, true).len(), 2);
    }

    #[test]
    fn short_repeats_and_brackets_are_not_copies() {
        let body: String = (0..9).map(|i| format!("let v{i} = compute({i});\n")).collect();
        let a = file("a.rs", &format!("fn a() {{\n{body}}}\n"));
        let b = file("b.rs", &format!("fn b() {{\n{body}}}\n"));
        assert!(find(&[a, b], 10, false).is_empty());
        let brackets = "}\n".repeat(30);
        assert!(find(&[file("c.rs", &brackets), file("d.rs", &brackets)], 10, false).is_empty());
    }
}
