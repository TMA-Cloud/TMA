//! What counts as code in a Rust file: not blank, not only a comment, and not
//! in the test module at the bottom (`#[cfg(test)]` and everything after it).

/// One line of code with its 1-based line number, whitespace collapsed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Line {
    pub number: usize,
    pub text: String,
}

/// The file's code lines, without comments, blanks and its test module.
pub fn code_lines(source: &str) -> Vec<Line> {
    let mut out = Vec::new();
    let mut in_block = false;
    for (index, raw) in source.lines().enumerate() {
        let trimmed = raw.trim();
        if !in_block && trimmed == "#[cfg(test)]" {
            break;
        }
        let text = strip_comments(raw, &mut in_block);
        let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if !text.is_empty() {
            out.push(Line { number: index + 1, text });
        }
    }
    out
}

/// The line with `//` and `/* */` comments removed, outside string literals.
fn strip_comments(line: &str, in_block: &mut bool) -> String {
    let mut out = String::new();
    let mut chars = line.chars().peekable();
    let mut in_string = false;
    while let Some(c) = chars.next() {
        if *in_block {
            if c == '*' && chars.peek() == Some(&'/') {
                chars.next();
                *in_block = false;
            }
            continue;
        }
        if in_string {
            out.push(c);
            if c == '\\' {
                if let Some(next) = chars.next() {
                    out.push(next);
                }
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        match (c, chars.peek()) {
            ('/', Some('/')) => break,
            ('/', Some('*')) => {
                chars.next();
                *in_block = true;
            }
            ('"', _) => {
                in_string = true;
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
}

/// Lines the size limit counts.
pub fn real_lines(source: &str) -> usize {
    code_lines(source).len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_code_but_not_comments_blanks_or_tests() {
        let source = "//! Module docs\n\nfn a() {\n    // why\n    let x = \"// not a comment\"; // trailing\n    /* block\n    still */ x\n}\n\n#[cfg(test)]\nmod tests {\n    fn t() {}\n}\n";
        let lines = code_lines(source);
        let texts: Vec<&str> = lines.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(texts, ["fn a() {", "let x = \"// not a comment\";", "x", "}"]);
        assert_eq!(lines[1].number, 5);
        assert_eq!(real_lines(source), 4);
    }
}
