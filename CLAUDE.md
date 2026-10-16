# TMA Cloud

Self-hosted cloud storage, written in Rust: a server (API, background worker and
admin commands in one binary), one egui interface that runs natively as the
desktop app and in the browser as WebAssembly, and Cloud Drive, which mounts the
store as a drive (WinFsp on Windows, FUSE on Linux and macOS). User docs live in
the [Wiki](https://tma-cloud.github.io/Wiki).

| Crate                  | What it is                                                                |
| ---------------------- | ------------------------------------------------------------------------- |
| `crates/tma-core`      | Pure, wasm-safe shared code: API types, file kinds, names, formatting     |
| `crates/tma-server`    | axum API, job worker and CLI (`tma-server serve\|worker\|rotate\|s3\|import`) |
| `crates/tma-client`    | The API client for both apps (reqwest natively, fetch in the browser)     |
| `crates/tma-ui`        | The egui interface shared by the desktop and web apps                     |
| `crates/tma-drive`     | Cloud Drive: a platform-independent core plus WinFsp and FUSE adapters    |
| `apps/tma-cloud`       | The desktop app (eframe): saved sign-in, edit in local apps, Cloud Drive  |
| `apps/tma-cloud-web`   | The web app (eframe web runner, built with trunk, served by the server)   |
| `xtask`                | `cargo xtask ci`: the checks CI runs                                      |

One Cargo workspace (edition 2024, resolver 3); shared dependency versions live in
the root `Cargo.toml`. The root `Dockerfile` builds the web app and the server
into one image; `make build` tags it with the workspace version.

## Rules for every crate

- **No source file over 550 real lines.** Blank lines and comments don't count;
  tests are exempt. When a file reaches the limit, split it. Don't raise the limit.
- **Refactors keep public shapes stable.** Public names, module paths and the
  REST wire format stay the same, so no consumer (or deployed client) has to change.
- **Split by concern and keep the re-exports.** An oversized `foo.rs` becomes
  `foo/mod.rs` re-exporting focused siblings. Keep the module graph acyclic.
- **Pure logic goes in its own module** so tests can cover it directly.
- **Never crash.** Crates `deny(clippy::unwrap_used, expect_used, panic)` outside
  tests; return errors with `?`. `unsafe` is denied workspace-wide; only the
  WinFsp adapter allows it, with a `SAFETY:` comment on every block.
- **Comments are short and explain why**, in one line rather than a paragraph.
  Don't restate the code, and don't add banner dividers.
- **Wire format is the contract.** JSON field names come from `tma-core` types
  (serde renames); the web app, desktop app and old clients all depend on them.
- Never commit `.env` or secrets. New settings go in `.env.example` with a comment.

## crates/tma-server

Layers: `routes → services / models → storage / crypto / util / config`.

- **Routes** parse the request, call a model or service, and shape the response.
  No SQL in routes. One file per area (`routes/files/*`, `routes/admin/*`).
- **Models** own SQL and caching. **Services** own cross-cutting work (audit
  batching, events, access times, rate limits, OnlyOffice).
- **Jobs** (`jobs/`) are the durable Postgres queue (migration 055): requests
  enqueue, the worker claims with `FOR UPDATE SKIP LOCKED`, woken by `NOTIFY`.
  Slow or retryable work (copies, permanent deletes, orphan scans) belongs there.
- **Migrations** are `crates/tma-server/migrations/NNN_snake_case.sql`, embedded
  at build time and applied at startup under an advisory lock, each atomically.
  Never edit a migration that has shipped; add a new one.
- Dynamic SQL goes through `sqlx::AssertSqlSafe` and never interpolates input.
- Tests: unit tests next to the code; `tests/api.rs` is the end-to-end suite
  (real Postgres, Redis and an S3 bucket via `TMA_TEST_*` variables).

## crates/tma-ui

- **Views render; actions run after the frame.** A view records an action (for
  example `files::Action`) and it runs with the whole `App` at hand.
- **Background work goes through `Tasks::run`**: a future plus a closure applied to
  the app on the next frame. Check the session `generation` (via `App::finish`)
  so results for an old session are dropped.
- **Colours come from `theme::Tokens`** (the light and dark palettes); never literals.
- Host differences (sessions, links, Cloud Drive, edit in app) go through the
  `Host` trait; platform differences (pickers, downloads) through `platform.rs`.
- Everything must build for `wasm32-unknown-unknown` (`cargo xtask wasm`).

## crates/tma-drive

- `core/` holds all filesystem behaviour (five-second listing cache, staging
  files, save-only mode, create-empty-then-write and temp-then-rename saves) and
  is tested with an in-memory backend. Adapters only translate calls.
- WinFsp is linked lazily (delay-load) and found through the registry, so the
  app starts without it. Building the bindings needs libclang (`LIBCLANG_PATH`).

## Before you finish

| What                 | Command                                                            |
| -------------------- | ------------------------------------------------------------------ |
| Format, lint, test   | `cargo xtask ci` (fmt, clippy `-D warnings`, tests, wasm lint)     |
| Server end to end    | `cargo test -p tma-server --test api` with the `TMA_TEST_*` vars   |
| Web app              | `cd apps/tma-cloud-web && trunk build --release`                   |
| Desktop installers   | `cargo xtask package` (needs `cargo install cargo-packager`)      |
| Root scripts         | `shellcheck setup.sh update.sh rotate.sh scripts/db-backup-restore.sh` |

## Git

- **Hooks** live in `.githooks/`. Turn them on once per clone with `make hooks`.
  - `pre-commit` checks staged files: rustfmt, and blocks `.env` files, conflict
    markers and files over 5 MB.
  - `commit-msg` enforces the message rules below.
  - `pre-push` runs `cargo xtask ci` when the pushed commits touch Rust code.
  - Bypass with `--no-verify` only when you have a good reason.
- **Commit messages** follow git's own conventions (`commit-msg` enforces them):
  - The subject is imperative and in sentence case ("Lock Cloud Drive creates per
    path instead of globally"). Aim for 50 characters; 72 is the hard limit. No
    trailing period and no `feat:` prefixes.
  - Leave a blank line after the subject, then a body that says what was wrong
    and why this fixes it, not how. Wrap it at 72 columns. URLs, trailers and
    indented code are exempt.
  - Keep the body short: about 20 lines at most, and 40 is the hard limit. A
    longer body usually means the commit should be split.
  - Always sign off with `git commit -s`.
- Version bumps get their own commit ("Bump workspace version").
