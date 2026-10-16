//! Settings dialogs: MFA setup and backup codes, sessions, users, desktop
//! clients, orphan review and the sub-user editor.

use std::collections::BTreeSet;

use egui::{Key, RichText};
use tma_core::api::{CreateSubUserRequest, MfaSetup, SubUser};

use super::save;
use crate::app::{App, Screen};
use crate::icons::ph;
use crate::theme::Weight;
use crate::widgets;

pub struct MfaSetupState {
    secret: Option<String>,
    qr_png: Option<Vec<u8>>,
    qr: Option<egui::TextureHandle>,
    code: String,
}

impl MfaSetupState {
    pub fn set_secret(&mut self, setup: MfaSetup) {
        let b64 = setup.qr_code.split_once("base64,").map(|(_, b)| b).unwrap_or("");
        self.qr_png = data_encoding::BASE64.decode(b64.as_bytes()).ok();
        self.secret = Some(setup.secret);
    }
}

pub struct SubUserForm {
    editing: Option<SubUser>,
    name: String,
    email: String,
    password: String,
    permissions: BTreeSet<String>,
}

impl SubUserForm {
    pub fn new(editing: Option<SubUser>) -> Self {
        let permissions = editing
            .as_ref()
            .map(|s| s.permissions.iter().cloned().collect())
            .unwrap_or_else(|| ["files.download".to_string(), "files.upload".to_string()].into());
        Self {
            name: editing.as_ref().and_then(|s| s.name.clone()).unwrap_or_default(),
            email: editing.as_ref().map(|s| s.email.clone()).unwrap_or_default(),
            password: String::new(),
            permissions,
            editing,
        }
    }
}

#[derive(Default)]
pub struct OrphanState {
    pub grace_hours: String,
    pub keys: BTreeSet<String>,
    pub ids: BTreeSet<String>,
    pub scanning: bool,
}

pub enum Dialog {
    MfaSetup(MfaSetupState),
    MfaDisable(String),
    BackupCodes(Vec<String>),
    Sessions,
    Users,
    Clients,
    Orphans(OrphanState),
    SubUser(SubUserForm),
    RemoveSubUser(SubUser),
}

impl Dialog {
    pub fn mfa_setup() -> Self {
        Self::MfaSetup(MfaSetupState { secret: None, qr_png: None, qr: None, code: String::new() })
    }
}

fn texture_from_png(ctx: &egui::Context, png: &[u8]) -> Option<egui::TextureHandle> {
    let image = image::load_from_memory(png).ok()?.to_rgba8();
    let color =
        egui::ColorImage::from_rgba_unmultiplied([image.width() as usize, image.height() as usize], image.as_raw());
    Some(ctx.load_texture("mfa-qr", color, egui::TextureOptions::NEAREST))
}

fn codes_list(ui: &mut egui::Ui, codes: &[String]) {
    egui::Grid::new("codes").num_columns(2).spacing([24.0, 6.0]).show(ui, |ui| {
        for (i, code) in codes.iter().enumerate() {
            ui.label(RichText::new(code).monospace().size(14.0));
            if i % 2 == 1 {
                ui.end_row();
            }
        }
    });
    ui.add_space(8.0);
    if widgets::secondary(ui, format!("{}  Copy all", ph::COPY)).clicked() {
        ui.ctx().copy_text(codes.join("\n"));
    }
}

pub fn show(app: &mut App, ctx: &egui::Context) {
    let t = app.t;
    let Screen::Main(main) = &mut app.screen else { return };
    let Some(dialog) = main.settings.dialog.take() else { return };
    let mut keep = true;
    let width = match dialog {
        Dialog::Users | Dialog::Orphans(_) => 760.0,
        Dialog::Sessions | Dialog::Clients => 620.0,
        _ => 420.0,
    };
    let mut dialog = dialog;
    let tasks = &app.tasks;
    let response = widgets::modal(ctx, "settings-dialog").show(ctx, |ui| {
        ui.set_min_width(width);
        ui.set_max_width(width);
        match &mut dialog {
            Dialog::MfaSetup(state) => {
                ui.label(RichText::new("Set up two-factor authentication").size(17.0).semibold());
                ui.label(widgets::muted(ui, "Scan the code with an authenticator app, then enter the 6-digit code it shows."));
                ui.add_space(10.0);
                if state.qr.is_none()
                    && let Some(png) = &state.qr_png
                {
                    state.qr = texture_from_png(ctx, png);
                }
                match (&state.qr, &state.secret) {
                    (Some(qr), Some(secret)) => {
                        ui.vertical_centered(|ui| {
                            ui.add(egui::Image::new((qr.id(), egui::Vec2::splat(180.0))));
                            ui.label(RichText::new(secret).monospace().size(12.0).color(t.label_secondary));
                        });
                    }
                    _ => {
                        ui.spinner();
                    }
                }
                ui.add_space(8.0);
                let r = widgets::field(ui, "Code", &mut state.code, false, "123456");
                let enter = r.lost_focus() && ui.input(|i| i.key_pressed(Key::Enter));
                ui.add_space(10.0);
                ui.horizontal(|ui| {
                    let ok = state.code.trim().len() >= 6;
                    if widgets::primary_enabled(ui, ok, "Turn on").clicked() || (enter && ok) {
                        let code = state.code.trim().to_string();
                        save(tasks, main, "mfa", move |c| async move { c.mfa_verify(&code).await }, |main, toasts, v| {
                            main.settings.mfa = Some(true);
                            main.user.mfa_enabled = true;
                            main.settings.backup_codes = Some(v.backup_codes.len() as i64);
                            main.settings.dialog = Some(Dialog::BackupCodes(v.backup_codes));
                            toasts.success("Two-factor authentication is on");
                        });
                        keep = false;
                    }
                    if widgets::secondary(ui, "Cancel").clicked() {
                        keep = false;
                    }
                });
            }
            Dialog::MfaDisable(code) => {
                ui.label(RichText::new("Turn off two-factor authentication?").size(17.0).semibold());
                ui.label(widgets::muted(ui, "Enter a code from your authenticator app or a backup code."));
                ui.add_space(8.0);
                widgets::field(ui, "Code", code, false, "123456");
                ui.add_space(10.0);
                ui.horizontal(|ui| {
                    if widgets::danger(ui, "Turn off").clicked() && !code.trim().is_empty() {
                        let code = code.trim().to_string();
                        save(tasks, main, "mfa", move |c| async move { c.mfa_disable(&code).await }, |main, toasts, _| {
                            main.settings.mfa = Some(false);
                            main.user.mfa_enabled = false;
                            toasts.success("Two-factor authentication is off");
                        });
                        keep = false;
                    }
                    if widgets::secondary(ui, "Cancel").clicked() {
                        keep = false;
                    }
                });
            }
            Dialog::BackupCodes(codes) => {
                ui.label(RichText::new("Backup codes").size(17.0).semibold());
                ui.label(widgets::muted(ui, "Each code signs you in once if you lose your phone. Store them somewhere safe; they are shown only now."));
                ui.add_space(10.0);
                if codes.is_empty() {
                    ui.spinner();
                } else {
                    codes_list(ui, codes);
                }
                ui.add_space(10.0);
                if widgets::primary(ui, "Done").clicked() {
                    keep = false;
                }
            }
            Dialog::Sessions => sessions(ui, main, tasks, &mut keep),
            Dialog::Users => super::dialogs_admin::users(ui, main, tasks, &mut keep),
            Dialog::Clients => super::dialogs_admin::clients(ui, main, &mut keep),
            Dialog::Orphans(state) => super::dialogs_admin::orphans(ui, main, tasks, state, &mut keep),
            Dialog::SubUser(form) => sub_user(ui, main, tasks, form, &mut keep),
            Dialog::RemoveSubUser(sub) => {
                ui.label(RichText::new(format!("Remove {}?", sub.email)).size(17.0).semibold());
                ui.label(widgets::muted(ui, "They are signed out everywhere. The files stay in your account."));
                ui.add_space(10.0);
                ui.horizontal(|ui| {
                    if widgets::danger(ui, "Remove").clicked() {
                        let id = sub.id.clone();
                        save(
                            tasks,
                            main,
                            "sub-user",
                            move |c| async move {
                                c.delete_sub_user(&id).await?;
                                c.sub_users().await
                            },
                            |main, toasts, list| {
                                toasts.success("Sub-user removed");
                                main.settings.sub_users = Some(list);
                            },
                        );
                        keep = false;
                    }
                    if widgets::secondary(ui, "Cancel").clicked() {
                        keep = false;
                    }
                });
            }
        }
    });
    if response.should_close() {
        keep = false;
    }
    if main.settings.dialog.is_none() {
        main.settings.dialog = keep.then_some(dialog);
    }
}

fn sessions(ui: &mut egui::Ui, main: &mut crate::app::Main, tasks: &crate::tasks::Tasks, keep: &mut bool) {
    let t = widgets::tokens(ui);
    ui.label(RichText::new("Signed-in devices").size(17.0).semibold());
    ui.add_space(8.0);
    let Some(list) = main.settings.sessions.clone() else {
        ui.spinner();
        return;
    };
    egui::ScrollArea::vertical().max_height(380.0).show(ui, |ui| {
        for s in &list {
            ui.horizontal(|ui| {
                ui.label(RichText::new(ph::DEVICES).size(18.0).color(t.label_tertiary));
                ui.vertical(|ui| {
                    let agent = s.user_agent.clone().unwrap_or_else(|| "Unknown device".into());
                    ui.add(egui::Label::new(RichText::new(agent).semibold()).truncate());
                    let seen = tma_core::format::relative_date(s.last_activity, chrono::Utc::now());
                    ui.label(
                        RichText::new(format!("{} · {seen}", s.ip_address.clone().unwrap_or_default()))
                            .size(11.0)
                            .color(t.label_tertiary),
                    );
                });
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if s.is_current {
                        widgets::badge(ui, "This device", t.positive_text);
                    } else if widgets::secondary(ui, "Sign out").clicked() {
                        let id = s.id.clone();
                        save(
                            tasks,
                            main,
                            "session",
                            move |c| async move { c.revoke_session(&id).await },
                            |_, toasts, _| toasts.success("Signed out"),
                        );
                        main.settings.sessions = Some(list.iter().filter(|x| x.id != s.id).cloned().collect());
                    }
                });
            });
            widgets::separator(ui);
        }
    });
    ui.horizontal(|ui| {
        if widgets::secondary(ui, "Sign out all other devices").clicked() {
            save(
                tasks,
                main,
                "session",
                |c| async move { c.revoke_other_sessions().await },
                |main, toasts, r| {
                    toasts.success(r.message);
                    main.settings.sessions =
                        main.settings.sessions.take().map(|l| l.into_iter().filter(|s| s.is_current).collect());
                },
            );
        }
        if widgets::primary(ui, "Done").clicked() {
            *keep = false;
        }
    });
}

fn sub_user(
    ui: &mut egui::Ui,
    main: &mut crate::app::Main,
    tasks: &crate::tasks::Tasks,
    form: &mut SubUserForm,
    keep: &mut bool,
) {
    let t = widgets::tokens(ui);
    let editing = form.editing.clone();
    ui.label(
        RichText::new(if editing.is_some() { "Edit permissions" } else { "Add a sub-user" }).size(17.0).semibold(),
    );
    ui.add_space(8.0);
    if editing.is_none() {
        widgets::field(ui, "Name", &mut form.name, false, "Their name");
        widgets::field(ui, "Email", &mut form.email, false, "name@example.com");
        widgets::field(ui, "Password", &mut form.password, true, "At least 8 characters");
        ui.add_space(8.0);
    } else {
        ui.label(widgets::muted(ui, form.email.clone()));
        ui.add_space(6.0);
    }
    ui.label(RichText::new("Permissions").semibold());
    for permission in tma_core::permissions::ALL {
        let key = permission.key().to_string();
        let mut on = form.permissions.contains(&key);
        ui.horizontal(|ui| {
            if ui.checkbox(&mut on, "").changed() {
                if on {
                    form.permissions.insert(key.clone());
                } else {
                    form.permissions.remove(&key);
                }
            }
            ui.vertical(|ui| {
                ui.label(permission.label());
                ui.label(RichText::new(permission.description()).size(11.0).color(t.label_tertiary));
            });
        });
    }
    ui.add_space(10.0);
    ui.horizontal(|ui| {
        let permissions: Vec<String> = form.permissions.iter().cloned().collect();
        let ready = editing.is_some()
            || (!form.name.trim().is_empty() && !form.email.trim().is_empty() && form.password.len() >= 8);
        if widgets::primary_enabled(ui, ready, if editing.is_some() { "Save" } else { "Add sub-user" }).clicked() {
            match editing {
                Some(sub) => save(
                    tasks,
                    main,
                    "sub-user",
                    move |c| async move {
                        c.update_sub_user(&sub.id, &permissions).await?;
                        c.sub_users().await
                    },
                    |main, toasts, list| {
                        toasts.success("Permissions saved");
                        main.settings.sub_users = Some(list);
                    },
                ),
                None => {
                    let body = CreateSubUserRequest {
                        email: form.email.trim().into(),
                        password: form.password.clone(),
                        name: form.name.trim().into(),
                        permissions,
                    };
                    save(
                        tasks,
                        main,
                        "sub-user",
                        move |c| async move {
                            c.create_sub_user(&body).await?;
                            c.sub_users().await
                        },
                        |main, toasts, list| {
                            toasts.success("Sub-user added");
                            main.settings.sub_users = Some(list);
                        },
                    );
                }
            }
            *keep = false;
        }
        if widgets::secondary(ui, "Cancel").clicked() {
            *keep = false;
        }
    });
}
