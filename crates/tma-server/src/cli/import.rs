//! Import a folder tree from disk into an account: folders are recreated, files
//! are encrypted and stored exactly as uploads are, and dates are kept. Size
//! limits are checked before anything is written; a failure rolls back the run.

use std::path::{Path, PathBuf};

use anyhow::{Context, bail};
use futures::StreamExt;

use super::ImportArgs;
use crate::config::Config;
use crate::models::files::crud::{self, PlannedUpload};
use crate::models::files::import;
use crate::models::users;
use crate::server::{self, Role};
use crate::state::AppState;

const BATCH: usize = 250;

struct Item {
    path: PathBuf,
    relative: String,
    is_dir: bool,
}

/// Every folder before its contents, sorted for a stable order.
fn walk(root: &Path) -> anyhow::Result<Vec<Item>> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let mut entries: Vec<_> =
            std::fs::read_dir(&dir).with_context(|| format!("Cannot read {}", dir.display()))?.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        let mut subdirs = Vec::new();
        for entry in entries {
            let path = entry.path();
            let relative = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
            let kind = entry.file_type()?;
            if kind.is_dir() {
                out.push(Item { path: path.clone(), relative, is_dir: true });
                subdirs.push(path);
            } else if kind.is_file() {
                out.push(Item { path, relative, is_dir: false });
            }
        }
        stack.extend(subdirs.into_iter().rev());
    }
    out.sort_by(|a, b| a.relative.cmp(&b.relative));
    Ok(out)
}

fn depth(relative: &str) -> i32 {
    relative.split('/').count() as i32
}

fn parent_of(relative: &str) -> &str {
    relative.rsplit_once('/').map(|(p, _)| p).unwrap_or("")
}

fn mtime(path: &Path) -> Option<chrono::DateTime<chrono::Utc>> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok().map(chrono::DateTime::<chrono::Utc>::from)
}

/// A name the app accepts: reserved characters become "_".
fn clean_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if matches!(c, '<' | '>' | ':' | '"' | '\\' | '/' | '|' | '?' | '*') { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim_matches('.').to_string();
    if cleaned.is_empty() { format!("file_{}", chrono::Utc::now().timestamp_millis()) } else { cleaned }
}

async fn store_file(state: &AppState, item: &Item, max: u64, index: usize) -> anyhow::Result<crud::StreamedUpload> {
    let name = clean_name(item.path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default().as_str());
    let file =
        tokio::fs::File::open(&item.path).await.with_context(|| format!("Cannot read {}", item.path.display()))?;
    let chunks = tokio_util::io::ReaderStream::with_capacity(file, 1 << 20).map(|c| c.map_err(|e| e.to_string()));
    let declared = mime_guess::from_path(&name).first_raw().map(String::from);
    crate::transfer::upload::store_stream(state, Box::pin(chunks), &name, declared, max, index)
        .await
        .map_err(|e| anyhow::anyhow!("{}: {e}", item.relative))
}

pub async fn run(args: ImportArgs) -> anyhow::Result<()> {
    if !args.source_dir.is_dir() {
        bail!("Source path is not a folder: {}", args.source_dir.display());
    }
    let items = walk(&args.source_dir)?;
    let files: Vec<&Item> = items.iter().filter(|i| !i.is_dir).collect();
    let total: u64 = files.iter().filter_map(|i| std::fs::metadata(&i.path).ok()).map(|m| m.len()).sum();
    let folders = items.len() - files.len();
    println!("Found {folders} folders and {} files, {}.", files.len(), tma_core::format::file_size(total as i64));
    if args.dry_run {
        return Ok(());
    }

    server::init_tracing();
    let state = server::build_state(Config::from_env()?, Role::Worker).await?;
    let owner = import::user_id(&state.pool, args.user_id.as_deref(), args.user_email.as_deref()).await?;
    let max = state.settings.get().await.max_upload_bytes() as u64;
    let oversize: Vec<&&Item> =
        files.iter().filter(|i| std::fs::metadata(&i.path).map(|m| m.len() > max).unwrap_or(false)).collect();
    if !oversize.is_empty() {
        let list: Vec<&str> = oversize.iter().take(20).map(|i| i.relative.as_str()).collect();
        bail!(
            "Import aborted before writing anything: {} file(s) exceed the {} limit: {}",
            oversize.len(),
            tma_core::format::file_size(max as i64),
            list.join(", ")
        );
    }
    let used = users::storage_used(&state.pool, &owner).await?;
    if let Some(limit) = users::storage_limit(&state.pool, &owner).await?
        && used + total as i64 > limit
    {
        bail!(
            "Import aborted before writing anything: it would exceed the account's {} storage limit",
            tma_core::format::file_size(limit)
        );
    }

    let run = uuid::Uuid::new_v4();
    match import_items(&state, &owner, run, &items, max, args.concurrency.max(1)).await {
        Ok(count) => {
            import::finish(&state.pool, run).await?;
            users::forget(&state, &owner).await;
            println!("Done: imported {count} files.");
            Ok(())
        }
        Err(err) => {
            eprintln!("Import failed: {err:#}. Rolling back…");
            let (f, d) = import::rollback(&state.pool, &state.storage, run, &owner).await?;
            eprintln!("Rolled back {f} files and {d} folders.");
            Err(err)
        }
    }
}

async fn import_items(
    state: &AppState,
    owner: &str,
    run: uuid::Uuid,
    items: &[Item],
    max: u64,
    concurrency: usize,
) -> anyhow::Result<usize> {
    let mut folder_ids: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut batch: Vec<&Item> = Vec::new();
    let mut done = 0usize;
    for item in items {
        if item.is_dir {
            done += commit(state, owner, run, &folder_ids, &mut batch, max, concurrency).await?;
            let parent = folder_ids.get(parent_of(&item.relative)).cloned();
            let name =
                clean_name(item.path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default().as_str());
            let id = import::create_folder(
                &state.pool,
                run,
                owner,
                &name,
                parent.as_deref(),
                mtime(&item.path),
                depth(&item.relative),
            )
            .await?;
            folder_ids.insert(item.relative.clone(), id);
        } else {
            batch.push(item);
            if batch.len() >= BATCH {
                done += commit(state, owner, run, &folder_ids, &mut batch, max, concurrency).await?;
            }
        }
    }
    done += commit(state, owner, run, &folder_ids, &mut batch, max, concurrency).await?;
    Ok(done)
}

/// Upload a batch, then insert its rows and record them for rollback.
async fn commit(
    state: &AppState,
    owner: &str,
    run: uuid::Uuid,
    folders: &std::collections::HashMap<String, String>,
    batch: &mut Vec<&Item>,
    max: u64,
    concurrency: usize,
) -> anyhow::Result<usize> {
    if batch.is_empty() {
        return Ok(0);
    }
    let items = std::mem::take(batch);
    let uploads: Vec<anyhow::Result<crud::StreamedUpload>> =
        futures::stream::iter(items.iter().enumerate().map(|(i, item)| store_file(state, item, max, i)))
            .buffered(concurrency)
            .collect()
            .await;
    let mut stored = Vec::with_capacity(uploads.len());
    let mut failure = None;
    for upload in uploads {
        match upload {
            Ok(u) => stored.push(u),
            Err(e) => failure = failure.or(Some(e)),
        }
    }
    let keys: Vec<String> = stored.iter().map(|u| u.storage_name.clone()).collect();
    if let Some(err) = failure {
        let _ = state.storage.delete_many(&keys).await;
        return Err(err);
    }
    let planned: Vec<PlannedUpload> = stored
        .iter()
        .zip(items.iter())
        .map(|(upload, item)| PlannedUpload {
            upload: upload.clone(),
            parent_id: folders.get(parent_of(&item.relative)).cloned(),
            modified: mtime(&item.path),
            client_id: None,
        })
        .collect();
    let rows = match crud::insert_uploads(&state.pool, &planned, owner).await {
        Ok(rows) => rows,
        Err(err) => {
            let _ = state.storage.delete_many(&keys).await;
            return Err(err);
        }
    };
    let records: Vec<(String, String, i32)> = rows
        .iter()
        .zip(items.iter())
        .zip(keys.iter())
        .map(|((row, item), key)| (row.id.clone(), key.clone(), depth(&item.relative)))
        .collect();
    import::record_files(&state.pool, run, owner, &records).await?;
    println!("Imported {} files…", rows.len());
    Ok(rows.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helpers() {
        assert_eq!(parent_of("a/b/c.txt"), "a/b");
        assert_eq!(parent_of("c.txt"), "");
        assert_eq!(depth("a/b"), 2);
        assert_eq!(clean_name("a:b?.txt"), "a_b_.txt");
    }
}
