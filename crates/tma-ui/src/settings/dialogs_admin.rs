//! Administration dialogs: every user with storage limits, desktop clients
//! online now, and the orphan review.

use egui::RichText;

use super::dialogs::OrphanState;
use super::save;
use crate::app::Main;
use crate::icons::ph;
use crate::tasks::Tasks;
use crate::theme::Weight;
use crate::widgets;

const GIB: f64 = 1024.0 * 1024.0 * 1024.0;

pub fn users(ui: &mut egui::Ui, main: &mut Main, tasks: &Tasks, keep: &mut bool) {
    let t = widgets::tokens(ui);
    ui.label(RichText::new("Registered users").size(17.0).semibold());
    ui.add_space(8.0);
    let Some(page) = main.settings.users.clone() else {
        ui.spinner();
        return;
    };
    let mut set_limit: Option<(String, Option<i64>)> = None;
    egui::ScrollArea::vertical().max_height(420.0).show(ui, |ui| {
        egui::Grid::new("users").num_columns(6).striped(true).spacing([14.0, 8.0]).show(ui, |ui| {
            for h in ["Name", "Email", "Storage", "Limit", "MFA", "Joined"] {
                ui.label(RichText::new(h).size(11.0).semibold().color(t.label_tertiary));
            }
            ui.end_row();
            for user in &page.users {
                let sub = user.parent_user_id.is_some();
                ui.horizontal(|ui| {
                    if sub {
                        ui.label(RichText::new("↳").color(t.label_tertiary));
                    }
                    ui.label(user.name.clone().unwrap_or_default());
                    if sub {
                        widgets::badge(ui, "Sub-user", t.accent);
                    }
                });
                ui.label(&user.email);
                ui.label(if sub {
                    "Shares owner's".to_string()
                } else {
                    tma_core::format::file_size(user.storage_used)
                });
                if sub {
                    ui.label(RichText::new("Inherited").color(t.label_tertiary));
                } else {
                    let id = egui::Id::new(("limit", &user.id));
                    let mut text = ui.data_mut(|d| d.get_temp::<String>(id)).unwrap_or_else(|| {
                        user.storage_limit
                            .map(|l| format!("{}", (l as f64 / GIB * 100.0).round() / 100.0))
                            .unwrap_or_default()
                    });
                    let r = ui.add(egui::TextEdit::singleline(&mut text).desired_width(70.0).hint_text("No limit"));
                    if r.changed() {
                        ui.data_mut(|d| d.insert_temp(id, text.clone()));
                    }
                    if r.lost_focus() {
                        let limit = text.trim().parse::<f64>().ok().filter(|v| *v > 0.0).map(|gb| (gb * GIB) as i64);
                        if limit != user.storage_limit {
                            set_limit = Some((user.id.clone(), limit));
                        }
                        ui.data_mut(|d| d.remove::<String>(id));
                    }
                }
                ui.label(if user.mfa_enabled {
                    RichText::new("On").color(t.positive_text)
                } else {
                    RichText::new("Off").color(t.label_tertiary)
                });
                ui.label(user.created_at.format("%b %-d, %Y").to_string());
                ui.end_row();
            }
        });
    });
    if let Some((id, limit)) = set_limit {
        save(
            tasks,
            main,
            "limit",
            move |c| async move {
                c.set_storage_limit(&id, limit).await?;
                c.users(None).await
            },
            |main, toasts, page| {
                main.settings.users = Some(page);
                toasts.success("Storage limit saved");
            },
        );
    }
    ui.add_space(8.0);
    ui.label(widgets::muted(ui, "Limits are in GB; leave empty for no limit."));
    ui.add_space(8.0);
    if widgets::primary(ui, "Done").clicked() {
        *keep = false;
    }
}

pub fn clients(ui: &mut egui::Ui, main: &mut Main, keep: &mut bool) {
    let t = widgets::tokens(ui);
    ui.label(RichText::new("Active desktop clients").size(17.0).semibold());
    ui.add_space(8.0);
    match &main.settings.clients {
        None => {
            ui.spinner();
        }
        Some(list) if list.clients.is_empty() => {
            ui.label(widgets::muted(ui, "No desktop app has checked in during the last 5 minutes."));
        }
        Some(list) => {
            let now = chrono::Utc::now();
            for c in &list.clients {
                ui.horizontal(|ui| {
                    ui.label(RichText::new(ph::DESKTOP).size(18.0).color(t.label_tertiary));
                    ui.vertical(|ui| {
                        ui.label(
                            RichText::new(c.user_name.clone().or(c.user_email.clone()).unwrap_or_default()).semibold(),
                        );
                        let detail = format!(
                            "v{} · {} · {} · seen {}",
                            c.app_version,
                            c.platform.clone().unwrap_or_default(),
                            c.ip_address.clone().unwrap_or_default(),
                            tma_core::format::relative_date(c.last_seen_at, now)
                        );
                        ui.label(RichText::new(detail).size(11.0).color(t.label_tertiary));
                    });
                });
                widgets::separator(ui);
            }
        }
    }
    ui.add_space(8.0);
    if widgets::primary(ui, "Done").clicked() {
        *keep = false;
    }
}

pub fn orphans(ui: &mut egui::Ui, main: &mut Main, tasks: &Tasks, state: &mut OrphanState, keep: &mut bool) {
    let t = widgets::tokens(ui);
    ui.label(RichText::new("Orphaned files").size(17.0).semibold());
    ui.label(widgets::muted(ui, "Objects in the bucket with no file record, and records whose object is missing. Recent items are skipped so uploads in progress are never touched."));
    ui.add_space(8.0);
    ui.horizontal(|ui| {
        ui.label("Skip items newer than");
        widgets::text_edit(ui, &mut state.grace_hours, "24", 50.0);
        ui.label("hours");
        let grace = state.grace_hours.trim().parse::<i64>().ok().map(|h| h * 60);
        if widgets::secondary(ui, if state.scanning { "Scanning…" } else { "Scan" }).clicked() && !state.scanning {
            state.scanning = true;
            state.keys.clear();
            state.ids.clear();
            save(
                tasks,
                main,
                "orphans",
                move |c| async move { c.scan_orphans(grace).await },
                |main, _, report| {
                    main.settings.orphans = Some(report);
                    if let Some(super::dialogs::Dialog::Orphans(s)) = &mut main.settings.dialog {
                        s.scanning = false;
                    }
                },
            );
        }
    });
    if main.settings.busy != Some("orphans") {
        state.scanning = false;
    }
    let Some(report) = main.settings.orphans.clone() else {
        if state.scanning {
            ui.spinner();
        }
        ui.add_space(8.0);
        if widgets::secondary(ui, "Close").clicked() {
            *keep = false;
        }
        return;
    };
    ui.add_space(8.0);
    ui.label(format!(
        "Scanned {} objects and {} records; {} too recent to judge.",
        report.totals.stored_objects, report.totals.database_rows, report.totals.skipped_too_recent
    ));
    egui::ScrollArea::vertical().max_height(360.0).show(ui, |ui| {
        widgets::section_title(
            ui,
            &format!(
                "Stored without a record ({}, {})",
                report.storage_orphans.count,
                tma_core::format::file_size(report.storage_orphans.total_bytes)
            ),
        );
        for item in &report.storage_orphans.items {
            let mut on = state.keys.contains(&item.key);
            if ui.checkbox(&mut on, format!("{}  ·  {}", item.key, tma_core::format::file_size(item.size))).changed() {
                if on {
                    state.keys.insert(item.key.clone());
                } else {
                    state.keys.remove(&item.key);
                }
            }
        }
        widgets::section_title(ui, &format!("Records without a stored file ({})", report.database_orphans.count));
        for item in &report.database_orphans.items {
            let mut on = state.ids.contains(&item.id);
            let owner = item.owner_email.clone().unwrap_or_default();
            if ui.checkbox(&mut on, format!("{}  ·  {owner}", item.name)).changed() {
                if on {
                    state.ids.insert(item.id.clone());
                } else {
                    state.ids.remove(&item.id);
                }
            }
        }
    });
    ui.add_space(10.0);
    ui.horizontal(|ui| {
        let selected = state.keys.len() + state.ids.len();
        if widgets::danger(ui, format!("Delete {selected} selected")).clicked() && selected > 0 {
            let (keys, ids): (Vec<String>, Vec<String>) =
                (state.keys.iter().cloned().collect(), state.ids.iter().cloned().collect());
            let grace = report.grace_minutes;
            save(
                tasks,
                main,
                "orphans",
                move |c| async move { c.delete_orphans(&keys, &ids, grace).await },
                |main, toasts, r| {
                    toasts.success(format!(
                        "Deleted {} object(s) and {} record(s)",
                        r.storage.deleted, r.database.deleted
                    ));
                    main.settings.orphans = None;
                },
            );
        }
        if widgets::secondary(ui, "Close").clicked() {
            *keep = false;
        }
        let _ = t;
    });
}
