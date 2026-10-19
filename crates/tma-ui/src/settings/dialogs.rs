//! Settings dialogs: the dispatcher, the password change and signed-in
//! sessions; MFA, users, clients and orphans live in their own modules.

use egui::{Key, RichText};

use super::parts::{self, Tone};
use super::{attempt, forms, save};
use crate::app::{App, Main, Screen};
use crate::icons::ph;
use crate::tasks::Tasks;
use crate::theme::Weight;
use crate::widgets;

#[derive(Default)]
pub struct PasswordForm {
    current: String,
    new: String,
    confirm: String,
    code: String,
    error: Option<String>,
}

pub enum Dialog {
    Mfa(super::mfa::MfaDialog),
    Password(PasswordForm),
    Sessions,
    Users,
    Clients,
    Orphans(super::orphans::OrphanState),
}

impl Dialog {
    fn title(&self) -> &'static str {
        match self {
            Dialog::Mfa(_) => "Two-factor authentication",
            Dialog::Password(_) => "Change password",
            Dialog::Sessions => "Active sessions",
            Dialog::Users => "Registered users",
            Dialog::Clients => "Desktop clients",
            Dialog::Orphans(_) => "Orphaned files",
        }
    }

    fn width(&self) -> f32 {
        match self {
            Dialog::Users => 860.0,
            Dialog::Orphans(_) => 780.0,
            Dialog::Sessions | Dialog::Clients => 640.0,
            Dialog::Mfa(_) | Dialog::Password(_) => 460.0,
        }
    }
}

pub fn show(app: &mut App, ctx: &egui::Context) {
    let Screen::Main(main) = &mut app.screen else { return };
    if let Some(message) = main.settings.end_session.take() {
        app.sign_out();
        app.toasts.success(message);
        return;
    }
    let Screen::Main(main) = &mut app.screen else { return };
    if let Some(notice) = main.settings.notice.take() {
        app.toasts.error(notice);
    }
    let Screen::Main(main) = &mut app.screen else { return };
    if let Some(notice) = main.settings.notice_ok.take() {
        app.toasts.success(notice);
    }
    let Screen::Main(main) = &mut app.screen else { return };
    if std::mem::take(&mut main.settings.reload_usage) {
        crate::app::load_usage(&app.tasks, &main.client, main.generation);
    }
    let Some(mut dialog) = main.settings.dialog.take() else { return };
    let mut keep = true;
    let tasks = &app.tasks;
    let width = dialog.width().min(ctx.content_rect().width() - 60.0).max(280.0);
    let response = widgets::modal(ctx, "settings-dialog").show(ctx, |ui| {
        ui.set_min_width(width);
        ui.set_max_width(width);
        if widgets::dialog_header(ui, dialog.title()) {
            keep = false;
        }
        match &mut dialog {
            Dialog::Mfa(state) => super::mfa::show(ui, main, tasks, state, &mut keep),
            Dialog::Password(form) => password(ui, main, tasks, form, &mut keep),
            Dialog::Sessions => sessions(ui, main, tasks, &mut keep),
            Dialog::Users => super::dialogs_admin::users(ui, main, tasks, &mut keep),
            Dialog::Clients => super::dialogs_admin::clients(ui, main, tasks, &mut keep),
            Dialog::Orphans(state) => super::orphans::show(ui, main, tasks, state, &mut keep),
        }
    });
    if response.should_close() {
        keep = false;
    }
    if main.settings.dialog.is_none() {
        main.settings.dialog = keep.then_some(dialog);
    }
}

/// What is wrong with a new password, before asking the server.
fn password_problem(form: &PasswordForm) -> Option<&'static str> {
    if form.current.is_empty() || form.new.is_empty() || form.confirm.is_empty() {
        Some("Fill in all fields")
    } else if form.new.chars().count() < 8 {
        Some("The new password needs at least 8 characters")
    } else if form.new != form.confirm {
        Some("The new passwords don't match")
    } else if form.new == form.current {
        Some("The new password must be different from the current one")
    } else {
        None
    }
}

fn password(ui: &mut egui::Ui, main: &mut Main, tasks: &Tasks, form: &mut PasswordForm, keep: &mut bool) {
    ui.spacing_mut().item_spacing.y = widgets::FORM_GAP;
    parts::note(
        ui,
        Tone::Warning,
        "After changing your password you are signed out on every device, this one included. Use a strong \
         password you don't use on other sites.",
    );
    let mfa = main.settings.mfa.unwrap_or(main.user.mfa_enabled);
    parts::secret_field(ui, "Current password", &mut form.current, "");
    parts::secret_field(ui, "New password", &mut form.new, "");
    parts::hint(ui, "Use at least 8 characters.");
    let r = parts::secret_field(ui, "Confirm new password", &mut form.confirm, "");
    let mut enter = r.lost_focus() && ui.input(|i| i.key_pressed(Key::Enter));
    if mfa {
        let r = widgets::field(ui, "Authentication code", &mut form.code, false, "Code from your app or a backup code");
        form.code = forms::any_code_input(&form.code);
        enter |= r.lost_focus() && ui.input(|i| i.key_pressed(Key::Enter));
    }
    if let Some(error) = &form.error {
        widgets::error_text(ui, error);
    }
    let busy = main.settings.busy == Some("password");
    widgets::dialog_footer(ui, |ui| {
        let label = if busy { "Saving…".to_string() } else { format!("{}  Change password", ph::LOCK) };
        if widgets::primary_enabled(ui, !busy, label).clicked() || (enter && !busy) {
            form.error = password_problem(form).map(String::from);
            if mfa && form.error.is_none() && forms::any_code(&form.code).is_none() {
                form.error = Some("Enter the 6-digit code from your app or a backup code".into());
            }
            if form.error.is_none() {
                let (old, new, code) = (form.current.clone(), form.new.clone(), forms::any_code(&form.code));
                attempt(
                    tasks,
                    main,
                    "password",
                    move |c| async move { c.change_password(&old, &new, code.as_deref()).await },
                    |main, _, result| match result {
                        Ok(_) => {
                            main.settings.dialog = None;
                            super::sign_out_after_now(main, "Password changed. Sign in again with the new password.");
                        }
                        Err(err) => {
                            if let Some(Dialog::Password(form)) = &mut main.settings.dialog {
                                form.error = Some(err.message);
                            }
                        }
                    },
                );
            }
        }
        if ui.add_enabled(!busy, egui::Button::new("Cancel")).clicked() {
            *keep = false;
        }
    });
}

fn sessions(ui: &mut egui::Ui, main: &mut Main, tasks: &Tasks, keep: &mut bool) {
    let t = widgets::tokens(ui);
    let list = main.settings.sessions.clone();
    let count = list.as_ref().map_or("Loading sessions…".to_string(), |l| match l.len() {
        0 => "No active sessions".into(),
        n => tma_core::format::count(n, "active session", "active sessions"),
    });
    if parts::count_header(ui, &count, list.is_none()) {
        main.settings.sessions = None;
        super::account::load_sessions(main, tasks);
    }
    ui.add_space(6.0);
    let Some(list) = list else {
        ui.vertical_centered(|ui| ui.spinner());
        return;
    };
    let revoking = main.settings.busy == Some("session");
    egui::ScrollArea::vertical().max_height(ui.ctx().content_rect().height() * 0.55).show(ui, |ui| {
        for s in &list {
            widgets::card(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.horizontal_top(|ui| {
                    ui.label(RichText::new(ph::DEVICES).size(20.0).color(t.label_tertiary));
                    ui.vertical(|ui| {
                        ui.set_max_width(ui.available_width() - 110.0);
                        ui.spacing_mut().item_spacing.y = 2.0;
                        let agent = s.user_agent.clone().unwrap_or_else(|| "Unknown device".into());
                        // Centred, so the chips sit level with the device name.
                        ui.horizontal(|ui| {
                            ui.label(RichText::new(forms::device_label(&agent)).size(14.0).semibold());
                            if s.is_current {
                                parts::chip(ui, Tone::Info, "Current");
                            }
                            if s.is_online {
                                parts::chip(ui, Tone::Success, "Online");
                            } else {
                                parts::chip(ui, Tone::Neutral, "Offline");
                            }
                        });
                        ui.add_space(4.0);
                        let small = |text: String| RichText::new(text).size(12.0).color(t.label_tertiary);
                        ui.add(egui::Label::new(small(agent)).truncate());
                        ui.label(small(s.ip_address.clone().unwrap_or_else(|| "Unknown address".into())));
                        ui.label(small(format!("Signed in {}", tma_core::format::full_date(s.created_at))));
                        ui.label(small(format!("Last active {}", tma_core::format::full_date(s.last_activity))));
                    });
                    if !s.is_current {
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Min), |ui| {
                            let button = egui::Button::new(RichText::new("Sign out").color(t.destructive_text));
                            if ui.add_enabled(!revoking, button).clicked() {
                                let id = s.id.clone();
                                save(
                                    tasks,
                                    main,
                                    "session",
                                    move |c| async move {
                                        c.revoke_session(&id).await?;
                                        c.sessions(false).await
                                    },
                                    |main, toasts, v| {
                                        main.settings.sessions = Some(v.sessions);
                                        toasts.success("Device signed out");
                                    },
                                );
                            }
                        });
                    }
                });
            });
            ui.add_space(4.0);
        }
    });
    widgets::dialog_footer(ui, |ui| {
        if widgets::primary(ui, "Done").clicked() {
            *keep = false;
        }
        let others = list.iter().any(|s| !s.is_current);
        if ui.add_enabled(others && !revoking, egui::Button::new("Sign out all other devices")).clicked() {
            sign_out_others(tasks, main, "session", false);
        }
    });
}

/// Sign out every other session and drop them from the list; `close` also closes
/// the dialog that offered it.
pub(super) fn sign_out_others(tasks: &Tasks, main: &mut Main, label: &'static str, close: bool) {
    save(
        tasks,
        main,
        label,
        |c| async move { c.revoke_other_sessions().await },
        move |main, toasts, r| {
            toasts.success(match r.deleted_count {
                0 => "No other sessions to sign out".to_string(),
                n => {
                    format!("Signed out of {}", tma_core::format::count(n as usize, "other session", "other sessions"))
                }
            });
            if close {
                main.settings.dialog = None;
            }
            main.settings.sessions =
                main.settings.sessions.take().map(|l| l.into_iter().filter(|s| s.is_current).collect());
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_checks() {
        let form = |current: &str, new: &str, confirm: &str| PasswordForm {
            current: current.into(),
            new: new.into(),
            confirm: confirm.into(),
            ..Default::default()
        };
        assert_eq!(password_problem(&form("", "a", "a")), Some("Fill in all fields"));
        assert_eq!(
            password_problem(&form("old", "short", "short")),
            Some("The new password needs at least 8 characters")
        );
        assert_eq!(password_problem(&form("old", "longenough", "different")), Some("The new passwords don't match"));
        assert_eq!(
            password_problem(&form("samesame", "samesame", "samesame")),
            Some("The new password must be different from the current one")
        );
        assert_eq!(password_problem(&form("old", "longenough", "longenough")), None);
    }
}
