//! Toasts from background threads: closures queued for the UI's next frame.

use std::sync::Arc;
use std::sync::mpsc::Sender;

use tma_client::Progress;
use tma_ui::App;
use tma_ui::transfers::State;

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

    /// Show a download in the transfers panel; returns the counters to fill.
    pub fn track_download(&self, name: &str) -> Arc<Progress> {
        let progress = Progress::new(0);
        let (name, shown) = (name.to_string(), progress.clone());
        self.send(move |app| {
            if let Some(transfers) = app.transfers_mut() {
                transfers.track_download(&name, shown);
            }
        });
        progress
    }

    /// Mark a tracked download done, or failed with `error`.
    pub fn finish_download(&self, progress: &Arc<Progress>, error: Option<String>) {
        let progress = progress.clone();
        self.send(move |app| {
            if let Some(transfers) = app.transfers_mut() {
                let state = error.map(State::Failed).unwrap_or(State::Done);
                transfers.finish_tracked(&progress, state);
            }
        });
    }

    pub fn error(&self, text: impl Into<String>) {
        let text = text.into();
        self.send(move |app| app.toasts.error(text));
    }
}
