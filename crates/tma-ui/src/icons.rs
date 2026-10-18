//! Folder and file artwork drawn in code (the web app's flat page and folder
//! glyphs), and the Phosphor icon font for UI symbols.

use egui::epaint::PathShape;
use egui::{Align2, Color32, FontId, Painter, Pos2, Rect, Stroke, Vec2, pos2};
use tma_core::FileKind;

pub use egui_phosphor::regular as ph;

use crate::theme::Tokens;

/// Points of a rounded rectangle corner arc, for building polygons.
fn arc(out: &mut Vec<Pos2>, center: Pos2, radius: f32, from_deg: f32, to_deg: f32) {
    const STEPS: usize = 5;
    for i in 0..=STEPS {
        let a = (from_deg + (to_deg - from_deg) * i as f32 / STEPS as f32).to_radians();
        out.push(center + Vec2::new(a.cos(), a.sin()) * radius);
    }
}

/// Map the 32×32 artwork grid into `rect`.
fn grid(rect: Rect) -> impl Fn(f32, f32) -> Pos2 {
    let side = rect.width().min(rect.height());
    let origin = rect.center() - Vec2::splat(side / 2.0);
    move |x, y| origin + Vec2::new(x, y) * (side / 32.0)
}

/// The folder: a darker back panel with its tab, and a lighter front flap.
pub fn folder(painter: &Painter, rect: Rect, t: &Tokens, zipped: bool) {
    let g = grid(rect);
    let s = rect.width().min(rect.height()) / 32.0;
    let back = Rect::from_min_max(g(1.0, 7.5), g(31.0, 28.0));
    painter.rect_filled(back, 4.0 * s, t.folder_back);
    painter.rect_filled(Rect::from_min_max(g(1.0, 4.5), g(15.5, 10.0)), 3.0 * s, t.folder_back);
    painter.rect_filled(Rect::from_min_max(g(1.0, 11.25), g(31.0, 28.0)), 3.5 * s, t.folder_front);
    if zipped {
        for (i, y) in [8.0, 9.25, 10.5, 11.75, 13.0, 14.25].iter().enumerate() {
            let x = if i % 2 == 0 { 14.5 } else { 16.0 };
            painter.rect_filled(Rect::from_min_max(g(x, *y), g(x + 2.0, y + 1.25)), 0.0, t.folder_zip);
        }
        painter.rect_filled(Rect::from_min_max(g(13.75, 15.5), g(18.75, 23.5)), 1.25 * s, t.folder_zip);
    }
}

/// The short format name some well-known extensions show instead of a symbol.
fn format_label(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "doc" | "docx" => "DOC",
        "xls" | "xlsx" => "XLS",
        "ppt" | "pptx" => "PPT",
        "pdf" => "PDF",
        "csv" => "CSV",
        "json" => "JSON",
        "sql" => "SQL",
        "svg" => "SVG",
        "psd" | "psb" => "PSD",
        "ai" => "AI",
        _ => return None,
    })
}

fn kind_symbol(kind: FileKind) -> Option<&'static str> {
    Some(match kind {
        FileKind::Document => ph::TEXT_ALIGN_JUSTIFY,
        FileKind::Spreadsheet => ph::TABLE,
        FileKind::Presentation => ph::PRESENTATION,
        FileKind::Image => ph::IMAGE,
        FileKind::Design => ph::PEN_NIB,
        FileKind::Video => ph::PLAY,
        FileKind::Audio => ph::MUSIC_NOTES,
        FileKind::Code => ph::CODE,
        FileKind::Database => ph::DATABASE,
        FileKind::Text => ph::TEXT_ALIGN_LEFT,
        FileKind::Executable => ph::APP_WINDOW,
        FileKind::Font => ph::TEXT_AA,
        FileKind::Pdf | FileKind::Archive | FileKind::Generic => return None,
    })
}

/// A flat, filled page in the kind's colour with a lighter fold and a symbol.
pub fn file(painter: &Painter, rect: Rect, t: &Tokens, name: &str, mime: Option<&str>) {
    let kind = tma_core::file_kind(name, mime);
    if kind == FileKind::Archive {
        return folder(painter, rect, t, true);
    }
    let g = grid(rect);
    let s = rect.width().min(rect.height()) / 32.0;
    let color = t.file_color(kind);
    let mut points = Vec::with_capacity(32);
    points.push(g(19.0, 2.0));
    points.push(g(27.0, 10.0));
    arc(&mut points, g(23.5, 26.5), 3.5 * s, 0.0, 90.0);
    arc(&mut points, g(8.5, 26.5), 3.5 * s, 90.0, 180.0);
    arc(&mut points, g(8.5, 5.5), 3.5 * s, 180.0, 270.0);
    painter.add(PathShape::convex_polygon(points, color, Stroke::NONE));
    let fold = vec![g(19.0, 2.0), g(27.0, 10.0), g(22.0, 10.0), g(19.0, 7.0)];
    painter.add(PathShape::convex_polygon(fold, Color32::from_white_alpha(100), Stroke::NONE));

    let ext = tma_core::names::extension_of(name);
    let center = g(16.0, 19.5);
    if let Some(label) = format_label(&ext) {
        let size = if label.len() > 3 { 5.6 } else { 6.6 } * s;
        painter.text(center, Align2::CENTER_CENTER, label, FontId::proportional(size.max(5.0)), t.on_accent);
    } else if let Some(symbol) = kind_symbol(kind) {
        painter.text(center, Align2::CENTER_CENTER, symbol, FontId::proportional((12.0 * s).max(6.0)), t.on_accent);
    }
}

/// A folder or file icon of `size` points, allocated in the layout.
pub fn item_icon(
    ui: &mut egui::Ui,
    size: f32,
    is_folder: bool,
    name: &str,
    mime: Option<&str>,
    t: &Tokens,
) -> egui::Response {
    let (rect, response) = ui.allocate_exact_size(Vec2::splat(size), egui::Sense::hover());
    if ui.is_rect_visible(rect) {
        if is_folder {
            folder(ui.painter(), rect, t, false);
        } else {
            file(ui.painter(), rect, t, name, mime);
        }
    }
    response
}

/// The app mark: a cloud in the accent colour.
pub fn logo(painter: &Painter, rect: Rect, t: &Tokens) {
    painter.rect_filled(rect, rect.width() * 0.26, t.accent);
    painter.text(
        rect.center() + Vec2::new(0.0, 0.5),
        Align2::CENTER_CENTER,
        ph::HARD_DRIVE,
        FontId::proportional(rect.width() * 0.56),
        t.on_accent,
    );
}

/// A small filled circle with initials, for the user menu.
pub fn avatar(painter: &Painter, center: Pos2, radius: f32, name: &str, t: &Tokens) {
    painter.circle_filled(center, radius, t.accent);
    painter.text(center, Align2::CENTER_CENTER, initials(name), FontId::proportional(radius * 0.85), t.on_accent);
}

/// Up to two initials from a name, or "?" when it has none.
pub fn initials(name: &str) -> String {
    let initials: String =
        name.split_whitespace().filter_map(|w| w.chars().next()).take(2).collect::<String>().to_uppercase();
    if initials.is_empty() { "?".to_string() } else { initials }
}

pub fn point(x: f32, y: f32) -> Pos2 {
    pos2(x, y)
}
