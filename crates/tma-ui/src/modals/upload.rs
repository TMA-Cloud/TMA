//! The upload dialog, as the web app had it: gather files and folders by
//! picking or dropping them, check the list, then upload them together.

use egui::{Align2, FontId, RichText, Sense, Stroke, Vec2};
use tma_client::UploadFile;

use super::Outcome;
use crate::icons::ph;
use crate::theme::Weight;
use crate::widgets;

/// Rows shown at once; the list scrolls beyond them.
const LIST_HEIGHT: f32 = 240.0;

/// Where a staged file lands, relative to the open folder ("Photos/2026/a.jpg").
pub fn shown_path(file: &UploadFile) -> String {
    match &file.relative_dir {
        Some(dir) if !dir.is_empty() => format!("{dir}/{}", file.name),
        _ => file.name.clone(),
    }
}

/// Add newly picked files, skipping any already in the list at the same path.
pub fn add(staged: &mut Vec<UploadFile>, files: Vec<UploadFile>) {
    for file in files {
        let path = shown_path(&file);
        if !staged.iter().any(|f| shown_path(f) == path) {
            staged.push(file);
        }
    }
}

fn dashed_border(ui: &egui::Ui, rect: egui::Rect, stroke: Stroke) {
    let corners = [rect.left_top(), rect.right_top(), rect.right_bottom(), rect.left_bottom(), rect.left_top()];
    ui.painter().extend(egui::Shape::dashed_line(&corners, stroke, 6.0, 4.0));
}

pub(super) fn body(ui: &mut egui::Ui, staged: &mut Vec<UploadFile>, outcome: &mut Option<Outcome>) {
    let t = widgets::tokens(ui);
    let hovering_files = ui.input(|i| !i.raw.hovered_files.is_empty());
    let height = if staged.is_empty() { 160.0 } else { 56.0 };
    let (rect, zone) = ui.allocate_exact_size(Vec2::new(ui.available_width(), height), Sense::click());
    let active = hovering_files || zone.hovered();
    if active {
        ui.painter().rect_filled(rect, 12.0, t.accent_fill);
    }
    dashed_border(ui, rect.shrink(1.0), Stroke::new(1.5, if active { t.accent } else { t.separator }));
    if staged.is_empty() {
        ui.painter().text(
            rect.center() - Vec2::new(0.0, 28.0),
            Align2::CENTER_CENTER,
            ph::UPLOAD_SIMPLE,
            FontId::proportional(30.0),
            t.accent,
        );
        ui.painter().text(
            rect.center() + Vec2::new(0.0, 12.0),
            Align2::CENTER_CENTER,
            "Drag and drop files or folders here",
            FontId::new(14.0, crate::theme::semibold()),
            t.label,
        );
        ui.painter().text(
            rect.center() + Vec2::new(0.0, 34.0),
            Align2::CENTER_CENTER,
            "or click to browse from your computer",
            FontId::proportional(12.0),
            t.label_secondary,
        );
    } else {
        ui.painter().text(
            rect.center(),
            Align2::CENTER_CENTER,
            format!("{}  Drop more here, or click to add files", ph::PLUS),
            FontId::proportional(13.0),
            t.label_secondary,
        );
    }
    if zone.clicked() {
        *outcome = Some(Outcome::Pick(false));
    }
    ui.add_space(8.0);
    ui.horizontal(|ui| {
        if widgets::secondary(ui, format!("{}  Files", ph::FILE)).clicked() {
            *outcome = Some(Outcome::Pick(false));
        }
        if widgets::secondary(ui, format!("{}  Folder", ph::FOLDER)).clicked() {
            *outcome = Some(Outcome::Pick(true));
        }
    });
    if !staged.is_empty() {
        ui.add_space(8.0);
        let mut remove = None;
        egui::ScrollArea::vertical().max_height(LIST_HEIGHT).show(ui, |ui| {
            for (index, file) in staged.iter().enumerate() {
                ui.horizontal(|ui| {
                    ui.label(RichText::new(ph::FILE).color(t.label_tertiary));
                    let width = ui.available_width() - 110.0;
                    ui.allocate_ui_with_layout(
                        Vec2::new(width, 18.0),
                        egui::Layout::left_to_right(egui::Align::Center),
                        |ui| ui.add(egui::Label::new(shown_path(file)).truncate()),
                    );
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if widgets::icon_button(ui, ph::X, "Remove").clicked() {
                            remove = Some(index);
                        }
                        ui.label(widgets::muted(ui, tma_core::format::file_size(file.size as i64)));
                    });
                });
            }
        });
        if let Some(index) = remove {
            staged.remove(index);
        }
        let total: u64 = staged.iter().map(|f| f.size).sum();
        ui.add_space(4.0);
        ui.label(
            RichText::new(format!(
                "{} · {}",
                crate::files::items_label(staged.len()).replace("item", "file"),
                tma_core::format::file_size(total as i64)
            ))
            .semibold(),
        );
    }
    widgets::dialog_footer(ui, |ui| {
        let label = match staged.len() {
            0 => "Upload".to_string(),
            1 => "Upload 1 file".to_string(),
            n => format!("Upload {n} files"),
        };
        if widgets::primary_enabled(ui, !staged.is_empty(), label).clicked() {
            *outcome = Some(Outcome::Upload);
        }
        if widgets::secondary(ui, "Cancel").clicked() {
            *outcome = Some(Outcome::Close);
        }
    });
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
}
