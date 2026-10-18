//! Updates: the versions running here and the latest release.

use egui::RichText;

use super::parts::{self, Tone};
use super::{attempt, fetch, section};
use tma_core::api::Versions;

use crate::app::Main;
use crate::host::{Host, HostKind, UpdateMode};
use crate::icons::ph;
use crate::tasks::Tasks;
use crate::theme::Weight;
use crate::widgets;

/// The wiki the update guidance links into.
const WIKI: &str = "https://tma-cloud.github.io/Wiki/docs";

/// The release notes of `version` in the wiki's changelog.
pub fn release_notes_url(version: &str) -> String {
    format!("{WIKI}/changelog/overview?version={version}")
}

/// Read the running and latest versions once after sign-in, for the sidebar's
/// notice; a feed that cannot be reached just leaves the notice out.
pub fn check(main: &Main, tasks: &Tasks) {
    let (client, generation) = (main.client.clone(), main.generation);
    tasks.run(
        async move { (client.versions().await.ok(), client.latest_versions().await.ok()) },
        move |app, (current, latest)| {
            if let Some(main) = app.main_mut(generation) {
                main.settings.versions = current.or(main.settings.versions.take());
                main.settings.latest = latest.or(main.settings.latest.take());
            }
        },
    );
}

/// Components with a newer release, as (name, version): the server, and the
/// desktop app when running in it (the web app is the server's own build).
pub fn available(current: &Versions, latest: &Versions, desktop: bool) -> Vec<(&'static str, String)> {
    let mut out = Vec::new();
    let newer = |c: &Option<String>, l: &Option<String>| match (c, l) {
        (Some(c), Some(l)) if tma_core::is_newer_version(l, c) => Some(l.clone()),
        _ => None,
    };
    if let Some(v) = newer(&current.server, &latest.server) {
        out.push(("Server", v));
    }
    let app = Some(env!("CARGO_PKG_VERSION").to_string());
    if let Some(v) = newer(&app, &latest.desktop).filter(|_| desktop) {
        out.push(("Desktop app", v));
    }
    out
}

pub fn load(main: &mut Main, tasks: &Tasks) {
    fetch(tasks, main, |c| async move { c.versions().await }, |s, v| s.versions = Some(v));
    if main.settings.latest.is_none() {
        fetch(tasks, main, |c| async move { c.latest_versions().await }, |s, v| s.latest = Some(v));
    }
}

/// A release number, or nothing for the feed's placeholders ("unknown").
fn version(v: Option<&str>) -> Option<&str> {
    v.filter(|v| v.starts_with(|c: char| c.is_ascii_digit()) && v.chars().all(|c| c.is_ascii_digit() || c == '.'))
}

/// A component's version beside its state against the release feed.
fn row(ui: &mut egui::Ui, name: &str, current: Option<&str>, latest: Option<&str>, checking: bool) {
    let latest = version(latest);
    let description = match latest {
        Some(l) => format!("Latest available: v{l}"),
        None if checking => "Checking for updates…".into(),
        None => "Installed version".into(),
    };
    widgets::setting_row(ui, name, &description, |ui| {
        let (tone, label) = match (current, latest) {
            (None, _) => (Tone::Neutral, "Loading…"),
            (Some(_), None) => (Tone::Neutral, "Not checked"),
            (Some(c), Some(l)) if tma_core::is_newer_version(l, c) => (Tone::Warning, "Update available"),
            (Some(_), Some(_)) => (Tone::Success, "Up to date"),
        };
        parts::chip(ui, tone, label);
        if let Some(c) = current {
            ui.label(RichText::new(format!("v{c}")).semibold());
        }
    });
}

pub fn show(main: &mut Main, ui: &mut egui::Ui, tasks: &Tasks, host: &mut dyn Host) {
    let desktop = host.kind() == HostKind::Desktop;
    let mode = host.update_mode();
    let app_version = host.app_version().to_string();
    widgets::heading(ui, ph::ARROWS_CLOCKWISE, "Updates", "Installed versions and available updates.");
    if let Some(error) = &main.settings.version_error {
        ui.add_space(6.0);
        parts::note(ui, Tone::Warning, error);
    }
    let current = main.settings.versions.clone().unwrap_or_default();
    let latest = main.settings.latest.clone().unwrap_or_default();
    let checking = main.settings.busy == Some("latest");
    section(ui, "Versions", "", |ui| {
        row(ui, "Server", current.server.as_deref(), latest.server.as_deref(), checking);
        if current.web.is_some() {
            row(ui, "Web app", current.web.as_deref(), latest.web.as_deref(), checking);
        }
        if desktop {
            row(ui, "Desktop app", Some(&app_version), latest.desktop.as_deref(), checking);
        }
        let newer_app = version(latest.desktop.as_deref()).is_some_and(|l| tma_core::is_newer_version(l, &app_version));
        if let (UpdateMode::Manual(url), true) = (&mode, newer_app) {
            widgets::setting_row(ui, "Get the new version", "Download it from the releases page", |ui| {
                if widgets::secondary(ui, format!("{}  Open releases", ph::DOWNLOAD_SIMPLE)).clicked() {
                    host.open_url(url);
                }
            });
        }
    });
    let newer = available(&current, &latest, desktop);
    guidance(ui, &newer, main.instance.is_first_user, &*host);
    let note = match mode {
        UpdateMode::Automatic => {
            "The app updates itself when nothing is uploading or downloading. Your admin takes care of server updates."
        }
        UpdateMode::Manual(_) => {
            "Get new versions of the app from the releases page. Your admin takes care of server updates."
        }
        UpdateMode::None => "See if a newer version of TMA Cloud is out.",
    };
    section(ui, "", "", |ui| {
        widgets::setting_row(ui, "Check for updates", note, |ui| {
            let label =
                if checking { "Checking…".to_string() } else { format!("{}  Check now", ph::MAGNIFYING_GLASS) };
            if ui.add_enabled(!checking, egui::Button::new(label)).clicked() {
                // The app's own check also downloads and installs what it finds.
                host.check_for_update(&main.client, tasks);
                attempt(
                    tasks,
                    main,
                    "latest",
                    |c| async move { Ok((c.versions().await?, c.latest_versions().await?)) },
                    move |main, toasts, result: tma_client::ApiResult<(Versions, Versions)>| match result {
                        Ok((current, latest)) => {
                            let newer = available(&current, &latest, desktop);
                            toasts.success(if newer.is_empty() {
                                "Everything is up to date"
                            } else {
                                "Updates available"
                            });
                            main.settings.version_error = None;
                            main.settings.versions = Some(current);
                            main.settings.latest = Some(latest);
                        }
                        Err(_) => {
                            main.settings.version_error = Some("Unable to check for updates right now".into());
                            toasts.error("Failed to check for updates");
                        }
                    },
                );
            }
        });
    });
}

/// The newest version among available updates, when it is a plain release number.
fn newest<'a>(newer: &'a [(&str, String)]) -> Option<&'a str> {
    newer
        .iter()
        .filter_map(|(_, v)| version(Some(v.as_str())))
        .reduce(|a, b| if tma_core::is_newer_version(b, a) { b } else { a })
}

/// What to do about an available update: read what changed, and, for the
/// administrator who installs server updates, how to install it. Both open the
/// wiki in the browser; nothing interrupts the page to say so.
fn guidance(ui: &mut egui::Ui, newer: &[(&str, String)], is_admin: bool, host: &dyn Host) {
    let Some(newest) = newest(newer) else { return };
    let server = newer.iter().any(|(name, _)| *name == "Server");
    section(ui, &format!("Update to v{newest}"), "", |ui| {
        // Whoever cannot install a server update is told who does.
        let description = if server && !is_admin {
            "See what is new and what got fixed. Your admin takes care of updating the server."
        } else {
            "See what is new and what got fixed."
        };
        widgets::setting_row(ui, &format!("What's new in v{newest}"), description, |ui| {
            if widgets::secondary(ui, format!("{}  Release notes", ph::ARROW_SQUARE_OUT)).clicked() {
                host.open_url(&release_notes_url(newest));
            }
        });
        if server && is_admin {
            widgets::setting_row(
                ui,
                "Update your server",
                "The guide walks you through it. Your data is backed up before anything changes.",
                |ui| {
                    if widgets::secondary(ui, format!("{}  Update guide", ph::ARROW_SQUARE_OUT)).clicked() {
                        host.open_url(&format!("{WIKI}/guides/operations/updating"));
                    }
                },
            );
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn versions(server: &str, desktop: &str) -> Versions {
        Versions { server: Some(server.into()), desktop: Some(desktop.into()), ..Default::default() }
    }

    #[test]
    fn feed_placeholders_are_not_versions() {
        assert_eq!(version(Some("4.0.1")), Some("4.0.1"));
        assert_eq!(version(Some("unknown")), None);
        assert_eq!(version(None), None);
    }

    #[test]
    fn guidance_names_the_newest_release() {
        let newer = vec![("Server", "4.0.1".to_string()), ("Desktop app", "4.1.0".to_string())];
        assert_eq!(newest(&newer), Some("4.1.0"));
        assert_eq!(newest(&[("Server", "unknown".to_string())]), None);
        assert_eq!(
            release_notes_url("4.0.1"),
            "https://tma-cloud.github.io/Wiki/docs/changelog/overview?version=4.0.1"
        );
    }

    #[test]
    fn lists_only_newer_components() {
        let current = versions("4.0.0", "4.0.0");
        assert!(available(&current, &versions("4.0.0", "0.0.1"), true).is_empty());
        let latest = versions("4.2.0", "999.0.0");
        assert_eq!(
            available(&current, &latest, true),
            vec![("Server", "4.2.0".into()), ("Desktop app", "999.0.0".into())]
        );
        assert_eq!(available(&current, &latest, false), vec![("Server", "4.2.0".into())]);
    }
}
