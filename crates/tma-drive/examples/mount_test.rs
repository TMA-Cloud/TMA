//! Mount Cloud Drive against a running server and exercise it with ordinary
//! file operations, the way apps use it (Windows only):
//! `TMA_URL=... TMA_EMAIL=... TMA_PASSWORD=... cargo run -p tma-drive --example mount_test`

#[cfg(windows)]
fn main() {
    if let Err(err) = run() {
        eprintln!("FAILED: {err}");
        std::process::exit(1);
    }
    println!("OK");
}

#[cfg(not(windows))]
fn main() {
    eprintln!("The mount test runs on Windows.");
}

#[cfg(windows)]
fn run() -> Result<(), String> {
    use std::io::Write;
    use std::sync::Arc;

    let env = |n: &str| std::env::var(n).map_err(|_| format!("{n} is not set"));
    let client = tma_client::Client::new(&env("TMA_URL")?).map_err(|e| e.message)?;
    tma_client::rt::block_on(client.login(&env("TMA_EMAIL")?, &env("TMA_PASSWORD")?, None)).map_err(|e| e.message)?;
    let backend = Arc::new(tma_drive::ClientBackend::new(client.clone()));
    let core = Arc::new(
        tma_drive::Core::new(backend, std::env::temp_dir().join("tma-drive-test"), true).map_err(|e| e.to_string())?,
    );
    let mounted = tma_drive::mount(core, "TMA Cloud Test", None)?;
    let root = format!("{}\\", mounted.mount_point);
    println!("mounted at {root}");
    let p = |rel: &str| std::path::PathBuf::from(format!("{root}{rel}"));

    let names: Vec<String> = std::fs::read_dir(&root)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    println!("root: {}", names.join(", "));
    if !names.iter().any(|n| n == "Finance") {
        return Err("seeded Finance folder not listed".into());
    }
    let budget = std::fs::read(p("Finance\\Q3 Budget.xlsx")).map_err(|e| format!("read: {e}"))?;
    println!("read Q3 Budget.xlsx: {} bytes", budget.len());

    std::fs::create_dir(p("Drive Test")).map_err(|e| format!("mkdir: {e}"))?;
    // Create then write, as most apps do.
    let mut f = std::fs::File::create(p("Drive Test\\note.txt")).map_err(|e| format!("create: {e}"))?;
    f.write_all(b"written through Cloud Drive").map_err(|e| e.to_string())?;
    drop(f);
    let back = std::fs::read(p("Drive Test\\note.txt")).map_err(|e| format!("read back: {e}"))?;
    if back != b"written through Cloud Drive" {
        return Err("content mismatch after write".into());
    }
    // Save via temp file + rename over the original, as Office does.
    std::fs::write(p("Drive Test\\~tmp1.tmp"), b"second version").map_err(|e| format!("temp write: {e}"))?;
    std::fs::rename(p("Drive Test\\~tmp1.tmp"), p("Drive Test\\note.txt")).map_err(|e| format!("rename over: {e}"))?;
    std::thread::sleep(std::time::Duration::from_millis(300));
    let v2 = std::fs::read(p("Drive Test\\note.txt")).map_err(|e| format!("read v2: {e}"))?;
    if v2 != b"second version" {
        return Err(format!("rename-over kept {:?}", String::from_utf8_lossy(&v2)));
    }
    std::fs::rename(p("Drive Test\\note.txt"), p("Drive Test\\renamed.txt")).map_err(|e| format!("rename: {e}"))?;
    std::fs::remove_file(p("Drive Test\\renamed.txt")).map_err(|e| format!("delete: {e}"))?;
    std::fs::remove_dir(p("Drive Test")).map_err(|e| format!("rmdir: {e}"))?;
    println!("create, write, rename-over, rename, delete all worked");
    drop(mounted);

    // Clean the trash entries this test made.
    let trash =
        tma_client::rt::block_on(client.list(&tma_client::View::Trash, &Default::default())).map_err(|e| e.message)?;
    let ids: Vec<String> = trash
        .files
        .iter()
        .filter(|f| f.name == "Drive Test" || f.name.ends_with(".txt") || f.name.ends_with(".tmp"))
        .map(|f| f.id.clone())
        .collect();
    if !ids.is_empty() {
        let queued = tma_client::rt::block_on(client.delete_forever(&ids)).map_err(|e| e.message)?;
        if let Some(job) = queued.job_id {
            tma_client::rt::block_on(client.wait_for_job(&job)).map_err(|e| e.message)?;
        }
    }
    Ok(())
}
