//! TMA Cloud for the desktop: the shared interface in a native window, with
//! desktop extras (saved sign-in, editing in local apps, file clipboard).
#![windows_subsystem = "windows"]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod clipboard;
#[cfg(windows)]
mod cursors;
mod drive;
mod edit;
mod fonts;
mod host;
mod notify_ui;
mod shortcuts;
#[cfg(windows)]
mod single;

const PREFS_KEY: &str = "prefs";
const SERVER_KEY: &str = "server";
const CLIENT_ID_KEY: &str = "client-id";

struct Shell {
    app: tma_ui::App,
    client_id: String,
    keys: shortcuts::ClipboardKeys,
    #[cfg(windows)]
    cursors: cursors::Cursors,
}

impl eframe::App for Shell {
    fn raw_input_hook(&mut self, ctx: &egui::Context, raw_input: &mut egui::RawInput) {
        // The held modifiers are known from the last frame; a Ctrl press always repaints first.
        self.keys.restore(raw_input, ctx.input(|i| i.modifiers), ctx.text_edit_focused());
    }

    fn ui(&mut self, ui: &mut egui::Ui, frame: &mut eframe::Frame) {
        self.app.ui(ui);
        #[cfg(windows)]
        self.cursors.apply(ui.ctx(), frame, tma_ui::widgets::tokens(ui).dark);
        #[cfg(not(windows))]
        let _ = frame;
    }

    fn save(&mut self, storage: &mut dyn eframe::Storage) {
        eframe::set_value(storage, PREFS_KEY, &self.app.prefs);
        eframe::set_value(storage, CLIENT_ID_KEY, &self.client_id);
        if let Some(server) = self.app.server_url() {
            eframe::set_value(storage, SERVER_KEY, &server);
        }
    }
}

fn icon() -> Option<egui::IconData> {
    let image = image::load_from_memory(include_bytes!("../../tma-cloud-web/public/tma-192.png")).ok()?.to_rgba8();
    Some(egui::IconData { width: image.width(), height: image.height(), rgba: image.into_raw() })
}

fn main() -> eframe::Result {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info,wgpu=warn,naga=warn")).init();
    if std::env::args().nth(1).as_deref() == Some("--forget-drive") {
        drive::forget();
        return Ok(());
    }
    #[cfg(windows)]
    let Some(_single) = single::claim() else { return Ok(()) };
    let mut viewport = egui::ViewportBuilder::default()
        .with_title("TMA Cloud")
        .with_inner_size([1280.0, 820.0])
        .with_min_inner_size([880.0, 560.0])
        .with_app_id("tma-cloud");
    if let Some(icon) = icon() {
        viewport = viewport.with_icon(icon);
    }
    let options = eframe::NativeOptions { viewport, persist_window: true, ..Default::default() };
    eframe::run_native(
        "TMA Cloud",
        options,
        Box::new(|cc| {
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
                #[cfg(windows)]
                cursors: cursors::Cursors::default(),
            }))
        }),
    )
}
