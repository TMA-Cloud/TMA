//! Uploads and downloads with progress: a queue that runs three at a time and
//! the panel that shows it.

use std::sync::Arc;

use tma_client::{Client, Progress, UploadFile, UploadOptions};

use crate::app::{App, Main};
use crate::tasks::Tasks;

mod panel;

pub use panel::show;

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
    /// When everything last finished without a failure; the panel hides a little after.
    finished_at: Option<f64>,
}

/// Where the panel leaves its height for the toasts, which sit above it.
pub const PANEL_HEIGHT: &str = "tma-transfer-panel-height";

/// Seconds a finished, failure-free panel stays up before it hides itself.
pub(super) const HIDE_AFTER: f64 = 5.0;

fn kind(direction: Direction) -> crate::transfer_text::Kind {
    use crate::transfer_text::Kind;
    match direction {
        Direction::Up => Kind::Upload,
        Direction::Down => Kind::Download,
        Direction::Job(_) => Kind::Job,
    }
}

fn outcome(state: &State) -> crate::transfer_text::Outcome {
    use crate::transfer_text::Outcome;
    match state {
        State::Queued | State::Running => Outcome::Pending,
        State::Done => Outcome::Done,
        State::Failed(reason) if reason == "Cancelled" => Outcome::Cancelled,
        State::Failed(_) => Outcome::Failed,
    }
}

impl Transfers {
    /// One upload waiting its turn; No files replaced is the file whose content it becomes.
    fn push_upload(&mut self, file: UploadFile, options: UploadOptions, replace: Option<String>) {
        self.next_id += 1;
        self.items.push(Transfer {
            id: self.next_id,
            name: file.name.clone(),
            direction: Direction::Up,
            progress: Progress::new(file.size),
            state: State::Queued,
            upload: Some((file, options)),
            replace,
            reported: false,
        });
        self.expanded = true;
    }

    pub fn queue_uploads(&mut self, files: Vec<UploadFile>, parent: Option<String>) {
        for file in files {
            self.push_upload(file, UploadOptions { parent_id: parent.clone() }, None);
        }
    }

    /// Upload new content for an existing file (same ID, name and shares).
    pub fn queue_replace(&mut self, file: UploadFile, existing_id: String) {
        self.push_upload(file, UploadOptions::default(), Some(existing_id));
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

    /// Stop every upload and download not finished yet: a large folder is one choice, not
    /// hundreds. Files already sent stay; server jobs run to the end.
    pub fn cancel_all(&mut self) {
        for item in self.items.iter_mut().filter(|i| !matches!(i.direction, Direction::Job(_))) {
            match item.state {
                State::Queued => {
                    item.progress.cancel();
                    item.state = State::Failed("Cancelled".into());
                }
                State::Running => item.progress.cancel(),
                State::Done | State::Failed(_) => {}
            }
        }
    }

    /// Whether any upload or download can still be cancelled.
    pub fn can_cancel(&self) -> bool {
        self.items
            .iter()
            .any(|i| !matches!(i.direction, Direction::Job(_)) && matches!(i.state, State::Running | State::Queued))
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

    #[test]
    fn cancel_all_stops_every_upload_but_not_server_jobs() {
        let mut transfers = Transfers::default();
        for (name, direction, state) in [
            ("sent.pdf", Direction::Up, State::Done),
            ("sending.pdf", Direction::Up, State::Running),
            ("waiting.pdf", Direction::Up, State::Queued),
            ("copying", Direction::Job("copy"), State::Running),
        ] {
            transfers.next_id += 1;
            transfers.items.push(Transfer {
                id: transfers.next_id,
                name: name.into(),
                direction,
                progress: Progress::new(1),
                state,
                upload: None,
                replace: None,
                reported: false,
            });
        }
        assert!(transfers.can_cancel());
        transfers.cancel_all();
        let cancelled: Vec<bool> = transfers.items.iter().map(|i| i.progress.is_cancelled()).collect();
        assert_eq!(cancelled, [false, true, true, false]);
        assert_eq!(transfers.items[0].state, State::Done);
        assert_eq!(transfers.items[2].state, State::Failed("Cancelled".into()));
        // The running upload ends once its request stops; the server job keeps going.
        assert_eq!(transfers.items[3].state, State::Running);
    }
}
