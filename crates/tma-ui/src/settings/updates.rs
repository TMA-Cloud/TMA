//! Updates: the versions running here and the latest release.

use egui::RichText;

use super::{fetch, save, section};
use crate::app::Main;
use crate::icons::ph;
use crate::tasks::Tasks;
use crate::theme::Weight;
use crate::widgets;

pub fn load(main: &mut Main, tasks: &Tasks) {
    fetch(tasks, main, |c| async move { c.versions().await }, |s, v| s.versions = Some(v));
}

fn row(ui: &mut egui::Ui, name: &str, description: &str, current: Option<&str>, latest: Option<&str>) {
    let t = widgets::tokens(ui);
    widgets::setting_row(ui, name, description, |ui| {
        match (current, latest) {
            (Some(c), Some(l)) if tma_core::is_newer_version(l, c) => {
                widgets::badge(ui, &format!("{l} available"), t.warning_text);
            }
            (Some(_), Some(_)) => {
                widgets::badge(ui, "Up to date", t.positive_text);
            }
            _ => {}
        }
        ui.label(RichText::new(current.map(|c| format!("v{c}")).unwrap_or_else(|| "—".into())).semibold());
    });
}

pub fn show(main: &mut Main, ui: &mut egui::Ui, tasks: &Tasks, app_version: &str) {
    widgets::heading(ui, ph::ARROWS_CLOCKWISE, "Updates", "What is running and whether a newer release exists.");
    ui.add_space(12.0);
    let current = main.settings.versions.clone().unwrap_or_default();
    let latest = main.settings.latest.clone();
    section(ui, "Components", "", |ui| {
        row(
            ui,
            "Server",
            "The API and web app on this server.",
            current.backend.as_deref(),
            latest.as_ref().and_then(|l| l.backend.as_deref()),
        );
        row(
            ui,
            "This app",
            "The app you are using now.",
            Some(app_version),
            latest.as_ref().and_then(|l| l.desktop.as_deref().or(l.frontend.as_deref())),
        );
    });
    let checking = main.settings.busy == Some("latest");
    section(ui, "Update check", "Compares against the published release list.", |ui| {
        if widgets::secondary(
            ui,
            if checking { "Checking…".to_string() } else { format!("{}  Check for updates", ph::ARROWS_CLOCKWISE) },
        )
        .clicked()
            && !checking
        {
            save(
                tasks,
                main,
                "latest",
                |c| async move { c.latest_versions().await },
                |main, _, v| main.settings.latest = Some(v),
            );
        }
    });
}
