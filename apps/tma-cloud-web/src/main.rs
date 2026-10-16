//! TMA Cloud in the browser: starts the shared interface on the page's canvas.
//! The server serves this build and the page talks to the same origin.

#[cfg(target_arch = "wasm32")]
mod web {
    use wasm_bindgen::JsCast as _;

    const CANVAS_ID: &str = "tma_canvas";
    const LOADING_ID: &str = "tma_loading";
    const PREFS_KEY: &str = "tma-prefs";

    struct WebShell {
        app: tma_ui::App,
    }

    impl eframe::App for WebShell {
        fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
            self.app.ui(ui);
        }

        fn save(&mut self, storage: &mut dyn eframe::Storage) {
            eframe::set_value(storage, PREFS_KEY, &self.app.prefs);
        }
    }

    pub fn start() {
        eframe::WebLogger::init(log::LevelFilter::Info).ok();
        wasm_bindgen_futures::spawn_local(async {
            let Some(document) = web_sys::window().and_then(|w| w.document()) else { return };
            let Some(canvas) =
                document.get_element_by_id(CANVAS_ID).and_then(|e| e.dyn_into::<web_sys::HtmlCanvasElement>().ok())
            else {
                log::error!("missing <canvas id=\"{CANVAS_ID}\">");
                return;
            };
            let result = eframe::WebRunner::new()
                .start(
                    canvas,
                    eframe::WebOptions::default(),
                    Box::new(|cc| {
                        let prefs = cc
                            .storage
                            .and_then(|s| eframe::get_value::<tma_ui::Prefs>(s, PREFS_KEY))
                            .unwrap_or_default();
                        let app = tma_ui::App::new(&cc.egui_ctx, Box::new(tma_ui::WebHost::default()), prefs, None);
                        Ok(Box::new(WebShell { app }))
                    }),
                )
                .await;
            if let Some(el) = document.get_element_by_id(LOADING_ID) {
                match result {
                    Ok(()) => el.remove(),
                    Err(e) => el.set_inner_html(&format!(
                        "<p>TMA Cloud could not start: {e:?}</p><p>A browser with WebGL2 is required.</p>"
                    )),
                }
            }
        });
    }
}

#[cfg(target_arch = "wasm32")]
fn main() {
    web::start();
}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    eprintln!("tma-cloud-web runs in the browser: build it with `trunk build --release` in apps/tma-cloud-web.");
}
