//! Administration (first user only): instance policies, users and devices,
//! trusted proxies, activity tracking and orphan cleanup.

use egui::RichText;

use super::dialogs::Dialog;
use super::{fetch, save, section};
use crate::app::Main;
use crate::icons::ph;
use crate::tasks::Tasks;
use crate::theme::Weight;
use crate::widgets;

pub fn load(main: &mut Main, tasks: &Tasks) {
    fetch(tasks, main, |c| async move { c.signup_status().await }, |s, v| s.signup = Some(v));
    fetch(tasks, main, |c| async move { c.active_clients().await }, |s, v| s.clients = Some(v));
    fetch(
        tasks,
        main,
        |c| async move { c.known_proxies().await },
        |s, v| {
            s.forms.proxies = v.known_proxies.join("\n");
            s.proxies = Some(v);
        },
    );
    fetch(
        tasks,
        main,
        |c| async move { c.activity_settings().await },
        |s, v| {
            s.forms.idle_days = v.session_idle_days.to_string();
            s.forms.access_enabled = v.access_time_tracking;
            s.forms.access_window = v.access_time_window_minutes.to_string();
            s.forms.access_flush = v.access_time_flush_seconds.to_string();
            s.activity = Some(v);
        },
    );
    super::integrations::load(main, tasks);
}

/// One bordered tile: a label, the figure, and a note.
fn summary(ui: &mut egui::Ui, width: f32, value: String, label: &str, note: &str) {
    let t = widgets::tokens(ui);
    egui::Frame::new()
        .stroke(egui::Stroke::new(1.0, t.separator))
        .corner_radius(egui::CornerRadius::same(14))
        .inner_margin(egui::Margin::symmetric(14, 12))
        .show(ui, |ui| {
            ui.set_width(width - 30.0);
            ui.spacing_mut().item_spacing.y = 3.0;
            ui.label(RichText::new(label).size(12.0).color(t.label_secondary));
            ui.label(RichText::new(value).size(18.0).bold().color(t.label));
            ui.label(RichText::new(note).size(11.0).color(t.label_tertiary));
        });
}

/// One policy switch: flips locally, saves, and reverts if the server refuses.
fn policy(main: &mut Main, ui: &mut egui::Ui, tasks: &Tasks, title: &str, description: &str, key: &'static str) {
    let Some(status) = main.settings.signup.clone() else { return };
    let mut value = match key {
        "signup" => status.signup_enabled,
        "password" => status.allow_password_change,
        "extensions" => status.hide_file_extensions,
        _ => status.electron_only_access,
    };
    let mut changed = false;
    widgets::setting_row(ui, title, description, |ui| {
        changed = widgets::toggle(ui, &mut value).changed();
    });
    if !changed {
        return;
    }
    if let Some(s) = &mut main.settings.signup {
        match key {
            "signup" => s.signup_enabled = value,
            "password" => s.allow_password_change = value,
            "extensions" => s.hide_file_extensions = value,
            _ => s.electron_only_access = value,
        }
    }
    if key == "extensions" {
        main.instance.hide_extensions = value;
    }
    save(
        tasks,
        main,
        "policy",
        move |c| async move {
            match key {
                "signup" => c.set_signup(value).await,
                "password" => c.set_password_change(value).await,
                "extensions" => c.set_hide_extensions(value).await,
                _ => c.set_desktop_only(value).await,
            }
        },
        |_, toasts, _| toasts.success("Saved"),
    );
}

pub fn show(main: &mut Main, ui: &mut egui::Ui, tasks: &Tasks) {
    let t = widgets::tokens(ui);
    widgets::heading(ui, ph::GEAR_SIX, "Administration", "Access, visibility and maintenance.");
    ui.add_space(12.0);
    let status = main.settings.signup.clone();
    let clients = main.settings.clients.as_ref().map(|c| c.clients.len()).unwrap_or(0);
    {
        // Three tiles share the row; narrow windows shrink them rather than overflow.
        let width = ((ui.available_width() - 2.0 * ui.spacing().item_spacing.x) / 3.0).max(80.0);
        ui.horizontal(|ui| {
            let total = status.as_ref().and_then(|s| s.total_users).unwrap_or(0);
            let other = status.as_ref().and_then(|s| s.additional_users).unwrap_or(0);
            summary(ui, width, total.to_string(), "Total users", "Including you");
            summary(
                ui,
                width,
                other.to_string(),
                "Other users",
                if status.as_ref().is_some_and(|s| s.signup_enabled) { "Signup is open" } else { "Signup is closed" },
            );
            summary(
                ui,
                width,
                if clients == 0 { "None online".into() } else { clients.to_string() },
                "Active desktop clients",
                "Seen in the last 5 minutes",
            );
        });
    }
    ui.add_space(12.0);
    section(ui, "Policies", "Rules applied to everyone who uses this workspace.", |ui| {
        policy(main, ui, tasks, "Allow user signup", "Let new people register their own account.", "signup");
        policy(main, ui, tasks, "Allow password change", "Let users change their own password.", "password");
        policy(main, ui, tasks, "Hide file extensions", "Show file names without their extensions.", "extensions");
        policy(
            main,
            ui,
            tasks,
            "Desktop app only",
            "Block browsers; only the desktop app can sign in. Share links keep working.",
            "desktop",
        );
    });
    let mut open = None;
    section(ui, "People & devices", "Who holds an account and what is connected.", |ui| {
        widgets::setting_row(ui, "Registered users", "Every account on this server, with its storage use.", |ui| {
            if widgets::secondary(ui, format!("{}  Show all users", ph::USERS_THREE)).clicked() {
                open = Some(Dialog::Users);
            }
        });
        widgets::setting_row(
            ui,
            "Active desktop clients",
            "Desktop apps that checked in within the last 5 minutes.",
            |ui| {
                if widgets::secondary(ui, format!("{}  View clients", ph::DESKTOP)).clicked() {
                    open = Some(Dialog::Clients);
                }
            },
        );
    });
    if let Some(dialog) = open {
        if matches!(dialog, Dialog::Users) {
            main.settings.users = None;
            fetch(tasks, main, |c| async move { c.users(None).await }, |s, v| s.users = Some(v));
        } else {
            fetch(tasks, main, |c| async move { c.active_clients().await }, |s, v| s.clients = Some(v));
        }
        main.settings.dialog = Some(dialog);
    }
    let busy = main.settings.busy;
    section(
        ui,
        "Known proxies",
        "Trust forwarded client addresses only from these reverse proxies (one IP, CIDR or hostname per line).",
        |ui| {
            ui.add(
                egui::TextEdit::multiline(&mut main.settings.forms.proxies)
                    .desired_rows(3)
                    .desired_width(f32::INFINITY)
                    .hint_text("10.0.0.0/8\nproxy.internal"),
            );
            ui.add_space(6.0);
            if widgets::primary_enabled(ui, busy.is_none(), "Save proxies").clicked() {
                let list: Vec<String> = main
                    .settings
                    .forms
                    .proxies
                    .lines()
                    .map(str::trim)
                    .filter(|l| !l.is_empty())
                    .map(String::from)
                    .collect();
                save(
                    tasks,
                    main,
                    "proxies",
                    move |c| async move { c.save_known_proxies(&list).await },
                    |main, toasts, v| {
                        main.settings.proxies = Some(v);
                        toasts.success("Saved. Restart the server to apply proxy changes.");
                    },
                );
            }
        },
    );
    section(ui, "Activity", "Sign-in lifetime and when files count as opened.", |ui| {
        let f = &mut main.settings.forms;
        ui.horizontal(|ui| {
            ui.label("Sign out after");
            widgets::text_edit(ui, &mut f.idle_days, "30", 50.0);
            ui.label("days without activity");
        });
        widgets::setting_row(
            ui,
            "Track when files are opened",
            "Powers Recent files and the Last opened column.",
            |ui| {
                widgets::toggle(ui, &mut f.access_enabled);
            },
        );
        ui.horizontal(|ui| {
            ui.label("Count a file again after");
            widgets::text_edit(ui, &mut f.access_window, "60", 50.0);
            ui.label("minutes; write every");
            widgets::text_edit(ui, &mut f.access_flush, "10", 40.0);
            ui.label("seconds");
        });
        ui.add_space(6.0);
        let days = f.idle_days.trim().parse::<i32>().ok();
        let window = f.access_window.trim().parse::<i32>().ok();
        let flush = f.access_flush.trim().parse::<i32>().ok();
        let enabled = f.access_enabled;
        if widgets::primary_enabled(
            ui,
            busy.is_none() && days.is_some() && window.is_some() && flush.is_some(),
            "Save activity settings",
        )
        .clicked()
            && let (Some(days), Some(window), Some(flush)) = (days, window, flush)
        {
            save(
                tasks,
                main,
                "activity",
                move |c| async move {
                    c.save_session_timeout(days).await?;
                    c.save_access_time(enabled, window, flush).await
                },
                |main, toasts, v| {
                    main.settings.activity = Some(v);
                    toasts.success("Saved");
                },
            );
        }
    });
    widgets::card(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.label(RichText::new("MAINTENANCE").size(11.0).semibold().color(t.destructive_text));
        ui.label(widgets::muted(
            ui,
            "These actions delete data and cannot be undone. Review what is listed before confirming.",
        ));
        ui.add_space(8.0);
        widgets::setting_row(
            ui,
            "Orphaned files",
            "Stored files with no database record, and records with no file.",
            |ui| {
                if widgets::secondary(
                    ui,
                    RichText::new(format!("{}  Review orphans", ph::BROOM)).color(t.destructive_text),
                )
                .clicked()
                {
                    main.settings.orphans = None;
                    main.settings.dialog = Some(Dialog::Orphans(Default::default()));
                }
            },
        );
    });
}
