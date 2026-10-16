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

    fn send(&self, apply: impl FnOnce(&mut App) + Send + 'static) {
        let _ = self.tx.send(Box::new(apply));
        self.ctx.request_repaint();
    }

    pub fn info(&self, text: impl Into<String>) {
        let text = text.into();
        self.send(move |app| app.toasts.info(text));
    }

    pub fn success(&self, text: impl Into<String>) {
        let text = text.into();
        self.send(move |app| app.toasts.success(text));
    }

    pub fn error(&self, text: impl Into<String>) {
        let text = text.into();
        self.send(move |app| app.toasts.error(text));
    }
}
