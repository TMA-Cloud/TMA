//! TMA Cloud for the desktop: the shared interface in a native window, with
//! desktop extras (saved sign-in, editing in local apps, file clipboard).
#![windows_subsystem = "windows"]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod clip_plan;
mod clipboard;
#[cfg(windows)]
mod clipboard_ole;
mod cursors;
mod drive;
mod edit;
mod fonts;
mod host;
mod notify_ui;
mod shortcuts;
#[cfg(windows)]
mod single;
mod update;
mod window;

const PREFS_KEY: &str = "prefs";
const SERVER_KEY: &str = "server";
const CLIENT_ID_KEY: &str = "client-id";

struct Shell {
    app: tma_ui::App,
    client_id: String,
    keys: shortcuts::ClipboardKeys,
    cursors: cursors::Cursors,
    placement: window::Placement,
}

impl eframe::App for Shell {
    fn raw_input_hook(&mut self, ctx: &egui::Context, raw_input: &mut egui::RawInput) {
        // The held modifiers are known from the last frame; a Ctrl press always repaints first.
        self.keys.restore(raw_input, ctx.input(|i| i.modifiers), ctx.text_edit_focused());
    }

    fn ui(&mut self, ui: &mut egui::Ui, frame: &mut eframe::Frame) {
        self.app.ui(ui);
        let info = ui.ctx().input(|i| i.viewport().clone());
        self.placement.observe(&info);
        self.cursors.apply(ui.ctx(), frame, tma_ui::widgets::tokens(ui).dark);
    }

    fn save(&mut self, storage: &mut dyn eframe::Storage) {
        self.app.remember_session();
        eframe::set_value(storage, PREFS_KEY, &self.app.prefs);
        eframe::set_value(storage, CLIENT_ID_KEY, &self.client_id);
        self.placement.save();
        // eframe still reads the window size it saved before, which would win over ours.
        storage.remove_string("window");
        if let Some(server) = self.app.server_url() {
            eframe::set_value(storage, SERVER_KEY, &server);
        }
    }
}

fn icon() -> Option<egui::IconData> {
    let image = image::load_from_memory(include_bytes!("../../tma-cloud-web/public/tma-192.png")).ok()?.to_rgba8();
    Some(egui::IconData { width: image.width(), height: image.height(), rgba: image.into_raw() })
}

/// Earlier versions kept prepared copies in these folders; files now open in Cloud Drive.
fn forget_old_copies() {
    let mut old = vec![std::env::temp_dir().join("tma-cloud-fs")];
    if let Some(local) = dirs::data_local_dir().map(|d| d.join("TMA Cloud")) {
        old.extend(["clipboard", "edit", "paste"].map(|name| local.join(name)));
    }
    for dir in old {
        let _ = std::fs::remove_dir_all(dir);
    }
    if let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("tma-cloud-") && name.ends_with("-setup.exe") {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

fn main() -> eframe::Result {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info,wgpu=warn,naga=warn")).init();
    if std::env::args().nth(1).as_deref() == Some("--forget-drive") {
        drive::forget();
        return Ok(());
    }
    #[cfg(windows)]
    let Some(_single) = single::claim() else { return Ok(()) };
    forget_old_copies();
    let placement = window::Placement::load().unwrap_or_default();
    let mut viewport = placement.apply(
        egui::ViewportBuilder::default()
            .with_title("TMA Cloud")
            .with_min_inner_size([880.0, 560.0])
            .with_app_id("tma-cloud"),
    );
    if let Some(icon) = icon() {
        viewport = viewport.with_icon(icon);
    }
    let options = eframe::NativeOptions { viewport, persist_window: false, ..Default::default() };
    eframe::run_native(
        "TMA Cloud",
        options,
        Box::new(move |cc| {
            let storage = cc.storage;
            let prefs = storage.and_then(|s| eframe::get_value::<tma_ui::Prefs>(s, PREFS_KEY)).unwrap_or_default();
            let server = storage.and_then(|s| eframe::get_value::<String>(s, SERVER_KEY));
            let client_id = storage
                .and_then(|s| eframe::get_value::<String>(s, CLIENT_ID_KEY))
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let host = host::DesktopHost::new(server, client_id.clone());
            let app = tma_ui::App::new(&cc.egui_ctx, Box::new(host), prefs, fonts::system_ui_font());
            Ok(Box::new(Shell {
                app,
                client_id,
                keys: shortcuts::ClipboardKeys::default(),
                cursors: cursors::Cursors::default(),
                placement,
            }))
        }),
    )
}
