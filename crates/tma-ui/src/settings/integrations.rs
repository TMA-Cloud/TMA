//! Integrations (first user only), each a collapsible card: Google sign-in,
//! OnlyOffice and the share link address.

use egui::RichText;
use tma_core::api::GoogleAuthInput;

use super::parts::{self, FormAction, Tone};
use super::{fetch, forms, save};
use crate::app::Main;
use crate::icons::ph;
use crate::tasks::Tasks;
use crate::widgets;

pub fn load(main: &mut Main, tasks: &Tasks) {
    fetch(tasks, main, |c| async move { c.onlyoffice_config().await }, |s, v| s.onlyoffice = Some(v));
    fetch(tasks, main, |c| async move { c.share_base_url().await }, |s, v| s.share_url = Some(v));
    fetch(tasks, main, |c| async move { c.google_config().await }, |s, v| s.google = Some(v));
}

pub fn show(main: &mut Main, ui: &mut egui::Ui, tasks: &Tasks) {
    google(main, ui, tasks);
    onlyoffice(main, ui, tasks);
    share_url(main, ui, tasks);
}

fn google(main: &mut Main, ui: &mut egui::Ui, tasks: &Tasks) {
    let summary = main.settings.google.clone();
    let configured = summary.as_ref().is_some_and(|g| g.configured);
    let status =
        summary.as_ref().map(|_| if configured { (Tone::Success, "On".into()) } else { (Tone::Info, "Off".into()) });
    let open = main.settings.open.contains("google");
    let busy = main.settings.busy == Some("google");
    let mut action = None;
    let mut turn_off = false;
    let clicked = parts::config_card(
        ui,
        ph::SIGN_IN,
        "Google sign-in",
        "Let people sign in with their Google account",
        status,
        open,
        |ui| {
            let f = &mut main.settings.forms;
            widgets::field(ui, "Authorized redirect URI", &mut f.google.redirect_uri, false, "");
            parts::hint(
                ui,
                "In Google Cloud, create an OAuth client of type Web application and add this exact URI under Authorized redirect URIs. Google allows plain http only for localhost.",
            );
            widgets::field(
                ui,
                "Client ID",
                &mut f.google.client_id,
                false,
                "123456789-abc123.apps.googleusercontent.com",
            );
            parts::hint(ui, "Ends in .apps.googleusercontent.com");
            parts::secret_field(
                ui,
                "Client secret",
                &mut f.google_secret,
                if configured { "Saved" } else { "GOCSPX-…" },
            );
            parts::hint(
                ui,
                if configured {
                    "Leave empty to keep the saved secret. It is stored encrypted and never shown again."
                } else {
                    "Stored encrypted and never shown again."
                },
            );
            if let Some(at) = summary.as_ref().filter(|_| configured).and_then(|g| g.updated_at) {
                parts::readonly(ui, "Last changed", &tma_core::format::full_date(at), "");
            }
            ui.label(widgets::muted(ui, "Saving checks the client ID and secret with Google first. Accounts that sign in with Google for the first time are created only while signup is allowed.").size(12.0));
            ui.horizontal(|ui| {
                if configured {
                    let t = widgets::tokens(ui);
                    let label = if busy { "Turning off…" } else { "Turn off Google sign-in" };
                    turn_off = ui
                        .add_enabled(!busy, egui::Button::new(RichText::new(label).color(t.destructive_text)))
                        .clicked();
                }
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    action = parts::form_actions(ui, busy, "Check and save", "Checking…");
                });
            });
        },
    );
    if clicked && main.settings.toggle_card("google") {
        let g = summary.clone().unwrap_or_default();
        main.settings.forms.google = GoogleAuthInput {
            client_id: g.client_id.unwrap_or_default(),
            client_secret: None,
            redirect_uri: g.redirect_uri.unwrap_or_else(|| forms::redirect_uri_for(main.client.base_url())),
            expected_version: Some(g.version),
        };
        main.settings.forms.google_secret.clear();
    }
    if turn_off {
        let version = summary.as_ref().map(|g| g.version);
        save(
            tasks,
            main,
            "google",
            move |c| async move { c.clear_google_config(version).await },
            |main, toasts, v| {
                main.settings.google = Some(v);
                main.settings.open.remove("google");
                toasts.success("Google sign-in is off");
            },
        );
    }
    match action {
        Some(FormAction::Cancel) => {
            main.settings.open.remove("google");
        }
        Some(FormAction::Save) => {
            let f = &main.settings.forms;
            let input = GoogleAuthInput {
                client_id: f.google.client_id.trim().to_string(),
                client_secret: Some(f.google_secret.trim().to_string()).filter(|s| !s.is_empty()),
                redirect_uri: f.google.redirect_uri.trim().to_string(),
                expected_version: summary.as_ref().map(|g| g.version),
            };
            save(
                tasks,
                main,
                "google",
                move |c| async move { c.save_google_config(&input).await },
                |main, toasts, v| {
                    main.settings.google = Some(v);
                    main.settings.forms.google_secret.clear();
                    main.settings.open.remove("google");
                    toasts.success("Google sign-in is on");
                },
            );
        }
        None => {}
    }
}

fn onlyoffice(main: &mut Main, ui: &mut egui::Ui, tasks: &Tasks) {
    let summary = main.settings.onlyoffice.clone();
    let configured = summary.as_ref().is_some_and(|o| o.url.is_some() && o.jwt_secret_set);
    let status = summary
        .as_ref()
        .map(|_| if configured { (Tone::Success, "Configured".into()) } else { (Tone::Info, "Not set up".into()) });
    let open = main.settings.open.contains("onlyoffice");
    let busy = main.settings.busy == Some("onlyoffice");
    let mut action = None;
    let description = "Edit and view documents, spreadsheets and presentations in the browser";
    let clicked = parts::config_card(ui, ph::FILE_TEXT, "OnlyOffice", description, status, open, |ui| {
        if configured {
            parts::note(
                ui,
                Tone::Info,
                "To update, enter both the URL and the JWT secret again. To turn it off, clear both fields.",
            );
            ui.add_space(4.0);
        }
        let f = &mut main.settings.forms;
        widgets::field(ui, "Document Server URL", &mut f.onlyoffice_url, false, "https://documentserver.example.com");
        parts::hint(ui, "Base URL of your OnlyOffice Document Server");
        parts::secret_field(ui, "JWT secret", &mut f.onlyoffice_secret, "Enter JWT secret");
        parts::hint(ui, "Secret key for signing OnlyOffice requests");
        action = parts::form_actions(ui, busy, "Save", "Saving…");
    });
    if clicked && main.settings.toggle_card("onlyoffice") {
        main.settings.forms.onlyoffice_url = summary.and_then(|o| o.url).unwrap_or_default();
        main.settings.forms.onlyoffice_secret.clear();
    }
    match action {
        Some(FormAction::Cancel) => {
            main.settings.open.remove("onlyoffice");
        }
        Some(FormAction::Save) => {
            let f = &main.settings.forms;
            let url = f.onlyoffice_url.trim().to_string();
            let secret = Some(f.onlyoffice_secret.trim().to_string()).filter(|s| !s.is_empty());
            save(
                tasks,
                main,
                "onlyoffice",
                move |c| async move { c.save_onlyoffice_config(&url, secret.as_deref()).await },
                |main, toasts, v| {
                    let on = v.url.is_some() && v.jwt_secret_set;
                    main.instance.onlyoffice = on;
                    main.settings.forms.onlyoffice_secret.clear();
                    main.settings.onlyoffice = Some(v);
                    main.settings.open.remove("onlyoffice");
                    toasts.success(if on { "OnlyOffice saved" } else { "OnlyOffice turned off" });
                },
            );
        }
        None => {}
    }
}

fn share_url(main: &mut Main, ui: &mut egui::Ui, tasks: &Tasks) {
    let saved = main.settings.share_url.clone();
    let url = saved.as_ref().and_then(|s| s.url.clone()).filter(|u| !u.is_empty());
    let status = saved.as_ref().map(|_| match &url {
        Some(_) => (Tone::Success, "Configured".to_string()),
        None => (Tone::Info, "Using sign-in address".to_string()),
    });
    let open = main.settings.open.contains("share");
    let busy = main.settings.busy == Some("share-url");
    let mut action = None;
    let clicked = parts::config_card(
        ui,
        ph::LINK,
        "Share link address",
        "A custom base URL for public share links",
        status,
        open,
        |ui| {
            widgets::field(
                ui,
                "Share base URL",
                &mut main.settings.forms.share_url,
                false,
                "https://share.example.com",
            );
            parts::hint(
                ui,
                "Public share links use this address. Leave it empty to use the address people sign in at.",
            );
            action = parts::form_actions(ui, busy, "Save", "Saving…");
        },
    );
    if clicked && main.settings.toggle_card("share") {
        main.settings.forms.share_url = url.unwrap_or_default();
    }
    match action {
        Some(FormAction::Cancel) => {
            main.settings.open.remove("share");
        }
        Some(FormAction::Save) => {
            let url = main.settings.forms.share_url.trim().to_string();
            save(
                tasks,
                main,
                "share-url",
                move |c| async move { c.save_share_base_url(&url).await },
                |main, toasts, v| {
                    main.settings.share_url = Some(v);
                    main.settings.open.remove("share");
                    toasts.success("Share link address saved");
                },
            );
        }
        None => {}
    }
}
