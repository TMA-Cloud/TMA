//! Sub-users: extra logins on the owner's account, each with the permissions
//! the owner ticks. Their actions are audited under their own name.

use egui::RichText;
use tma_core::api::{CreateSubUserRequest, SubUser};
use tma_core::permissions::PermissionInfo;

use super::parts::{self, Tone};
use super::{fetch, forms, save, section};
use crate::app::Main;
use crate::icons::ph;
use crate::tasks::Tasks;
use crate::theme::Weight;
use crate::widgets;

/// The add-a-sub-user form.
pub struct NewSubUser {
    name: String,
    email: String,
    password: String,
    permissions: Vec<String>,
    error: Option<String>,
}

pub fn load(main: &mut Main, tasks: &Tasks) {
    main.settings.sub_users = None;
    fetch(tasks, main, |c| async move { c.sub_users().await }, |s, v| s.sub_users = Some(v));
}

fn catalog(main: &Main) -> Vec<PermissionInfo> {
    main.settings
        .sub_users
        .as_ref()
        .map(|l| l.available_permissions.clone())
        .filter(|p| !p.is_empty())
        .unwrap_or_else(tma_core::permissions::catalog)
}

/// An allow-list of capabilities: one ticked row per permission; anything unticked is denied.
fn checklist(ui: &mut egui::Ui, available: &[PermissionInfo], value: &mut Vec<String>, enabled: bool) {
    let t = widgets::tokens(ui);
    widgets::card(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.add_enabled_ui(enabled, |ui| {
            ui.horizontal(|ui| {
                ui.label(RichText::new("Permissions").size(14.0).semibold().color(t.label));
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui.add_enabled(!value.is_empty(), egui::Button::new("Clear all")).clicked() {
                        value.clear();
                    }
                    let all = available.iter().all(|p| value.contains(&p.key));
                    if ui.add_enabled(!all, egui::Button::new("Select all")).clicked() {
                        *value = available.iter().map(|p| p.key.clone()).collect();
                    }
                });
            });
            for permission in available {
                widgets::separator(ui);
                let mut on = value.contains(&permission.key);
                ui.horizontal_top(|ui| {
                    if ui.checkbox(&mut on, "").changed() {
                        value.retain(|k| *k != permission.key);
                        if on {
                            value.push(permission.key.clone());
                        }
                        // Keep the catalog's order so the stored list is stable.
                        value.sort_by_key(|k| available.iter().position(|p| &p.key == k));
                    }
                    ui.vertical(|ui| {
                        ui.spacing_mut().item_spacing.y = 1.0;
                        ui.label(RichText::new(&permission.label).semibold());
                        ui.label(RichText::new(&permission.description).size(12.0).color(t.label_tertiary));
                    });
                });
            }
        });
        if value.is_empty() {
            ui.add_space(4.0);
            parts::note(ui, Tone::Warning, "With no permissions selected, this person can only browse and search.");
        }
    });
}

fn create_form(ui: &mut egui::Ui, main: &mut Main, tasks: &Tasks, available: &[PermissionInfo]) {
    let busy = main.settings.busy == Some("sub-user");
    let Some(form) = &mut main.settings.sub_user_form else { return };
    let mut submit = false;
    let mut cancel = false;
    widgets::card(ui, |ui| {
        ui.set_width(ui.available_width());
        widgets::form(ui, |ui| {
            parts::pair(
                ui,
                |ui| {
                    widgets::field(ui, "Name", &mut form.name, false, "Jane Doe");
                },
                |ui| {
                    widgets::field(ui, "Email", &mut form.email, false, "jane@example.com");
                },
            );
            parts::secret_field(ui, "Password", &mut form.password, "At least 8 characters");
            checklist(ui, available, &mut form.permissions, !busy);
            if let Some(error) = &form.error {
                widgets::error_text(ui, error);
            }
            ui.horizontal(|ui| {
                let label =
                    if busy { "Creating…".to_string() } else { format!("{}  Create sub-user", ph::USER_PLUS) };
                submit = widgets::primary_enabled(ui, !busy, label).clicked();
                cancel = ui.add_enabled_ui(!busy, |ui| widgets::secondary(ui, "Cancel")).inner.clicked();
            });
        });
    });
    if cancel {
        main.settings.sub_user_form = None;
        return;
    }
    if !submit {
        return;
    }
    form.error = if form.name.trim().is_empty() {
        Some("Enter a name for the sub-user.".into())
    } else if form.email.trim().is_empty() {
        Some("Enter an email address for the new sub-user.".into())
    } else if form.password.chars().count() < 8 {
        Some("The password needs at least 8 characters.".into())
    } else {
        None
    };
    if form.error.is_some() {
        return;
    }
    let body = CreateSubUserRequest {
        email: form.email.trim().into(),
        password: form.password.clone(),
        name: form.name.trim().into(),
        permissions: form.permissions.clone(),
    };
    super::attempt(
        tasks,
        main,
        "sub-user",
        move |c| async move { c.create_sub_user(&body).await },
        |main, toasts, result| match result {
            Ok(v) => {
                toasts.success(format!("{} can now sign in to this account", v.sub_user.email));
                if let Some(list) = &mut main.settings.sub_users {
                    list.sub_users.push(v.sub_user);
                }
                main.settings.sub_user_form = None;
            }
            Err(err) => {
                if let Some(form) = &mut main.settings.sub_user_form {
                    form.error = Some(err.message);
                }
            }
        },
    );
}

fn replace(main: &mut Main, sub: SubUser) {
    if let Some(list) = &mut main.settings.sub_users {
        for item in list.sub_users.iter_mut().filter(|s| s.id == sub.id) {
            *item = sub.clone();
        }
    }
}

fn row(ui: &mut egui::Ui, main: &mut Main, tasks: &Tasks, sub: &SubUser, available: &[PermissionInfo]) {
    let t = widgets::tokens(ui);
    let busy = main.settings.busy == Some("sub-user");
    let expanded = main.settings.sub_user_draft.as_ref().is_some_and(|d| d.0 == sub.id);
    let confirming = main.settings.sub_user_removing.as_deref() == Some(sub.id.as_str());
    widgets::card(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.horizontal(|ui| {
            ui.vertical(|ui| {
                ui.set_max_width((ui.available_width() - 200.0).max(160.0));
                ui.spacing_mut().item_spacing.y = 2.0;
                ui.label(
                    RichText::new(sub.name.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| "Unnamed".into()))
                        .semibold(),
                );
                ui.label(RichText::new(&sub.email).size(12.0).color(t.label_secondary));
                let summary = forms::permission_summary(&sub.permissions, available);
                let caret = if expanded { ph::CARET_DOWN } else { ph::CARET_RIGHT };
                let text = format!("{caret} {summary} ({}/{})", sub.permissions.len(), available.len());
                if ui
                    .add_enabled(!busy, egui::Button::new(RichText::new(text).size(12.0).color(t.accent)).frame(false))
                    .clicked()
                {
                    main.settings.sub_user_draft =
                        if expanded { None } else { Some((sub.id.clone(), sub.permissions.clone())) };
                }
                let mfa = if sub.mfa_enabled { "Two-factor on" } else { "Two-factor off" };
                let added = tma_core::format::full_date(sub.created_at);
                ui.label(RichText::new(format!("{mfa} · Added {added}")).size(12.0).color(t.label_tertiary));
            });
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if confirming {
                    if ui.add_enabled(!busy, egui::Button::new("Cancel")).clicked() {
                        main.settings.sub_user_removing = None;
                    }
                    if ui
                        .add_enabled(!busy, egui::Button::new(RichText::new("Yes, remove").color(t.destructive_text)))
                        .clicked()
                    {
                        let id = sub.id.clone();
                        save(
                            tasks,
                            main,
                            "sub-user",
                            move |c| async move { c.delete_sub_user(&id).await.map(|_| id) },
                            |main, toasts, id| {
                                if let Some(list) = &mut main.settings.sub_users {
                                    list.sub_users.retain(|s| s.id != id);
                                }
                                main.settings.sub_user_removing = None;
                                toasts.success("Sub-user removed");
                            },
                        );
                    }
                } else if ui
                    .add_enabled(
                        !busy,
                        egui::Button::new(RichText::new(ph::TRASH).color(t.destructive_text)).frame(false),
                    )
                    .on_hover_text(format!("Remove {}", sub.email))
                    .clicked()
                {
                    main.settings.sub_user_removing = Some(sub.id.clone());
                }
            });
        });
        if !expanded {
            return;
        }
        let Some((_, draft)) = &mut main.settings.sub_user_draft else { return };
        ui.add_space(6.0);
        checklist(ui, available, draft, !busy);
        let draft = draft.clone();
        ui.horizontal(|ui| {
            if widgets::primary_enabled(ui, !busy, if busy { "Saving…" } else { "Save permissions" }).clicked() {
                let id = sub.id.clone();
                save(
                    tasks,
                    main,
                    "sub-user",
                    move |c| async move { c.update_sub_user(&id, &draft).await },
                    |main, toasts, v| {
                        replace(main, v.sub_user);
                        main.settings.sub_user_draft = None;
                        toasts.success("Permissions updated");
                    },
                );
            }
            if ui.add_enabled(!busy, egui::Button::new("Cancel")).clicked() {
                main.settings.sub_user_draft = None;
            }
        });
    });
}

pub fn show(main: &mut Main, ui: &mut egui::Ui, tasks: &Tasks) {
    widgets::heading(ui, ph::USERS, "Sub-users", "People who share your files and storage");
    if main.user.is_sub_user {
        ui.label(widgets::muted(ui, "Only the account owner can manage sub-users."));
        return;
    }
    let list = main.settings.sub_users.clone();
    let available = catalog(main);
    // The count lives in the list's own header; one line of context says what a sub-user is.
    let about = "Each signs in with their own email and password and can only do what you allow. The audit log shows who did what.";
    section(ui, "Your sub-users", about, |ui| {
        // The list and its controls form one padded row of the section card.
        widgets::row_frame(ui).show(ui, |ui| {
            ui.spacing_mut().item_spacing.y = 6.0;
            let header = list.as_ref().map_or("Loading sub-users…".to_string(), |l| match l.sub_users.len() {
                0 => "No sub-users yet".into(),
                n => tma_core::format::count(n, "sub-user", "sub-users"),
            });
            if parts::count_header(ui, &header, list.is_none()) {
                load(main, tasks);
            }
            if main.settings.sub_user_form.is_some() {
                create_form(ui, main, tasks, &available);
            } else if widgets::primary(ui, format!("{}  Add sub-user", ph::USER_PLUS)).clicked() {
                // Full access is the common case for a colleague who needs the same files.
                let permissions = available.iter().map(|p| p.key.clone()).collect();
                main.settings.sub_user_form = Some(NewSubUser {
                    name: String::new(),
                    email: String::new(),
                    password: String::new(),
                    permissions,
                    error: None,
                });
            }
            ui.add_space(6.0);
            match &list {
                None => {
                    ui.spinner();
                }
                Some(l) if l.sub_users.is_empty() => {}
                Some(l) => {
                    for sub in &l.sub_users {
                        row(ui, main, tasks, sub, &available);
                        ui.add_space(4.0);
                    }
                }
            }
        });
    });
}
