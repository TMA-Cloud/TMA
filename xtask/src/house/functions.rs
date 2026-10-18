//! Duplicate functions: two functions with the same body, whatever their names.
//! A body shorter than a `dupes::WINDOW` copy slips past the window check, yet
//! is still one function written twice; one of them should call the other.

use std::collections::HashMap;
use std::path::PathBuf;

use super::dupes::mask_literals;
use super::lines::Line;

/// Bodies shorter than this are too generic to call copies (a getter, a match arm).
pub const MIN_BODY: usize = 3;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Twin {
    pub file: PathBuf,
    pub line: usize,
    pub name: String,
    pub other_file: PathBuf,
    pub other_line: usize,
    pub other_name: String,
}

/// The name of the function a line declares, if it declares one.
fn declared(text: &str) -> Option<&str> {
    let at = text.find("fn ").filter(|&i| i == 0 || text[..i].ends_with(' '))?;
    let name = &text[at + 3..];
    let end = name.find(|c: char| !(c.is_alphanumeric() || c == '_'))?;
    (end > 0).then(|| &name[..end])
}

/// Braces opened minus closed, outside string and char literals.
fn depth_change(text: &str) -> isize {
    let masked = mask_literals(text).replace("'{'", "").replace("'}'", "");
    masked
        .chars()
        .map(|c| {
            if c == '{' {
                1
            } else if c == '}' {
                -1
            } else {
                0
            }
        })
        .sum()
}

/// Every function in the file with at least `MIN_BODY` body lines: (line, name, body).
pub fn bodies(lines: &[Line]) -> Vec<(usize, String, String)> {
    let mut out = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let Some(name) = declared(&line.text) else { continue };
        // The signature ends at the first line with a brace (or a `;`, for a declaration).
        let Some(open) = lines[i..].iter().position(|l| l.text.contains('{') || l.text.ends_with(';')) else {
            continue;
        };
        // A declaration, or a body that closes on the line it opens (`fn a() {}`), has nothing to compare.
        if !lines[i + open].text.contains('{') || depth_change(&lines[i + open].text) <= 0 {
            continue;
        }
        let mut depth = 0;
        let mut body = Vec::new();
        for l in &lines[i + open..] {
            depth += depth_change(&l.text);
            if depth <= 0 {
                break;
            }
            body.push(l.text.as_str());
        }
        // The first entry is the signature's last line, which may carry the name.
        let body = &body[1.min(body.len())..];
        if body.len() >= MIN_BODY {
            out.push((line.number, name.to_string(), body.join("\n")));
        }
    }
    out
}

pub fn find(files: &[(PathBuf, Vec<Line>)]) -> Vec<Twin> {
    let mut seen: HashMap<String, (usize, usize, String)> = HashMap::new();
    let mut out = Vec::new();
    for (f, (path, lines)) in files.iter().enumerate() {
        for (line, name, body) in bodies(lines) {
            match seen.get(&body) {
                Some((g, other_line, other_name)) => out.push(Twin {
                    file: path.clone(),
                    line,
                    name,
                    other_file: files[*g].0.clone(),
                    other_line: *other_line,
                    other_name: other_name.clone(),
                }),
                None => {
                    seen.insert(body, (f, line, name));
                }
            }
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
    fn same_body_under_another_name_is_a_twin() {
        let body = "let a = load();\nlet b = a.trim();\nsave(b, \"{\");\n";
        let a = file("a.rs", &format!("pub fn first(x: u8) {{\n{body}}}\n"));
        let b = file("b.rs", &format!("fn second()\nwhere T: Copy\n{{\n{body}}}\n"));
        let twins = find(&[a, b]);
        assert_eq!(twins.len(), 1);
        assert_eq!((twins[0].name.as_str(), twins[0].other_name.as_str()), ("second", "first"));
    }

    #[test]
    fn short_or_different_bodies_are_not_twins() {
        let a = file("a.rs", "fn a() -> u8 {\n1\n}\nfn b() {\nx();\ny();\nz();\n}\n");
        // A one-line body must not swallow the function after it.
        let b = file(
            "b.rs",
            "fn c() -> u8 {\n1\n}\nfn on(_x: bool) {}\nfn d() {\nx();\ny();\nw();\n}\ntrait T { fn e(); }\n",
        );
        assert!(find(&[a, b]).is_empty());
    }
}
