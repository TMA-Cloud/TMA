//! Load test: many desktop apps with Cloud Drive against one server, shaped
//! like a real production account. See the wiki's Load Testing guide.
//!
//!   TMA_URL=http://localhost:3200 cargo run --release -p tma-drive --example load -- <command>
//!
//!   seed <sub-users> <scale>     production's tree (2,194 folders, 16,787 files) times scale
//!   run <apps> <open folders> <actions/min per app> <seconds>
//!   bigfiles <count> <megabytes> uploads and downloads that many large files at once
//!   bulk                         copies, trashes and deletes the largest folder for good
//!   refusals                     over-quota and no-permission uploads must say why
//!   reads                        times the read paths on the account as it is
//!
//! It signs in only as the `@load.test` accounts `seed` creates, so it cannot
//! touch anyone else's files, but it still writes: never point it at production.

mod corpus;
mod desktop;
mod heavy;
mod rng;
mod seed;
mod stats;

use tma_client::Client;

/// Every account the tool creates shares this password (TMA_LOAD_PASSWORD overrides it).
fn password() -> String {
    std::env::var("TMA_LOAD_PASSWORD").unwrap_or_else(|_| "Load-test-pass-2026".into())
}

/// The account owner is `owner@load.test`; its sub-users are `user<n>@load.test`.
fn email(n: usize) -> String {
    if n == 0 { "owner@load.test".into() } else { format!("user{n}@load.test") }
}

fn block<F: std::future::Future>(future: F) -> F::Output {
    tma_client::rt::block_on(future)
}

fn sign_in(base: &str, address: &str) -> Result<Client, String> {
    let client = Client::new(base).map_err(|e| e.message)?;
    block(client.login(address, &password(), None)).map_err(|e| format!("sign-in as {address}: {}", e.message))?;
    Ok(client)
}

fn number<T: std::str::FromStr>(args: &[String], at: usize, what: &str) -> Result<T, String> {
    args.get(at).and_then(|a| a.parse().ok()).ok_or_else(|| format!("expected {what} as argument {at}"))
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let Ok(base) = std::env::var("TMA_URL") else {
        eprintln!("Set TMA_URL to the server to test, for example http://localhost:3200");
        std::process::exit(2);
    };
    let result = match args.get(1).map(String::as_str) {
        Some("seed") => number(&args, 2, "the sub-user count")
            .and_then(|users| seed::seed(&base, users, number(&args, 3, "the scale")?)),
        Some("run") => (|| {
            let plan = desktop::Plan {
                apps: number(&args, 2, "the app count")?,
                open: number(&args, 3, "open folders per app")?,
                per_minute: number(&args, 4, "actions per minute per app")?,
                seconds: number(&args, 5, "the duration in seconds")?,
            };
            desktop::run(&base, &plan)
        })(),
        Some("bigfiles") => {
            (|| heavy::bigfiles(&base, number(&args, 2, "the file count")?, number(&args, 3, "megabytes")?))()
        }
        Some("bulk") => heavy::bulk(&base),
        Some("refusals") => heavy::refusals(&base),
        Some("reads") => heavy::reads(&base),
        _ => Err("commands: seed, run, bigfiles, bulk, refusals, reads (see the top of main.rs)".into()),
    };
    if let Err(err) = result {
        eprintln!("FAILED: {err}");
        std::process::exit(1);
    }
}
