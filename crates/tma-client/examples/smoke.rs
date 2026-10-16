//! Exercise the native client against a running server:
//! `TMA_URL=http://localhost:3200 TMA_EMAIL=... TMA_PASSWORD=... cargo run -p tma-client --example smoke`

use tma_client::{Client, ListQuery, Progress, Source, UploadFile, UploadOptions, View};

fn env(name: &str) -> Result<String, String> {
    std::env::var(name).map_err(|_| format!("{name} is not set"))
}

async fn run() -> Result<(), String> {
    let url = env("TMA_URL")?;
    let client = Client::new(&url).map_err(|e| e.message)?;
    let user = client.login(&env("TMA_EMAIL")?, &env("TMA_PASSWORD")?, None).await.map_err(|e| e.message)?;
    println!("signed in as {}", user.email);
    let token = client.session_token().ok_or("no session cookie after sign-in")?;

    // A fresh client with only the saved token must be signed in too.
    let restored = Client::new(&url).map_err(|e| e.message)?;
    restored.restore_session(&token);
    let again = restored.profile().await.map_err(|e| e.message)?;
    println!("restored session for {}", again.email);

    let root = restored.list(&View::Folder(None), &ListQuery::default()).await.map_err(|e| e.message)?;
    println!("root has {} items", root.files.len());

    let body = b"hello from the native client".to_vec();
    let file = UploadFile {
        name: "smoke-native.txt".into(),
        size: body.len() as u64,
        source: Source::Bytes(body.clone().into()),
        modified_ms: None,
        relative_dir: Some("Smoke Test".into()),
    };
    let item =
        restored.upload(&file, &UploadOptions::default(), Progress::new(file.size)).await.map_err(|e| e.message)?;
    println!("uploaded {} into a new folder", item.name);

    let dest = std::env::temp_dir().join("tma-smoke-native.txt");
    restored.download_to(&item.id, &dest, Progress::new(0)).await.map_err(|e| e.message)?;
    let back = std::fs::read(&dest).map_err(|e| e.to_string())?;
    if back != body {
        return Err("downloaded bytes differ".into());
    }
    println!("download matches");

    let folder = restored
        .list(&View::Folder(None), &ListQuery::default())
        .await
        .map_err(|e| e.message)?
        .files
        .into_iter()
        .find(|f| f.name == "Smoke Test")
        .ok_or("folder missing")?;
    let queued = restored.trash(std::slice::from_ref(&folder.id)).await.map_err(|e| e.message)?;
    let gone = restored.delete_forever(std::slice::from_ref(&folder.id)).await.map_err(|e| e.message)?;
    if let Some(job) = gone.job_id {
        restored.wait_for_job(&job).await.map_err(|e| e.message)?;
    }
    println!("cleaned up ({})", if queued.queued { "queued" } else { "direct" });
    let _ = std::fs::remove_file(dest);
    Ok(())
}

fn main() {
    match tma_client::rt::block_on(run()) {
        Ok(()) => println!("OK"),
        Err(err) => {
            eprintln!("FAILED: {err}");
            std::process::exit(1);
        }
    }
}
