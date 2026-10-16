//! Scanning the bucket for orphans and deleting the chosen ones in batches.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use tma_core::api::{OrphanDeleteOutcome, OrphanDeleteReport};

use super::super::{attempt, save};
use super::{BATCH, OrphanState};
use crate::app::Main;
use crate::tasks::Tasks;

pub(super) fn scan(main: &mut Main, tasks: &Tasks, state: &mut OrphanState, notes: Vec<String>) {
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

pub(super) fn delete(main: &mut Main, tasks: &Tasks, state: &mut OrphanState) {
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
                (0, _) => toasts.info("Nothing was deleted: every entry is still in use"),
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
