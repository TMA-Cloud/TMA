//! Uploading a file whose name is already taken in the folder: ask whether to
//! replace the existing file or keep both, before anything is sent.

use egui::RichText;
use tma_client::UploadFile;
use tma_core::api::FileItem;

use crate::app::App;
use crate::theme::Weight;
use crate::widgets;

pub struct Clash {
    pub file: UploadFile,
    pub existing: FileItem,
    pub replace: bool,
}

/// Uploads held back until the user decides about the clashing names.
pub struct Pending {
    pub parent: Option<String>,
    pub clean: Vec<UploadFile>,
    pub clashes: Vec<Clash>,
}

/// Split uploads into those that can go now and those whose name an existing
/// file already has (compared without case, as the server does). Files inside
/// an uploaded folder merge into folders of the same name, so they are not asked about.
pub fn split(files: Vec<UploadFile>, existing: &[FileItem]) -> (Vec<UploadFile>, Vec<(UploadFile, FileItem)>) {
    let mut clean = Vec::new();
    let mut clashes = Vec::new();
    for file in files {
        let taken = (file.relative_dir.is_none())
            .then(|| existing.iter().find(|e| !e.is_folder() && e.name.to_lowercase() == file.name.to_lowercase()))
            .flatten();
        match taken {
            Some(existing) => clashes.push((file, existing.clone())),
            None => clean.push(file),
        }
    }
    (clean, clashes)
}

enum Choice {
    Upload,
    Cancel,
}

pub fn show(app: &mut App, ctx: &egui::Context) {
    let crate::app::Screen::Main(main) = &mut app.screen else { return };
    let Some(pending) = &mut main.browser.conflicts else { return };
    let mut choice = None;
    let count = pending.clashes.len();
    let response = widgets::modal(ctx, "upload-conflicts").show(ctx, |ui| {
        ui.set_width(460.0);
        let title = if count == 1 {
            "A file with this name already exists".to_string()
        } else {
            format!("{count} files with these names already exist")
        };
        ui.label(RichText::new(title).size(17.0).semibold());
        ui.add_space(4.0);
        ui.label("Replace keeps the existing file's link and shares. Keep both adds a number to the new file's name.");
        ui.add_space(10.0);
        egui::ScrollArea::vertical().max_height(260.0).show(ui, |ui| {
            for clash in &mut pending.clashes {
                ui.horizontal(|ui| {
                    ui.add(egui::Label::new(&clash.file.name).truncate()).on_hover_text(&clash.file.name);
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        ui.selectable_value(&mut clash.replace, false, "Keep both");
                        ui.selectable_value(&mut clash.replace, true, "Replace");
                    });
                });
            }
        });
        ui.add_space(8.0);
        if count > 1 {
            ui.horizontal(|ui| {
                if widgets::ghost(ui, "Replace all").clicked() {
                    pending.clashes.iter_mut().for_each(|c| c.replace = true);
                }
                if widgets::ghost(ui, "Keep all").clicked() {
                    pending.clashes.iter_mut().for_each(|c| c.replace = false);
                }
            });
            ui.add_space(8.0);
        }
        ui.horizontal(|ui| {
            if widgets::primary(ui, "Upload").clicked() {
                choice = Some(Choice::Upload);
            }
            if widgets::secondary(ui, "Cancel").clicked() {
                choice = Some(Choice::Cancel);
            }
        });
    });
    if response.should_close() && choice.is_none() {
        choice = Some(Choice::Cancel);
    }
    match choice {
        Some(Choice::Upload) => {
            let Some(pending) = main.browser.conflicts.take() else { return };
            let mut uploads = pending.clean;
            for clash in pending.clashes {
                if clash.replace {
                    main.transfers.queue_replace(clash.file, clash.existing.id);
                } else {
                    uploads.push(clash.file);
                }
            }
            main.transfers.queue_uploads(uploads, pending.parent);
        }
        Some(Choice::Cancel) => main.browser.conflicts = None,
        None => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn upload(name: &str, dir: Option<&str>) -> UploadFile {
        UploadFile {
            name: name.into(),
            size: 1,
            source: tma_client::Source::Bytes(bytes::Bytes::new()),
            modified_ms: None,
            relative_dir: dir.map(String::from),
        }
    }

    fn existing(name: &str, kind: &str) -> FileItem {
        serde_json::from_value(serde_json::json!({
            "id": format!("id-{name}"), "name": name, "type": kind, "modified": "2026-01-01T00:00:00Z",
        }))
        .unwrap_or_else(|e| unreachable!("fixture: {e}"))
    }

    #[test]
    fn clashing_names_are_held_back() {
        let have = [existing("Report.pdf", "file"), existing("Photos", "folder")];
        let files = vec![
            upload("report.PDF", None),
            upload("new.txt", None),
            upload("Photos", None),
            upload("Report.pdf", Some("Archive")),
        ];
        let (clean, clashes) = split(files, &have);
        let names: Vec<&str> = clean.iter().map(|f| f.name.as_str()).collect();
        // A folder of the same name, and files inside an uploaded folder, are not clashes.
        assert_eq!(names, ["new.txt", "Photos", "Report.pdf"]);
        assert_eq!(clashes.len(), 1);
        assert_eq!(clashes[0].1.id, "id-Report.pdf");
    }
}
