//! The upload dialog: gather files and folders by picking or dropping them,
//! check the list, then upload them together into the folder named in the header.

use egui::text::{LayoutJob, TextFormat};
use egui::{Align, Align2, CornerRadius, FontId, Layout, Rect, RichText, Sense, Stroke, Ui, UiBuilder, Vec2};
use tma_client::UploadFile;

use super::Outcome;
use crate::icons::{self, ph};
use crate::theme::{Tokens, Weight};
use crate::widgets;

/// Rows shown at once; the list scrolls beyond them.
const LIST_ROWS: f32 = 7.0;
const ROW: f32 = 34.0;
const PICK_WIDTH: f32 = 136.0;

/// Where a staged file lands, relative to the open folder ("Photos/2026/a.jpg").
pub fn shown_path(file: &UploadFile) -> String {
    match &file.relative_dir {
        Some(dir) if !dir.is_empty() => format!("{dir}/{}", file.name),
        _ => file.name.clone(),
    }
}

/// Add newly picked files, skipping any already in the list at the same path.
pub fn add(staged: &mut Vec<UploadFile>, files: Vec<UploadFile>) {
    let mut seen: std::collections::HashSet<String> = staged.iter().map(shown_path).collect();
    for file in files {
        if seen.insert(shown_path(&file)) {
            staged.push(file);
        }
    }
}

/// Whether the server's limit (`max`, 0 for none) refuses this file.
fn too_large(file: &UploadFile, max: i64) -> bool {
    max > 0 && file.size as i64 > max
}

/// What the list adds up to: files that can go, their bytes, and those over the limit.
pub fn totals(staged: &[UploadFile], max: i64) -> (usize, u64, usize) {
    let over = staged.iter().filter(|f| too_large(f, max)).count();
    let bytes = staged.iter().filter(|f| !too_large(f, max)).map(|f| f.size).sum();
    (staged.len() - over, bytes, over)
}

fn dashed_border(ui: &Ui, rect: Rect, stroke: Stroke) {
    let corners = [rect.left_top(), rect.right_top(), rect.right_bottom(), rect.left_bottom(), rect.left_top()];
    ui.painter().extend(egui::Shape::dashed_line(&corners, stroke, 6.0, 4.0));
}

/// A picker button of a fixed width, so a pair centres without measuring.
fn pick(ui: &mut Ui, icon: &str, label: &str) -> bool {
    ui.add_sized([PICK_WIDTH, 32.0], egui::Button::new(format!("{icon}  {label}")).corner_radius(16)).clicked()
}

/// The drop zone, tall and explanatory while the list is empty, a strip after.
fn zone(ui: &mut Ui, empty: bool, outcome: &mut Option<Outcome>) {
    let t = widgets::tokens(ui);
    let hovering = ui.input(|i| !i.raw.hovered_files.is_empty());
    let height = if empty { 190.0 } else { 52.0 };
    let (rect, response) = ui.allocate_exact_size(Vec2::new(ui.available_width(), height), Sense::click());
    let active = hovering || response.hovered();
    ui.painter().rect_filled(rect, 14.0, if active { t.accent_fill } else { t.fill_quaternary });
    dashed_border(ui, rect.shrink(1.0), Stroke::new(1.5, if active { t.accent } else { t.separator_strong }));
    if response.hovered() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    if empty {
        let top = rect.center_top();
        ui.painter().circle_filled(top + Vec2::new(0.0, 44.0), 24.0, t.accent_fill);
        let font = FontId::proportional(24.0);
        ui.painter().text(top + Vec2::new(0.0, 44.0), Align2::CENTER_CENTER, ph::CLOUD_ARROW_UP, font, t.accent);
        let title = FontId::new(14.0, crate::theme::semibold());
        ui.painter().text(
            top + Vec2::new(0.0, 88.0),
            Align2::CENTER_CENTER,
            "Drop files or folders here",
            title,
            t.label,
        );
        let note = "or choose them from your computer";
        ui.painter().text(
            top + Vec2::new(0.0, 108.0),
            Align2::CENTER_CENTER,
            note,
            FontId::proportional(12.0),
            t.label_tertiary,
        );
        let row = Rect::from_center_size(top + Vec2::new(0.0, 150.0), Vec2::new(PICK_WIDTH * 2.0 + 8.0, 32.0));
        // A child that takes no room: the zone already did, and what follows goes below it.
        let mut child = ui.new_child(UiBuilder::new().max_rect(row).layout(Layout::left_to_right(Align::Center)));
        child.spacing_mut().item_spacing.x = 8.0;
        pickers(&mut child, outcome);
    } else {
        let inner = rect.shrink2(Vec2::new(14.0, 10.0));
        let mut child = ui.new_child(UiBuilder::new().max_rect(inner).layout(Layout::left_to_right(Align::Center)));
        let more = RichText::new(format!("{}  Drop more here, or add", ph::PLUS)).size(13.0).color(t.label_secondary);
        child.label(more);
        child.with_layout(Layout::right_to_left(Align::Center), |ui| {
            ui.spacing_mut().item_spacing.x = 6.0;
            if widgets::secondary(ui, format!("{}  Folder", ph::FOLDER)).clicked() {
                *outcome = Some(Outcome::Pick(true));
            }
            if widgets::secondary(ui, format!("{}  Files", ph::FILE)).clicked() {
                *outcome = Some(Outcome::Pick(false));
            }
        });
    }
    // The buttons inside claim their own clicks; a click anywhere else picks files.
    if response.clicked() && outcome.is_none() {
        *outcome = Some(Outcome::Pick(false));
    }
}

fn pickers(ui: &mut Ui, outcome: &mut Option<Outcome>) {
    if pick(ui, ph::FILE, "Choose files") {
        *outcome = Some(Outcome::Pick(false));
    }
    if pick(ui, ph::FOLDER, "Choose folder") {
        *outcome = Some(Outcome::Pick(true));
    }
}

/// One file: its type's icon, the folders it lands in greyed before its name,
/// its size (red when over the limit) and a remove button.
fn row(ui: &mut Ui, t: &Tokens, file: &UploadFile, max: i64) -> bool {
    let (rect, response) = ui.allocate_exact_size(Vec2::new(ui.available_width(), ROW), Sense::hover());
    if response.hovered() {
        ui.painter().rect_filled(rect, CornerRadius::same(8), t.fill_quaternary);
    }
    let icon = Rect::from_center_size(rect.left_center() + Vec2::new(18.0, 0.0), Vec2::splat(20.0));
    icons::file(ui.painter(), icon, t, &file.name, None);
    let over = too_large(file, max);
    let size = tma_core::format::file_size(file.size as i64);
    let size_font = FontId::proportional(12.0);
    let size_galley =
        ui.painter().layout_no_wrap(size, size_font, if over { t.destructive_text } else { t.label_tertiary });
    let right = rect.right() - 40.0;
    ui.painter().galley(
        egui::pos2(right - size_galley.size().x, rect.center().y - size_galley.size().y / 2.0),
        size_galley.clone(),
        t.label,
    );
    let mut job = LayoutJob::default();
    if let Some(dir) = file.relative_dir.as_deref().filter(|d| !d.is_empty()) {
        job.append(&format!("{dir}/"), 0.0, TextFormat::simple(FontId::proportional(13.0), t.label_tertiary));
    }
    job.append(&file.name, 0.0, TextFormat::simple(FontId::proportional(13.0), t.label));
    job.wrap = egui::text::TextWrapping::truncate_at_width(right - size_galley.size().x - 12.0 - (rect.left() + 36.0));
    let name = ui.painter().layout_job(job);
    ui.painter().galley(egui::pos2(rect.left() + 36.0, rect.center().y - name.size().y / 2.0), name, t.label);
    if over {
        let limit = tma_core::format::file_size(max);
        response.on_hover_text(format!("Larger than the {limit} upload limit; it will be skipped"));
    }
    let remove = Rect::from_center_size(egui::pos2(rect.right() - 16.0, rect.center().y), Vec2::splat(24.0));
    ui.put(remove, egui::Button::new(RichText::new(ph::X).size(13.0).color(t.label_tertiary)).frame(false))
        .on_hover_text("Remove")
        .clicked()
}

fn list(ui: &mut Ui, staged: &mut Vec<UploadFile>, max: i64) {
    let t = widgets::tokens(ui);
    let mut remove = None;
    egui::Frame::new()
        .fill(t.surface_raised)
        .stroke(Stroke::new(1.0, t.separator))
        .corner_radius(CornerRadius::same(12))
        .inner_margin(egui::Margin::same(4))
        .show(ui, |ui| {
            ui.spacing_mut().item_spacing.y = 0.0;
            // Only the rows in view are laid out, so a dropped folder of thousands stays smooth.
            egui::ScrollArea::vertical().max_height(ROW * LIST_ROWS).auto_shrink([false, true]).show_rows(
                ui,
                ROW,
                staged.len(),
                |ui, range| {
                    for index in range {
                        if row(ui, &t, &staged[index], max) {
                            remove = Some(index);
                        }
                    }
                },
            );
        });
    if let Some(index) = remove {
        staged.remove(index);
    }
}

/// Totals on the left, the buttons on the right.
fn footer(ui: &mut Ui, staged: &mut Vec<UploadFile>, max: i64, outcome: &mut Option<Outcome>) {
    let t = widgets::tokens(ui);
    let (count, bytes, over) = totals(staged, max);
    ui.add_space(12.0);
    ui.horizontal(|ui| {
        ui.set_min_height(32.0);
        if !staged.is_empty() {
            let files = if count == 1 { "1 file".to_string() } else { format!("{count} files") };
            let summary = format!("{files} · {}", tma_core::format::file_size(bytes as i64));
            ui.label(RichText::new(summary).size(12.5).semibold().color(t.label_secondary));
            if over > 0 {
                ui.label(RichText::new(format!("· {over} too large")).size(12.5).color(t.destructive_text));
            }
            if ui.add(egui::Button::new(RichText::new("Clear").size(12.5).color(t.accent)).frame(false)).clicked() {
                staged.clear();
            }
        }
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            let label = match count {
                0 => "Upload".to_string(),
                1 => "Upload 1 file".to_string(),
                n => format!("Upload {n} files"),
            };
            if widgets::primary_enabled(ui, count > 0, label).clicked() {
                *outcome = Some(Outcome::Upload);
            }
            if widgets::secondary(ui, "Cancel").clicked() {
                *outcome = Some(Outcome::Close);
            }
        });
    });
}

pub(super) fn body(ui: &mut Ui, staged: &mut Vec<UploadFile>, max: i64, outcome: &mut Option<Outcome>) {
    zone(ui, staged.is_empty(), outcome);
    if !staged.is_empty() {
        ui.add_space(10.0);
        list(ui, staged, max);
    }
    footer(ui, staged, max, outcome);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(name: &str, dir: Option<&str>) -> UploadFile {
        UploadFile {
            name: name.into(),
            size: 1,
            source: tma_client::Source::Bytes(bytes::Bytes::new()),
            modified_ms: None,
            relative_dir: dir.map(String::from),
        }
    }

    #[test]
    fn picking_again_does_not_duplicate() {
        let mut staged = vec![file("a.txt", None)];
        add(&mut staged, vec![file("a.txt", None), file("a.txt", Some("Photos")), file("b.txt", None)]);
        let paths: Vec<String> = staged.iter().map(shown_path).collect();
        assert_eq!(paths, ["a.txt", "Photos/a.txt", "b.txt"]);
    }

    #[test]
    fn files_over_the_limit_are_counted_apart() {
        let mut big = file("big.iso", None);
        big.size = 50;
        let staged = vec![file("a.txt", None), big];
        assert_eq!(totals(&staged, 10), (1, 1, 1));
        assert_eq!(totals(&staged, 0), (2, 51, 0));
    }
}
