//! Rules about what the source says, carried over from the old app's lint rules.

use super::lines::Line;

/// Colours come from `theme::Tokens`; a literal colour goes out of step with the themes.
const RAW_COLOURS: &[&str] = &[
    "Color32::from_rgb(",
    "Color32::from_rgba_unmultiplied(",
    "Color32::from_rgba_premultiplied(",
    "Color32::from_gray(",
    "Color32::WHITE",
    "Color32::BLACK",
    "Color32::RED",
    "Color32::GREEN",
    "Color32::BLUE",
    "Color32::YELLOW",
];

/// A raw colour on a code line, if any.
pub fn raw_colour(line: &Line) -> Option<&'static str> {
    RAW_COLOURS.iter().copied().find(|c| line.text.contains(c))
}

/// U+2019 in user-facing text is easily confused with a backtick; use the ASCII apostrophe.
pub fn smart_apostrophe(line: &Line) -> bool {
    line.text.contains('\u{2019}')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(text: &str) -> Line {
        Line { number: 1, text: text.into() }
    }

    #[test]
    fn flags_literal_colours_and_curly_apostrophes() {
        assert_eq!(raw_colour(&line("let c = Color32::from_rgb(1, 2, 3);")), Some("Color32::from_rgb("));
        assert_eq!(raw_colour(&line("let c = t.accent;")), None);
        assert!(smart_apostrophe(&line("\"Can\u{2019}t open\"")));
        assert!(!smart_apostrophe(&line("\"Can't open\"")));
    }
}
