//! Mount Cloud Drive against a running server and exercise it with ordinary
//! file operations, the way apps use it. On Linux, `TMA_ADAPTER=nfs` tests the
//! macOS NFS adapter instead of FUSE (run as root, with the NFS client installed):
//! `TMA_URL=... TMA_EMAIL=... TMA_PASSWORD=... cargo run -p tma-drive --example mount_test`
//! `TMA_HOLD=<seconds>` keeps the drive mounted for trying it by hand instead.

#[cfg(any(windows, unix))]
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let result = match (args.get(1).map(String::as_str), args.get(2)) {
        (Some("--ops"), Some(root)) => ops(root),
        _ => host(),
    };
    if let Err(err) = result {
        eprintln!("FAILED: {err}");
        std::process::exit(1);
    }
    println!("OK");
}

#[cfg(not(any(windows, unix)))]
fn main() {
    eprintln!("The mount test runs on Windows, Linux and macOS.");
}

#[cfg(any(windows, unix))]
fn login() -> Result<tma_client::Client, String> {
    let env = |n: &str| std::env::var(n).map_err(|_| format!("{n} is not set"));
    let client = tma_client::Client::new(&env("TMA_URL")?).map_err(|e| e.message)?;
    tma_client::rt::block_on(client.login(&env("TMA_EMAIL")?, &env("TMA_PASSWORD")?, None)).map_err(|e| e.message)?;
    Ok(client)
}

/// Mount, then run the file operations in a child process: apps are other
/// processes, and Cloud Files never calls a sync engine for its own requests.
#[cfg(any(windows, unix))]
fn host() -> Result<(), String> {
    use std::sync::Arc;

    env_logger::init();
    let client = login()?;
    // A run that failed halfway leaves its folder behind; start clean.
    let root = tma_client::rt::block_on(client.list(&tma_client::View::Folder(None), &Default::default()))
        .map_err(|e| e.message)?;
    let stale: Vec<String> = root.files.iter().filter(|f| f.name == "Drive Test").map(|f| f.id.clone()).collect();
    if !stale.is_empty() {
        tma_client::rt::block_on(client.trash(&stale)).map_err(|e| e.message)?;
        clean_trash(&client)?;
    }
    let backend = Arc::new(tma_drive::ClientBackend::new(client.clone()));
    let core = Arc::new(
        tma_drive::Core::new(backend, std::env::temp_dir().join("tma-drive-test"), cfg!(windows))
            .map_err(|e| e.to_string())?,
    );
    let mounted = mount(core.clone())?;
    println!("mounted at {}", mounted.mount_point);
    // As in the app: a change made anywhere drops the cached listings.
    let _events = tma_client::events::subscribe(&client, Arc::new(move |_| core.invalidate_all()));
    if let Some(secs) = std::env::var("TMA_HOLD").ok().and_then(|s| s.parse().ok()) {
        std::thread::sleep(std::time::Duration::from_secs(secs));
        return Ok(());
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let status = std::process::Command::new(exe).arg("--ops").arg(&mounted.mount_point).status();
    drop(mounted);
    clean_trash(&client)?;
    match status {
        Ok(s) if s.success() => Ok(()),
        _ => Err("the file operations failed".into()),
    }
}

#[cfg(any(windows, unix))]
fn ops(mount_point: &str) -> Result<(), String> {
    use std::io::Write;

    let client = login()?;
    let sep = std::path::MAIN_SEPARATOR;
    let root = format!("{mount_point}{sep}");
    let p = |rel: &str| std::path::PathBuf::from(format!("{root}{}", rel.replace('\\', &sep.to_string())));

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

    // Left by a run that stopped halfway.
    let _ = std::fs::remove_dir_all(p("Drive Test"));
    std::fs::create_dir(p("Drive Test")).map_err(|e| format!("mkdir: {e}"))?;
    // Create then write, as most apps do.
    let mut f = std::fs::File::create(p("Drive Test\\note.txt")).map_err(|e| format!("create: {e}"))?;
    f.write_all(b"written through Cloud Drive").map_err(|e| e.to_string())?;
    drop(f);
    let back = std::fs::read(p("Drive Test\\note.txt")).map_err(|e| format!("read back: {e}"))?;
    if back != b"written through Cloud Drive" {
        return Err("content mismatch after write".into());
    }
    // Uploads may wait for the file to go quiet (NFS, Cloud Files), so poll the server.
    let wait_for = |name: &str, size: i64| {
        (0..30).find_map(|_| {
            std::thread::sleep(std::time::Duration::from_millis(500));
            tma_client::rt::block_on(client.search(name, 10))
                .ok()?
                .into_iter()
                .find(|f| f.name == name && f.size == Some(size))
                .map(|f| f.id)
        })
    };
    let first = wait_for("note.txt", 27).ok_or("note.txt never reached the server")?;
    println!("note.txt reached the server");

    // A file added on the server (the web app, another device) shows up in the drive.
    let folder = tma_client::rt::block_on(client.search("Drive Test", 10))
        .map_err(|e| e.message)?
        .into_iter()
        .find(|f| f.name == "Drive Test")
        .ok_or("Drive Test never reached the server")?;
    let made = std::env::temp_dir().join("tma-remote-upload.txt");
    std::fs::write(&made, b"made on the server").map_err(|e| e.to_string())?;
    let file = tma_client::UploadFile {
        name: "remote.txt".into(),
        size: 18,
        source: tma_client::Source::Path(made),
        modified_ms: None,
        relative_dir: None,
    };
    let options = tma_client::UploadOptions { parent_id: Some(folder.id) };
    tma_client::rt::block_on(client.upload(&file, &options, tma_client::Progress::new(18))).map_err(|e| e.message)?;
    let appeared = (0..30).any(|_| {
        std::thread::sleep(std::time::Duration::from_millis(500));
        std::fs::read(p("Drive Test\\remote.txt")).is_ok_and(|b| b == b"made on the server")
    });
    if !appeared {
        return Err("a file added on the server never showed up".into());
    }
    println!("a file added on the server showed up");
    // Save via temp file + rename over the original, as Office does.
    std::fs::write(p("Drive Test\\~tmp1.tmp"), b"second version").map_err(|e| format!("temp write: {e}"))?;
    std::fs::rename(p("Drive Test\\~tmp1.tmp"), p("Drive Test\\note.txt")).map_err(|e| format!("rename over: {e}"))?;
    std::thread::sleep(std::time::Duration::from_millis(300));
    let v2 = std::fs::read(p("Drive Test\\note.txt")).map_err(|e| format!("read v2: {e}"))?;
    if v2 != b"second version" {
        return Err(format!("rename-over kept {:?}", String::from_utf8_lossy(&v2)));
    }
    let second = wait_for("note.txt", 14).ok_or("the saved version never reached the server")?;
    if second != first {
        return Err("the saved version became a new file".into());
    }
    println!("saved version reached the server as the same file");
    // Word's save: the document becomes a backup, the new copy takes its name, the backup goes.
    std::thread::sleep(std::time::Duration::from_secs(1));
    std::fs::write(p("Drive Test\\~WRD0000.tmp"), b"third version").map_err(|e| format!("word temp: {e}"))?;
    std::fs::rename(p("Drive Test\\note.txt"), p("Drive Test\\~WRL0001.tmp")).map_err(|e| format!("backup: {e}"))?;
    std::fs::rename(p("Drive Test\\~WRD0000.tmp"), p("Drive Test\\note.txt")).map_err(|e| format!("word save: {e}"))?;
    std::fs::remove_file(p("Drive Test\\~WRL0001.tmp")).map_err(|e| format!("drop backup: {e}"))?;
    let third = wait_for("note.txt", 13).ok_or("Word's save never reached the server")?;
    if third != first {
        return Err("Word's save made a new file".into());
    }
    std::thread::sleep(std::time::Duration::from_secs(3));
    for scratch in ["~WRL0001.tmp", "~WRD0000.tmp", "~tmp1.tmp"] {
        let found = tma_client::rt::block_on(client.search(scratch, 10)).map_err(|e| e.message)?;
        if found.iter().any(|f| f.name == scratch) {
            return Err(format!("{scratch} was uploaded"));
        }
    }
    println!("Word's save kept the file and uploaded no scratch files");
    std::thread::sleep(std::time::Duration::from_secs(1));
    std::fs::rename(p("Drive Test\\note.txt"), p("Drive Test\\renamed.txt")).map_err(|e| format!("rename: {e}"))?;
    wait_for("renamed.txt", 13).ok_or("the rename never reached the server")?;
    std::fs::remove_file(p("Drive Test\\renamed.txt")).map_err(|e| format!("delete: {e}"))?;
    std::fs::remove_file(p("Drive Test\\remote.txt")).map_err(|e| format!("delete remote: {e}"))?;
    std::fs::remove_dir(p("Drive Test")).map_err(|e| format!("rmdir: {e}"))?;
    println!("create, write, rename-over, rename, delete all worked");
    // Adapters that sync in the background (Cloud Files) catch up within seconds.
    let settled = (0..30).any(|_| {
        std::thread::sleep(std::time::Duration::from_millis(500));
        ["note.txt", "renamed.txt", "remote.txt", "Drive Test"].iter().all(|name| {
            tma_client::rt::block_on(client.search(name, 10))
                .map(|found| !found.iter().any(|f| f.name == *name))
                .unwrap_or(false)
        })
    });
    if !settled {
        return Err("the server still has items the test deleted".into());
    }
    println!("the server matches the folder");
    Ok(())
}

/// Clean the trash entries this test made.
#[cfg(any(windows, unix))]
fn clean_trash(client: &tma_client::Client) -> Result<(), String> {
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

/// Either adapter's mount; dropping it unmounts.
struct Mounted {
    mount_point: String,
    _guard: Box<dyn std::any::Any>,
}

/// `TMA_ADAPTER=nfs` on Linux tests the macOS adapter.
fn mount(core: std::sync::Arc<tma_drive::Core>) -> Result<Mounted, String> {
    #[cfg(target_os = "linux")]
    if std::env::var("TMA_ADAPTER").is_ok_and(|a| a == "nfs") {
        let at = std::env::temp_dir().join("tma-nfs-test");
        let m = tma_drive::nfs_fs::mount(core, "TMA Cloud Test", at.to_str())?;
        return Ok(Mounted { mount_point: m.mount_point.clone(), _guard: Box::new(m) });
    }
    #[cfg(windows)]
    {
        let at = std::env::temp_dir().join("TMA Cloud Test");
        let m = tma_drive::cloud_files::mount(core, "TMA Cloud Test", at.to_str())?;
        return Ok(Mounted { mount_point: m.mount_point.clone(), _guard: Box::new(Forget(Some(m))) });
    }
    #[allow(unreachable_code)]
    {
        let m = tma_drive::mount(core, "TMA Cloud Test", None)?;
        Ok(Mounted { mount_point: m.mount_point.clone(), _guard: Box::new(m) })
    }
}

/// The test folder leaves no sync root behind in Explorer.
#[cfg(windows)]
struct Forget(Option<tma_drive::cloud_files::Mounted>);

#[cfg(windows)]
impl Drop for Forget {
    fn drop(&mut self) {
        if let Some(Err(err)) = self.0.take().map(|m| m.forget()) {
            eprintln!("unregister: {err}");
        }
    }
}
