//! Profile and Security: who you are signed in as, and what it takes to sign
//! in: password, two-factor authentication and signed-in devices.

use egui::{CornerRadius, Frame, Margin, RichText, Sense, Stroke, Vec2};

use super::dialogs::{Dialog, PasswordForm};
use super::parts::{self, Tone};
use super::{Page, fetch, save, section};
use crate::app::Main;
use crate::icons::{self, ph};
use crate::tasks::Tasks;
use crate::theme::Weight;
use crate::widgets;

pub fn load_security(main: &mut Main, tasks: &Tasks) {
    fetch(tasks, main, |c| async move { c.mfa_status().await }, |s, v| s.mfa = Some(v.enabled));
    fetch(tasks, main, |c| async move { c.signup_status().await }, |s, v| s.signup = Some(v));
    load_sessions(main, tasks);
    if main.settings.mfa.unwrap_or(main.user.mfa_enabled) {
        fetch(tasks, main, |c| async move { c.mfa_backup_count().await }, |s, v| s.backup_codes = Some(v));
    }
}

pub fn load_sessions(main: &Main, tasks: &Tasks) {
    fetch(tasks, main, |c| async move { c.sessions(true).await }, |s, v| s.sessions = Some(v.sessions));
}

fn row(ui: &mut egui::Ui, label: &str, description: &str, value: &str) {
    widgets::setting_row(ui, label, description, |ui| {
        ui.label(RichText::new(value).semibold());
    });
}

fn account_kind(main: &Main) -> &'static str {
    if main.user.is_sub_user { "Sub-user" } else { "Account owner" }
}

/// Identity as a card: name, address and the kind of account.
fn identity_card(ui: &mut egui::Ui, main: &Main) {
    let t = widgets::tokens(ui);
    Frame::new()
        .fill(t.surface_raised)
        .stroke(Stroke::new(1.0, t.separator))
        .corner_radius(CornerRadius::same(18))
        .inner_margin(Margin::symmetric(18, 16))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal(|ui| {
                let name = main.user.name.clone().filter(|n| !n.is_empty());
                let (rect, _) = ui.allocate_exact_size(Vec2::splat(56.0), Sense::hover());
                icons::avatar(ui.painter(), rect.center(), 28.0, name.as_deref().unwrap_or(&main.user.email), &t);
                ui.add_space(8.0);
                ui.vertical(|ui| {
                    ui.set_max_width((ui.available_width() - 130.0).max(120.0));
                    ui.add_space(6.0);
                    let title = name.unwrap_or_else(|| "Unnamed account".into());
                    ui.add(egui::Label::new(RichText::new(title).size(18.0).bold().color(t.label)).truncate());
                    ui.add(
                        egui::Label::new(RichText::new(&main.user.email).size(12.5).color(t.label_secondary))
                            .truncate(),
                    );
                });
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    parts::chip(ui, Tone::Neutral, account_kind(main));
                });
            });
        });
}

pub fn profile(main: &mut Main, ui: &mut egui::Ui, tasks: &Tasks) {
    widgets::heading(ui, ph::USER, "Profile", "Your account information.");
    ui.add_space(8.0);
    identity_card(ui, main);
    let user = main.user.clone();
    section(ui, "Account details", "", |ui| {
        row(ui, "Email address", "The address you sign in with", &user.email);
        let since = user.created_at.map(|c| c.format("%B %-d, %Y").to_string()).unwrap_or_else(|| "Unknown".into());
        row(ui, "Member since", "Date the account was created", &since);
        let description = if user.is_sub_user {
            "You work in the account owner's files and storage, with the permissions they assigned"
        } else {
            "You own this storage and can add sub-users to it"
        };
        row(ui, "Account type", description, account_kind(main));
        if main.instance.is_first_user {
            row(ui, "Role", "Manages users and settings for this server", "Administrator");
        }
    });
    let mfa = main.settings.mfa.unwrap_or(user.mfa_enabled);
    let mut manage = false;
    section(ui, "Security", "Managed on the Security page.", |ui| {
        let description = if mfa {
            "A verification code is required at sign-in"
        } else {
            "Add a verification code to protect your account"
        };
        widgets::setting_row(ui, "Two-factor authentication", description, |ui| {
            let (icon, label) = if mfa { (ph::SHIELD_CHECK, "Manage") } else { (ph::KEY, "Set up") };
            manage = widgets::secondary(ui, format!("{icon}  {label}")).clicked();
            if mfa {
                parts::chip(ui, Tone::Success, "Enabled");
            }
        });
    });
    if manage {
        main.settings.page = Page::Security;
        super::opened(main, tasks);
    }
}

pub fn security(main: &mut Main, ui: &mut egui::Ui, tasks: &Tasks) {
    widgets::heading(ui, ph::SHIELD, "Security", "Sign-in protection and active sessions.");
    ui.add_space(8.0);
    let allowed = main.settings.signup.as_ref().map(|s| s.allow_password_change);
    let mfa = main.settings.mfa.unwrap_or(main.user.mfa_enabled);
    let mut open = None;
    section(ui, "Sign-in", "How you verify your identity when you sign in.", |ui| {
        let description = match (mfa, main.settings.backup_codes) {
            (true, Some(n)) => {
                format!("On · {} left", tma_core::format::count(n as usize, "backup code", "backup codes"))
            }
            (true, None) => "On · a verification code is required at sign-in".into(),
            (false, _) => "Require a code from an authenticator app at sign-in".into(),
        };
        widgets::setting_row(ui, "Two-factor authentication", &description, |ui| {
            if widgets::secondary(ui, format!("{}  Manage", ph::KEY)).clicked() {
                open = Some(Dialog::Mfa(Default::default()));
            }
            if mfa {
                parts::chip(ui, Tone::Success, "Enabled");
            }
        });
        match allowed {
            Some(true) => widgets::setting_row(ui, "Password", "Change the password you use to sign in", |ui| {
                if widgets::secondary(ui, format!("{}  Change password", ph::LOCK)).clicked() {
                    open = Some(Dialog::Password(PasswordForm::default()));
                }
            }),
            Some(false) => parts::note(ui, Tone::Neutral, "Your administrator has turned off password changes."),
            None => {
                ui.spinner();
            }
        }
    });
    section(ui, "Devices", "Browsers and apps signed in to your account.", |ui| {
        let description = match &main.settings.sessions {
            None => "Counting active sessions…".to_string(),
            Some(list) if list.is_empty() => "Only this device is signed in".to_string(),
            Some(list) => format!(
                "{}, including this one",
                tma_core::format::count(list.len(), "active session", "active sessions")
            ),
        };
        widgets::setting_row(ui, "Active sessions", &description, |ui| {
            if widgets::secondary(ui, format!("{}  View sessions", ph::DEVICES)).clicked() {
                open = Some(Dialog::Sessions);
            }
        });
    });
    if let Some(dialog) = open {
        if matches!(dialog, Dialog::Sessions) {
            main.settings.sessions = None;
            load_sessions(main, tasks);
        }
        if matches!(dialog, Dialog::Mfa(_)) && mfa {
            fetch(tasks, main, |c| async move { c.mfa_backup_count().await }, |s, v| s.backup_codes = Some(v));
        }
        main.settings.dialog = Some(dialog);
    }
    let busy = main.settings.busy == Some("logout-all");
    parts::danger_group(
        ui,
        "Sign out everywhere",
        "Ends every session for your account, including this one. You will need to sign in again.",
        |ui| {
            widgets::setting_row(ui, "Sign out of all sessions", "Immediately ends every active session", |ui| {
                let label =
                    if busy { "Signing out…".to_string() } else { format!("{}  Sign out everywhere", ph::SIGN_OUT) };
                let t = widgets::tokens(ui);
                if ui.add_enabled(!busy, egui::Button::new(RichText::new(label).color(t.destructive_text))).clicked() {
                    save(
                        tasks,
                        main,
                        "logout-all",
                        |c| async move { c.logout_all().await },
                        |main, _, _| super::sign_out_after_now(main, "Signed out on all devices"),
                    );
                }
            });
        },
    );
}
