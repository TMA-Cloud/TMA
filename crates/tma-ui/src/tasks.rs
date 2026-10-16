//! Background work for an immediate-mode UI: a future runs off the frame, and
//! its result comes back as a closure applied to the app on the next frame.

use std::future::Future;
use std::sync::mpsc::{Receiver, Sender, channel};

use tma_client::rt::{self, MaybeSend};

use crate::app::App;

#[cfg(not(target_arch = "wasm32"))]
pub type Apply = Box<dyn FnOnce(&mut App) + Send>;
#[cfg(target_arch = "wasm32")]
pub type Apply = Box<dyn FnOnce(&mut App)>;

pub struct Tasks {
    tx: Sender<Apply>,
    rx: Receiver<Apply>,
    ctx: egui::Context,
}

impl Tasks {
    pub fn new(ctx: egui::Context) -> Self {
        let (tx, rx) = channel();
        Self { tx, rx, ctx }
    }

    /// Run `future`, then `apply` its output to the app.
    pub fn run<T, F, A>(&self, future: F, apply: A)
    where
        T: MaybeSend + 'static,
        F: Future<Output = T> + MaybeSend + 'static,
        A: FnOnce(&mut App, T) + MaybeSend + 'static,
    {
        let (tx, ctx) = (self.tx.clone(), self.ctx.clone());
        rt::spawn(async move {
            let output = future.await;
            let _ = tx.send(Box::new(move |app: &mut App| apply(app, output)));
            ctx.request_repaint();
        });
    }

    /// Queue a change to apply on the next frame (from callbacks without `&mut App`).
    pub fn later(&self, apply: impl FnOnce(&mut App) + MaybeSend + 'static) {
        let _ = self.tx.send(Box::new(apply));
        self.ctx.request_repaint();
    }

    pub fn sender(&self) -> Sender<Apply> {
        self.tx.clone()
    }

    pub fn ctx(&self) -> &egui::Context {
        &self.ctx
    }

    pub fn drain(&self) -> Vec<Apply> {
        self.rx.try_iter().collect()
    }
}
