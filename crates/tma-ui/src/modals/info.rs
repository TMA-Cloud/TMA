//! The details dialog for one file or folder.

use egui::RichText;
use tma_core::api::{FileInfo, FileItem};

use crate::icons;
use crate::theme::Weight;
use crate::widgets;

fn info_row(ui: &mut egui::Ui, label: &str, value: String) {
    let t = widgets::tokens(ui);
    ui.horizontal(|ui| {
        ui.add_sized([110.0, 18.0], egui::Label::new(RichText::new(label).color(t.label_secondary)));
        ui.add(egui::Label::new(value).wrap());
    });
}

pub(super) fn info_body(ui: &mut egui::Ui, item: &FileItem, info: Option<&FileInfo>) {
    let t = widgets::tokens(ui);
    ui.horizontal(|ui| {
        icons::item_icon(ui, 44.0, item.is_folder(), &item.name, item.mime_type.as_deref(), &t);
        ui.vertical(|ui| {
            ui.add(egui::Label::new(RichText::new(&item.name).size(16.0).semibold()).wrap());
            let kind = if item.is_folder() {
                "Folder"
            } else {
                tma_core::file_kind(&item.name, item.mime_type.as_deref()).label()
            };
            ui.label(widgets::muted(ui, kind));
        });
    });
    ui.add_space(10.0);
    widgets::separator(ui);
    let Some(info) = info else {
        ui.spinner();
        return;
    };
    let location = if info.location_path.is_empty() {
        "My Files".to_string()
    } else {
        format!("My Files / {}", info.location_path.join(" / "))
    };
    info_row(ui, "Location", location);
    if let Some(folder) = &info.folder_info {
        info_row(ui, "Size", tma_core::format::file_size(folder.total_size));
        info_row(ui, "Contains", format!("{} files, {} folders", folder.file_count, folder.folder_count));
    } else if let Some(size) = info.size {
        info_row(ui, "Size", tma_core::format::file_size(size));
    }
    info_row(ui, "Modified", tma_core::format::full_date(info.modified));
    if let Some(at) = info.accessed_at {
        info_row(ui, "Last opened", tma_core::format::full_date(at));
    }
    if info.shared {
        info_row(ui, "Shared", tma_core::format::share_remaining(info.expires_at, chrono::Utc::now()));
    }
}
