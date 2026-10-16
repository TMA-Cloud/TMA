//! The two-factor dialog: status, enrolment with a QR code, turning it off,
//! backup codes (saved as a file, regenerated after a confirm and a cooldown)
//! and the offer to sign out other sessions after a change.

use egui::{Align2, FontId, Key, RichText, Sense, Vec2};

use super::parts::{self, Tone};
use super::{attempt, forms, save};
use crate::app::Main;
use crate::icons::ph;
use crate::tasks::Tasks;
use crate::theme::Weight;
use crate::widgets;

/// Seconds between regenerations, as the server enforces.
const COOLDOWN_SECS: f64 = 300.0;

#[derive(Default)]
enum Step {
    #[default]
    Status,
    Verify,
    Disable,
    ConfirmRegenerate,
    /// New codes; `then_prompt` continues to the sessions prompt.
    Codes {
        codes: Vec<String>,
        then_prompt: bool,
    },
    SessionPrompt,
}

#[derive(Default)]
pub struct MfaDialog {
    step: Step,
    secret: Option<String>,
    qr_png: Option<Vec<u8>>,
    qr: Option<egui::TextureHandle>,
    code: String,
}

fn texture_from_png(ctx: &egui::Context, png: &[u8]) -> Option<egui::TextureHandle> {
    let image = image::load_from_memory(png).ok()?.to_rgba8();
    let color =
        egui::ColorImage::from_rgba_unmultiplied([image.width() as usize, image.height() as usize], image.as_raw());
    Some(ctx.load_texture("mfa-qr", color, egui::TextureOptions::NEAREST))
}

fn with_dialog(main: &mut Main, change: impl FnOnce(&mut MfaDialog)) {
    if let Some(super::dialogs::Dialog::Mfa(state)) = &mut main.settings.dialog {
        change(state);
    }
}

/// Save the codes as a text file through the browser or a save dialog.
fn save_codes(tasks: &Tasks, main: &Main, codes: &[String]) {
    let now = chrono::Local::now();
    let (name, content) = forms::backup_codes_file(
        codes,
        &main.user.email,
        &now.format("%B %-d, %Y, %I:%M:%S %p").to_string(),
        &now.format("%Y-%m-%d").to_string(),
    );
    tasks.run(crate::platform::save_text(name, content), |app, result| match result {
        Ok(true) => app.toasts.success("Backup codes saved"),
        Ok(false) => {}
        Err(e) => app.toasts.error(format!("Could not save the backup codes: {e}")),
    });
}

/// A large, centred code box.
fn code_box(ui: &mut egui::Ui, code: &mut String, hint: &str) -> bool {
    let r = widgets::bordered_field(
        ui,
        egui::TextEdit::singleline(code)
            .font(FontId::monospace(26.0))
            .horizontal_align(egui::Align::Center)
            .hint_text(hint)
            .desired_width(f32::INFINITY)
            .margin(egui::Margin::symmetric(12, 10)),
    );
    r.lost_focus() && ui.input(|i| i.key_pressed(Key::Enter))
}

fn status_panel(ui: &mut egui::Ui, enabled: bool) {
    let t = widgets::tokens(ui);
    widgets::card(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.horizontal(|ui| {
            let (rect, _) = ui.allocate_exact_size(Vec2::splat(44.0), Sense::hover());
            let (icon, color) =
                if enabled { (ph::SHIELD_CHECK, t.positive_text) } else { (ph::SHIELD_SLASH, t.label_tertiary) };
            ui.painter().circle_filled(rect.center(), 22.0, t.fill_tertiary);
            ui.painter().text(rect.center(), Align2::CENTER_CENTER, icon, FontId::proportional(22.0), color);
            ui.vertical(|ui| {
                ui.label(RichText::new("Status").size(12.0).color(t.label_secondary));
                ui.label(RichText::new(if enabled { "Enabled" } else { "Disabled" }).size(20.0).bold());
            });
        });
    });
}

pub fn show(ui: &mut egui::Ui, main: &mut Main, tasks: &Tasks, state: &mut MfaDialog, keep: &mut bool) {
    // Results arrive without a clock or tasks; apply what they asked for here.
    if let Some(secs) = main.settings.regenerate_from_now.take() {
        main.settings.regenerate_after = Some(ui.input(|i| i.time) + secs);
    }
    if let Some(codes) = main.settings.save_codes.take() {
        save_codes(tasks, main, &codes);
    }
    let busy = main.settings.busy == Some("mfa");
    let enabled = main.settings.mfa.unwrap_or(main.user.mfa_enabled);
    match &mut state.step {
        Step::Status => {
            status_panel(ui, enabled);
            ui.add_space(8.0);
            if enabled {
                status_enabled(ui, main, state);
            } else {
                let label = if busy { "Setting up…".to_string() } else { format!("{}  Enable MFA", ph::SHIELD_PLUS) };
                if widgets::primary_enabled(ui, !busy, label).clicked() {
                    save(
                        tasks,
                        main,
                        "mfa",
                        |c| async move { c.mfa_setup().await },
                        |main, _, setup| {
                            with_dialog(main, |d| {
                                let b64 = setup.qr_code.split_once("base64,").map(|(_, b)| b).unwrap_or("");
                                d.qr_png = data_encoding::BASE64.decode(b64.as_bytes()).ok();
                                d.qr = None;
                                d.secret = Some(setup.secret);
                                d.code.clear();
                                d.step = Step::Verify;
                            });
                        },
                    );
                }
            }
        }
        Step::Verify => verify(ui, main, tasks, state, busy),
        Step::Disable => disable(ui, main, tasks, state, busy),
        Step::ConfirmRegenerate => {
            parts::note(
                ui,
                Tone::Warning,
                "This invalidates every existing backup code and creates new ones. Make sure you no longer need the old list.",
            );
            widgets::dialog_footer(ui, |ui| {
                if widgets::primary_enabled(ui, !busy, if busy { "Regenerating…" } else { "Regenerate" }).clicked() {
                    regenerate(main, tasks);
                }
                if widgets::secondary(ui, "Cancel").clicked() {
                    state.step = Step::Status;
                }
            });
        }
        Step::Codes { codes, then_prompt } => {
            ui.label(widgets::muted(
                ui,
                "Each code signs you in once if you lose your phone. Store them somewhere safe; they are shown only now.",
            ));
            ui.add_space(8.0);
            egui::Grid::new("codes").num_columns(2).spacing([28.0, 6.0]).show(ui, |ui| {
                for (i, code) in codes.iter().enumerate() {
                    ui.label(RichText::new(format!("{:>2}. {code}", i + 1)).monospace().size(14.0));
                    if i % 2 == 1 {
                        ui.end_row();
                    }
                }
            });
            let then_prompt = *then_prompt;
            let codes = codes.clone();
            widgets::dialog_footer(ui, |ui| {
                if widgets::primary(ui, if then_prompt { "Continue" } else { "Done" }).clicked() {
                    state.step = if then_prompt { Step::SessionPrompt } else { Step::Status };
                }
                if widgets::secondary(ui, format!("{}  Save as file", ph::DOWNLOAD_SIMPLE)).clicked() {
                    save_codes(tasks, main, &codes);
                }
                if widgets::secondary(ui, format!("{}  Copy all", ph::COPY)).clicked() {
                    ui.ctx().copy_text(codes.join("\n"));
                }
            });
        }
        Step::SessionPrompt => {
            let t = widgets::tokens(ui);
            ui.vertical_centered(|ui| {
                ui.label(RichText::new(ph::SHIELD).size(34.0).color(t.accent));
                ui.label(RichText::new("Sign out of other sessions?").size(17.0).semibold());
                ui.label(widgets::muted(ui, "For security, end every other signed-in session now."));
            });
            widgets::dialog_footer(ui, |ui| {
                if widgets::primary_enabled(ui, !busy, if busy { "Signing out…" } else { "Yes" }).clicked() {
                    save(
                        tasks,
                        main,
                        "mfa",
                        |c| async move { c.revoke_other_sessions().await },
                        |main, toasts, r| {
                            toasts.success(match r.deleted_count {
                                0 => "No other sessions to sign out".to_string(),
                                n => format!(
                                    "Signed out of {}",
                                    tma_core::format::count(n as usize, "other session", "other sessions")
                                ),
                            });
                            main.settings.dialog = None;
                            main.settings.sessions =
                                main.settings.sessions.take().map(|l| l.into_iter().filter(|s| s.is_current).collect());
                        },
                    );
                }
                if widgets::secondary(ui, "Skip").clicked() {
                    main.settings.notice_ok = Some("Two-factor settings updated".into());
                    *keep = false;
                }
            });
        }
    }
}

fn status_enabled(ui: &mut egui::Ui, main: &mut Main, state: &mut MfaDialog) {
    if let Some(n) = main.settings.backup_codes {
        parts::note(
            ui,
            Tone::Warning,
            &format!("Backup codes: {n} remaining. Keep them somewhere safe; each code works only once."),
        );
        ui.add_space(6.0);
    }
    let now = ui.input(|i| i.time);
    let wait = main.settings.regenerate_after.map(|at| at - now).filter(|w| *w > 0.0);
    let label = match wait {
        Some(secs) => {
            ui.ctx().request_repaint_after(std::time::Duration::from_millis(500));
            format!("Wait {} to regenerate", forms::cooldown_label((secs * 1000.0) as i64))
        }
        None => format!("{}  Regenerate backup codes", ph::KEY),
    };
    let t = widgets::tokens(ui);
    ui.horizontal(|ui| {
        if ui.add_enabled(wait.is_none(), egui::Button::new(label)).clicked() {
            state.step = Step::ConfirmRegenerate;
        }
        let off =
            egui::Button::new(RichText::new(format!("{}  Disable MFA", ph::SHIELD_SLASH)).color(t.destructive_text));
        if ui.add(off).clicked() {
            state.code.clear();
            state.step = Step::Disable;
        }
    });
}

fn verify(ui: &mut egui::Ui, main: &mut Main, tasks: &Tasks, state: &mut MfaDialog, busy: bool) {
    let t = widgets::tokens(ui);
    ui.label(RichText::new("Scan this QR code with your authenticator app:").semibold());
    ui.add_space(6.0);
    if state.qr.is_none()
        && let Some(png) = &state.qr_png
    {
        state.qr = texture_from_png(ui.ctx(), png);
    }
    ui.vertical_centered(|ui| match &state.qr {
        Some(qr) => {
            egui::Frame::new().fill(egui::Color32::WHITE).corner_radius(12).inner_margin(10).show(ui, |ui| {
                ui.add(egui::Image::new((qr.id(), Vec2::splat(196.0))));
            });
        }
        None => {
            ui.spinner();
        }
    });
    if let Some(secret) = state.secret.clone() {
        ui.add_space(6.0);
        ui.label(RichText::new("Or enter this code manually:").size(12.0).color(t.label_secondary));
        ui.horizontal(|ui| {
            ui.add(egui::Label::new(RichText::new(&secret).monospace().size(12.5)).wrap());
            if widgets::icon_button(ui, ph::COPY, "Copy secret").clicked() {
                ui.ctx().copy_text(secret.clone());
            }
        });
    }
    ui.add_space(8.0);
    ui.label(RichText::new("Verification code").size(12.0).color(t.label_secondary));
    let enter = code_box(ui, &mut state.code, "000000");
    state.code = forms::totp_input(&state.code);
    parts::hint(ui, "Enter the 6-digit code from your authenticator app.");
    let ready = state.code.len() == 6 && !busy;
    widgets::dialog_footer(ui, |ui| {
        if widgets::primary_enabled(ui, ready, if busy { "Verifying…" } else { "Verify & enable" }).clicked()
            || (enter && ready)
        {
            let code = state.code.clone();
            save(
                tasks,
                main,
                "mfa",
                move |c| async move { c.mfa_verify(&code).await },
                |main, toasts, v| {
                    main.settings.mfa = Some(true);
                    main.user.mfa_enabled = true;
                    main.settings.backup_codes = Some(v.backup_codes.len() as i64);
                    toasts.success("Two-factor authentication is on");
                    let prompt = v.should_prompt_sessions;
                    with_dialog(main, |d| d.step = Step::Codes { codes: v.backup_codes.clone(), then_prompt: prompt });
                    if cfg!(target_arch = "wasm32") {
                        main.settings.save_codes = Some(v.backup_codes);
                    }
                },
            );
        }
        if widgets::secondary(ui, "Cancel").clicked() {
            state.code.clear();
            state.step = Step::Status;
        }
    });
}

fn disable(ui: &mut egui::Ui, main: &mut Main, tasks: &Tasks, state: &mut MfaDialog, busy: bool) {
    parts::note(
        ui,
        Tone::Danger,
        "Enter a verification code to turn off two-factor authentication. This removes the extra security layer from your account.",
    );
    ui.add_space(8.0);
    let enter = code_box(ui, &mut state.code, "000000 or ABCD-EFGH");
    state.code = forms::any_code_input(&state.code);
    parts::hint(ui, "The 6-digit code from your app, or an 8-character backup code (dashes are fine).");
    let code = forms::any_code(&state.code);
    let ready = code.is_some() && !busy;
    widgets::dialog_footer(ui, |ui| {
        if widgets::danger(ui, if busy { "Disabling…" } else { "Disable MFA" }).clicked() && ready || (enter && ready)
        {
            let code = code.clone().unwrap_or_default();
            attempt(
                tasks,
                main,
                "mfa",
                move |c| async move { c.mfa_disable(&code).await },
                |main, toasts, result| match result {
                    Ok(_) => {
                        main.settings.mfa = Some(false);
                        main.user.mfa_enabled = false;
                        main.settings.backup_codes = None;
                        toasts.success("Two-factor authentication is off");
                        with_dialog(main, |d| d.step = Step::SessionPrompt);
                    }
                    Err(err) => toasts.error(err.message),
                },
            );
        }
        if widgets::secondary(ui, "Cancel").clicked() {
            state.code.clear();
            state.step = Step::Status;
        }
    });
}

fn regenerate(main: &mut Main, tasks: &Tasks) {
    attempt(
        tasks,
        main,
        "mfa",
        |c| async move { c.mfa_regenerate_codes().await },
        |main, toasts, result| match result {
            Ok(v) => {
                main.settings.backup_codes = Some(v.backup_codes.len() as i64);
                main.settings.regenerate_from_now = Some(COOLDOWN_SECS);
                toasts.success("New backup codes created");
                with_dialog(main, |d| d.step = Step::Codes { codes: v.backup_codes.clone(), then_prompt: false });
                if cfg!(target_arch = "wasm32") {
                    main.settings.save_codes = Some(v.backup_codes);
                }
            }
            Err(err) => {
                if let Some(ms) = err.body.get("retryAfterMs").and_then(serde_json::Value::as_f64) {
                    main.settings.regenerate_from_now = Some(ms / 1000.0);
                }
                toasts.error(err.message);
                with_dialog(main, |d| d.step = Step::Status);
            }
        },
    );
}
