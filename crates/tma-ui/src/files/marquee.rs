//! Rubber-band selection: dragging on empty space in the listing selects every
//! item the rectangle touches, including rows scrolled out of view. The band's
//! start is kept in content coordinates, so it stays put while the list scrolls.

use std::collections::BTreeSet;

use egui::{Id, Pos2, Rect, Response, Sense, Stroke, Ui, Vec2};

use crate::app::Main;
use crate::theme::Tokens;

/// How a band combines with the selection it started from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// A plain drag: the band is the selection.
    Replace,
    /// Shift: the band adds to what was selected.
    Add,
    /// Ctrl (Cmd on a Mac): items the band touches flip, as in Explorer and Finder.
    Toggle,
}

/// A drag in progress, in content coordinates so scrolling does not move its start.
#[derive(Debug, Clone)]
pub struct Drag {
    start: Pos2,
    mode: Mode,
    /// The selection when the drag began.
    base: BTreeSet<String>,
}

/// The selection while a band touches `touched`.
pub fn combine(base: &BTreeSet<String>, touched: impl IntoIterator<Item = String>, mode: Mode) -> BTreeSet<String> {
    match mode {
        Mode::Replace => touched.into_iter().collect(),
        Mode::Add => base.iter().cloned().chain(touched).collect(),
        Mode::Toggle => {
            let touched: BTreeSet<String> = touched.into_iter().collect();
            base.symmetric_difference(&touched).cloned().collect()
        }
    }
}

/// Scrolling speed in points per second while the pointer is `past` points beyond an
/// edge (negative inside it): it starts slow and speeds up the farther out it goes.
pub fn edge_speed(past: f32) -> f32 {
    const ZONE: f32 = 32.0;
    let depth = (past + ZONE).max(0.0);
    (depth * 18.0).min(2400.0)
}

/// Where items sit, measured from the top-left of the listing's content.
#[derive(Debug, Clone, Copy)]
pub enum Layout {
    Rows { pitch: f32, height: f32, width: f32 },
    Tiles { per_row: usize, pitch: Vec2, tile: Vec2 },
}

/// Indexes of the items `rect` touches, out of `count`.
pub fn hits(layout: Layout, rect: Rect, count: usize) -> Vec<usize> {
    let band = |lo: f32, hi: f32, pitch: f32| {
        let first = (lo / pitch).floor().max(0.0) as usize;
        let last = (hi / pitch).floor().max(0.0) as usize;
        first..=last
    };
    let mut out = Vec::new();
    match layout {
        Layout::Rows { pitch, height, width } => {
            if rect.max.x < 0.0 || rect.min.x > width {
                return out;
            }
            for i in band(rect.min.y, rect.max.y, pitch).filter(|i| *i < count) {
                let top = i as f32 * pitch;
                if rect.max.y >= top && rect.min.y <= top + height {
                    out.push(i);
                }
            }
        }
        Layout::Tiles { per_row, pitch, tile } => {
            let per_row = per_row.max(1);
            for row in band(rect.min.y, rect.max.y, pitch.y) {
                for col in band(rect.min.x, rect.max.x, pitch.x).filter(|c| *c < per_row) {
                    let min = Pos2::new(col as f32 * pitch.x, row as f32 * pitch.y);
                    let index = row * per_row + col;
                    if index < count && rect.intersects(Rect::from_min_size(min, tile)) {
                        out.push(index);
                    }
                }
            }
        }
    }
    out
}

/// The listing's background: register it before the items so they stay on top.
pub fn background(ui: &mut Ui) -> Response {
    // On touch a drag scrolls the list, so the background only takes taps.
    let sense = if crate::widgets::touch_mode(ui.ctx()) { Sense::click() } else { Sense::click_and_drag() };
    ui.interact(ui.clip_rect(), Id::unique("listing-background"), sense)
}

/// Wheel and scroll bar with a mouse (a drag draws a selection band); dragging too on touch.
pub fn scroll_source(ctx: &egui::Context) -> egui::scroll_area::ScrollSource {
    if crate::widgets::touch_mode(ctx) {
        egui::scroll_area::ScrollSource::ALL
    } else {
        egui::scroll_area::ScrollSource { scroll_bar: true, mouse_wheel: true, ..egui::scroll_area::ScrollSource::NONE }
    }
}

/// Follow a drag on the background; `origin` is the content's top-left on screen.
pub fn update(main: &mut Main, ui: &mut Ui, background: &Response, origin: Pos2, layout: Layout, t: &Tokens) {
    let modifiers = ui.input(|i| i.modifiers);
    let b = &mut main.browser;
    if background.clicked() && !modifiers.command && !modifiers.shift {
        b.selected.clear();
        b.anchor = None;
    }
    if background.drag_started()
        && let Some(press) = ui.input(|i| i.pointer.press_origin())
    {
        let mode = if modifiers.command {
            Mode::Toggle
        } else if modifiers.shift {
            Mode::Add
        } else {
            Mode::Replace
        };
        b.marquee = Some(Drag { start: press - origin.to_vec2(), mode, base: b.selected.clone() });
    }
    let Some(drag) = b.marquee.clone() else { return };
    if background.drag_stopped() || !ui.input(|i| i.pointer.primary_down()) {
        b.marquee = None;
        return;
    }
    let Some(pointer) = ui.input(|i| i.pointer.latest_pos()) else { return };
    let rect = Rect::from_two_pos(drag.start, pointer - origin.to_vec2());
    let touched = hits(layout, rect, b.items.len());
    let ids = touched.iter().filter_map(|i| b.items.get(*i)).map(|item| item.id.clone());
    b.selected = combine(&drag.base, ids, drag.mode);
    if drag.mode == Mode::Replace {
        b.anchor = touched.first().and_then(|i| b.items.get(*i)).map(|item| item.id.clone());
    }
    let view = ui.clip_rect();
    ui.painter().with_clip_rect(view).rect(
        rect.translate(origin.to_vec2()),
        egui::CornerRadius::same(2),
        t.accent_fill,
        Stroke::new(1.0, t.accent),
        egui::StrokeKind::Inside,
    );
    // Near the top or bottom edge the list scrolls under the band, by time rather than
    // per frame, so it moves at the same speed on any display.
    let dt = ui.input(|i| i.stable_dt).min(0.1);
    let up = edge_speed(view.top() - pointer.y);
    let down = edge_speed(pointer.y - view.bottom());
    let delta = (up - down) * dt;
    if delta != 0.0 {
        ui.scroll_with_delta(Vec2::new(0.0, delta));
        ui.ctx().request_repaint();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x0: f32, y0: f32, x1: f32, y1: f32) -> Rect {
        Rect::from_two_pos(Pos2::new(x0, y0), Pos2::new(x1, y1))
    }

    #[test]
    fn rows_touched_by_the_band() {
        let rows = Layout::Rows { pitch: 44.0, height: 40.0, width: 600.0 };
        assert_eq!(hits(rows, rect(10.0, 5.0, 50.0, 100.0), 10), vec![0, 1, 2]);
        // The gap between rows touches nothing.
        assert!(hits(rows, rect(10.0, 41.0, 50.0, 43.0), 10).is_empty());
        // Rows past the end of the listing do not exist.
        assert_eq!(hits(rows, rect(0.0, 300.0, 50.0, 900.0), 8), vec![6, 7]);
        // Beside the listing.
        assert!(hits(rows, rect(610.0, 0.0, 700.0, 100.0), 10).is_empty());
    }

    fn set(ids: &[&str]) -> BTreeSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn bands_combine_like_explorer() {
        let base = set(&["a", "b"]);
        let touched = || vec!["b".to_string(), "c".to_string()];
        assert_eq!(combine(&base, touched(), Mode::Replace), set(&["b", "c"]));
        assert_eq!(combine(&base, touched(), Mode::Add), set(&["a", "b", "c"]));
        assert_eq!(combine(&base, touched(), Mode::Toggle), set(&["a", "c"]));
    }

    #[test]
    fn edge_scrolling_speeds_up_past_the_edge() {
        assert_eq!(edge_speed(-100.0), 0.0);
        assert!(edge_speed(-10.0) > 0.0);
        assert!(edge_speed(40.0) > edge_speed(0.0));
        assert_eq!(edge_speed(10_000.0), 2400.0);
    }

    #[test]
    fn tiles_touched_by_the_band() {
        let tiles = Layout::Tiles { per_row: 3, pitch: Vec2::new(136.0, 148.0), tile: Vec2::new(128.0, 132.0) };
        // Top-left tile and the one to its right.
        assert_eq!(hits(tiles, rect(10.0, 10.0, 140.0, 20.0), 9), vec![0, 1]);
        // A column of the second tile, across two rows.
        assert_eq!(hits(tiles, rect(140.0, 10.0, 150.0, 160.0), 9), vec![1, 4]);
        // Past the last column, and past the last item.
        assert!(hits(tiles, rect(420.0, 10.0, 500.0, 20.0), 9).is_empty());
        assert_eq!(hits(tiles, rect(10.0, 300.0, 400.0, 310.0), 7), vec![6]);
    }
}
