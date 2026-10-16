//! What the transfer panel says: a headline that names the work and how it
//! went, and each row's status. Pure, so the wording is tested.

/// The kind of work a row stands for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Upload,
    Download,
    Job,
}

/// One row as the headline sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Pending,
    Done,
    Failed,
    Cancelled,
}

fn files(n: usize) -> String {
    if n == 1 { "1 file".into() } else { format!("{n} files") }
}

/// A job's name once it has finished: "Moving 3 items to the trash" → "Moved 3 items to the trash".
pub fn finished(name: &str) -> String {
    const VERBS: [(&str, &str); 6] = [
        ("Moving", "Moved"),
        ("Restoring", "Restored"),
        ("Copying", "Copied"),
        ("Deleting", "Deleted"),
        ("Emptying", "Emptied"),
        ("Preparing", "Prepared"),
    ];
    VERBS
        .iter()
        .find_map(|(now, done)| name.strip_prefix(now).map(|rest| format!("{done}{rest}")))
        .unwrap_or_else(|| name.to_string())
}

/// Moving to the trash is not a transfer: a list with any such work says "tasks".
fn noun(rows: &[(Kind, Outcome, &str)]) -> &'static str {
    if rows.iter().any(|r| r.0 == Kind::Job) { "tasks" } else { "transfers" }
}

/// The headline over the list. `current` is the name of a row still running, if any.
pub fn headline(rows: &[(Kind, Outcome, &str)]) -> String {
    let count = |kind: Kind, outcome: Outcome| rows.iter().filter(|r| r.0 == kind && r.1 == outcome).count();
    let pending: Vec<&(Kind, Outcome, &str)> = rows.iter().filter(|r| r.1 == Outcome::Pending).collect();
    if let Some(first) = pending.first() {
        let finished_so_far = rows.iter().filter(|r| r.1 != Outcome::Pending).count();
        return match (pending.len(), first.0) {
            (1, Kind::Job) => format!("{}…", first.2),
            (1, Kind::Upload) if rows.len() == 1 => format!("Uploading {}", first.2),
            (1, Kind::Download) if rows.len() == 1 => format!("Downloading {}", first.2),
            _ if rows.iter().all(|r| r.0 == Kind::Upload) => {
                format!("Uploading {} of {}", (finished_so_far + 1).min(rows.len()), files(rows.len()))
            }
            _ if rows.iter().all(|r| r.0 == Kind::Download) => {
                format!("Downloading {} of {}", (finished_so_far + 1).min(rows.len()), files(rows.len()))
            }
            (n, _) => format!("{n} {} in progress", noun(rows)),
        };
    }
    let failed = rows.iter().filter(|r| r.1 == Outcome::Failed).count();
    let done = rows.iter().filter(|r| r.1 == Outcome::Done).count();
    if let [(kind, Outcome::Done, name)] = rows {
        return match kind {
            Kind::Upload => format!("Uploaded {name}"),
            Kind::Download => format!("Downloaded {name}"),
            Kind::Job => finished(name),
        };
    }
    if let [(_, Outcome::Failed, name)] = rows {
        return format!("Could not finish {name}");
    }
    if failed > 0 {
        return format!("{done} completed, {failed} failed");
    }
    let (up, down) = (count(Kind::Upload, Outcome::Done), count(Kind::Download, Outcome::Done));
    match (up, down) {
        _ if done == 0 => "Cancelled".into(),
        (n, 0) if n == done => format!("{} uploaded", files(n)),
        (0, n) if n == done => format!("{} downloaded", files(n)),
        _ => format!("{done} {} completed", noun(rows)),
    }
}

/// A finished row's status line.
pub fn row_status(kind: Kind) -> &'static str {
    match kind {
        Kind::Upload => "Uploaded",
        Kind::Download => "Saved",
        Kind::Job => "Completed",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use Kind::*;
    use Outcome::*;

    #[test]
    fn single_items_name_themselves() {
        assert_eq!(headline(&[(Upload, Done, "Docker_Clean.md")]), "Uploaded Docker_Clean.md");
        assert_eq!(headline(&[(Upload, Pending, "Docker_Clean.md")]), "Uploading Docker_Clean.md");
        assert_eq!(headline(&[(Download, Done, "a.zip")]), "Downloaded a.zip");
        assert_eq!(headline(&[(Job, Pending, "Moving 3 items to the trash")]), "Moving 3 items to the trash…");
        assert_eq!(headline(&[(Job, Done, "Moving 3 items to the trash")]), "Moved 3 items to the trash");
        assert_eq!(headline(&[(Upload, Failed, "big.iso")]), "Could not finish big.iso");
    }

    #[test]
    fn batches_count() {
        let rows = [(Upload, Done, "a"), (Upload, Pending, "b"), (Upload, Pending, "c")];
        assert_eq!(headline(&rows), "Uploading 2 of 3 files");
        assert_eq!(headline(&[(Upload, Done, "a"), (Upload, Done, "b")]), "2 files uploaded");
        assert_eq!(headline(&[(Download, Done, "a"), (Download, Done, "b")]), "2 files downloaded");
        assert_eq!(headline(&[(Upload, Done, "a"), (Download, Done, "b")]), "2 transfers completed");
        assert_eq!(headline(&[(Upload, Done, "a"), (Upload, Failed, "b")]), "1 completed, 1 failed");
        assert_eq!(headline(&[(Upload, Cancelled, "a"), (Upload, Cancelled, "b")]), "Cancelled");
        assert_eq!(headline(&[(Upload, Pending, "a"), (Job, Pending, "Copying 2 items")]), "2 tasks in progress");
        assert_eq!(headline(&[(Upload, Done, "a"), (Job, Done, "Moving 1 item to the trash")]), "2 tasks completed");
    }

    #[test]
    fn jobs_read_as_finished() {
        assert_eq!(finished("Emptying the trash"), "Emptied the trash");
        assert_eq!(finished("Deleting 4 items forever"), "Deleted 4 items forever");
        assert_eq!(finished("Something else"), "Something else");
        assert_eq!(row_status(Download), "Saved");
    }
}
