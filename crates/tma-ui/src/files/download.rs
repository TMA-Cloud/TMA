//! Starting downloads from the listing.

use tma_core::api::FileItem;

use crate::app::App;

/// Start downloads: a save dialog and a tracked transfer on desktop, the browser's own download on the web.
pub fn start_download(app: &mut App, items: Vec<FileItem>) {
    let crate::app::Screen::Main(main) = &mut app.screen else { return };
    if items.is_empty() {
        return;
    }
    let (client, generation) = (main.client.clone(), main.generation);
    let single = items.len() == 1;
    let first = items[0].clone();
    let name = if single && !first.is_folder() {
        first.name.clone()
    } else if single {
        format!("{}.zip", first.name)
    } else {
        "download.zip".to_string()
    };
    #[cfg(not(target_arch = "wasm32"))]
    {
        let ids: Vec<String> = items.iter().map(|i| i.id.clone()).collect();
        app.tasks.run(crate::platform::save_path(name.clone()), move |app, dest| {
            let Some(dest) = dest else { return };
            let Some(main) = app.main_mut(generation) else { return };
            let (id, progress) = main.transfers.add_download(&name);
            app.tasks.run(
                async move {
                    if single {
                        client.download_to(&ids[0], &dest, progress).await
                    } else {
                        client.download_bulk_to(&ids, &dest, progress).await
                    }
                },
                move |app, result| {
                    if let Some(main) = app.main_mut(generation) {
                        main.transfers.finish(
                            id,
                            match result {
                                Ok(()) => crate::transfers::State::Done,
                                Err(err) => crate::transfers::State::Failed(err.message),
                            },
                        );
                    }
                },
            );
        });
    }
    #[cfg(target_arch = "wasm32")]
    {
        if single {
            crate::platform::browser_download(&client.download_url(&first.id), &name);
        } else {
            let ids: Vec<String> = items.iter().map(|i| i.id.clone()).collect();
            let url = client.bulk_download_form_url();
            app.tasks.run(async move { client.bulk_download_ticket(&ids).await }, move |app, result| {
                app.finish(generation, result, |_, _, ticket| crate::platform::browser_post_download(&url, &ticket));
            });
        }
    }
}
