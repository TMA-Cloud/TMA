//! About: what this app is, the versions running, where to read more, and the legal pages.

use egui::{CornerRadius, Frame, Margin, RichText, Stroke, TextureHandle, Ui};

use super::parts::{self, Tone};
use super::{fetch, section};
use crate::app::Main;
use crate::host::{Host, HostKind};
use crate::icons::{self, ph};
use crate::links;
use crate::tasks::Tasks;
use crate::theme::{self, Weight};
use crate::widgets;

/// The year the copyright begins and who holds it, as in LICENSE.
const COPYRIGHT_SINCE: i32 = 2025;
const COPYRIGHT_HOLDER: &str = "Zinadin Zidan and TMA Cloud contributors";

pub fn load(main: &mut Main, tasks: &Tasks) {
    if main.settings.versions.is_none() {
        fetch(tasks, main, |c| async move { c.versions().await }, |s, v| s.versions = Some(v));
    }
}

pub fn show(main: &mut Main, ui: &mut Ui, tasks: &Tasks, host: &mut dyn Host) {
    let version = host.app_version().to_string();
    let platform = platform(host.kind());
    let server = main.settings.versions.as_ref().and_then(|v| v.server.clone());
    widgets::heading(ui, ph::INFO, "About", "Version, support and legal information.");
    ui.add_space(16.0);
    banner(ui, &version);

    section(ui, "App information", "", |ui| {
        value_row(ui, "Platform", "", &platform);
        let address = main.client.base_url().to_string();
        let server_label = server.as_deref().map_or_else(|| "Loading…".to_string(), |v| format!("v{v}"));
        value_row(ui, "Server", &address, &server_label);
        widgets::setting_row(
            ui,
            "Troubleshooting info",
            "Copy your versions and platform to include in a bug report.",
            |ui| {
                if widgets::secondary(ui, format!("{}  Copy details", ph::COPY)).clicked() {
                    ui.ctx().copy_text(details(&version, &platform, server.as_deref()));
                    tasks.run(async {}, |app, ()| app.toasts.success("Details copied"));
                }
            },
        );
    });

    section(ui, "Learn more", "", |ui| {
        link_row(ui, host, ("Documentation", "Guides for using and running TMA Cloud."), "Open wiki", links::WIKI);
        let notes = links::release_notes(&version);
        link_row(ui, host, ("What's new", "See what changed in this version."), "Release notes", &notes);
        link_row(ui, host, ("TMA Cloud on GitHub", "Source code and releases."), "GitHub", links::ORG);
        link_row(ui, host, ("Report a problem", "Found a bug? Let us know on GitHub."), "Report issue", links::ISSUES);
    });

    section(ui, "Legal", "", |ui| {
        let privacy = links::privacy_policy();
        link_row(ui, host, ("Privacy Policy", "How your data is handled."), "Read", &privacy);
        let terms = links::terms_of_use();
        link_row(ui, host, ("Terms of Use", "The rules for using TMA Cloud."), "Read", &terms);
        link_row(ui, host, ("License", "Free and open source under the MIT License."), "View", links::LICENSE);
    });

    ui.add_space(20.0);
    let t = widgets::tokens(ui);
    ui.vertical_centered(|ui| {
        // The clock's year, so the notice never needs a yearly edit.
        let year = chrono::Datelike::year(&chrono::Local::now());
        ui.label(RichText::new(copyright(year)).size(12.0).color(t.label_tertiary));
    });
}

/// The app's icon, name, what it is and its version, on an accent-tinted card.
fn banner(ui: &mut Ui, version: &str) {
    let t = widgets::tokens(ui);
    let card = Frame::new()
        .fill(theme::mix(t.surface, t.accent, 0.10))
        .stroke(Stroke::new(1.0, theme::mix(t.separator, t.accent, 0.30)))
        .corner_radius(CornerRadius::same(16))
        .inner_margin(Margin::same(24));
    card.show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.horizontal(|ui| {
            app_icon(ui, 76.0);
            ui.add_space(12.0);
            ui.vertical(|ui| {
                ui.spacing_mut().item_spacing.y = 4.0;
                ui.add_space(2.0);
                ui.label(RichText::new("TMA Cloud").size(26.0).semibold().color(t.label));
                ui.label(
                    RichText::new("Open-source cloud storage you host yourself.").size(14.0).color(t.label_secondary),
                );
                ui.add_space(4.0);
                parts::chip(ui, Tone::Neutral, &format!("Version {version}"));
            });
        });
    });
}

/// The app icon the installers and the browser tab use, decoded once; the
/// painted mark stands in if it cannot be.
fn app_icon(ui: &mut Ui, size: f32) {
    let key = egui::Id::unique("about-app-icon");
    // Loaded outside data_mut: loading a texture locks the context again.
    let texture = match ui.data(|d| d.get_temp::<Option<TextureHandle>>(key)) {
        Some(texture) => texture,
        None => {
            let texture = decode_icon()
                .map(|pixels| ui.ctx().load_texture("about-app-icon", pixels, egui::TextureOptions::LINEAR));
            ui.data_mut(|d| d.insert_temp(key, texture.clone()));
            texture
        }
    };
    let corner = CornerRadius::same((size * 0.22) as u8);
    match texture {
        Some(texture) => {
            ui.add(egui::Image::new((texture.id(), egui::vec2(size, size))).corner_radius(corner));
        }
        None => {
            let (rect, _) = ui.allocate_exact_size(egui::vec2(size, size), egui::Sense::hover());
            icons::logo(ui.painter(), rect, &widgets::tokens(ui));
        }
    }
}

fn decode_icon() -> Option<egui::ColorImage> {
    let image = image::load_from_memory(include_bytes!("../../../../apps/tma-cloud-web/public/tma-192.png")).ok()?;
    let rgba = image.to_rgba8();
    Some(egui::ColorImage::from_rgba_unmultiplied([rgba.width() as usize, rgba.height() as usize], rgba.as_raw()))
}

/// A row that states a value on its right.
fn value_row(ui: &mut Ui, title: &str, description: &str, value: &str) {
    widgets::setting_row(ui, title, description, |ui| {
        ui.label(RichText::new(value).semibold());
    });
}

/// A row whose button opens a page in the browser.
fn link_row(ui: &mut Ui, host: &dyn Host, (title, description): (&str, &str), button: &str, url: &str) {
    widgets::setting_row(ui, title, description, |ui| {
        if widgets::secondary(ui, format!("{}  {button}", ph::ARROW_SQUARE_OUT)).clicked() {
            host.open_url(url);
        }
    });
}

/// Where this copy of the app runs, in words.
fn platform(kind: HostKind) -> String {
    match kind {
        HostKind::Desktop => {
            let os = match std::env::consts::OS {
                "windows" => "Windows",
                "macos" => "macOS",
                "linux" => "Linux",
                other => other,
            };
            format!("Desktop app on {os} ({})", std::env::consts::ARCH)
        }
        HostKind::Web => "Web app in your browser".to_string(),
    }
}

/// What a bug report needs to know, without the server's address.
fn details(version: &str, platform: &str, server: Option<&str>) -> String {
    let server = server.map_or_else(|| "Server version unknown".to_string(), |v| format!("Server v{v}"));
    format!("TMA Cloud v{version}\n{platform}\n{server}")
}

/// The copyright line: a range up to `year`, or the first year alone (also
/// when a wrong clock says it is earlier).
fn copyright(year: i32) -> String {
    if year > COPYRIGHT_SINCE {
        format!("© {COPYRIGHT_SINCE}–{year} {COPYRIGHT_HOLDER}")
    } else {
        format!("© {COPYRIGHT_SINCE} {COPYRIGHT_HOLDER}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copyright_runs_to_this_year() {
        assert_eq!(copyright(2026), "© 2025–2026 Zinadin Zidan and TMA Cloud contributors");
        assert_eq!(copyright(2025), "© 2025 Zinadin Zidan and TMA Cloud contributors");
        assert_eq!(copyright(2001), "© 2025 Zinadin Zidan and TMA Cloud contributors");
    }

    #[test]
    fn details_name_versions_and_platform() {
        let text = details("4.0.0", "Desktop app on Windows (x86_64)", Some("4.0.1"));
        assert_eq!(text, "TMA Cloud v4.0.0\nDesktop app on Windows (x86_64)\nServer v4.0.1");
        assert!(details("4.0.0", "Web app in your browser", None).ends_with("Server version unknown"));
        assert_eq!(platform(HostKind::Web), "Web app in your browser");
    }
}
