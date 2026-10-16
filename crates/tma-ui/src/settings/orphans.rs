//! Orphan review: stored objects with no record and records with no object.
//! Nothing is deleted until the administrator picks entries and confirms.

use std::collections::BTreeSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use egui::RichText;
use tma_core::api::{OrphanDeleteOutcome, OrphanDeleteReport};

use super::parts::{self, Tone};
use super::{attempt, save};
use crate::app::Main;
use crate::icons::ph;
use crate::tasks::Tasks;
use crate::theme::Weight;
use crate::widgets;

/// The server takes at most this many entries per list in one request.
const BATCH: usize = 500;

/// Newer than this may still be an upload in progress; the server floor is an hour.
const GRACE: [(i64, &str); 5] =
    [(60, "1 hour"), (6 * 60, "6 hours"), (24 * 60, "24 hours"), (7 * 24 * 60, "7 days"), (30 * 24 * 60, "30 days")];

#[derive(Clone, Copy, PartialEq, Eq, Default)]
enum Tab {
    #[default]
    Storage,
    Database,
}

pub struct OrphanState {
    grace: i64,
    tab: Tab,
    keys: BTreeSet<String>,
    ids: BTreeSet<String>,
    confirming: bool,
    started: bool,
    progress: Option<(Arc<AtomicUsize>, usize)>,
}

impl Default for OrphanState {
    fn default() -> Self {
        Self {
            grace: 24 * 60,
            tab: Tab::Storage,
            keys: BTreeSet::new(),
            ids: BTreeSet::new(),
            confirming: false,
            started: false,
            progress: None,
        }
    }
}

fn scan(main: &mut Main, tasks: &Tasks, state: &mut OrphanState, notes: Vec<String>) {
    state.keys.clear();
    state.ids.clear();
    state.confirming = false;
    main.settings.orphans = None;
    main.settings.orphan_notes = Vec::new();
    main.settings.orphan_error = None;
    let grace = state.grace;
    attempt(
        tasks,
        main,
        "orphans",
        move |c| async move { c.scan_orphans(Some(grace)).await },
        move |main, toasts, result| match result {
            Ok(report) => {
                main.settings.orphans = Some(report);
                main.settings.orphan_notes = notes;
            }
            Err(err) => {
                main.settings.orphan_error = Some("Unable to scan for orphaned files right now".into());
                toasts.error(err.message);
            }
        },
    );
}

fn merge(into: &mut OrphanDeleteOutcome, from: OrphanDeleteOutcome) {
    into.deleted += from.deleted;
    into.skipped += from.skipped;
    into.results.extend(from.results);
}

fn delete(main: &mut Main, tasks: &Tasks, state: &mut OrphanState) {
    let (keys, ids): (Vec<String>, Vec<String>) =
        (state.keys.iter().cloned().collect(), state.ids.iter().cloned().collect());
    let grace = state.grace;
    let done = Arc::new(AtomicUsize::new(0));
    state.progress = Some((done.clone(), keys.len() + ids.len()));
    state.confirming = false;
    save(
        tasks,
        main,
        "orphans-delete",
        move |c| async move {
            let mut total = OrphanDeleteReport { grace_minutes: grace, ..Default::default() };
            for chunk in keys.chunks(BATCH) {
                let r = c.delete_orphans(chunk, &[], grace).await?;
                merge(&mut total.storage, r.storage);
                done.fetch_add(chunk.len(), Ordering::Relaxed);
            }
            for chunk in ids.chunks(BATCH) {
                let r = c.delete_orphans(&[], chunk, grace).await?;
                merge(&mut total.database, r.database);
                done.fetch_add(chunk.len(), Ordering::Relaxed);
            }
            Ok(total)
        },
        |main, toasts, r| {
            let (deleted, skipped) = (r.storage.deleted + r.database.deleted, r.storage.skipped + r.database.skipped);
            let noun = |n: i64| if n == 1 { "orphan" } else { "orphans" };
            match (deleted, skipped) {
                (0, _) => toasts.info("Nothing deleted: every entry still checks out"),
                (d, 0) => toasts.success(format!("Deleted {d} {}", noun(d))),
                (d, s) => toasts.info(format!("Deleted {d} {}, skipped {s}", noun(d))),
            }
            let notes = r
                .storage
                .results
                .iter()
                .chain(&r.database.results)
                .filter(|x| !x.deleted)
                .map(|x| {
                    let what = x.key.clone().or(x.id.clone()).unwrap_or_default();
                    format!("{what}: {}", x.reason.as_deref().unwrap_or("Skipped"))
                })
                .collect();
            main.settings.orphan_rescan = Some(notes);
        },
    );
}

/// One selectable entry: a checkbox, the title, details and its size.
fn entry(ui: &mut egui::Ui, checked: bool, title: &str, details: &[String], size: i64, trashed: bool) -> bool {
    let t = widgets::tokens(ui);
    let stroke = if checked { t.destructive.gamma_multiply(0.7) } else { t.separator };
    let mut toggled = false;
    let r = egui::Frame::new()
        .stroke(egui::Stroke::new(1.0, stroke))
        .fill(if checked { t.destructive.gamma_multiply(0.08) } else { egui::Color32::TRANSPARENT })
        .corner_radius(12)
        .inner_margin(egui::Margin::symmetric(12, 9))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal_top(|ui| {
                let mut on = checked;
                toggled |= ui.checkbox(&mut on, "").changed();
                ui.vertical(|ui| {
                    ui.set_max_width(ui.available_width() - 80.0);
                    ui.horizontal_wrapped(|ui| {
                        ui.add(egui::Label::new(RichText::new(title).semibold()).wrap());
                        if trashed {
                            parts::chip(ui, Tone::Neutral, "In trash");
                        }
                    });
                    for line in details {
                        ui.add(egui::Label::new(RichText::new(line).size(11.5).color(t.label_tertiary)).wrap());
                    }
                });
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Min), |ui| {
                    ui.label(RichText::new(tma_core::format::file_size(size)).size(12.0).color(t.label_secondary));
                });
            });
        })
        .response;
    toggled || ui.interact(r.rect, ui.id().with(("orphan", title)), egui::Sense::click()).clicked()
}

fn date(d: Option<chrono::DateTime<chrono::Utc>>) -> String {
    d.map(tma_core::format::full_date).unwrap_or_else(|| "Unknown".into())
}

pub fn show(ui: &mut egui::Ui, main: &mut Main, tasks: &Tasks, state: &mut OrphanState, keep: &mut bool) {
    let t = widgets::tokens(ui);
    if let Some(notes) = main.settings.orphan_rescan.take() {
        state.progress = None;
        scan(main, tasks, state, notes);
    }
    if !state.started {
        state.started = true;
        scan(main, tasks, state, Vec::new());
    }
    if main.settings.busy != Some("orphans-delete") && main.settings.orphan_rescan.is_none() {
        state.progress = None;
    }
    let scanning = main.settings.busy == Some("orphans");
    let deleting = state.progress.is_some();
    parts::note(
        ui,
        Tone::Info,
        "Nothing is deleted automatically. Orphans are only removed when you select them here.",
    );
    ui.add_space(6.0);
    ui.horizontal(|ui| {
        ui.label("Ignore anything newer than");
        let current = GRACE.iter().find(|g| g.0 == state.grace).map_or("24 hours", |g| g.1);
        let mut grace = state.grace;
        ui.add_enabled_ui(!scanning && !deleting, |ui| {
            egui::ComboBox::from_id_salt("orphan-grace").selected_text(current).show_ui(ui, |ui| {
                for (minutes, label) in GRACE {
                    ui.selectable_value(&mut grace, minutes, label);
                }
            });
        });
        let rescan = ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            ui.add_enabled(!scanning && !deleting, egui::Button::new(if scanning { "Scanning…" } else { "Rescan" }))
                .clicked()
        });
        if grace != state.grace || rescan.inner {
            state.grace = grace;
            scan(main, tasks, state, Vec::new());
        }
    });
    let report = main.settings.orphans.clone();
    if let Some(r) = &report {
        let mut summary =
            format!("Scanned {} stored objects against {} records", r.totals.stored_objects, r.totals.database_rows);
        if r.totals.skipped_too_recent > 0 {
            summary.push_str(&format!(" · {} held back as too recent", r.totals.skipped_too_recent));
        }
        summary.push_str(&format!(" · {}", tma_core::format::full_date(r.scanned_at)));
        ui.label(RichText::new(summary).size(11.5).color(t.label_tertiary));
    }
    ui.add_space(4.0);
    ui.horizontal(|ui| {
        let tabs = [
            (
                Tab::Storage,
                ph::HARD_DRIVES,
                "In storage, no record",
                report.as_ref().map_or(0, |r| r.storage_orphans.count),
            ),
            (Tab::Database, ph::DATABASE, "Record, no file", report.as_ref().map_or(0, |r| r.database_orphans.count)),
        ];
        for (tab, icon, label, count) in tabs {
            if ui.selectable_label(state.tab == tab, format!("{icon}  {label}  ({count})")).clicked() {
                state.tab = tab;
                state.confirming = false;
            }
        }
    });
    ui.label(
        RichText::new(match state.tab {
            Tab::Storage => "Unlinked data taking up storage. Deleting it frees the space and cannot be undone.",
            Tab::Database => {
                "Records pointing to data that is gone. Deleting them clears the broken entry without touching storage."
            }
        })
        .size(12.0)
        .color(t.label_secondary),
    );
    let Some(report) = report else {
        ui.add_space(20.0);
        match &main.settings.orphan_error {
            Some(error) => widgets::error_text(ui, error),
            None => {
                ui.vertical_centered(|ui| {
                    ui.spinner();
                    ui.label(widgets::muted(ui, "Scanning storage and database…"));
                });
            }
        }
        ui.add_space(20.0);
        footer(ui, main, tasks, state, keep, 0);
        return;
    };
    let (shown, picked, truncated) = match state.tab {
        Tab::Storage => (report.storage_orphans.items.len(), state.keys.len(), report.storage_orphans.truncated),
        Tab::Database => (report.database_orphans.items.len(), state.ids.len(), report.database_orphans.truncated),
    };
    let selected = state.keys.len() + state.ids.len();
    if shown > 0 {
        ui.horizontal(|ui| {
            let all = picked == shown;
            if ui
                .add_enabled(
                    !deleting,
                    egui::Button::new(if all {
                        "Clear selection".to_string()
                    } else {
                        format!("Select all {shown} shown")
                    })
                    .frame(false),
                )
                .clicked()
            {
                state.confirming = false;
                match (state.tab, all) {
                    (Tab::Storage, true) => state.keys.clear(),
                    (Tab::Database, true) => state.ids.clear(),
                    (Tab::Storage, false) => {
                        state.keys = report.storage_orphans.items.iter().map(|i| i.key.clone()).collect()
                    }
                    (Tab::Database, false) => {
                        state.ids = report.database_orphans.items.iter().map(|i| i.id.clone()).collect()
                    }
                }
            }
            if selected > 0 {
                let bytes: i64 = report
                    .storage_orphans
                    .items
                    .iter()
                    .filter(|i| state.keys.contains(&i.key))
                    .map(|i| i.size)
                    .sum::<i64>()
                    + report
                        .database_orphans
                        .items
                        .iter()
                        .filter(|i| state.ids.contains(&i.id))
                        .map(|i| i.size)
                        .sum::<i64>();
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.label(
                        RichText::new(format!("{selected} selected · {}", tma_core::format::file_size(bytes)))
                            .size(12.0)
                            .color(t.label_secondary),
                    );
                });
            }
        });
    }
    egui::ScrollArea::vertical().max_height(ui.ctx().content_rect().height() * 0.36).show(ui, |ui| {
        if shown == 0 {
            ui.add_space(24.0);
            ui.vertical_centered(|ui| {
                ui.label(widgets::muted(
                    ui,
                    match state.tab {
                        Tab::Storage => "No unreferenced data in storage",
                        Tab::Database => "No records with missing data",
                    },
                ));
            });
            ui.add_space(24.0);
        }
        match state.tab {
            Tab::Storage => {
                for item in &report.storage_orphans.items {
                    let details = [format!("Last written {}", date(item.last_modified))];
                    if entry(ui, state.keys.contains(&item.key), &item.key, &details, item.size, false) && !deleting {
                        state.confirming = false;
                        if !state.keys.remove(&item.key) {
                            state.keys.insert(item.key.clone());
                        }
                    }
                }
            }
            Tab::Database => {
                for item in &report.database_orphans.items {
                    let owner =
                        item.owner_name.clone().or(item.owner_email.clone()).unwrap_or_else(|| "Unknown".into());
                    let details = [
                        format!("Missing key: {}", item.path),
                        format!("Owner: {owner} · Added {}", date(Some(item.created_at))),
                    ];
                    if entry(ui, state.ids.contains(&item.id), &item.name, &details, item.size, item.trashed)
                        && !deleting
                    {
                        state.confirming = false;
                        if !state.ids.remove(&item.id) {
                            state.ids.insert(item.id.clone());
                        }
                    }
                }
            }
        }
    });
    if truncated {
        ui.label(
            RichText::new(format!("Showing the first {shown} entries. Delete these and rescan to see the rest."))
                .size(12.0)
                .color(t.warning_text),
        );
    }
    let notes = main.settings.orphan_notes.clone();
    if !notes.is_empty() {
        let kept = if notes.len() == 1 {
            "1 entry was kept".to_string()
        } else {
            format!("{} entries were kept", notes.len())
        };
        parts::note(ui, Tone::Warning, &format!("{kept}:\n{}", notes.join("\n")));
    }
    footer(ui, main, tasks, state, keep, selected);
}

fn footer(
    ui: &mut egui::Ui,
    main: &mut Main,
    tasks: &Tasks,
    state: &mut OrphanState,
    keep: &mut bool,
    selected: usize,
) {
    let t = widgets::tokens(ui);
    widgets::separator(ui);
    let busy = main.settings.busy.is_some_and(|b| b.starts_with("orphans"));
    ui.horizontal(|ui| {
        let message = if state.confirming {
            "This cannot be undone. Click again to confirm.".to_string()
        } else if selected == 0 {
            "Select the entries you want to remove".into()
        } else {
            format!("{selected} selected across both tabs")
        };
        ui.label(RichText::new(message).size(12.0).color(t.label_secondary));
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if widgets::secondary(ui, "Close").clicked() {
                *keep = false;
            }
            let label = match &state.progress {
                Some((done, total)) if *total > BATCH => {
                    format!("Deleting {} of {total}…", done.load(Ordering::Relaxed))
                }
                Some(_) => "Deleting…".into(),
                None if state.confirming => format!("Confirm delete {selected}"),
                None => format!("{}  Delete {selected} selected", ph::TRASH),
            };
            let button = if state.confirming {
                egui::Button::new(RichText::new(label).color(egui::Color32::WHITE).semibold()).fill(t.destructive)
            } else {
                egui::Button::new(RichText::new(label).color(t.destructive_text))
            };
            if ui.add_enabled(selected > 0 && !busy, button).clicked() {
                if state.confirming {
                    delete(main, tasks, state);
                } else {
                    state.confirming = true;
                }
            }
            if state.progress.is_some() {
                ui.ctx().request_repaint_after(std::time::Duration::from_millis(200));
            }
        });
    });
}
