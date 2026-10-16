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
    /// Work the server does (moving to the trash, copying), shown while it runs.
    Job(&'static str),
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
    /// A failure already listed in the upload issues dialog.
    reported: bool,
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
                reported: false,
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
            reported: false,
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
            reported: false,
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
            reported: false,
        });
        self.expanded = true;
    }

    /// Finish a download started with `track_download`, found by its counters.
    pub fn finish_tracked(&mut self, progress: &Arc<Progress>, state: State) {
        if let Some(item) = self.items.iter_mut().find(|i| Arc::ptr_eq(&i.progress, progress)) {
            item.state = state;
        }
    }

    /// Show a server job until `finish` is called with its id.
    pub fn start_job(&mut self, name: String, icon: &'static str) -> u64 {
        self.next_id += 1;
        self.items.push(Transfer {
            id: self.next_id,
            name,
            direction: Direction::Job(icon),
            progress: Progress::new(0),
            state: State::Running,
            upload: None,
            replace: None,
            reported: false,
        });
        self.next_id
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

/// Failed uploads grouped by reason, largest group first: one heading saying 40
/// files did not match their type reads better than 40 lines saying the same.
pub fn group_failures(failures: &[(String, String)]) -> Vec<(String, Vec<String>)> {
    let mut groups: Vec<(String, Vec<String>)> = Vec::new();
    for (name, reason) in failures {
        // The server names the extension inside some reasons; the file name already shows it.
        let read_error;
        let heading = if reason.starts_with("File content does not match extension") {
            "Content does not match the file extension"
        } else if reason.starts_with("Invalid file name") {
            "File name is not allowed"
        } else if let Some((_, why)) = reason.strip_prefix("Cannot read ").and_then(|r| r.rsplit_once(": ")) {
            // The local path differs per file; the name underneath already says which one.
            read_error = format!("The file could not be read: {why}");
            read_error.as_str()
        } else {
            reason.as_str()
        };
        match groups.iter_mut().find(|(r, _)| r == heading) {
            Some((_, names)) => names.push(name.clone()),
            None => groups.push((heading.to_string(), vec![name.clone()])),
        }
    }
    groups.sort_by_key(|(_, names)| std::cmp::Reverse(names.len()));
    groups
}

/// Once a batch of uploads is done, failures not yet reported, as (name, reason).
fn unreported_failures(transfers: &mut Transfers) -> Vec<(String, String)> {
    if transfers.is_busy() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for item in &mut transfers.items {
        if let (Direction::Up, State::Failed(reason), false) = (item.direction, &item.state, item.reported) {
            item.reported = true;
            // Cancelling is the user's own choice, not an issue to report.
            if reason != "Cancelled" {
                out.push((item.name.clone(), reason.clone()));
            }
        }
    }
    out
}

/// Start queued uploads while fewer than three run; report a finished batch's failures.
pub fn pump(main: &mut Main, tasks: &Tasks) {
    let generation = main.generation;
    if main.modal.is_none() {
        let failures = unreported_failures(&mut main.transfers);
        if !failures.is_empty() {
            main.modal = Some(crate::modals::Modal::UploadIssues(group_failures(&failures)));
        }
    }
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
    let phone = widgets::mobile(ctx);
    let width = if phone { (ctx.content_rect().width() - 40.0).min(420.0) } else { 320.0 };
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
        // Bottom-left, as the web app had it, so toasts (bottom-right) never cover it;
        // on a phone it spans the width above the tab bar.
        .anchor(
            if phone { Align2::CENTER_BOTTOM } else { Align2::LEFT_BOTTOM },
            if phone { [0.0, -70.0] } else { [18.0, -18.0] },
        )
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
                    ui.set_width(width);
                    ui.horizontal(|ui| {
                        let working = main
                            .transfers
                            .items
                            .iter()
                            .any(|i| matches!(i.direction, Direction::Job(_)) && i.state == State::Running);
                        let title = if busy {
                            let verb = if working { "Working on" } else { "Transferring" };
                            format!("{verb} {} of {total}", (done + failed + 1).min(total))
                        } else if failed > 0 {
                            format!("{done} done, {failed} failed")
                        } else {
                            format!("{done} done")
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
                    if busy && fraction == 0.0 {
                        widgets::busy_bar(ui, width);
                    } else if busy {
                        widgets::progress_bar(ui, fraction, width);
                    }
                    if main.transfers.expanded {
                        ui.add_space(6.0);
                        egui::ScrollArea::vertical().max_height(220.0).show(ui, |ui| {
                            for item in main.transfers.items.iter().rev() {
                                ui.horizontal(|ui| {
                                    let icon = match item.direction {
                                        Direction::Up => ph::ARROW_UP,
                                        Direction::Down => ph::ARROW_DOWN,
                                        Direction::Job(icon) => icon,
                                    };
                                    ui.label(RichText::new(icon).color(t.label_tertiary));
                                    ui.vertical(|ui| {
                                        ui.set_width(230.0);
                                        ui.add(egui::Label::new(&item.name).truncate());
                                        match &item.state {
                                            State::Queued => {
                                                ui.label(RichText::new("Waiting").size(11.0).color(t.label_tertiary));
                                            }
                                            // No byte counts: a bar that moves rather than one that fills.
                                            State::Running if item.progress.total.load(Ordering::Relaxed) == 0 => {
                                                widgets::busy_bar(ui, 220.0)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn failure(name: &str, reason: &str) -> (String, String) {
        (name.into(), reason.into())
    }

    #[test]
    fn failures_group_by_what_to_do() {
        let groups = group_failures(&[
            failure("a.mp4", "File content does not match extension .mp4"),
            failure("big.iso", "Storage limit exceeded"),
            failure("b.mpeg", "File content does not match extension .mpeg"),
        ]);
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].0, "Content does not match the file extension");
        assert_eq!(groups[0].1, vec!["a.mp4".to_string(), "b.mpeg".to_string()]);
        assert_eq!(groups[1], ("Storage limit exceeded".to_string(), vec!["big.iso".to_string()]));
        let unreadable = group_failures(&[
            failure("a.txt", r"Cannot read C:\Temp\a.txt: not found"),
            failure("b.txt", r"Cannot read C:\Temp\b.txt: not found"),
        ]);
        assert_eq!(
            unreadable,
            vec![("The file could not be read: not found".to_string(), vec!["a.txt".into(), "b.txt".into()])]
        );
    }

    #[test]
    fn a_batch_reports_once_and_skips_cancelled() {
        let mut transfers = Transfers::default();
        transfers.queue_uploads(Vec::new(), None);
        for (name, state) in [("x", State::Failed("Nope".into())), ("y", State::Failed("Cancelled".into()))] {
            transfers.next_id += 1;
            transfers.items.push(Transfer {
                id: transfers.next_id,
                name: name.into(),
                direction: Direction::Up,
                progress: Progress::new(1),
                state,
                upload: None,
                replace: None,
                reported: false,
            });
        }
        assert_eq!(unreported_failures(&mut transfers), vec![failure("x", "Nope")]);
        assert!(unreported_failures(&mut transfers).is_empty());
    }
}
