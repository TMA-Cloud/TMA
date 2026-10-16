//! Profile and Security: the account's details, password, two-factor
//! authentication and signed-in devices.

use egui::RichText;

use super::dialogs::Dialog;
use super::{fetch, save, section};
use crate::app::Main;
use crate::icons::ph;
use crate::tasks::Tasks;
use crate::widgets;

pub fn load_security(main: &mut Main, tasks: &Tasks) {
    fetch(tasks, main, |c| async move { c.mfa_status().await }, |s, v| s.mfa = Some(v.enabled));
    fetch(tasks, main, |c| async move { c.mfa_backup_count().await }, |s, v| s.backup_codes = Some(v));
    fetch(tasks, main, |c| async move { c.signup_status().await }, |s, v| s.signup = Some(v));
}

fn row(ui: &mut egui::Ui, label: &str, value: &str) {
    widgets::setting_row(ui, label, "", |ui| {
        ui.label(value);
    });
}

pub fn profile(main: &mut Main, ui: &mut egui::Ui, tasks: &Tasks) {
    let t = widgets::tokens(ui);
    widgets::heading(ui, ph::USER, "Profile", "Who you are signed in as.");
    ui.add_space(12.0);
    let user = main.user.clone();
    section(ui, "Account details", "", |ui| {
        row(ui, "Name", user.name.as_deref().unwrap_or("—"));
        row(ui, "Email address", &user.email);
        if let Some(created) = user.created_at {
            row(ui, "Member since", &created.format("%B %-d, %Y").to_string());
        }
        let kind = if user.is_sub_user {
            "Sub-user"
        } else if main.instance.is_first_user {
            "Administrator"
        } else {
            "Account owner"
        };
        row(ui, "Account type", kind);
        if user.is_sub_user {
            ui.add_space(4.0);
            ui.label(widgets::muted(ui, "You use the owner's files and storage with the permissions they granted."));
        }
    });
    let mfa = main.settings.mfa.unwrap_or(user.mfa_enabled);
    section(ui, "Sign-in security", "", |ui| {
        widgets::setting_row(
            ui,
            "Multi-factor authentication",
            "Require a code from your phone when you sign in.",
            |ui| {
                if mfa {
                    widgets::badge(ui, "Enabled", t.positive_text);
                } else if widgets::secondary(ui, format!("{}  Set up MFA", ph::SHIELD_PLUS)).clicked() {
                    main.settings.dialog = Some(Dialog::mfa_setup());
                    fetch(
                        tasks,
                        main,
                        |c| async move { c.mfa_setup().await },
                        |s, v| {
                            if let Some(Dialog::MfaSetup(setup)) = &mut s.dialog {
                                setup.set_secret(v);
                            }
                        },
                    );
                }
            },
        );
    });
}

pub fn security(main: &mut Main, ui: &mut egui::Ui, tasks: &Tasks) {
    let t = widgets::tokens(ui);
    widgets::heading(ui, ph::SHIELD, "Security", "Your password, two-factor authentication and devices.");
    ui.add_space(12.0);
    let allowed = main.instance.is_first_user || main.settings.signup.as_ref().is_some_and(|s| s.allow_password_change);
    let mfa = main.settings.mfa.unwrap_or(main.user.mfa_enabled);
    section(
        ui,
        "Password",
        if allowed { "Use at least 8 characters." } else { "The administrator has turned off password changes." },
        |ui| {
            if !allowed {
                return;
            }
            let f = &mut main.settings.forms;
            widgets::field(ui, "Current password", &mut f.old_password, true, "");
            widgets::field(ui, "New password", &mut f.new_password, true, "");
            widgets::field(ui, "Confirm new password", &mut f.confirm_password, true, "");
            if mfa {
                widgets::field(ui, "Authentication code", &mut f.password_mfa, false, "123456");
            }
            ui.add_space(8.0);
            let mismatch = !f.confirm_password.is_empty() && f.new_password != f.confirm_password;
            if mismatch {
                widgets::error_text(ui, "The new passwords do not match");
            }
            let ready =
                !f.old_password.is_empty() && f.new_password.len() >= 8 && !mismatch && !f.confirm_password.is_empty();
            if widgets::primary_enabled(ui, ready && main.settings.busy.is_none(), "Change password").clicked() {
                let (old, new, code) = (
                    f.old_password.clone(),
                    f.new_password.clone(),
                    Some(f.password_mfa.trim().to_string()).filter(|c| !c.is_empty()),
                );
                save(
                    tasks,
                    main,
                    "password",
                    move |c| async move { c.change_password(&old, &new, code.as_deref()).await },
                    |main, toasts, _| {
                        main.settings.forms.old_password.clear();
                        main.settings.forms.new_password.clear();
                        main.settings.forms.confirm_password.clear();
                        main.settings.forms.password_mfa.clear();
                        toasts.success("Password changed. Other devices were signed out.");
                    },
                );
            }
        },
    );
    section(ui, "Two-factor authentication", "A code from an authenticator app is needed at every sign-in.", |ui| {
        widgets::setting_row(ui, "Status", "", |ui| {
            if mfa {
                widgets::badge(ui, "Enabled", t.positive_text);
            } else {
                widgets::badge(ui, "Off", t.label_tertiary);
            }
        });
        ui.horizontal(|ui| {
            if mfa {
                if widgets::secondary(ui, format!("{}  New backup codes", ph::KEY)).clicked() {
                    main.settings.dialog = Some(Dialog::BackupCodes(Vec::new()));
                    fetch(
                        tasks,
                        main,
                        |c| async move { c.mfa_regenerate_codes().await },
                        |s, v| {
                            s.dialog = Some(Dialog::BackupCodes(v.backup_codes));
                        },
                    );
                }
                if widgets::secondary(
                    ui,
                    RichText::new(format!("{}  Turn off", ph::SHIELD_SLASH)).color(t.destructive_text),
                )
                .clicked()
                {
                    main.settings.dialog = Some(Dialog::MfaDisable(String::new()));
                }
            } else if widgets::primary(ui, format!("{}  Set up", ph::SHIELD_PLUS)).clicked() {
                main.settings.dialog = Some(Dialog::mfa_setup());
                fetch(
                    tasks,
                    main,
                    |c| async move { c.mfa_setup().await },
                    |s, v| {
                        if let Some(Dialog::MfaSetup(setup)) = &mut s.dialog {
                            setup.set_secret(v);
                        }
                    },
                );
            }
        });
        if let (true, Some(n)) = (mfa, main.settings.backup_codes) {
            ui.add_space(4.0);
            ui.label(widgets::muted(ui, format!("{n} backup code(s) left.")));
        }
    });
    section(ui, "Devices", "Browsers and apps signed in to your account.", |ui| {
        ui.horizontal(|ui| {
            if widgets::secondary(ui, format!("{}  Manage sessions", ph::DEVICES)).clicked() {
                main.settings.dialog = Some(Dialog::Sessions);
                main.settings.sessions = None;
                fetch(tasks, main, |c| async move { c.sessions(true).await }, |s, v| s.sessions = Some(v.sessions));
            }
            if widgets::secondary(
                ui,
                RichText::new(format!("{}  Sign out everywhere", ph::SIGN_OUT)).color(t.destructive_text),
            )
            .clicked()
            {
                save(
                    tasks,
                    main,
                    "logout-all",
                    |c| async move { c.logout_all().await },
                    |main, toasts, _| {
                        main.change_pending = false;
                        toasts.info("Signed out of every device");
                    },
                );
            }
        });
    });
}
