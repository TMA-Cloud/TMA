//! End-to-end API tests: the real server and worker against Postgres, Redis and
//! an S3 bucket, driven through the same client the apps use.
//!
//! Skipped unless `TMA_TEST_DATABASE_URL` and `TMA_TEST_REDIS_URL` are set. The
//! database is wiped first, so its name must contain "test". Uploads need
//! `TMA_TEST_S3_ENDPOINT`, `TMA_TEST_S3_ACCESS_KEY`, `TMA_TEST_S3_SECRET_KEY`
//! and `TMA_TEST_S3_BUCKET` (CI runs RustFS; the bucket is created if missing).
#![expect(clippy::unwrap_used, clippy::expect_used, reason = "tests fail loudly on purpose")]

use std::net::SocketAddr;

use tma_client::{Client, ListQuery, Progress, Source, UploadFile, UploadOptions, View};
use tma_core::api::{CreateSubUserRequest, SortBy, SortOrder, StorageSettingsInput};
use tma_server::config::Config;
use tma_server::crypto::{Keyring, generate_key};
use tma_server::server::{Role, build_state_with_keyring};

struct Env {
    database: String,
    redis: String,
    s3: Option<(String, String, String, String)>,
}

fn env() -> Option<Env> {
    let var = |n: &str| std::env::var(n).ok().filter(|v| !v.is_empty());
    let database = var("TMA_TEST_DATABASE_URL")?;
    let redis = var("TMA_TEST_REDIS_URL")?;
    let s3 = match (
        var("TMA_TEST_S3_ENDPOINT"),
        var("TMA_TEST_S3_ACCESS_KEY"),
        var("TMA_TEST_S3_SECRET_KEY"),
        var("TMA_TEST_S3_BUCKET"),
    ) {
        (Some(e), Some(a), Some(s), Some(b)) => Some((e, a, s, b)),
        _ => None,
    };
    Some(Env { database, redis, s3 })
}

/// Start the server and worker on a free port; returns its base URL.
async fn start(env: &Env) -> String {
    assert!(env.database.contains("test"), "refusing to wipe a database whose name lacks \"test\"");
    let pool = sqlx::PgPool::connect(&env.database).await.unwrap();
    sqlx::raw_sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public;").execute(&pool).await.unwrap();
    pool.close().await;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let config = Config {
        production: false,
        port: addr.port(),
        backend_url: Some(format!("http://{addr}")),
        database_url: env.database.clone(),
        redis_url: env.redis.clone(),
        jwt_secret: "integration-test-secret".into(),
        force_insecure_cookies: true,
        metrics_allowed_ips: vec!["127.0.0.1".into()],
        versions_url: "https://tma-cloud.github.io/updates/versions.json".into(),
        worker_concurrency: 4,
        web_dist_dir: None,
        onlyoffice_reject_unauthorized: true,
        held_cursor_limit: 3,
    };
    let keyring = Keyring::from_text(&format!("1:{}", generate_key()), true).unwrap();
    let state = build_state_with_keyring(config, keyring, Role::Both).await.unwrap();
    // As `serve` does: opens are written behind by this flusher.
    state.access.spawn_flusher();
    let (_tx, rx) = tokio::sync::watch::channel(false);
    let worker_state = state.clone();
    tokio::spawn(async move {
        let _keep = _tx;
        let _ = tma_server::jobs::worker::run(worker_state, rx).await;
    });
    let app = tma_server::routes::router(state);
    tokio::spawn(async move {
        let _ = axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await;
    });
    format!("http://{addr}")
}

fn text_file(name: &str, body: &str, dir: Option<&str>) -> UploadFile {
    UploadFile {
        name: name.into(),
        size: body.len() as u64,
        source: Source::Bytes(body.as_bytes().to_vec().into()),
        modified_ms: None,
        relative_dir: dir.map(String::from),
    }
}

/// A non-ASCII extension still gets an attachment header, and stored bytes run in a sandbox.
async fn assert_download_is_sandboxed(client: &Client) {
    let page = client
        .upload(
            &text_file("page.htmlé", "<script>alert(1)</script>", None),
            &UploadOptions::default(),
            Progress::new(0),
        )
        .await
        .unwrap();
    let raw = reqwest::Client::new()
        .get(client.url(&format!("/api/files/{}/download", page.id)))
        .header("cookie", format!("token={}", client.session_token().unwrap()))
        .send()
        .await
        .unwrap();
    assert_eq!(raw.status().as_u16(), 200);
    assert!(raw.headers()["content-disposition"].to_str().unwrap().starts_with("attachment;"));
    assert!(raw.headers()["content-security-policy"].to_str().unwrap().ends_with("sandbox"));
}

async fn root(client: &Client) -> Vec<tma_core::api::FileItem> {
    client.list(&View::Folder(None), &ListQuery::default()).await.unwrap().files
}

/// Names sort ignoring case and with numbers by value, page by page as well.
async fn assert_name_order(client: &Client) {
    for name in ["photo 10", "Photo 2", "alpha"] {
        client.create_folder(name, None).await.unwrap();
    }
    let expected = ["alpha", "Documents", "Photo 2", "photo 10"];
    let by_name = ListQuery { sort: Some(SortBy::Name), order: Some(SortOrder::Asc), ..ListQuery::default() };
    let names: Vec<String> =
        client.list(&View::Folder(None), &by_name).await.unwrap().files.into_iter().map(|f| f.name).collect();
    assert_eq!(names, expected);
    // One row per page walks the cursor through every comparison.
    let (mut paged, mut cursor) = (Vec::new(), None);
    loop {
        let query = ListQuery { cursor: cursor.take(), limit: Some(1), ..by_name.clone() };
        let page = client.list(&View::Folder(None), &query).await.unwrap();
        paged.extend(page.files.into_iter().map(|f| f.name));
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    assert_eq!(paged, expected);
}

/// A new folder or a rename may not take a sibling's name in any case; an item may change its own case.
async fn assert_names_are_unique(client: &Client) {
    assert_eq!(client.create_folder("documents", None).await.unwrap_err().status, 409);
    let alpha = root(client).await.into_iter().find(|f| f.name == "alpha").unwrap();
    assert_eq!(client.rename(&alpha.id, "PHOTO 2").await.unwrap_err().status, 409);
    client.rename(&alpha.id, "Alpha").await.unwrap();
    // The same name is free inside another folder.
    let docs = root(client).await.into_iter().find(|f| f.name == "Documents").unwrap();
    client.create_folder("Alpha", Some(&docs.id)).await.unwrap();
}

/// A new upload is in Recent files under the person who sent it, before anyone opens it.
async fn assert_upload_names_uploader(client: &Client, id: &str) {
    let recent = client.recent(10).await.unwrap();
    let uploader = recent.iter().find(|f| f.id == id).and_then(|f| f.opened_by.clone());
    assert_eq!(uploader.map(|o| o.name).as_deref(), Some("Ada Admin"));
}

/// Recent files say which of the account's people opened a file: here a sub-user.
async fn assert_recent_names_opener(owner: &Client, sub: &Client, id: &str) {
    owner.save_access_time(true, 0, 1).await.unwrap();
    let dest = std::env::temp_dir().join(format!("tma-it-sub-{id}.txt"));
    sub.download_to(id, &dest, Progress::new(0)).await.unwrap();
    let _ = std::fs::remove_file(&dest);
    // Opens are written behind in batches; the first flush waits out the default interval.
    for _ in 0..40 {
        let recent = owner.recent(10).await.unwrap();
        let opener = recent.iter().find(|f| f.id == id).and_then(|f| f.opened_by.clone());
        if opener.as_ref().is_some_and(|o| o.name == "Sam") {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    panic!("Recent files never named the sub-user who opened the file");
}

/// A save names the content version it started from; one from an outdated copy is
/// refused, so it cannot overwrite a newer save (the lost save of 15 October).
async fn assert_stale_saves_are_refused(client: &Client, id: &str, current: i64) {
    let save = |text: &'static str, base: Option<i64>| {
        let file = text_file("deep.txt", text, None);
        async move { client.replace_from(id, &file, base, Progress::new(0)).await }
    };
    let landed = save("third", Some(current)).await.unwrap();
    assert_eq!(landed.content_version, current + 1, "every save raises the version");
    let refused = save("stale", Some(current)).await.unwrap_err();
    assert!(refused.is_conflict(), "a save from the old version is refused: {refused:?}");
    let dest = std::env::temp_dir().join(format!("tma-it-stale-{id}.txt"));
    client.download_to(id, &dest, Progress::new(0)).await.unwrap();
    assert_eq!(std::fs::read_to_string(&dest).unwrap(), "third", "the newer save is kept");
    let _ = std::fs::remove_file(&dest);
    // Without a base (the web app's deliberate Replace) a save always lands.
    assert_eq!(save("fourth", None).await.unwrap().content_version, current + 2);
}

/// While one person edits a file in a desktop app, others see who and cannot save over it.
async fn assert_edit_locks(owner: &Client, base: &str, id: &str) {
    let request = CreateSubUserRequest {
        email: "casey@example.test".into(),
        password: "sub-user-password".into(),
        name: "Casey".into(),
        permissions: vec!["files.download".into(), "files.edit".into()],
    };
    owner.create_sub_user(&request).await.unwrap();
    let casey = Client::new(base).unwrap();
    casey.login("casey@example.test", "sub-user-password", None).await.unwrap();
    assert!(casey.lock(id).await.unwrap().acquired);
    assert!(casey.lock(id).await.unwrap().acquired, "renewing your own lock keeps it");
    let busy = owner.lock(id).await.unwrap();
    assert!(!busy.acquired);
    assert_eq!(busy.lock.name, "Casey");
    let listed = owner.search("deep", 10).await.unwrap().into_iter().find(|f| f.id == id).unwrap();
    assert_eq!(listed.lock.map(|l| l.name).as_deref(), Some("Casey"), "listings show who is editing");
    let refused = owner.replace(id, &text_file("deep.txt", "over Casey", None), Progress::new(0)).await.unwrap_err();
    assert!(refused.is_conflict(), "others cannot save over the editor: {refused:?}");
    casey.replace(id, &text_file("deep.txt", "Casey edit", None), Progress::new(0)).await.unwrap();
    casey.unlock(id).await.unwrap();
    assert!(owner.lock(id).await.unwrap().acquired, "a released lock is free");
    owner.unlock(id).await.unwrap();
    owner.replace(id, &text_file("deep.txt", "after Casey", None), Progress::new(0)).await.unwrap();
    assert_locks_tell_computers_apart(owner, id).await;
}

/// An editing session in the browser holds the lock like a desktop app, and only
/// that session renews or ends it.
async fn assert_browser_sessions_lock(owner: &Client, database: &str, id: &str) {
    use std::time::Duration;
    use tma_server::models::files::locks::{self, Actor, Taken};
    let pool = sqlx::PgPool::connect(database).await.unwrap();
    let me = owner.profile().await.unwrap().id;
    let session = format!("{}key-1", tma_core::api::BROWSER_DEVICE_PREFIX);
    let browser = Actor { user: &me, device: Some(&session) };
    let taken = locks::acquire(&pool, id, &me, browser, Duration::from_secs(600)).await.unwrap();
    assert!(matches!(taken, Some(Taken::Held { .. })));
    let listed = owner.search("deep", 10).await.unwrap().into_iter().find(|f| f.id == id).unwrap();
    assert!(listed.lock.as_ref().is_some_and(tma_core::api::FileLock::in_browser), "listings say it is the browser");
    let refused =
        owner.replace(id, &text_file("deep.txt", "over the browser", None), Progress::new(0)).await.unwrap_err();
    assert!(refused.message.contains("in the browser"), "{refused:?}");
    let other = format!("{}key-2", tma_core::api::BROWSER_DEVICE_PREFIX);
    let second = Actor { user: &me, device: Some(&other) };
    let busy = locks::acquire(&pool, id, &me, second, Duration::from_secs(600)).await.unwrap();
    assert!(matches!(busy, Some(Taken::Busy(_))), "a second browser session only views it");
    assert!(!locks::release_device(&pool, id, &other).await.unwrap(), "only the holding session ends it");
    locks::renew_device(&pool, id, &session, Duration::from_secs(600)).await.unwrap();
    assert!(locks::release_device(&pool, id, &session).await.unwrap());
    assert!(locks::holder(&pool, id).await.unwrap().is_none());
    pool.close().await;
}

/// One person signed in on two computers: the second is kept out like anyone else.
async fn assert_locks_tell_computers_apart(owner: &Client, id: &str) {
    let http = reqwest::Client::new();
    let cookie = format!("token={}", owner.session_token().unwrap());
    let send = |method: reqwest::Method, path: &str, device: &str| {
        http.request(method, owner.url(path))
            .header("cookie", &cookie)
            .header("x-requested-with", "XMLHttpRequest")
            .header(tma_core::DEVICE_HEADER_NAME, device)
    };
    let lock = |device: &'static str| {
        let request = send(reqwest::Method::POST, &format!("/api/files/{id}/lock"), device)
            .header("content-type", "application/json")
            .body("{}");
        async move { request.send().await.unwrap().json::<tma_core::api::LockResponse>().await.unwrap() }
    };
    let laptop = lock("laptop").await;
    assert!(laptop.acquired);
    assert_eq!(laptop.lock.device_id.as_deref(), Some("laptop"));
    assert!(!lock("desktop").await.acquired, "the same person on another computer waits too");
    let form = reqwest::multipart::Form::new()
        .part("file", reqwest::multipart::Part::bytes(b"from the desktop".to_vec()).file_name("deep.txt"));
    let refused = send(reqwest::Method::POST, &format!("/api/files/{id}/replace"), "desktop")
        .multipart(form)
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status().as_u16(), 409, "nor can it save over the laptop's edit");
    let other = send(reqwest::Method::DELETE, &format!("/api/files/{id}/lock"), "desktop").send().await.unwrap();
    assert!(other.status().is_success());
    assert!(!lock("desktop").await.acquired, "another computer cannot release it");
    send(reqwest::Method::DELETE, &format!("/api/files/{id}/lock"), "laptop").send().await.unwrap();
    assert!(lock("desktop").await.acquired, "once released, either computer can take it");
    send(reqwest::Method::DELETE, &format!("/api/files/{id}/lock"), "desktop").send().await.unwrap();
}

/// Folder totals and account storage stay exact through a batch upload that
/// builds a tree, a replace, a copy, a move, and trash and permanent delete.
async fn assert_counters_stay_exact(owner: &Client, database: &str) {
    let mut form = reqwest::multipart::Form::new();
    let paths = ["Tree/a.txt", "Tree/Sub/b.txt", "Tree/Sub/c.txt", "Tree/Sub/Deep/d.txt", "Tree/Sub/Deep/e.txt"];
    for (i, path) in paths.iter().enumerate() {
        let name = path.rsplit('/').next().unwrap().to_string();
        let body = "x".repeat(10 * (i + 1)).into_bytes();
        form = form
            .text("relativePaths", path.to_string())
            .text("clientIds", i.to_string())
            .part("files", reqwest::multipart::Part::bytes(body).file_name(name));
    }
    let uploaded = reqwest::Client::new()
        .post(owner.url("/api/files/upload/bulk"))
        .header("cookie", format!("token={}", owner.session_token().unwrap()))
        .header("x-requested-with", "XMLHttpRequest")
        .multipart(form)
        .send()
        .await
        .unwrap();
    assert!(uploaded.status().is_success(), "{}", uploaded.text().await.unwrap());
    let tree = root(owner).await.into_iter().find(|f| f.name == "Tree").unwrap();
    let info = owner.info(&tree.id).await.unwrap().folder_info.unwrap();
    assert_eq!((info.file_count, info.folder_count, info.total_size), (5, 2, 150));
    let inside = owner.list(&View::Folder(Some(tree.id.clone())), &ListQuery::default()).await.unwrap().files;
    let a = inside.iter().find(|f| f.name == "a.txt").unwrap();
    owner.replace(&a.id, &text_file("a.txt", &"y".repeat(35), None), Progress::new(0)).await.unwrap();
    let copied = owner.copy_items(std::slice::from_ref(&tree.id), None).await.unwrap();
    owner.wait_for_job(&copied.job_id.unwrap()).await.unwrap();
    let sub = inside.iter().find(|f| f.name == "Sub").unwrap();
    owner.move_items(std::slice::from_ref(&sub.id), None).await.unwrap();
    let copy = root(owner).await.into_iter().find(|f| f.name != "Tree" && f.name.starts_with("Tree")).unwrap();
    let trashed = owner.trash(std::slice::from_ref(&copy.id)).await.unwrap();
    owner.settle(&trashed).await.unwrap();
    let gone = owner.delete_forever(std::slice::from_ref(&copy.id)).await.unwrap();
    owner.wait_for_job(&gone.job_id.unwrap()).await.unwrap();
    let info = owner.info(&tree.id).await.unwrap().folder_info.unwrap();
    assert_eq!((info.file_count, info.folder_count, info.total_size), (1, 0, 35), "Sub moved out, a.txt replaced");

    // Recomputing from scratch finds nothing to repair, and usage is the sum of every file.
    let pool = sqlx::PgPool::connect(database).await.unwrap();
    let accounts: Vec<String> =
        sqlx::query_scalar("SELECT id FROM users WHERE parent_user_id IS NULL").fetch_all(&pool).await.unwrap();
    for account in &accounts {
        let drift: i32 =
            sqlx::query_scalar("SELECT reconcile_folder_aggregates($1)").bind(account).fetch_one(&pool).await.unwrap();
        assert_eq!(drift, 0, "folder totals drifted for {account}");
    }
    let wrong: Vec<(String, i64, i64)> = sqlx::query_as(
        "SELECT u.id, u.storage_used, COALESCE(SUM(f.size) FILTER (WHERE f.type = 'file'), 0)::bigint
           FROM users u LEFT JOIN files f ON f.user_id = u.id
          WHERE u.parent_user_id IS NULL GROUP BY u.id, u.storage_used
         HAVING u.storage_used <> COALESCE(SUM(f.size) FILTER (WHERE f.type = 'file'), 0)",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert!(wrong.is_empty(), "storage usage drifted: {wrong:?}");
    pool.close().await;
}

/// The change feed names each folder whose listing changed: where a folder was
/// made, both ends of a move, a file's folder when someone starts editing it.
/// A cursor from before pruned history starts over.
async fn assert_change_feed(owner: &Client, database: &str, folder: &str, file: &str) {
    let has = |changes: &tma_core::api::Changes, id: Option<&str>| changes.folders.contains(&id.map(String::from));
    let start = owner.changes(None).await.unwrap();
    assert!(start.reset && start.folders.is_empty(), "no cursor yet: list everything");
    let made = owner.create_folder("Feed", Some(folder)).await.unwrap();
    let after = owner.changes(Some(&start.cursor)).await.unwrap();
    assert!(!after.reset && has(&after, Some(folder)), "{after:?}");
    assert!(!has(&after, None), "the root did not change");
    owner.move_items(std::slice::from_ref(&made.id), None).await.unwrap();
    let moved = owner.changes(Some(&after.cursor)).await.unwrap();
    assert!(has(&moved, Some(folder)) && has(&moved, None), "a move changes both folders: {moved:?}");
    owner.lock(file).await.unwrap();
    let locked = owner.changes(Some(&moved.cursor)).await.unwrap();
    assert!(has(&locked, Some(folder)), "who is editing shows in the folder: {locked:?}");
    owner.unlock(file).await.unwrap();

    let pool = sqlx::PgPool::connect(database).await.unwrap();
    sqlx::query("UPDATE file_change_floor SET xid = pg_current_xact_id()").execute(&pool).await.unwrap();
    pool.close().await;
    assert!(owner.changes(Some(&locked.cursor)).await.unwrap().reset, "pruned past the cursor: start over");
    let fresh = owner.changes(None).await.unwrap();
    assert!(!owner.changes(Some(&fresh.cursor)).await.unwrap().reset);
}

/// An upload refused before its body is read still gets its answer: the client
/// sends the whole body before reading, so a reply mid-body used to reach it
/// as a dropped connection ("cannot reach the server").
async fn assert_refusals_are_heard(owner: &Client, base: &str) {
    let request = CreateSubUserRequest {
        email: "viewer@example.test".into(),
        password: "sub-user-password".into(),
        name: "Viewer".into(),
        permissions: Vec::new(),
    };
    owner.create_sub_user(&request).await.unwrap();
    let viewer = Client::new(base).unwrap();
    viewer.login("viewer@example.test", "sub-user-password", None).await.unwrap();
    let body = "x".repeat(5 * 1024 * 1024);
    let refused = viewer.upload(&text_file("big.bin", &body, None), &UploadOptions::default(), Progress::new(0)).await;
    assert_eq!(refused.map(|f| f.id).map_err(|e| e.status), Err(403), "the refusal arrives, not a network error");
}

/// Restoring from the trash and deleting forever are granted separately.
/// Share links: the public page lists the file and the Shared view shows it;
/// unsharing removes both. Every listing view builds its own SQL, so each is read.
async fn assert_share_links(owner: &Client, id: &str) {
    let in_shared =
        || async { owner.list(&View::Shared, &ListQuery::default()).await.unwrap().files.iter().any(|f| f.id == id) };
    let links = owner.share(&[id.to_string()], true, Some("7d")).await.unwrap();
    let link = links.links.get(id).expect("a link").clone();
    let page = reqwest::get(&link).await.unwrap();
    assert!(page.status().is_success());
    assert!(page.text().await.unwrap().contains("note.txt"));
    assert!(in_shared().await);
    owner.list(&View::Starred, &ListQuery::default()).await.unwrap();
    owner.share(&[id.to_string()], false, None).await.unwrap();
    assert_eq!(reqwest::get(&link).await.unwrap().status().as_u16(), 404);
    assert!(!in_shared().await);
}

async fn assert_trash_grants_are_separate(owner: &Client, base: &str, id: &str) {
    let request = CreateSubUserRequest {
        email: "riley@example.test".into(),
        password: "sub-user-password".into(),
        name: "Riley".into(),
        permissions: vec!["files.delete".into(), "files.restore".into()],
    };
    owner.create_sub_user(&request).await.unwrap();
    let riley = Client::new(base).unwrap();
    riley.login("riley@example.test", "sub-user-password", None).await.unwrap();
    let ids = [id.to_string()];
    riley.trash(&ids).await.unwrap();
    riley.restore(&ids).await.unwrap();
    riley.trash(&ids).await.unwrap();
    assert_eq!(riley.delete_forever(&ids).await.unwrap_err().status, 403);
    assert_eq!(riley.empty_trash().await.unwrap_err().status, 403);
    riley.restore(&ids).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn full_workflow() {
    let Some(env) = env() else {
        eprintln!("skipped: TMA_TEST_DATABASE_URL / TMA_TEST_REDIS_URL not set");
        return;
    };
    let base = start(&env).await;
    let health = reqwest::get(format!("{base}/health")).await.unwrap();
    assert!(health.status().is_success());

    // The first account becomes the administrator.
    let admin = Client::new(&base).unwrap();
    let user = admin.signup(Some("Ada Admin"), "ada@example.test", "correct-horse-battery").await.unwrap();
    assert_eq!(user.email, "ada@example.test");
    assert!(admin.signup_status().await.unwrap().can_toggle);
    assert!(!admin.storage_status().await.unwrap().configured);

    // Wrong passwords are refused; a fresh client can sign in again.
    let other = Client::new(&base).unwrap();
    assert!(other.login("ada@example.test", "wrong-password", None).await.unwrap_err().is_unauthorized());
    other.login("ada@example.test", "correct-horse-battery", None).await.unwrap();

    // Instance switches answer with their new value under the keys the apps read.
    assert_eq!(admin.set_signup(false).await.unwrap()["signupEnabled"], false);
    assert!(!admin.signup_status().await.unwrap().signup_enabled);
    admin.set_signup(true).await.unwrap();
    assert_eq!(admin.set_hide_extensions(true).await.unwrap()["hideFileExtensions"], true);
    assert!(admin.hide_extensions().await.unwrap());
    admin.set_hide_extensions(false).await.unwrap();
    assert_eq!(admin.set_desktop_only(false).await.unwrap()["desktopOnly"], false);
    assert_eq!(admin.set_password_change(true).await.unwrap()["allowPasswordChange"], true);
    assert!(admin.set_cloud_drive_save_only(true).await.unwrap().save_only);
    assert!(admin.cloud_drive_config().await.unwrap().save_only);
    admin.activity_settings().await.unwrap();

    // Folders work without a bucket.
    let docs = admin.create_folder("Docs", None).await.unwrap();
    admin.rename(&docs.id, "Documents").await.unwrap();
    assert!(root(&admin).await.iter().any(|f| f.name == "Documents" && f.is_folder()));
    assert_name_order(&admin).await;
    assert_names_are_unique(&admin).await;

    let Some((endpoint, access, secret, bucket)) = env.s3.clone() else {
        eprintln!("bucket not configured: skipping upload checks");
        return;
    };
    // A fresh S3 server has no buckets; make the test one.
    let s3 = aws_sdk_s3::Client::from_conf(
        aws_sdk_s3::Config::builder()
            .behavior_version_latest()
            .region(aws_sdk_s3::config::Region::new("us-east-1"))
            .endpoint_url(&endpoint)
            .credentials_provider(aws_credential_types::Credentials::new(&access, &secret, None, None, "test"))
            .force_path_style(true)
            .build(),
    );
    let _ = s3.create_bucket().bucket(&bucket).send().await;
    let input = StorageSettingsInput {
        provider: "s3".into(),
        endpoint: Some(endpoint),
        region: Some("us-east-1".into()),
        bucket: Some(bucket),
        force_path_style: Some(true),
        access_key_id: Some(access),
        secret_access_key: Some(secret),
        expected_version: None,
    };
    assert!(admin.test_storage_config(&input).await.unwrap().ok);
    admin.save_storage_config(&input).await.unwrap();

    // Upload, list, download (decrypted), and a folder upload that creates its folders.
    let body = "hello, encrypted world";
    let item = admin
        .upload(
            &text_file("note.txt", body, None),
            &UploadOptions { parent_id: Some(docs.id.clone()) },
            Progress::new(0),
        )
        .await
        .unwrap();
    assert_upload_names_uploader(&admin, &item.id).await;
    let dest = std::env::temp_dir().join(format!("tma-it-{}.txt", item.id));
    admin.download_to(&item.id, &dest, Progress::new(0)).await.unwrap();
    assert_eq!(std::fs::read_to_string(&dest).unwrap(), body);
    let _ = std::fs::remove_file(&dest);
    let deep = admin
        .upload(&text_file("deep.txt", "x", Some("A/B")), &UploadOptions::default(), Progress::new(0))
        .await
        .unwrap();
    assert!(root(&admin).await.iter().any(|f| f.name == "A" && f.is_folder()));
    let info = admin.info(&deep.id).await.unwrap();
    assert_eq!(info.location_path, ["A", "B"]);
    assert_eq!(info.location_ids.last(), deep.parent_id.as_ref());
    assert_eq!(info.location_ids.len(), 2);

    // New content for a file keeps its id, as saving in a desktop app does.
    let replaced = admin.replace(&deep.id, &text_file("deep.txt", "second", None), Progress::new(0)).await.unwrap();
    assert_eq!(replaced.id, deep.id);
    admin.download_to(&deep.id, &dest, Progress::new(0)).await.unwrap();
    assert_eq!(std::fs::read_to_string(&dest).unwrap(), "second");
    let _ = std::fs::remove_file(&dest);
    assert_stale_saves_are_refused(&admin, &deep.id, replaced.content_version).await;
    assert_edit_locks(&admin, &base, &deep.id).await;
    assert_browser_sessions_lock(&admin, &env.database, &deep.id).await;
    assert_change_feed(&admin, &env.database, &docs.id, &item.id).await;
    assert_refusals_are_heard(&admin, &base).await;

    // Search, stats, star.
    assert!(admin.search("note", 10).await.unwrap().iter().any(|f| f.id == item.id));
    admin.star(std::slice::from_ref(&item.id), true).await.unwrap();
    let stats = admin.stats().await.unwrap();
    assert_eq!(stats.starred_count, 1);
    assert!(stats.total_files >= 2);

    // Copy runs in the worker; the copy has the same content.
    let queued = admin.copy_items(std::slice::from_ref(&item.id), None).await.unwrap();
    admin.wait_for_job(&queued.job_id.unwrap()).await.unwrap();
    let copy = root(&admin).await.into_iter().find(|f| f.name == "note.txt").expect("copy at the root");
    let dest = std::env::temp_dir().join(format!("tma-it-{}.txt", copy.id));
    admin.download_to(&copy.id, &dest, Progress::new(0)).await.unwrap();
    assert_eq!(std::fs::read_to_string(&dest).unwrap(), body);
    let _ = std::fs::remove_file(&dest);

    // The web app's bulk download: a ticket from a guarded request, then a plain form post that streams the ZIP.
    let ticket = admin.bulk_download_ticket(&[item.id.clone(), copy.id.clone()]).await.unwrap();
    let form_url = admin.bulk_download_form_url();
    let http = reqwest::Client::new();
    let post_ticket = |cookie: Option<String>| {
        let mut request = http.post(&form_url).form(&[("ticket", ticket.as_str())]);
        if let Some(cookie) = cookie {
            request = request.header("cookie", cookie);
        }
        request.send()
    };
    let zip = post_ticket(Some(format!("token={}", admin.session_token().unwrap()))).await.unwrap();
    assert_eq!(zip.status().as_u16(), 200);
    assert_eq!(zip.headers()["content-type"], "application/zip");
    let archive = zip.bytes().await.unwrap();
    assert!(archive.starts_with(b"PK\x03\x04"));
    assert!(archive.windows(8).any(|w| w == b"note.txt"));
    assert_download_is_sandboxed(&admin).await;
    // The ticket is bound to the session that asked for it.
    let elsewhere = post_ticket(Some(format!("token={}", other.session_token().unwrap()))).await.unwrap();
    assert_eq!(elsewhere.status().as_u16(), 401);
    assert_eq!(post_ticket(None).await.unwrap().status().as_u16(), 401);

    assert_share_links(&admin, &item.id).await;

    // Trash, restore, delete forever (worker).
    admin.trash(std::slice::from_ref(&copy.id)).await.unwrap();
    assert!(admin.list(&View::Trash, &ListQuery::default()).await.unwrap().files.iter().any(|f| f.id == copy.id));
    admin.restore(std::slice::from_ref(&copy.id)).await.unwrap();
    admin.trash(std::slice::from_ref(&copy.id)).await.unwrap();
    let gone = admin.delete_forever(std::slice::from_ref(&copy.id)).await.unwrap();
    admin.wait_for_job(&gone.job_id.unwrap()).await.unwrap();
    assert!(admin.list(&View::Trash, &ListQuery::default()).await.unwrap().files.is_empty());

    // A view-only sub-user sees the owner's files but cannot upload.
    let sub = CreateSubUserRequest {
        email: "sam@example.test".into(),
        password: "sub-user-password".into(),
        name: "Sam".into(),
        permissions: vec!["files.download".into()],
    };
    admin.create_sub_user(&sub).await.unwrap();
    let sam = Client::new(&base).unwrap();
    sam.login("sam@example.test", "sub-user-password", None).await.unwrap();
    assert!(root(&sam).await.iter().any(|f| f.name == "Documents"));
    let refused =
        sam.upload(&text_file("nope.txt", "x", None), &UploadOptions::default(), Progress::new(0)).await.unwrap_err();
    assert_eq!(refused.status, 403);
    assert_recent_names_opener(&admin, &sam, &item.id).await;
    assert_trash_grants_are_separate(&admin, &base, &item.id).await;

    assert_counters_stay_exact(&admin, &env.database).await;

    // Sessions: signing out everywhere ends this client's session too.
    assert!(!admin.sessions(false).await.unwrap().sessions.is_empty());
    admin.logout_all().await.unwrap();
    assert!(admin.profile().await.unwrap_err().is_unauthorized());
}
