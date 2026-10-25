//! How the app looks on this device: light or dark, and how large it draws.

use egui::RichText;

use crate::app::Prefs;
use crate::icons::ph;
use crate::theme::{TextSize, ThemeChoice};
use crate::widgets::{self, row_frame, setting_row};

use super::section;

/// A sample of what file names look like: codes, and letters other faces mix up.
const SAMPLE: &str = "Quarterly Plan QP_K482-ZT0715.xlsx  ·  Il1 O0 5S 8B";

pub fn show(prefs: &mut Prefs, ui: &mut egui::Ui) {
    widgets::heading(ui, ph::TEXT_AA, "Appearance", "How TMA Cloud looks on this device");
    section(ui, "Display", "", |ui| {
        setting_row(ui, "Theme", "Light, dark, or the same as your system", |ui| {
            for (choice, label) in
                [(ThemeChoice::Dark, "Dark"), (ThemeChoice::Light, "Light"), (ThemeChoice::System, "System")]
            {
                ui.selectable_value(&mut prefs.theme, choice, label);
            }
        });
        setting_row(ui, "Text size", "Text, icons and spacing grow or shrink together", |ui| {
            for size in TextSize::ALL.iter().rev() {
                ui.selectable_value(&mut prefs.text_size, *size, size.label());
            }
        });
        row_frame(ui).show(ui, |ui| {
            ui.set_width(ui.available_width());
            let t = widgets::tokens(ui);
            ui.label(RichText::new(SAMPLE).size(15.0).color(t.label));
        });
    });
}
