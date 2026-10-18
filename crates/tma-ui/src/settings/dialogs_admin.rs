//! Administration dialogs: every account with its storage and limit, and the
//! desktop clients online now.

use egui::{Key, RichText};
use tma_core::api::{AdminUser, AdminUserPage};

use super::forms::{self, Unit};
use super::parts::{self, Tone};
use super::users_table::{self, Col};
use super::{LimitEdit, fetch, save};
use crate::app::Main;
use crate::icons::ph;
use crate::tasks::Tasks;
use crate::theme::Weight;
use crate::widgets;

pub fn load_users(main: &mut Main, tasks: &Tasks) {
    main.settings.users = None;
    main.settings.limit_edit = None;
    fetch(tasks, main, |c| async move { c.users(None).await }, |s, v| s.users = Some(v));
}

pub fn load_clients(main: &mut Main, tasks: &Tasks) {
    main.settings.clients = None;
    fetch(tasks, main, |c| async move { c.active_clients().await }, |s, v| s.clients = Some(v));
}

fn load_more(main: &mut Main, tasks: &Tasks) {
    let Some(cursor) = main.settings.users.as_ref().and_then(|p| p.next_cursor.clone()) else { return };
    if main.settings.users_more {
        return;
    }
    main.settings.users_more = true;
    let generation = main.generation;
    let client = main.client.clone();
    tasks.run(async move { client.users(Some(&cursor)).await }, move |app, result| {
        if let Some(main) = app.main_mut(generation) {
            main.settings.users_more = false;
        }
        app.finish(generation, result, |main, _, page| {
            if let Some(list) = &mut main.settings.users {
                let fresh: Vec<AdminUser> =
                    page.users.into_iter().filter(|u| !list.users.iter().any(|k| k.id == u.id)).collect();
                list.users.extend(fresh);
                list.next_cursor = page.next_cursor;
            }
        });
    });
}

/// Save a limit (None removes it) and reload the list.
fn set_limit(main: &mut Main, tasks: &Tasks, user_id: String, limit: Option<i64>) {
    let own = user_id == main.user.id;
    save(
        tasks,
        main,
        "limit",
        move |c| async move {
            c.set_storage_limit(&user_id, limit).await?;
            c.users(None).await
        },
        move |main, toasts, page| {
            main.settings.users = Some(page);
            main.settings.limit_edit = None;
            main.settings.limit_error = None;
            toasts.success(if limit.is_some() { "Storage limit updated" } else { "Storage limit removed" });
            if own {
                main.instance.usage = None;
                main.settings.reload_usage = true;
            }
        },
    );
}

/// The limit cell: the value, which opens the editor below the row.
fn limit_cell(ui: &mut egui::Ui, main: &mut Main, user: &AdminUser) {
    let t = widgets::tokens(ui);
    let busy = main.settings.busy == Some("limit");
    let value = user.storage_limit.filter(|l| *l > 0).map(tma_core::format::file_size);
    let color = if value.is_some() { t.label } else { t.label_secondary };
    let text = RichText::new(format!("{}  {}", value.unwrap_or_else(|| "Default".into()), ph::PENCIL_SIMPLE))
        .size(13.0)
        .color(color);
    if ui.add_enabled(!busy, egui::Button::new(text).frame(false)).on_hover_text("Edit storage limit").clicked() {
        let (value, unit) = forms::split_size(user.storage_limit, Unit::Tb);
        main.settings.limit_edit = Some(LimitEdit { user_id: user.id.clone(), value, unit });
        main.settings.limit_error = None;
    }
}

/// The storage limit editor, in a strip under the account it edits.
fn limit_editor(ui: &mut egui::Ui, main: &mut Main, tasks: &Tasks, user: &AdminUser) {
    let t = widgets::tokens(ui);
    let busy = main.settings.busy == Some("limit");
    let Some(edit) = &mut main.settings.limit_edit else { return };
    let mut action = None;
    egui::Frame::new().inner_margin(egui::Margin { left: 54, right: 14, top: 2, bottom: 12 }).show(ui, |ui| {
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 8.0;
            ui.label(RichText::new("Storage limit").size(13.0).color(t.label_secondary));
            let field = egui::TextEdit::singleline(&mut edit.value)
                .desired_width(72.0)
                .hint_text("Default")
                .margin(egui::Margin::symmetric(8, 6));
            let r = ui.add_enabled_ui(!busy, |ui| widgets::bordered_field(ui, field)).inner;
            if r.lost_focus() && ui.input(|i| i.key_pressed(Key::Enter)) {
                action = Some("save");
            }
            if ui.input(|i| i.key_pressed(Key::Escape)) {
                action = Some("cancel");
            }
            egui::ComboBox::from_id_salt(("unit", &user.id)).selected_text(edit.unit.label()).width(56.0).show_ui(
                ui,
                |ui| {
                    for unit in Unit::ALL {
                        ui.selectable_value(&mut edit.unit, unit, unit.label());
                    }
                },
            );
            if widgets::primary_enabled(ui, !busy, "Save").clicked() {
                action = Some("save");
            }
            if ui.add_enabled(!busy, egui::Button::new("Use default")).clicked() {
                action = Some("reset");
            }
            if ui.add_enabled(!busy, egui::Button::new("Cancel").frame(false)).clicked() {
                action = Some("cancel");
            }
        });
    });
    let (value, unit) = (edit.value.clone(), edit.unit);
    match action {
        Some("cancel") => main.settings.limit_edit = None,
        Some("reset") => set_limit(main, tasks, user.id.clone(), None),
        Some(_) if value.trim().is_empty() => set_limit(main, tasks, user.id.clone(), None),
        Some(_) => match forms::size_bytes(&value, unit) {
            None => main.settings.limit_error = Some("Enter a positive number".into()),
            Some(bytes) if bytes < user.storage_used => {
                main.settings.limit_error = Some(format!(
                    "The limit can't be below the {} already stored",
                    tma_core::format::file_size(user.storage_used)
                ));
            }
            Some(bytes) => set_limit(main, tasks, user.id.clone(), Some(bytes)),
        },
        None => {}
    }
}

pub fn users(ui: &mut egui::Ui, main: &mut Main, tasks: &Tasks, keep: &mut bool) {
    let page = main.settings.users.clone();
    let rows = page.as_ref().map(|p| forms::account_rows(&p.users)).unwrap_or_default();
    let count = match &page {
        None => "Loading users…".to_string(),
        Some(p) if p.users.is_empty() => "No users to display yet".into(),
        Some(p) => {
            let accounts = rows.iter().filter(|(_, owner)| owner.is_none()).count();
            let subs = p.users.len() - accounts;
            let base = tma_core::format::count(accounts, "account", "accounts");
            if subs > 0 {
                format!("{base} · {}", tma_core::format::count(subs, "sub-user", "sub-users"))
            } else {
                format!("{base} total")
            }
        }
    };
    if parts::count_header(ui, &count, page.is_none()) {
        load_users(main, tasks);
    }
    let Some(page) = page else {
        ui.vertical_centered(|ui| ui.spinner());
        return;
    };
    if page.users.is_empty() {
        ui.add_space(8.0);
        ui.label(widgets::muted(ui, "Accounts appear here once people sign up."));
    } else {
        ui.add_space(10.0);
        users_table::adoption(ui, &page.users);
        ui.add_space(12.0);
        if let Some(error) = main.settings.limit_error.clone() {
            widgets::error_text(ui, &error);
            ui.add_space(6.0);
        }
        if users_list(ui, main, tasks, &page, &rows) {
            load_more(main, tasks);
        }
    }
    widgets::dialog_footer(ui, |ui| {
        if widgets::primary(ui, "Done").clicked() {
            *keep = false;
        }
    });
}

/// The table of accounts; true when its end has scrolled into view and more can load.
fn users_list(
    ui: &mut egui::Ui,
    main: &mut Main,
    tasks: &Tasks,
    page: &AdminUserPage,
    rows: &[(usize, Option<usize>)],
) -> bool {
    let mut reached_end = false;
    users_table::card(ui, |ui| {
        let cols = users_table::layout(ui.available_width() - 28.0);
        users_table::header(ui, &cols);
        egui::ScrollArea::vertical().max_height(ui.ctx().content_rect().height() * 0.5).show(ui, |ui| {
            for &(index, owner) in rows {
                let user = &page.users[index];
                let sub = owner.is_some();
                users_table::row(ui, &cols, if sub { 48.0 } else { 56.0 }, |ui, col| match col {
                    Col::User => users_table::identity(ui, user, sub),
                    Col::Storage => users_table::storage(ui, user, sub),
                    Col::Limit if sub => {
                        ui.label(widgets::muted(ui, "Inherited"));
                    }
                    Col::Limit => limit_cell(ui, main, user),
                    Col::Mfa => users_table::mfa(ui, user.mfa_enabled),
                    Col::Joined => users_table::joined(ui, user),
                });
                if main.settings.limit_edit.as_ref().is_some_and(|e| e.user_id == user.id) {
                    limit_editor(ui, main, tasks, user);
                }
            }
            if page.next_cursor.is_some() {
                ui.add_space(8.0);
                let r = ui.horizontal(|ui| {
                    if main.settings.users_more {
                        ui.spinner();
                    } else if ui.button("Load more").clicked() {
                        reached_end = true;
                    }
                });
                reached_end |= ui.is_rect_visible(r.response.rect);
            }
        });
    });
    reached_end
}

pub fn clients(ui: &mut egui::Ui, main: &mut Main, tasks: &Tasks, keep: &mut bool) {
    let t = widgets::tokens(ui);
    let list = main.settings.clients.clone();
    let count = list.as_ref().map_or("Loading clients…".to_string(), |l| match l.clients.len() {
        0 => "No active desktop clients".into(),
        n => tma_core::format::count(n, "active client", "active clients"),
    });
    if parts::count_header(ui, &count, list.is_none()) {
        load_clients(main, tasks);
    }
    let Some(list) = list else {
        ui.vertical_centered(|ui| ui.spinner());
        return;
    };
    let groups = forms::version_groups(&list.clients);
    if groups.len() > 1 {
        ui.horizontal_wrapped(|ui| {
            for (version, n) in &groups {
                parts::chip(ui, Tone::Info, &format!("v{version} × {n}"));
            }
        });
    }
    if list.clients.is_empty() {
        ui.add_space(6.0);
        ui.label(widgets::muted(ui, "No desktop app has been active in the last 5 minutes."));
    }
    egui::ScrollArea::vertical().max_height(ui.ctx().content_rect().height() * 0.55).show(ui, |ui| {
        for c in &list.clients {
            widgets::card(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.horizontal_top(|ui| {
                    ui.label(RichText::new(ph::DESKTOP).size(18.0).color(t.label_tertiary));
                    ui.vertical(|ui| {
                        ui.set_max_width(ui.available_width() - 90.0);
                        // Who first, then where and when; the chip beside it already gives the version.
                        ui.spacing_mut().item_spacing.y = 2.0;
                        let email = c.user_email.clone().unwrap_or_default();
                        ui.label(
                            RichText::new(c.user_name.clone().unwrap_or_else(|| email.clone())).size(14.0).semibold(),
                        );
                        if c.user_name.is_some() {
                            ui.label(RichText::new(email).size(13.0).color(t.label_secondary));
                        }
                        ui.add_space(4.0);
                        let small = |text: String| RichText::new(text).size(12.0).color(t.label_tertiary);
                        let platform = forms::platform_label(c.platform.as_deref());
                        let place = match &c.ip_address {
                            Some(ip) => format!("{platform}, {ip}"),
                            None => platform.to_string(),
                        };
                        ui.label(small(place));
                        ui.label(small(format!("Last seen {}", tma_core::format::full_date(c.last_seen_at))));
                    });
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Min), |ui| {
                        parts::chip(ui, Tone::Success, &format!("v{}", c.app_version));
                    });
                });
            });
            ui.add_space(4.0);
        }
    });
    widgets::dialog_footer(ui, |ui| {
        if widgets::primary(ui, "Done").clicked() {
            *keep = false;
        }
    });
}
