//! Toasts from background threads: closures queued for the UI's next frame.

use std::sync::mpsc::Sender;

use tma_ui::App;

#[derive(Clone)]
pub struct Notifier {
    tx: Sender<tma_ui::Apply>,
    ctx: egui::Context,
}

impl Notifier {
    pub fn new(tasks: &tma_ui::Tasks) -> Self {
        Self { tx: tasks.sender(), ctx: tasks.ctx().clone() }
    }

    /// Run `apply` with the whole app on the next frame.
    pub fn apply(&self, apply: impl FnOnce(&mut App) + Send + 'static) {
        self.send(apply);
    }

    fn send(&self, apply: impl FnOnce(&mut App) + Send + 'static) {
        let _ = self.tx.send(Box::new(apply));
        self.ctx.request_repaint();
    }

    /// Close the window, which ends the app the same way the close button does.
    pub fn close_app(&self) {
        self.ctx.send_viewport_cmd(egui::ViewportCommand::Close);
    }

    /// A file handed to its app is open (or failed to open): end its opening animation.
    pub fn opened(&self, id: &str) {
        tma_ui::opening::finish(&self.ctx, id);
    }

    pub fn info(&self, text: impl Into<String>) {
        let text = text.into();
        self.send(move |app| app.toasts.info(text));
    }

    pub fn success(&self, text: impl Into<String>) {
        let text = text.into();
        self.send(move |app| app.toasts.success(text));
    }

    /// Draw a new frame, for state the UI reads by itself (the update card).
    pub fn repaint(&self) {
        self.ctx.request_repaint();
    }

    pub fn error(&self, text: impl Into<String>) {
        let text = text.into();
        self.send(move |app| app.toasts.error(text));
    }
}
