//! Opening a file: in the computer's own app (desktop), the image viewer, the
//! document editor, or a notice when the browser cannot show it. Also opening
//! the folder that holds an item found elsewhere.

use tma_core::Permission;
use tma_core::api::FileItem;

use super::Place;
use super::actions::{Action, run};
use crate::app::{App, Screen, Section};
use crate::host::HostKind;

/// Whether OnlyOffice can open this file.
pub(super) fn is_document(name: &str) -> bool {
    const EXTS: &[&str] = &[
        "docx", "doc", "docm", "dotx", "dotm", "dot", "xlsx", "xls", "xlsm", "xlsb", "xltx", "xltm", "csv", "pptx",
        "ppt", "pptm", "ppsx", "ppsm", "pps", "potx", "potm", "odt", "ods", "odp", "pdf",
    ];
    EXTS.contains(&tma_core::names::extension_of(name).as_str())
}

/// What opening a file the browser cannot show says instead of downloading it.
fn no_preview(name: &str) -> String {
    match tma_core::names::extension_of(name).as_str() {
        "" => format!("{name} can't be opened in the browser. Download it to open it on your computer."),
        ext => format!(".{ext} files can't be opened in the browser. Download the file to open it on your computer."),
    }
}

pub(super) fn is_image(item: &FileItem) -> bool {
    item.mime_type.as_deref().is_some_and(|m| m.starts_with("image/") && m != "image/svg+xml")
}

/// Open a file (not a folder) the way this app and its type allow.
pub(super) fn file(app: &mut App, item: FileItem) {
    let Screen::Main(main) = &mut app.screen else { return };
    if main.browser.place == Place::Trash {
        app.toasts.info("Restore the file to open it");
    } else if !main.user.can(Permission::Download) {
        // Every way of opening reads the file, which the server allows only with Download.
        app.toasts.error("You don't have permission to open files. Ask the account owner.");
    } else if app.host.kind() == HostKind::Desktop {
        // The desktop app hands every file to the computer, which opens it in its own app.
        run(app, Action::EditInApp(item));
    } else if is_image(&item) {
        run(app, Action::Preview(item));
    } else if is_document(&item.name) && main.instance.onlyoffice {
        run(app, Action::OpenDocument(item));
    } else {
        // Opening must not start a download nobody asked for; Download is one click away.
        app.toasts.info(no_preview(&item.name));
    }
}

/// Open a document in OnlyOffice: inside the page on the web, in the browser from the desktop app.
pub(super) fn document(app: &mut App, item: FileItem) {
    let Screen::Main(main) = &mut app.screen else { return };
    let (client, generation) = (main.client.clone(), main.generation);
    let theme = if app.t.dark { "dark" } else { "light" };
    let tab = client.url(&format!("/api/onlyoffice/viewer/{}?theme={theme}", item.id));
    match app.host.kind() {
        // On a phone the editor gets the whole tab, as before.
        HostKind::Web if crate::widgets::mobile(app.tasks.ctx()) => app.host.open_url(&tab),
        HostKind::Web => {
            let css = |c: egui::Color32| format!("rgb({},{},{})", c.r(), c.g(), c.b());
            let t = app.t;
            let look = crate::document::Look {
                background: css(t.canvas),
                surface: css(t.surface),
                text: css(t.label),
                separator: css(t.separator),
            };
            let theme = theme.to_string();
            app.tasks.run(
                async move {
                    let reply = client.document_editor(&item.id, &theme).await.map_err(|e| e.message)?;
                    crate::document::open(&item.name, reply, &look, &tab).await
                },
                |app, result: Result<(), String>| {
                    if let Err(err) = result {
                        app.toasts.error(err);
                    }
                },
            );
        }
        HostKind::Desktop => {
            let theme = theme.to_string();
            app.tasks.run(async move { client.onlyoffice_ticket(&item.id, &theme).await }, move |app, result| {
                match result {
                    Ok(url) => app.host.open_url(&url),
                    Err(err) => app.fail(generation, &err),
                }
            });
        }
    }
}

/// Search results and Recent show items from anywhere; this opens the folder holding one.
pub(super) fn location(app: &mut App, item: FileItem) {
    let Screen::Main(main) = &mut app.screen else { return };
    let (client, generation) = (main.client.clone(), main.generation);
    main.section = Section::Files;
    let parent = item.parent_id.clone();
    app.tasks.run(
        async move {
            match parent {
                Some(p) => client.info(&p).await.map(|info| vec![(info.id, info.name)]),
                None => Ok(Vec::new()),
            }
        },
        move |app, result| {
            let prefs = app.prefs.clone();
            let Screen::Main(main) = &mut app.screen else { return };
            if main.generation != generation {
                return;
            }
            let path = result.unwrap_or_default();
            let client = main.client.clone();
            main.browser.open(Place::Folder, path, &app.tasks, &client, generation, &prefs);
            main.browser.select_only(&item.id);
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_files_say_so_instead_of_downloading() {
        assert_eq!(
            no_preview("backup.zip"),
            ".zip files can't be opened in the browser. Download the file to open it on your computer."
        );
        assert!(no_preview("Makefile").starts_with("Makefile can't be opened"));
        assert!(is_document("Report.DOCX"));
    }
}
