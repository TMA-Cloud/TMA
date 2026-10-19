//! The rare, heavy work: big files, bulk copies and deletes, refused uploads,
//! and how long the read paths take on the account as it stands.

use std::time::Instant;

use tma_client::{Client, ListQuery, Progress, Source, UploadFile, UploadOptions, View};
use tma_core::api::CreateSubUserRequest;
use tma_drive::{Backend, ClientBackend};

use crate::corpus::Corpus;
use crate::{block, email, password, sign_in};

/// A file of `mb` MiB in the temp folder, written once and reused.
fn big_file(mb: u64) -> Result<std::path::PathBuf, String> {
    let path = std::env::temp_dir().join(format!("tma-load-big-{mb}.bin"));
    if std::fs::metadata(&path).map(|m| m.len()).ok() != Some(mb * 1024 * 1024) {
        let chunk = vec![7u8; 1024 * 1024];
        let mut out = std::fs::File::create(&path).map_err(|e| e.to_string())?;
        for _ in 0..mb {
            std::io::Write::write_all(&mut out, &chunk).map_err(|e| e.to_string())?;
        }
    }
    Ok(path)
}

fn upload_path(client: &Client, name: &str, mb: u64) -> Result<String, tma_client::ApiError> {
    let path = big_file(mb).map_err(tma_client::ApiError::local)?;
    let file = UploadFile {
        name: name.into(),
        size: mb * 1024 * 1024,
        source: Source::Path(path),
        modified_ms: None,
        relative_dir: None,
    };
    block(client.upload(&file, &UploadOptions::default(), Progress::new(file.size))).map(|f| f.id)
}

/// `count` uploads of `mb` MiB at once, then downloads of all of them at once.
pub fn bigfiles(base: &str, count: usize, mb: u64) -> Result<(), String> {
    let client = sign_in(base, &email(0))?;
    big_file(mb)?;
    let started = Instant::now();
    let ids: Vec<String> = std::thread::scope(|s| {
        let uploads: Vec<_> = (0..count)
            .map(|n| {
                let client = client.clone();
                s.spawn(move || upload_path(&client, &format!("Big {n} {}.bin", started.elapsed().as_nanos()), mb))
            })
            .collect();
        uploads
            .into_iter()
            .filter_map(|u| u.join().ok())
            .filter_map(|r| r.map_err(|e| println!("upload: {}", e.message)).ok())
            .collect()
    });
    let rate = |n: usize, t: Instant| (n as u64 * mb) as f64 / t.elapsed().as_secs_f64();
    println!("{} × {mb} MiB uploaded in {:?} ({:.0} MiB/s)", ids.len(), started.elapsed(), rate(ids.len(), started));
    let started = Instant::now();
    std::thread::scope(|s| {
        for id in &ids {
            let backend = ClientBackend::new(client.clone());
            s.spawn(move || {
                if let Err(err) = backend.download_with(id, &mut |_| Ok(())) {
                    println!("download {id}: {err}");
                }
            });
        }
    });
    println!("{} × {mb} MiB downloaded in {:?} ({:.0} MiB/s)", ids.len(), started.elapsed(), rate(ids.len(), started));
    block(client.trash(&ids)).map(|_| ()).map_err(|e| e.message)
}

/// Copy the largest top-level folder whole, then trash the copy and delete it for good.
pub fn bulk(base: &str) -> Result<(), String> {
    let client = sign_in(base, &email(0))?;
    let root = block(client.list(&View::Folder(None), &ListQuery::default())).map_err(|e| e.message)?.files;
    let biggest =
        root.iter().filter(|f| f.is_folder()).max_by_key(|f| f.size.unwrap_or(0)).ok_or("no folder to copy")?;
    let info = block(client.info(&biggest.id)).map_err(|e| e.message)?.folder_info;
    println!("copying {} ({info:?})", biggest.name);
    let timed =
        |what: &str, queued: Result<tma_core::api::QueuedResponse, tma_client::ApiError>| -> Result<(), String> {
            let started = Instant::now();
            let queued = queued.map_err(|e| e.message)?;
            block(client.settle(&queued)).map_err(|e| e.message)?;
            println!("{what}: {:?}", started.elapsed());
            Ok(())
        };
    timed("copy", block(client.copy_items(std::slice::from_ref(&biggest.id), None)))?;
    let root = block(client.list(&View::Folder(None), &ListQuery::default())).map_err(|e| e.message)?.files;
    let copy = root
        .iter()
        .filter(|f| f.id != biggest.id && f.name.starts_with(&biggest.name))
        .max_by_key(|f| f.modified)
        .ok_or("the copy did not appear")?;
    timed("trash", block(client.trash(std::slice::from_ref(&copy.id))))?;
    timed("delete forever", block(client.delete_forever(std::slice::from_ref(&copy.id))))
}

/// Uploads the server refuses must say why, not drop the connection: over the
/// storage limit, and from a sub-user without the upload permission.
pub fn refusals(base: &str) -> Result<(), String> {
    let owner = sign_in(base, &email(0))?;
    let me = block(owner.profile()).map_err(|e| e.message)?;
    let used = block(owner.storage_usage()).map_err(|e| e.message)?.used;
    block(owner.set_storage_limit(&me.id, Some(used + 2 * 1024 * 1024))).map_err(|e| e.message)?;
    let over = upload_path(&owner, "over-quota.bin", 5);
    block(owner.set_storage_limit(&me.id, None)).map_err(|e| e.message)?;
    println!("over quota: {:?}", over.map_err(|e| (e.status, e.message)));
    let request = CreateSubUserRequest {
        email: "viewer@load.test".into(),
        password: password(),
        name: "Viewer".into(),
        permissions: Vec::new(),
    };
    let _ = block(owner.create_sub_user(&request));
    let viewer = sign_in(base, "viewer@load.test")?;
    for mb in [1, 5, 40] {
        let refused = upload_path(&viewer, "not-allowed.bin", mb);
        println!("{mb} MiB without permission: {:?}", refused.map_err(|e| (e.status, e.message)));
    }
    Ok(())
}

/// Median and worst of five runs of each read path.
pub fn reads(base: &str) -> Result<(), String> {
    let client = sign_in(base, &email(0))?;
    let backend = ClientBackend::new(client.clone());
    let corpus = Corpus::walk(&client)?;
    let fullest = corpus.fullest_folder();
    let cursor = block(client.changes(None)).map_err(|e| e.message)?.cursor;
    let time = |name: &str, f: &dyn Fn() -> String| {
        let mut runs = Vec::new();
        let mut answer = String::new();
        for _ in 0..5 {
            let started = Instant::now();
            answer = f();
            runs.push(started.elapsed().as_millis());
        }
        runs.sort_unstable();
        println!("{name:<30} median {:>5} ms  worst {:>5} ms  ({answer})", runs[2], runs[4]);
    };
    time("drive listing of the root", &|| format!("{:?} items", backend.list(None).map(|l| l.len())));
    time("drive listing of the fullest", &|| format!("{:?} items", backend.list(fullest.as_deref()).map(|l| l.len())));
    time("search", &|| format!("{:?} hits", block(client.search("invoice", 50)).map(|r| r.len())));
    time("recent", &|| format!("{:?} items", block(client.recent(50)).map(|r| r.len())));
    time("stats", &|| format!("{:?}", block(client.stats()).map(|s| s.total_files)));
    time("changes since a cursor", &|| {
        format!("{:?} folders", block(client.changes(Some(&cursor))).map(|c| c.folders.len()))
    });
    time("storage usage", &|| format!("{:?} bytes", block(client.storage_usage()).map(|u| u.used)));
    Ok(())
}
