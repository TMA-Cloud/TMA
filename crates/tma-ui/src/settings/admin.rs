//! Administration (first user only): figures first, then policies, people
//! and devices, session and activity settings, networking, integrations, and
//! maintenance last in its own frame.

use egui::RichText;
use tma_core::api::ActivitySettings;

use super::dialogs::Dialog;
use super::parts::{self, FormAction, Tone};
use super::{attempt, fetch, forms, section};
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
        _ => &mut s.electron_only_access,
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
            changed = widgets::toggle_with_id(ui, egui::Id::new(("policy", title)), &mut value).changed()
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
        "Users, policies, integrations and maintenance for this server.",
    );
    ui.add_space(8.0);
    stats(main, ui);
    let s = main.settings.signup.clone().unwrap_or_default();
    section(ui, "Policies", "These apply to every user on this server.", |ui| {
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
        let desktop_only = s.can_toggle_electron_only_access && (desktop || s.electron_only_access);
        let note = if desktop {
            "Only the desktop app can sign in. Public share links stay available."
        } else {
            "Only the desktop app can sign in. Turn this on from the desktop app."
        };
        policy(main, ui, tasks, Policy::DesktopOnly, "Desktop app only", note, desktop_only);
        let ext = "Display file names without their extensions";
        policy(main, ui, tasks, Policy::Extensions, "Hide file extensions", ext, s.can_toggle_hide_file_extensions);
        let drive = "Other apps can save to Cloud Drive but cannot open or copy files from it";
        let can = main.settings.cloud_drive.is_some_and(|d| d.can_configure);
        policy(main, ui, tasks, Policy::SaveOnly, "Cloud Drive save-only", drive, can);
    });
    let mut open = None;
    section(ui, "Users and devices", "Accounts on this server and connected desktop apps.", |ui| {
        widgets::setting_row(ui, "Registered users", "All accounts with their storage use and limits", |ui| {
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
    section(ui, "Sessions and activity", "Session length and file access tracking.", |ui| {
        session_card(main, ui, tasks);
        access_card(main, ui, tasks);
    });
    section(ui, "Network", "Settings for running behind a reverse proxy.", |ui| {
        proxies_card(main, ui, tasks);
    });
    section(ui, "Integrations", "Services connected to this server.", |ui| {
        super::integrations::show(main, ui, tasks);
    });
    parts::danger_group(
        ui,
        "Maintenance",
        "These actions permanently delete data. Review the results carefully before you confirm.",
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

fn session_card(main: &mut Main, ui: &mut egui::Ui, tasks: &Tasks) {
    let status = main.settings.activity.map(|a| (Tone::Neutral, forms::plural(i64::from(a.session_idle_days), "day")));
    let open = main.settings.open.contains("session");
    let busy = main.settings.busy == Some("session-timeout");
    let mut action = None;
    let clicked = parts::config_card(
        ui,
        ph::CLOCK,
        "Session timeout",
        "Sign users out after a period of inactivity",
        status,
        open,
        |ui| {
            let (min, max) = ActivitySettings::IDLE_DAYS;
            widgets::field(ui, "Days without activity", &mut main.settings.forms.idle_days, false, "30");
            parts::hint(
                ui,
                &format!(
                    "{min} to {max} days. Any activity resets the timer, so active users stay signed in. A shorter timeout also applies to existing sessions."
                ),
            );
            action = parts::form_actions(ui, busy, "Save", "Saving…");
        },
    );
    if clicked
        && main.settings.toggle_card("session")
        && let Some(a) = main.settings.activity
    {
        main.settings.forms.idle_days = a.session_idle_days.to_string();
    }
    match action {
        Some(FormAction::Cancel) => {
            main.settings.open.remove("session");
        }
        Some(FormAction::Save) => {
            match forms::whole_number(&main.settings.forms.idle_days, ActivitySettings::IDLE_DAYS, "Session timeout") {
                Err(e) => main.settings.report(e),
                Ok(days) => super::save(
                    tasks,
                    main,
                    "session-timeout",
                    move |c| async move { c.save_session_timeout(days).await },
                    |main, toasts, v| {
                        main.settings.activity = Some(v);
                        main.settings.open.remove("session");
                        toasts.success("Session timeout saved");
                    },
                ),
            }
        }
        None => {}
    }
}

fn access_card(main: &mut Main, ui: &mut egui::Ui, tasks: &Tasks) {
    let status = main.settings.activity.map(|a| {
        let tone = if a.access_time_tracking { Tone::Neutral } else { Tone::Warning };
        (tone, forms::access_time_label(a.access_time_tracking, a.access_time_window_minutes))
    });
    let open = main.settings.open.contains("access");
    let busy = main.settings.busy == Some("access-time");
    let mut action = None;
    let clicked = parts::config_card(
        ui,
        ph::CLOCK_COUNTER_CLOCKWISE,
        "Last opened tracking",
        "Record when files and folders are opened",
        status,
        open,
        |ui| {
            let f = &mut main.settings.forms;
            ui.checkbox(&mut f.access_enabled, "Record when items are opened");
            parts::hint(ui, "When off, Recent files and Last opened dates are no longer updated.");
            let (wmin, wmax) = ActivitySettings::WINDOW_MINUTES;
            let (fmin, fmax) = ActivitySettings::FLUSH_SECONDS;
            ui.add_enabled_ui(f.access_enabled, |ui| {
            widgets::field(ui, "Update window (minutes)", &mut f.access_window, false, "60");
            parts::hint(ui, &format!("{wmin} to {wmax}. Repeat opens within this window are not recorded again, which reduces database writes. Use 0 to record every open."));
            widgets::field(ui, "Write interval (seconds)", &mut f.access_flush, false, "10");
            parts::hint(ui, &format!("{fmin} to {fmax}. How often recorded opens are written to the database."));
        });
            action = parts::form_actions(ui, busy, "Save", "Saving…");
        },
    );
    if clicked
        && main.settings.toggle_card("access")
        && let Some(a) = main.settings.activity
    {
        let f = &mut main.settings.forms;
        f.access_enabled = a.access_time_tracking;
        f.access_window = a.access_time_window_minutes.to_string();
        f.access_flush = a.access_time_flush_seconds.to_string();
    }
    match action {
        Some(FormAction::Cancel) => {
            main.settings.open.remove("access");
        }
        Some(FormAction::Save) => {
            let f = &main.settings.forms;
            let enabled = f.access_enabled;
            let parsed = forms::whole_number(&f.access_window, ActivitySettings::WINDOW_MINUTES, "Update window")
                .and_then(|w| {
                    forms::whole_number(&f.access_flush, ActivitySettings::FLUSH_SECONDS, "Write interval")
                        .map(|s| (w, s))
                });
            match parsed {
                Err(e) => main.settings.report(e),
                Ok((window, flush)) => super::save(
                    tasks,
                    main,
                    "access-time",
                    move |c| async move { c.save_access_time(enabled, window, flush).await },
                    |main, toasts, v| {
                        main.settings.activity = Some(v);
                        main.settings.open.remove("access");
                        toasts.success("Access time settings saved");
                    },
                ),
            }
        }
        None => {}
    }
}

fn proxies_card(main: &mut Main, ui: &mut egui::Ui, tasks: &Tasks) {
    let status = main.settings.proxies.as_ref().map(|p| {
        if p.known_proxies.is_empty() {
            (Tone::Info, "Not set up".to_string())
        } else {
            (Tone::Success, forms::plural(p.known_proxies.len() as i64, "proxy").replace("proxys", "proxies"))
        }
    });
    let open = main.settings.open.contains("proxies");
    let busy = main.settings.busy == Some("proxies");
    let restart = main.settings.restart_required;
    let mut action = None;
    let clicked = parts::config_card(
        ui,
        ph::GLOBE_HEMISPHERE_WEST,
        "Known proxies",
        "Reverse proxies allowed to report the client IP address",
        status,
        open,
        |ui| {
            widgets::bordered_field(
                ui,
                egui::TextEdit::multiline(&mut main.settings.forms.proxies)
                    .desired_rows(3)
                    .desired_width(f32::INFINITY)
                    .hint_text("10.1.2.100, 172.18.0.0/16, proxy.example.com"),
            );
            parts::hint(
                ui,
                "Enter IP addresses, CIDR ranges or host names, separated by commas or new lines. Only these proxies may set X-Forwarded-For; with none listed, the header is ignored. Changes take effect after a server restart.",
            );
            action = parts::form_actions(ui, busy, "Save", "Saving…");
        },
    );
    if restart {
        parts::note(ui, Tone::Warning, "Restart the server to apply the new proxy list.");
    }
    if clicked
        && main.settings.toggle_card("proxies")
        && let Some(p) = &main.settings.proxies
    {
        main.settings.forms.proxies = p.known_proxies.join(", ");
    }
    match action {
        Some(FormAction::Cancel) => {
            main.settings.open.remove("proxies");
        }
        Some(FormAction::Save) => {
            let list = forms::parse_proxies(&main.settings.forms.proxies);
            super::save(
                tasks,
                main,
                "proxies",
                move |c| async move { c.save_known_proxies(&list).await },
                |main, toasts, v| {
                    main.settings.restart_required = v.restart_required.unwrap_or(true);
                    main.settings.proxies = Some(v);
                    main.settings.open.remove("proxies");
                    toasts.success("Known proxies saved. Restart the server to apply the change.");
                },
            );
        }
        None => {}
    }
}
