//! Build a production-shaped account through the API: the owner, sub-users who
//! may do everything, and production's tree (2,194 folders up to 10 deep,
//! 16,787 files, a few folders holding hundreds of items) times a scale.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tma_client::{Client, Progress, Source, UploadFile, UploadOptions};
use tma_core::api::{CreateSubUserRequest, StorageSettingsInput};

use crate::rng::Rng;
use crate::stats::lock;
use crate::{block, email, password};

/// Uploads in flight while seeding.
const UPLOADERS: usize = 24;
/// Seeded files are capped at this size; listing and sync load do not depend on it.
const MAX_SEED_FILE: usize = 512 * 1024;
/// Words seeded file names are made of.
const KINDS: [&str; 12] = [
    "Invoice",
    "Report",
    "Scan",
    "Contract",
    "Photo",
    "Budget",
    "Minutes",
    "Statement",
    "Plan",
    "Receipt",
    "Memo",
    "Draft",
];
const TOPICS: [&str; 12] = [
    "Northwind",
    "Payroll",
    "Warehouse",
    "Quarterly",
    "Customer",
    "Supplier",
    "Audit",
    "Project",
    "Tax",
    "Branch",
    "Fleet",
    "Training",
];

pub fn upload(client: &Client, folder: Option<&str>, name: &str, bytes: Vec<u8>) -> Result<String, String> {
    let file = UploadFile {
        name: name.into(),
        size: bytes.len() as u64,
        source: Source::Bytes(bytes.into()),
        modified_ms: None,
        relative_dir: None,
    };
    let options = UploadOptions { parent_id: folder.map(String::from) };
    block(client.upload(&file, &options, Progress::new(file.size))).map(|f| f.id).map_err(|e| e.message)
}

/// Sign up the owner (the first user on a fresh server), or sign in when it exists.
fn owner(base: &str) -> Result<Client, String> {
    let client = Client::new(base).map_err(|e| e.message)?;
    if block(client.signup(Some("Load Owner"), &email(0), &password())).is_err() {
        block(client.login(&email(0), &password(), None)).map_err(|e| format!("owner sign-in: {}", e.message))?;
    }
    Ok(client)
}

/// Connect the bucket named by TMA_LOAD_S3_* when set; otherwise the server's own is kept.
fn connect_storage(client: &Client) {
    let var = |n: &str| std::env::var(n).ok();
    let Some(endpoint) = var("TMA_LOAD_S3_ENDPOINT") else { return };
    let input = StorageSettingsInput {
        provider: "s3".into(),
        endpoint: Some(endpoint),
        region: Some(var("TMA_LOAD_S3_REGION").unwrap_or_else(|| "us-east-1".into())),
        bucket: var("TMA_LOAD_S3_BUCKET"),
        force_path_style: Some(true),
        access_key_id: var("TMA_LOAD_S3_ACCESS_KEY"),
        secret_access_key: var("TMA_LOAD_S3_SECRET_KEY"),
        expected_version: None,
    };
    if let Err(err) = block(client.save_storage_config(&input)) {
        println!("storage: {}", err.message);
    }
}

pub fn seed(base: &str, users: usize, scale: usize) -> Result<(), String> {
    let client = owner(base)?;
    connect_storage(&client);
    for n in 1..=users {
        let request = CreateSubUserRequest {
            email: email(n),
            password: password(),
            name: format!("User {n}"),
            permissions: tma_core::permissions::all_keys(),
        };
        if let Err(err) = block(client.create_sub_user(&request)) {
            println!("sub-user {n}: {}", err.message);
        }
    }
    let started = Instant::now();
    let folders = make_folders(&client, 2194 * scale.max(1))?;
    println!("{} folders in {:?}", folders.len(), started.elapsed());
    let uploaded = upload_files(base, users, &folders, 16787 * scale.max(1));
    println!("seeded {} folders and {uploaded} files in {:?}", folders.len(), started.elapsed());
    Ok(())
}

/// Each new folder goes under a recent one above depth 10, now and then at the root,
/// which grows production's deep, narrow tree.
fn make_folders(client: &Client, total: usize) -> Result<Vec<String>, String> {
    let mut rng = Rng::new(1);
    let mut folders: Vec<(String, usize)> = Vec::new();
    for n in 0..total {
        let shallow: Vec<&(String, usize)> = folders.iter().rev().take(400).filter(|f| f.1 < 10).collect();
        let parent = if rng.chance(0.01) { None } else { rng.pick(&shallow).map(|f| (*f).clone()) };
        let depth = parent.as_ref().map_or(1, |p| p.1 + 1);
        let made = block(client.create_folder(&format!("Folder {n}"), parent.as_ref().map(|p| p.0.as_str())))
            .map_err(|e| format!("folder {n}: {}", e.message))?;
        folders.push((made.id, depth));
    }
    Ok(folders.into_iter().map(|f| f.0).collect())
}

/// A fifth of the files go to one folder in a hundred, as production's busiest do.
/// Uploaders sign in as different people, so no one's request budget runs out.
fn upload_files(base: &str, users: usize, folders: &[String], total: usize) -> usize {
    let mut rng = Rng::new(2);
    let busy = rng.sample(folders, (folders.len() / 100).max(1));
    let plan: Vec<(String, String)> = (0..total)
        .filter_map(|n| {
            let folder = if rng.chance(0.2) { rng.pick(&busy) } else { rng.pick(folders) }?.clone();
            let ext = rng.pick(&["pdf", "jpg", "xlsx", "htm", "gif", "docx", "txt", "xml"])?;
            // Varied names, so search timings mean something (one shared word matches every file).
            let kind = rng.pick(&KINDS)?;
            let topic = rng.pick(&TOPICS)?;
            Some((folder, format!("{topic} {kind} {n}.{ext}")))
        })
        .collect();
    let queue = Arc::new(Mutex::new(plan));
    let done = Arc::new(Mutex::new(0usize));
    let workers: Vec<_> = (0..UPLOADERS)
        .map(|w| {
            let (queue, done, base) = (queue.clone(), done.clone(), base.to_string());
            std::thread::spawn(move || {
                let client = match crate::sign_in(&base, &email(w % (users + 1))) {
                    Ok(client) => client,
                    Err(err) => return println!("{err}"),
                };
                let mut rng = Rng::new(100 + w as u64);
                while let Some((folder, name)) = lock(&queue).pop() {
                    match upload(&client, Some(&folder), &name, rng.body(MAX_SEED_FILE)) {
                        Ok(_) => *lock(&done) += 1,
                        Err(err) => println!("upload {name}: {err}"),
                    }
                }
            })
        })
        .collect();
    while workers.iter().any(|w| !w.is_finished()) {
        std::thread::sleep(Duration::from_secs(15));
        println!("files {}/{total}", lock(&done));
    }
    *lock(&done)
}
