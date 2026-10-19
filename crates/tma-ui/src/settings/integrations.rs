//! Integrations (first user only), each a collapsible card: OnlyOffice and
//! the share link address.

use super::parts::{self, FormAction, Tone};
use super::{fetch, save};
use crate::app::Main;
use crate::icons::ph;
use crate::tasks::Tasks;
use crate::widgets;

pub fn load(main: &mut Main, tasks: &Tasks) {
    fetch(tasks, main, |c| async move { c.onlyoffice_config().await }, |s, v| s.onlyoffice = Some(v));
    fetch(tasks, main, |c| async move { c.share_base_url().await }, |s, v| s.share_url = Some(v));
}

pub fn show(main: &mut Main, ui: &mut egui::Ui, tasks: &Tasks) {
    onlyoffice(main, ui, tasks);
    share_url(main, ui, tasks);
}

fn onlyoffice(main: &mut Main, ui: &mut egui::Ui, tasks: &Tasks) {
    let summary = main.settings.onlyoffice.clone();
    let configured = summary.as_ref().is_some_and(|o| o.url.is_some() && o.jwt_secret_set);
    let status = summary
        .as_ref()
        .map(|_| if configured { (Tone::Success, "Set up".into()) } else { (Tone::Info, "Not set up".into()) });
    let open = main.settings.open.contains("onlyoffice");
    let busy = main.settings.busy == Some("onlyoffice");
    let mut action = None;
    let description = "View and edit documents, spreadsheets and presentations in the browser";
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
        parts::hint(ui, "The address of your OnlyOffice Document Server");
        parts::secret_field(ui, "JWT secret", &mut f.onlyoffice_secret, "Enter JWT secret");
        parts::hint(ui, "The secret OnlyOffice uses to sign its requests");
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
        Some(_) => (Tone::Success, "Set up".to_string()),
        None => (Tone::Info, "Server address".to_string()),
    });
    let open = main.settings.open.contains("share");
    let busy = main.settings.busy == Some("share-url");
    let mut action = None;
    let clicked = parts::config_card(
        ui,
        ph::LINK,
        "Share link address",
        "Use a separate address for public share links",
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
            parts::hint(ui, "Public share links use this address. Leave it empty to use the server address.");
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
