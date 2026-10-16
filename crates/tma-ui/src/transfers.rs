//! Uploads and downloads with progress: a queue that runs three at a time and
//! the panel that shows it.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use egui::{Align2, CornerRadius, Frame, Margin, RichText, Stroke};
use tma_client::{Client, Progress, UploadFile, UploadOptions};

use crate::app::{App, Main};
use crate::icons::ph;
use crate::tasks::Tasks;
use crate::theme::Weight;
use crate::widgets;

const PARALLEL: usize = 3;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum State {
    Queued,
    Running,
    Done,
    Failed(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Up,
    Down,
}

pub struct Transfer {
    pub id: u64,
    pub name: String,
    pub direction: Direction,
    pub progress: Arc<Progress>,
    pub state: State,
    upload: Option<(UploadFile, UploadOptions)>,
    /// The existing file this upload replaces, keeping its ID.
    replace: Option<String>,
}

#[derive(Default)]
pub struct Transfers {
    pub items: Vec<Transfer>,
    next_id: u64,
    pub expanded: bool,
}

impl Transfers {
    pub fn queue_uploads(&mut self, files: Vec<UploadFile>, parent: Option<String>) {
        for file in files {
            self.next_id += 1;
            self.items.push(Transfer {
                id: self.next_id,
                name: file.name.clone(),
                direction: Direction::Up,
                progress: Progress::new(file.size),
                state: State::Queued,
                upload: Some((file, UploadOptions { parent_id: parent.clone() })),
                replace: None,
            });
        }
        self.expanded = true;
    }

    /// Upload new content for an existing file (same ID, name and shares).
    pub fn queue_replace(&mut self, file: UploadFile, existing_id: String) {
        self.next_id += 1;
        self.items.push(Transfer {
            id: self.next_id,
            name: file.name.clone(),
            direction: Direction::Up,
            progress: Progress::new(file.size),
            state: State::Queued,
            upload: Some((file, UploadOptions::default())),
            replace: Some(existing_id),
        });
        self.expanded = true;
    }

    /// Track a download the caller runs; returns its progress counters and id.
    pub fn add_download(&mut self, name: &str) -> (u64, Arc<Progress>) {
        self.next_id += 1;
        let progress = Progress::new(0);
        self.items.push(Transfer {
            id: self.next_id,
            name: name.to_string(),
            direction: Direction::Down,
            progress: progress.clone(),
            state: State::Running,
            upload: None,
            replace: None,
        });
        self.expanded = true;
        (self.next_id, progress)
    }

    /// Show a download the host runs on its own thread (opening a file in its app).
    pub fn track_download(&mut self, name: &str, progress: Arc<Progress>) {
        self.next_id += 1;
        self.items.push(Transfer {
            id: self.next_id,
            name: name.to_string(),
            direction: Direction::Down,
            progress,
            state: State::Running,
            upload: None,
            replace: None,
        });
        self.expanded = true;
    }

    /// Finish a download started with `track_download`, found by its counters.
    pub fn finish_tracked(&mut self, progress: &Arc<Progress>, state: State) {
        if let Some(item) = self.items.iter_mut().find(|i| Arc::ptr_eq(&i.progress, progress)) {
            item.state = state;
        }
    }

    pub fn finish(&mut self, id: u64, state: State) {
        if let Some(item) = self.items.iter_mut().find(|i| i.id == id) {
            item.state = state;
        }
    }

    fn running(&self) -> usize {
        self.items.iter().filter(|i| i.state == State::Running).count()
    }

    pub fn is_busy(&self) -> bool {
        self.items.iter().any(|i| matches!(i.state, State::Running | State::Queued))
    }
}

/// Start queued uploads while fewer than three run.
pub fn pump(main: &mut Main, tasks: &Tasks) {
    let generation = main.generation;
    while main.transfers.running() < PARALLEL {
        let Some(item) = main.transfers.items.iter_mut().find(|i| i.state == State::Queued) else { break };
        let Some((file, options)) = item.upload.take() else {
            item.state = State::Failed("Nothing to upload".into());
            continue;
        };
        item.state = State::Running;
        let (id, progress, client): (u64, Arc<Progress>, Client) =
            (item.id, item.progress.clone(), main.client.clone());
        let replace = item.replace.clone();
        let send = async move {
            match replace {
                Some(existing) => client.replace(&existing, &file, progress).await,
                None => client.upload(&file, &options, progress).await,
            }
        };
        tasks.run(send, move |app: &mut App, result| {
            let Some(main) = app.main_mut(generation) else { return };
            match result {
                Ok(_) => {
                    main.transfers.finish(id, State::Done);
                    main.change_pending = true;
                }
                Err(err) => main.transfers.finish(id, State::Failed(err.message)),
            }
        });
    }
}

/// The floating panel in the bottom-left corner.
pub fn show(main: &mut Main, ctx: &egui::Context) {
    let t = crate::widgets::tokens_ctx(ctx);
    if main.transfers.items.is_empty() {
        return;
    }
    let total = main.transfers.items.len();
    let done = main.transfers.items.iter().filter(|i| matches!(i.state, State::Done)).count();
    let failed = main.transfers.items.iter().filter(|i| matches!(i.state, State::Failed(_))).count();
    let busy = main.transfers.is_busy();
    if busy {
        ctx.request_repaint_after(std::time::Duration::from_millis(150));
    }
    let mut clear = false;
    egui::Area::new(egui::Id::new("transfers"))
        .anchor(Align2::RIGHT_BOTTOM, [-18.0, -18.0])
        .order(egui::Order::Foreground)
        .show(ctx, |ui| {
            Frame::new()
                .fill(t.surface_raised)
                .stroke(Stroke::new(1.0, t.separator))
                .corner_radius(CornerRadius::same(14))
                .inner_margin(Margin::same(12))
                .shadow(egui::epaint::Shadow {
                    offset: [0, 8],
                    blur: 24,
                    spread: 0,
                    color: egui::Color32::from_black_alpha(45),
                })
                .show(ui, |ui| {
                    ui.set_width(320.0);
                    ui.horizontal(|ui| {
                        let title = if busy {
                            format!("Transferring {} of {total}", (done + failed + 1).min(total))
                        } else if failed > 0 {
                            format!("{done} done, {failed} failed")
                        } else {
                            format!("{done} transfer(s) complete")
                        };
                        ui.label(RichText::new(title).semibold());
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if !busy && widgets::icon_button(ui, ph::X, "Clear").clicked() {
                                clear = true;
                            }
                            let icon = if main.transfers.expanded { ph::CARET_DOWN } else { ph::CARET_UP };
                            if widgets::icon_button(ui, icon, "Details").clicked() {
                                main.transfers.expanded = !main.transfers.expanded;
                            }
                        });
                    });
                    let fraction = {
                        let (d, tot) = main.transfers.items.iter().fold((0u64, 0u64), |(d, tot), i| {
                            (
                                d + i.progress.done.load(Ordering::Relaxed),
                                tot + i.progress.total.load(Ordering::Relaxed),
                            )
                        });
                        if tot == 0 { 0.0 } else { d as f32 / tot as f32 }
                    };
                    if busy {
                        widgets::progress_bar(ui, fraction, 320.0);
                    }
                    if main.transfers.expanded {
                        ui.add_space(6.0);
                        egui::ScrollArea::vertical().max_height(220.0).show(ui, |ui| {
                            for item in main.transfers.items.iter().rev() {
                                ui.horizontal(|ui| {
                                    let icon =
                                        if item.direction == Direction::Up { ph::ARROW_UP } else { ph::ARROW_DOWN };
                                    ui.label(RichText::new(icon).color(t.label_tertiary));
                                    ui.vertical(|ui| {
                                        ui.set_width(230.0);
                                        ui.add(egui::Label::new(&item.name).truncate());
                                        match &item.state {
                                            State::Queued => {
                                                ui.label(RichText::new("Waiting").size(11.0).color(t.label_tertiary));
                                            }
                                            State::Running => {
                                                widgets::progress_bar(ui, item.progress.fraction(), 220.0)
                                            }
                                            State::Done => {
                                                ui.label(RichText::new("Done").size(11.0).color(t.positive_text));
                                            }
                                            State::Failed(msg) => {
                                                ui.label(RichText::new(msg).size(11.0).color(t.destructive_text));
                                            }
                                        }
                                    });
                                    if matches!(item.state, State::Running | State::Queued)
                                        && widgets::icon_button(ui, ph::X_CIRCLE, "Cancel").clicked()
                                    {
                                        item.progress.cancel();
                                    }
                                });
                            }
                        });
                    }
                });
        });
    for item in &mut main.transfers.items {
        if item.state == State::Queued && item.progress.is_cancelled() {
            item.state = State::Failed("Cancelled".into());
        }
    }
    if clear {
        main.transfers.items.clear();
    }
}
