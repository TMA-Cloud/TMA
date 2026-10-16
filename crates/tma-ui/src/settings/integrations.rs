//! Integrations and limits (first user only): OnlyOffice, the share link
//! address, the upload size limit, Google sign-in and Cloud Drive mode.

use egui::RichText;
use tma_core::api::GoogleAuthInput;

use super::{fetch, save, section};
use crate::app::Main;
use crate::tasks::Tasks;
use crate::widgets;

const GIB: f64 = 1024.0 * 1024.0 * 1024.0;

pub fn load(main: &mut Main, tasks: &Tasks) {
    fetch(
        tasks,
        main,
        |c| async move { c.onlyoffice_config().await },
        |s, v| {
            s.forms.onlyoffice_url = v.url.clone().unwrap_or_default();
            s.forms.onlyoffice_secret.clear();
            s.onlyoffice = Some(v);
        },
    );
    fetch(
        tasks,
        main,
        |c| async move { c.share_base_url().await },
        |s, v| {
            s.forms.share_url = v.url.clone().unwrap_or_default();
            s.share_url = Some(v);
        },
    );
    fetch(
        tasks,
        main,
        |c| async move { c.max_upload().await },
        |s, v| {
            s.forms.max_upload_gb = format!("{}", (v.max_bytes as f64 / GIB * 100.0).round() / 100.0);
            s.max_upload = Some(v);
        },
    );
    fetch(
        tasks,
        main,
        |c| async move { c.google_config().await },
        |s, v| {
            s.forms.google = GoogleAuthInput {
                client_id: v.client_id.clone().unwrap_or_default(),
                client_secret: None,
                redirect_uri: v.redirect_uri.clone().unwrap_or_default(),
                expected_version: Some(v.version),
            };
            s.google = Some(v);
        },
    );
    fetch(tasks, main, |c| async move { c.cloud_drive_config().await }, |s, v| s.cloud_drive = Some(v));
}

pub fn show(main: &mut Main, ui: &mut egui::Ui, tasks: &Tasks) {
    let t = widgets::tokens(ui);
    let busy = main.settings.busy;
    let oo_set = main.settings.onlyoffice.as_ref().is_some_and(|o| o.url.is_some() && o.jwt_secret_set);
    section(ui, "OnlyOffice", "Open and edit documents, spreadsheets and presentations in the browser.", |ui| {
        if oo_set {
            widgets::badge(ui, "Configured", t.positive_text);
            ui.add_space(6.0);
        }
        let f = &mut main.settings.forms;
        widgets::field(ui, "Document Server URL", &mut f.onlyoffice_url, false, "https://office.example.com");
        let hint =
            if oo_set { "Leave blank to keep the saved secret" } else { "The JWT secret set on the Document Server" };
        widgets::field(ui, "JWT secret", &mut f.onlyoffice_secret, true, hint);
        ui.add_space(6.0);
        let (url, secret) = (
            f.onlyoffice_url.trim().to_string(),
            Some(f.onlyoffice_secret.trim().to_string()).filter(|s| !s.is_empty()),
        );
        if widgets::primary_enabled(ui, busy.is_none(), "Save OnlyOffice").clicked() {
            save(
                tasks,
                main,
                "onlyoffice",
                move |c| async move { c.save_onlyoffice_config(&url, secret.as_deref()).await },
                |main, toasts, v| {
                    main.instance.onlyoffice = v.url.is_some() && v.jwt_secret_set;
                    main.settings.forms.onlyoffice_secret.clear();
                    main.settings.onlyoffice = Some(v);
                    toasts.success("OnlyOffice saved");
                },
            );
        }
    });
    section(
        ui,
        "Share link address",
        "Public share links use this address instead of the one people sign in at.",
        |ui| {
            widgets::field(ui, "Base URL", &mut main.settings.forms.share_url, false, "https://share.example.com");
            ui.add_space(6.0);
            let url = main.settings.forms.share_url.trim().to_string();
            if widgets::primary_enabled(ui, busy.is_none(), "Save address").clicked() {
                save(
                    tasks,
                    main,
                    "share-url",
                    move |c| async move { c.save_share_base_url(&url).await },
                    |main, toasts, v| {
                        main.settings.share_url = Some(v);
                        toasts.success("Saved");
                    },
                );
            }
        },
    );
    section(ui, "Upload limit", "The largest single file anyone can upload.", |ui| {
        ui.horizontal(|ui| {
            widgets::text_edit(ui, &mut main.settings.forms.max_upload_gb, "10", 80.0);
            ui.label("GB");
        });
        ui.add_space(6.0);
        let bytes = main
            .settings
            .forms
            .max_upload_gb
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|v| *v > 0.0)
            .map(|gb| (gb * GIB) as i64);
        if widgets::primary_enabled(ui, busy.is_none() && bytes.is_some(), "Save limit").clicked()
            && let Some(bytes) = bytes
        {
            save(
                tasks,
                main,
                "max-upload",
                move |c| async move { c.save_max_upload(bytes).await },
                |main, toasts, v| {
                    main.instance.max_upload = v.max_bytes;
                    main.settings.max_upload = Some(v);
                    toasts.success("Saved");
                },
            );
        }
    });
    let google_on = main.settings.google.as_ref().is_some_and(|g| g.configured);
    section(
        ui,
        "Google sign-in",
        "Let people sign in with their Google account. The client is verified with Google before saving.",
        |ui| {
            if google_on {
                widgets::badge(ui, "Enabled", t.positive_text);
                ui.add_space(6.0);
            }
            let g = &mut main.settings.forms.google;
            widgets::field(ui, "Client ID", &mut g.client_id, false, "1234.apps.googleusercontent.com");
            let mut secret = g.client_secret.clone().unwrap_or_default();
            if widgets::field(
                ui,
                "Client secret",
                &mut secret,
                true,
                if google_on { "Leave blank to keep the saved secret" } else { "" },
            )
            .changed()
            {
                g.client_secret = Some(secret).filter(|s| !s.is_empty());
            }
            widgets::field(
                ui,
                "Redirect URI",
                &mut g.redirect_uri,
                false,
                "https://cloud.example.com/api/google/callback",
            );
            ui.add_space(6.0);
            let input = g.clone();
            ui.horizontal(|ui| {
                if widgets::primary_enabled(ui, busy.is_none(), "Save Google sign-in").clicked() {
                    save(
                        tasks,
                        main,
                        "google",
                        move |c| async move { c.save_google_config(&input).await },
                        |main, toasts, v| {
                            main.settings.forms.google.expected_version = Some(v.version);
                            main.settings.forms.google.client_secret = None;
                            main.settings.google = Some(v);
                            toasts.success("Google sign-in saved");
                        },
                    );
                }
                if google_on && widgets::ghost(ui, RichText::new("Turn off").color(t.destructive_text)).clicked() {
                    let version = main.settings.google.as_ref().map(|g| g.version);
                    save(
                        tasks,
                        main,
                        "google",
                        move |c| async move { c.clear_google_config(version).await },
                        |main, toasts, v| {
                            main.settings.google = Some(v);
                            toasts.success("Google sign-in turned off");
                        },
                    );
                }
            });
        },
    );
    if let Some(drive) = main.settings.cloud_drive {
        section(ui, "Cloud Drive", "How the desktop app's Windows drive behaves for everyone.", |ui| {
            let mut save_only = drive.save_only;
            widgets::setting_row(
                ui,
                "Save-only drive",
                "Apps can save new files into the drive but cannot open existing ones from it.",
                |ui| {
                    if widgets::toggle(ui, &mut save_only).changed() {
                        save(
                            tasks,
                            main,
                            "cloud-drive",
                            move |c| async move { c.set_cloud_drive_save_only(save_only).await },
                            |main, toasts, v| {
                                main.settings.cloud_drive = Some(v);
                                toasts.success("Saved");
                            },
                        );
                    }
                },
            );
        });
    }
}
