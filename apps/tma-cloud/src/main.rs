//! TMA Cloud for the desktop: the shared interface in a native window, with
//! desktop extras (saved sign-in, editing in local apps, file clipboard).
#![windows_subsystem = "windows"]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

// Pure and tested on every system; only the Windows clipboard calls it so far.
#[cfg(windows)]
mod app_windows;
#[cfg_attr(not(windows), expect(dead_code, reason = "only the Windows clipboard calls it so far"))]
mod clip_plan;
mod clipboard;
#[cfg(windows)]
mod clipboard_ole;
#[cfg(windows)]
mod cloak;
mod credentials;
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
    /// Whether the window opens maximized, which the first frames do not show yet.
    opens_maximized: bool,
    reveal: window::Reveal,
}

impl eframe::App for Shell {
    fn raw_input_hook(&mut self, ctx: &egui::Context, raw_input: &mut egui::RawInput) {
        // The held modifiers are known from the last frame; a Ctrl press always repaints first.
        self.keys.restore(raw_input, ctx.input(|i| i.modifiers), ctx.text_edit_focused());
    }

    fn ui(&mut self, ui: &mut egui::Ui, frame: &mut eframe::Frame) {
        self.app.ui(ui);
        let info = ui.ctx().input(|i| i.viewport().clone());
        self.reveal_window(ui.ctx(), frame, &info);
        self.placement.observe(&info);
        self.cursors.apply(ui.ctx(), frame, tma_ui::widgets::tokens(ui).dark);
    }

    fn save(&mut self, storage: &mut dyn eframe::Storage) {
        self.app.remember_session();
        eframe::set_value(storage, PREFS_KEY, &self.app.prefs);
        eframe::set_value(storage, CLIENT_ID_KEY, &self.client_id);
        self.placement.save();
        if let Some(server) = self.app.server_url() {
            eframe::set_value(storage, SERVER_KEY, &server);
        }
    }
}

impl Shell {
    /// Keep the window off the screen until it has drawn at its final size.
    fn reveal_window(&mut self, ctx: &egui::Context, frame: &eframe::Frame, info: &egui::ViewportInfo) {
        let now = ctx.input(|i| i.time);
        match self.reveal.step(now, self.opens_maximized, !self.app.is_loading(), info) {
            window::Step::Done => return,
            window::Step::Cloak => {
                set_cloaked(frame, true);
                // Maximized only now, out of sight (see window::Placement::apply).
                if cfg!(windows) && self.opens_maximized {
                    ctx.send_viewport_cmd(egui::ViewportCommand::Maximized(true));
                }
            }
            window::Step::Uncloak => set_cloaked(frame, false),
            window::Step::Wait => {}
        }
        ctx.request_repaint();
    }
}

#[cfg(windows)]
fn set_cloaked(frame: &eframe::Frame, cloaked: bool) {
    cloak::set(frame, cloaked);
}

/// Other systems show a window once it has drawn; there is nothing to hide.
#[cfg(not(windows))]
fn set_cloaked(_frame: &eframe::Frame, _cloaked: bool) {}

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
    credentials::init();
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
    let result = eframe::run_native(
        "TMA Cloud",
        options,
        Box::new(move |cc| {
            let storage = cc.storage;
            let prefs = storage.and_then(|s| eframe::get_value::<tma_ui::Prefs>(s, PREFS_KEY)).unwrap_or_default();
            let server = storage.and_then(|s| eframe::get_value::<String>(s, SERVER_KEY));
            let client_id = storage
                .and_then(|s| eframe::get_value::<String>(s, CLIENT_ID_KEY))
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            // Locks taken from this computer keep the same person on another one out too.
            tma_client::set_device_id(&client_id);
            let host = host::DesktopHost::new(server, client_id.clone());
            let app = tma_ui::App::new(&cc.egui_ctx, Box::new(host), prefs, fonts::system_ui_font());
            Ok(Box::new(Shell {
                app,
                client_id,
                keys: shortcuts::ClipboardKeys::default(),
                cursors: cursors::Cursors::default(),
                placement,
                opens_maximized: placement.maximized,
                reveal: window::Reveal::default(),
            }))
        }),
    );
    // An update that closed the app starts its new version only now, once nothing of this copy runs.
    update::finish();
    result
}
