//! Administration (first user only): figures first, then policies, people
//! and devices, session and activity settings, networking, integrations, and
//! maintenance last in its own frame.

use egui::RichText;

use super::dialogs::Dialog;
use super::parts;
use super::{attempt, fetch, section};
use crate::app::Main;
use crate::icons::ph;
use crate::tasks::Tasks;
use crate::widgets;

pub fn load(main: &mut Main, tasks: &Tasks) {
    fetch(tasks, main, |c| async move { c.signup_status().await }, |s, v| s.signup = Some(v));
    fetch(tasks, main, |c| async move { c.active_clients().await }, |s, v| s.clients = Some(v));
    fetch(tasks, main, |c| async move { c.known_proxies().await }, |s, v| s.proxies = Some(v));
    fetch(tasks, main, |c| async move { c.activity_settings().await }, |s, v| s.activity = Some(v));
    fetch(tasks, main, |c| async move { c.cloud_drive_config().await }, |s, v| s.cloud_drive = Some(v));
    super::integrations::load(main, tasks);
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Policy {
    Signup,
    Password,
    Extensions,
    DesktopOnly,
    SaveOnly,
}

impl Policy {
    fn toast(self, on: bool) -> &'static str {
        match (self, on) {
            (Policy::Signup, true) => "Sign-up turned on",
            (Policy::Signup, false) => "Sign-up turned off",
            (Policy::Password, true) => "Password changes turned on",
            (Policy::Password, false) => "Password changes turned off",
            (Policy::Extensions, true) => "File extensions hidden",
            (Policy::Extensions, false) => "File extensions visible",
            (Policy::DesktopOnly, true) => "Browser sign-in turned off",
            (Policy::DesktopOnly, false) => "Browser sign-in turned on",
            (Policy::SaveOnly, true) => "Cloud Drive set to save-only",
            (Policy::SaveOnly, false) => "Cloud Drive set to full access",
        }
    }
}

/// Read or write one policy in the loaded state.
fn policy_value(main: &mut Main, policy: Policy, set: Option<bool>) -> Option<bool> {
    if policy == Policy::SaveOnly {
        let drive = main.settings.cloud_drive.as_mut()?;
        if let Some(v) = set {
            drive.save_only = v;
        }
        return Some(drive.save_only);
    }
    let s = main.settings.signup.as_mut()?;
    let field = match policy {
        Policy::Signup => &mut s.signup_enabled,
        Policy::Password => &mut s.allow_password_change,
        Policy::Extensions => &mut s.hide_file_extensions,
        _ => &mut s.desktop_only,
    };
    if let Some(v) = set {
        *field = v;
    }
    Some(*field)
}

/// One switch: flips at once, saves, and flips back if the server refuses.
fn policy(
    main: &mut Main,
    ui: &mut egui::Ui,
    tasks: &Tasks,
    policy: Policy,
    title: &str,
    description: &str,
    allowed: bool,
) {
    let Some(mut value) = policy_value(main, policy, None) else {
        widgets::setting_row(ui, title, description, |ui| {
            ui.spinner();
        });
        return;
    };
    let busy = main.settings.busy == Some("policy");
    let mut changed = false;
    widgets::setting_row(ui, title, description, |ui| {
        ui.add_enabled_ui(allowed && !busy, |ui| {
            changed = widgets::toggle_with_id(ui, egui::Id::unique(("policy", title)), &mut value).changed()
        });
    });
    if !changed {
        return;
    }
    policy_value(main, policy, Some(value));
    if policy == Policy::Extensions {
        main.instance.hide_extensions = value;
    }
    attempt(
        tasks,
        main,
        "policy",
        move |c| async move {
            match policy {
                Policy::Signup => c.set_signup(value).await.map(|_| ()),
                Policy::Password => c.set_password_change(value).await.map(|_| ()),
                Policy::Extensions => c.set_hide_extensions(value).await.map(|_| ()),
                Policy::DesktopOnly => c.set_desktop_only(value).await.map(|_| ()),
                Policy::SaveOnly => c.set_cloud_drive_save_only(value).await.map(|_| ()),
            }
        },
        move |main, toasts, result| match result {
            Ok(()) => toasts.success(policy.toast(value)),
            Err(err) => {
                policy_value(main, policy, Some(!value));
                if policy == Policy::Extensions {
                    main.instance.hide_extensions = !value;
                }
                toasts.error(err.message);
            }
        },
    );
}

fn stats(main: &Main, ui: &mut egui::Ui) {
    let status = main.settings.signup.as_ref();
    let width = parts::tile_width(ui, 3);
    ui.horizontal_wrapped(|ui| {
        let total = status.map(|s| s.total_users.map_or("Unavailable".into(), |n| n.to_string()));
        parts::stat(ui, width, ph::USERS, "Total users", total, "Including your account");
        let other = status.map(|s| match s.additional_users {
            Some(0) => "None yet".into(),
            Some(n) => n.to_string(),
            None => "Unavailable".into(),
        });
        let open = status.is_some_and(|s| s.signup_enabled);
        parts::stat(
            ui,
            width,
            ph::USER_PLUS,
            "Other users",
            other,
            if open { "Sign-up is on" } else { "Sign-up is off" },
        );
        let clients = main.settings.clients.as_ref().map(|c| match c.clients.len() {
            0 => "None online".to_string(),
            n => n.to_string(),
        });
        parts::stat(ui, width, ph::DESKTOP, "Active desktop clients", clients, "Active in the last 5 minutes");
    });
}

pub fn show(main: &mut Main, ui: &mut egui::Ui, tasks: &Tasks, desktop: bool) {
    widgets::heading(
        ui,
        ph::GEAR_SIX,
        "Administration",
        "Users, policies, integrations and maintenance for this server",
    );
    ui.add_space(8.0);
    stats(main, ui);
    let s = main.settings.signup.clone().unwrap_or_default();
    section(ui, "Policies", "These apply to everyone on this server", |ui| {
        policy(
            main,
            ui,
            tasks,
            Policy::Signup,
            "Allow sign-up",
            "Anyone who can reach this server can create an account",
            s.can_toggle,
        );
        let password = "Users can change their password from the Security page";
        policy(
            main,
            ui,
            tasks,
            Policy::Password,
            "Allow password changes",
            password,
            s.can_toggle_allow_password_change,
        );
        // Turned on from a browser it would lock that browser out at once.
        let desktop_only = s.can_toggle_desktop_only && (desktop || s.desktop_only);
        let note = if desktop {
            "Only the desktop app can sign in. Public share links stay available."
        } else {
            "Only the desktop app can sign in. Turn this on from the desktop app."
        };
        policy(main, ui, tasks, Policy::DesktopOnly, "Desktop app only", note, desktop_only);
        let ext = "Show file names without extensions such as .pdf or .docx";
        policy(main, ui, tasks, Policy::Extensions, "Hide file extensions", ext, s.can_toggle_hide_file_extensions);
        let drive = "Other apps can save to Cloud Drive but can't open or copy files from it";
        let can = main.settings.cloud_drive.is_some_and(|d| d.can_configure);
        policy(main, ui, tasks, Policy::SaveOnly, "Cloud Drive save-only", drive, can);
    });
    let mut open = None;
    section(ui, "Users and devices", "", |ui| {
        widgets::setting_row(ui, "Registered users", "Every account with its storage use and limit", |ui| {
            if widgets::secondary(ui, format!("{}  Show all users", ph::USERS_THREE)).clicked() {
                open = Some(Dialog::Users);
            }
        });
        let description = "Desktop apps active in the last 5 minutes";
        widgets::setting_row(ui, "Active desktop clients", description, |ui| {
            if widgets::secondary(ui, format!("{}  View clients", ph::DESKTOP)).clicked() {
                open = Some(Dialog::Clients);
            }
        });
    });
    match open {
        Some(Dialog::Users) => super::dialogs_admin::load_users(main, tasks),
        Some(Dialog::Clients) => super::dialogs_admin::load_clients(main, tasks),
        _ => {}
    }
    if open.is_some() {
        main.settings.dialog = open;
    }
    section(ui, "Sessions and activity", "", |ui| {
        super::admin_activity::session_card(main, ui, tasks);
        super::admin_activity::access_card(main, ui, tasks);
    });
    section(ui, "Network", "", |ui| {
        super::admin_activity::proxies_card(main, ui, tasks);
    });
    section(ui, "Integrations", "", |ui| {
        super::integrations::show(main, ui, tasks);
    });
    parts::danger_group(
        ui,
        "Maintenance",
        "These actions delete data for good. Check the results carefully before you confirm.",
        |ui| {
            let description = "Find stored data without a file record, and file records without stored data";
            widgets::setting_row(ui, "Orphaned files", description, |ui| {
                let t = widgets::tokens(ui);
                let label = RichText::new(format!("{}  Review orphans", ph::TRASH)).color(t.destructive_text);
                if ui.button(label).clicked() {
                    main.settings.orphans = None;
                    main.settings.dialog = Some(Dialog::Orphans(Default::default()));
                }
            });
        },
    );
}
