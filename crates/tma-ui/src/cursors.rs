//! TMA Cloud's own pointers: 28 px artwork in the app palette, a light and a
//! dark set, carried over from the web app. egui only names system cursors,
//! so each host swaps its cursor for these (CSS on the web, Win32 natively).

use egui::CursorIcon;

/// The artwork's size in points; hosts scale it to the screen.
pub const SIZE: f32 = 28.0;

pub struct Shape {
    /// The CSS name of the system cursor it replaces.
    pub name: &'static str,
    /// The click point, in points from the top-left corner.
    pub hotspot: (f32, f32),
    light: &'static str,
    dark: &'static str,
}

impl Shape {
    pub fn svg(&self, dark: bool) -> &'static str {
        if dark { self.dark } else { self.light }
    }
}

macro_rules! shape {
    ($name:literal, $x:literal, $y:literal) => {
        Shape {
            name: $name,
            hotspot: ($x, $y),
            light: include_str!(concat!("../assets/cursors/light-", $name, ".svg")),
            dark: include_str!(concat!("../assets/cursors/dark-", $name, ".svg")),
        }
    };
}

pub static SHAPES: [Shape; 14] = [
    shape!("default", 4.0, 4.0),
    shape!("pointer", 11.0, 4.0),
    shape!("text", 14.0, 14.0),
    shape!("crosshair", 14.0, 14.0),
    shape!("grab", 14.0, 12.0),
    shape!("grabbing", 14.0, 14.0),
    shape!("move", 14.0, 14.0),
    shape!("copy", 4.0, 4.0),
    shape!("alias", 4.0, 4.0),
    shape!("not-allowed", 14.0, 14.0),
    shape!("zoom-in", 12.0, 12.0),
    shape!("zoom-out", 12.0, 12.0),
    shape!("progress", 4.0, 4.0),
    shape!("context-menu", 4.0, 4.0),
];

/// The artwork for a cursor egui asks for; `None` keeps the system one (resize arrows, hidden).
pub fn for_icon(icon: CursorIcon) -> Option<&'static Shape> {
    let name = match icon {
        CursorIcon::Default => "default",
        CursorIcon::PointingHand => "pointer",
        CursorIcon::Text => "text",
        CursorIcon::Crosshair => "crosshair",
        CursorIcon::Grab => "grab",
        CursorIcon::Grabbing => "grabbing",
        CursorIcon::Move | CursorIcon::AllScroll => "move",
        CursorIcon::Copy => "copy",
        CursorIcon::Alias => "alias",
        CursorIcon::NotAllowed | CursorIcon::NoDrop => "not-allowed",
        CursorIcon::ZoomIn => "zoom-in",
        CursorIcon::ZoomOut => "zoom-out",
        CursorIcon::Progress | CursorIcon::Wait => "progress",
        CursorIcon::ContextMenu => "context-menu",
        _ => return None,
    };
    SHAPES.iter().find(|s| s.name == name)
}

fn data_uri(svg: &str) -> String {
    let mut out = String::from("data:image/svg+xml,");
    for c in svg.trim().chars() {
        match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' | '/' | ':' | '=' | ',' | ' ' => out.push(c),
            _ => {
                let mut buf = [0u8; 4];
                for b in c.encode_utf8(&mut buf).bytes() {
                    out.push_str(&format!("%{b:02X}"));
                }
            }
        }
    }
    out.replace(' ', "%20")
}

/// Rules that replace the cursor eframe sets on the canvas (an inline style)
/// with the artwork; `html[data-theme='dark']` picks the dark set.
pub fn css() -> String {
    let mut css = String::new();
    for dark in [false, true] {
        let scope = if dark { "html[data-theme='dark'] " } else { "" };
        for shape in &SHAPES {
            let (x, y) = shape.hotspot;
            css.push_str(&format!(
                "{scope}canvas[style*='cursor: {name};'] {{ cursor: url(\"{uri}\") {x} {y}, {name} !important; }}\n",
                name = shape.name,
                uri = data_uri(shape.svg(dark)),
            ));
        }
    }
    css
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_shape_has_both_sets() {
        for shape in &SHAPES {
            assert!(shape.svg(false).starts_with("<svg"), "{} light", shape.name);
            assert!(shape.svg(true).starts_with("<svg"), "{} dark", shape.name);
            assert!(shape.hotspot.0 < SIZE && shape.hotspot.1 < SIZE);
        }
        assert_eq!(for_icon(CursorIcon::PointingHand).map(|s| s.name), Some("pointer"));
        assert!(for_icon(CursorIcon::ResizeHorizontal).is_none());
    }

    #[test]
    fn css_is_safe_inside_quotes() {
        let css = css();
        assert!(css.contains("canvas[style*='cursor: pointer;']"));
        assert!(!css.contains("url(\"data:image/svg+xml,<"), "the artwork is escaped");
        assert!(!css.contains('#'), "colours are escaped as %23");
    }
}
