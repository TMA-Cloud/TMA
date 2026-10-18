//! End-to-end API tests: the real server and worker against Postgres, Redis and
//! an S3 bucket, driven through the same client the apps use.
//!
//! Skipped unless `TMA_TEST_DATABASE_URL` and `TMA_TEST_REDIS_URL` are set. The
//! database is wiped first, so its name must contain "test". Uploads need
//! `TMA_TEST_S3_ENDPOINT`, `TMA_TEST_S3_ACCESS_KEY`, `TMA_TEST_S3_SECRET_KEY`
//! and `TMA_TEST_S3_BUCKET` (CI runs RustFS; the bucket is created if missing).
#![allow(clippy::unwrap_used, clippy::expect_used)]

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

/// Restoring from the trash and deleting forever are granted separately.
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
    let dest = std::env::temp_dir().join(format!("tma-it-{}.txt", item.id));
    admin.download_to(&item.id, &dest, Progress::new(0)).await.unwrap();
    assert_eq!(std::fs::read_to_string(&dest).unwrap(), body);
    let _ = std::fs::remove_file(&dest);
    let deep = admin
        .upload(&text_file("deep.txt", "x", Some("A/B")), &UploadOptions::default(), Progress::new(0))
        .await
        .unwrap();
    assert!(root(&admin).await.iter().any(|f| f.name == "A" && f.is_folder()));
    assert_eq!(admin.info(&deep.id).await.unwrap().location_path, ["A", "B"]);

    // New content for a file keeps its id, as saving in a desktop app does.
    let replaced = admin.replace(&deep.id, &text_file("deep.txt", "second", None), Progress::new(0)).await.unwrap();
    assert_eq!(replaced.id, deep.id);
    admin.download_to(&deep.id, &dest, Progress::new(0)).await.unwrap();
    assert_eq!(std::fs::read_to_string(&dest).unwrap(), "second");
    let _ = std::fs::remove_file(&dest);

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

    // Share links: the public page lists the file; unsharing removes the link.
    let links = admin.share(std::slice::from_ref(&item.id), true, Some("7d")).await.unwrap();
    let link = links.links.get(&item.id).expect("a link").clone();
    let page = reqwest::get(&link).await.unwrap();
    assert!(page.status().is_success());
    assert!(page.text().await.unwrap().contains("note.txt"));
    admin.share(std::slice::from_ref(&item.id), false, None).await.unwrap();
    assert_eq!(reqwest::get(&link).await.unwrap().status().as_u16(), 404);

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

    // Sessions: signing out everywhere ends this client's session too.
    assert!(!admin.sessions(false).await.unwrap().sessions.is_empty());
    admin.logout_all().await.unwrap();
    assert!(admin.profile().await.unwrap_err().is_unauthorized());
}
