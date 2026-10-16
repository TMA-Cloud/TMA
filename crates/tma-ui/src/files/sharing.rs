//! Details and sharing: the info and share dialogs, copying links, and adding
//! items to the share of the folder they are in.

use tma_core::api::FileItem;

use super::actions::ids;
use crate::app::{App, Screen};
use crate::modals::Modal;

pub(super) fn info(app: &mut App, item: FileItem) {
    let Screen::Main(main) = &mut app.screen else { return };
    let (client, generation) = (main.client.clone(), main.generation);
    main.modal = Some(Modal::Info { item: item.clone(), info: None });
    let id = item.id.clone();
    app.tasks.run(async move { client.info(&id).await }, move |app, result| {
        app.finish(generation, result, |main, _, info| {
            if let Some(Modal::Info { info: slot, item }) = &mut main.modal
                && item.id == info.id
            {
                *slot = Some(info);
            }
        });
    });
}

pub(super) fn share(app: &mut App, items: Vec<FileItem>) {
    let Screen::Main(main) = &mut app.screen else { return };
    let (client, generation) = (main.client.clone(), main.generation);
    let ids = ids(&items);
    main.modal = Some(Modal::share(items));
    app.tasks.run(async move { client.share_links(&ids).await }, move |app, result| {
        app.finish(generation, result, |main, _, links| {
            if let Some(Modal::Share(share)) = &mut main.modal {
                share.links = links.links;
            }
        });
    });
}

pub(super) fn copy_links(app: &mut App, ids: Vec<String>) {
    let Screen::Main(main) = &app.screen else { return };
    let (client, generation) = (main.client.clone(), main.generation);
    app.tasks.run(async move { client.share_links(&ids).await }, move |app, result| {
        let ctx = app.tasks.ctx().clone();
        app.finish(generation, result, |_, toasts, links| {
            let list: Vec<String> = links.links.into_values().collect();
            if !list.is_empty() {
                ctx.copy_text(list.join("\n"));
                toasts.success(if list.len() == 1 {
                    "Link copied".to_string()
                } else {
                    format!("{} links copied", list.len())
                });
            }
        });
    });
}

pub(super) fn link_to_folder_share(app: &mut App, ids: Vec<String>) {
    let Screen::Main(main) = &app.screen else { return };
    let (client, generation) = (main.client.clone(), main.generation);
    app.tasks.run(async move { client.link_parent_share(&ids).await }, move |app, result| {
        app.finish(generation, result, |main, toasts, _| {
            toasts.success("Linked to the folder's share");
            main.change_pending = true;
        });
    });
}
