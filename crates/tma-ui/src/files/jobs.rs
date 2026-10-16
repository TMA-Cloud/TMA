//! Actions that change items on the server and show as a row in the transfer
//! panel: trash, restore, star, paste (copy or move) and move.

use tma_core::api::FileItem;

use super::Place;
use super::actions::{Action, ids, items_label, paste_system_files, run};
use crate::app::{App, Screen};
use crate::icons::ph;
use crate::transfers::State;

/// Mark a job's row in the transfers panel done or failed once the server answers.
pub(crate) fn settle_job<T>(app: &mut App, generation: u64, row: u64, result: &tma_client::ApiResult<T>) {
    if let Some(main) = app.main_mut(generation) {
        let state = match result {
            Ok(_) => State::Done,
            Err(err) => State::Failed(err.message.clone()),
        };
        main.transfers.finish(row, state);
    }
}

/// A job finished: mark its row in the transfer panel and refresh the listing.
fn job_finished<T>(app: &mut App, generation: u64, row: u64, result: tma_client::ApiResult<T>) {
    settle_job(app, generation, row, &result);
    app.finish(generation, result, |main, _, _| main.change_pending = true);
}

pub(super) fn trash(app: &mut App, items: Vec<FileItem>) {
    let Screen::Main(main) = &mut app.screen else { return };
    let (client, generation) = (main.client.clone(), main.generation);
    let ids = ids(&items);
    main.browser.items.retain(|i| !ids.contains(&i.id));
    main.browser.selected.clear();
    let row = main.transfers.start_job(format!("Moving {} to the trash", items_label(items.len())), ph::TRASH);
    app.tasks.run(async move { client.settle(&client.trash(&ids).await?).await }, move |app, result| {
        job_finished(app, generation, row, result)
    });
}

pub(super) fn restore(app: &mut App, ids: Vec<String>) {
    let Screen::Main(main) = &mut app.screen else { return };
    let (client, generation) = (main.client.clone(), main.generation);
    main.browser.items.retain(|i| !ids.contains(&i.id));
    let label = format!("Restoring {}", items_label(ids.len()));
    let row = main.transfers.start_job(label, ph::ARROW_COUNTER_CLOCKWISE);
    app.tasks.run(async move { client.settle(&client.restore(&ids).await?).await }, move |app, result| {
        job_finished(app, generation, row, result)
    });
}

pub(super) fn star(app: &mut App, ids: Vec<String>, starred: bool) {
    let Screen::Main(main) = &mut app.screen else { return };
    let (client, generation) = (main.client.clone(), main.generation);
    for item in main.browser.items.iter_mut().filter(|i| ids.contains(&i.id)) {
        item.starred = starred;
    }
    if !starred && main.browser.place == Place::Starred {
        main.browser.items.retain(|i| !ids.contains(&i.id));
    }
    app.tasks.run(async move { client.star(&ids, starred).await }, move |app, result| {
        app.finish(generation, result, |main, _, _| main.change_pending = true);
    });
}

/// Paste what was copied or cut: files from other apps upload, TMA Cloud items copy or move.
pub(super) fn paste(app: &mut App) {
    let Screen::Main(main) = &mut app.screen else { return };
    if main.browser.place != Place::Folder {
        return;
    }
    let in_app = main.browser.clip.as_ref().map(|c| c.seq);
    match super::paste::source(in_app, app.host.clipboard_has_files(), app.host.clipboard_sequence()) {
        super::paste::Source::System => return paste_system_files(app),
        super::paste::Source::Nothing => return,
        super::paste::Source::InApp => {}
    }
    let Some(clip) = main.browser.clip.clone() else { return };
    let (client, generation) = (main.client.clone(), main.generation);
    let target = main.browser.folder_id();
    if clip.cut {
        main.browser.clip = None;
        run(app, Action::MoveTo(clip.ids, target));
    } else {
        let row = main.transfers.start_job(format!("Copying {}", items_label(clip.ids.len())), ph::COPY);
        app.tasks.run(
            async move { client.settle(&client.copy_items(&clip.ids, target.as_deref()).await?).await },
            move |app, result| job_finished(app, generation, row, result),
        );
    }
}

pub(super) fn move_to(app: &mut App, ids: Vec<String>, target: Option<String>) {
    let Screen::Main(main) = &mut app.screen else { return };
    if target.as_ref().is_some_and(|t| ids.contains(t)) {
        return;
    }
    let (client, generation) = (main.client.clone(), main.generation);
    main.browser.items.retain(|i| !ids.contains(&i.id));
    let row = main.transfers.start_job(format!("Moving {}", items_label(ids.len())), ph::ARROWS_OUT_CARDINAL);
    app.tasks.run(async move { client.move_items(&ids, target.as_deref()).await }, move |app, result| {
        job_finished(app, generation, row, result)
    });
}
