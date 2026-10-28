# TMA Cloud

Self-hosted cloud storage, written in Rust: a server (API, background worker and
admin commands in one binary), one egui interface that runs natively as the
desktop app and in the browser as WebAssembly, and Cloud Drive, which shows the
store as a folder with no extra driver (Cloud Files on Windows, FUSE on Linux, a
local NFS mount on macOS). User docs live in the [Wiki](https://tma-cloud.github.io/Wiki).

| Crate                | What it is                                                                    |
| -------------------- | ----------------------------------------------------------------------------- |
| `crates/tma-core`    | Pure, wasm-safe shared code: API types, file kinds, names, formatting         |
| `crates/tma-server`  | axum API, job worker and CLI (`tma-server serve\|worker\|rotate\|s3\|import`) |
| `crates/tma-client`  | The API client for both apps (reqwest natively, fetch in the browser)         |
| `crates/tma-ui`      | The egui interface shared by the desktop and web apps                         |
| `crates/tma-drive`   | Cloud Drive: a platform-independent core plus Cloud Files, FUSE and NFS       |
| `apps/tma-cloud`     | The desktop app (eframe): saved sign-in, edit in local apps, Cloud Drive      |
| `apps/tma-cloud-web` | The web app (eframe web runner, built with trunk, served by the server)       |
| `xtask`              | `cargo xtask ci`: the checks CI runs                                          |

One Cargo workspace (edition 2024, resolver 3); shared dependency versions live in
the root `Cargo.toml`. The root `Dockerfile` builds the web app and the server
into one image; `make build` tags it with the workspace version.

## Rules for every crate

- **No source file over 400 lines of code, no function over 150.** Blank lines,
  comments and the `#[cfg(test)]` module don't count. Split by concern before you
  get there; never raise either limit. `cargo xtask house` and Clippy's
  `too_many_lines` enforce them; `cargo xtask house --sizes` lists the largest files.
- **No copied code.** A run of 10 or more identical code lines in two places, or
  two functions with the same body of 3 or more lines, fails `cargo xtask house`;
  share one function instead. After a refactor, run `cargo xtask house --near` to
  find copies that differ only in strings or numbers (it also flags data tables, so
  CI does not run it).
- **No deprecated or unused code.** The workspace lints deny `deprecated` and the
  whole `unused` group, so `cargo check` itself fails on a deprecated call or an
  unused import, variable, function, field or result. Delete dead code; don't hide
  it. A lint may be silenced only with `#[expect(lint, reason = "...")]` (Clippy
  rejects `#[allow]` and missing reasons), and an `expect` fails once nothing
  triggers it. Platform-only code uses `#[cfg_attr(target_arch = "wasm32", expect(...))]`.
- **No unused dependencies.** `cargo xtask house` fails on a dependency a crate's
  code never names. One needed only for a feature or for linking goes under
  `[package.metadata.cargo-machete] ignored` with a comment saying why.
- **Refactors keep public shapes stable.** Public names, module paths and the
  REST wire format stay the same, so no consumer (or deployed client) has to change.
- **Split by concern and keep the re-exports.** An oversized `foo.rs` becomes
  `foo/mod.rs` re-exporting focused siblings. Keep the module graph acyclic.
- **Pure logic goes in its own module** so tests can cover it directly.
- **Never crash.** Crates `deny(clippy::unwrap_used, expect_used, panic)` outside
  tests; return errors with `?`. `unsafe` is denied workspace-wide; only
  `cloud_files/cfapi/` and the desktop app's Windows glue (`cursors/windows.rs`,
  `single.rs`, `clipboard_ole.rs`, `cloak.rs`, `app_windows.rs`) allow it, with a `SAFETY:` comment on every block.
- **Colours come from `theme::Tokens`** in `tma-ui` and the apps: `cargo xtask house`
  rejects literal colours outside `theme.rs` (use `theme::with_alpha`, `theme::mix`
  or `theme::NO_TINT`), and curly apostrophes in strings.
- **Comments are short and explain why**, in one line rather than a paragraph.
  Don't restate the code, and don't add banner dividers.
- **Wire format is the contract.** JSON field names come from `tma-core` types
  (serde renames); the server, web app and desktop app all depend on them, so a
  rename changes all three, and its docs, in one commit.
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
- **Icons come from `icons::ph`**: Phosphor glyphs in two small fonts that hold only
  the icons listed there. After adding one, run `python scripts/subset-icons.py`; a test
  fails while any listed icon has no glyph.
- **Pointers come from `cursors.rs`**: the app's own artwork replaces system
  cursors (CSS on the web; Win32, X11 Render or NSCursor in the desktop app,
  while Wayland keeps the system's). Set the `egui::CursorIcon` you mean; file
  rows keep the arrow, buttons get the hand from `interact_cursor`.
- **Folder listings are cached** (`files/cache.rs`): a revisited place shows
  its last listing at once while the fresh one loads; Back restores its scroll.
- Host differences (sessions, links, Cloud Drive, edit in app) go through the
  `Host` trait; platform differences (pickers, downloads) through `platform.rs`.
- Everything must build for `wasm32-unknown-unknown` (`cargo xtask wasm`).

## crates/tma-drive

- `core/` holds all filesystem behaviour (five-second listing cache, staging
  files, save-only mode, create-empty-then-write and temp-then-rename saves) and
  is tested with an in-memory backend. FUSE and NFS only translate calls.
  `core/scratch.rs` keeps editors' scratch and backup files local, so an Office
  save replaces the document under its id; Cloud Files does the same in `filter.rs`.
- `cloud_files/` (Windows) is a sync engine instead: placeholders download on
  open, a watcher uploads local changes, and server events resync folders that
  have been browsed. What to change is planned in the pure `sync_plan.rs`.
  Downloads stream straight into the placeholder; nothing is staged on disk.
  Windows never calls the engine for its own process, so drive it from another
  process when testing (the `mount_test` example does).
- `cloud_files/cfapi/` is our own thin layer over Cloud Files (cldapi and the
  WinRT sync-root manager) through Microsoft's `windows` crate. Every Windows
  callback is caught and always answered: a panic there aborts the app.
  Since Windows lists nothing for the app's own process, `Core::populate`
  fills a folder's placeholders before the app opens or copies from it.
- The desktop app's Edit in app and Copy hand other apps paths inside the
  mounted drive, never temporary copies. `Core::allow_read` lets those paths
  through save-only mode for a while.
- `nfs_fs/` (macOS) is a localhost NFSv3 server; it builds on Linux too, so
  test it there with `TMA_ADAPTER=nfs cargo run -p tma-drive --example mount_test`.

## Docs (the Wiki)

The wiki is a separate repo (TMA-Cloud/Wiki), checked out next to this one. Its
`WRITING.md` holds the rules; these are the ones that matter from this side:

- **A user-facing change updates the wiki in the same session**: a route, field,
  status or error code, audit event, migration, setting, limit, default, schedule,
  UI label or behaviour. Remove what you remove from the app from every wiki page too.
- **Every fact in the wiki comes from this code.** Look it up; never write from memory
  or copy from another wiki page. Copy UI labels and numbers exactly.
- **Plain words.** No filler ("simply", "seamless", "ensures that"), no "Best
  Practices" lists; say what happens. The administrator is "the first user".
- `npm run check:code` in the wiki compares it with this checkout (routes, error
  codes, audit events, schema, env vars, rate limits, version, menu labels).
  `pre-push` runs it when server, UI or app code changed.

## Before you finish

| What               | Command                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------- |
| Wiki matches code  | `npm run check:code` and `npm run lint` in the wiki                                          |
| Format, lint, test | `cargo xtask ci` (rustfmt and Prettier, house rules, clippy `-D warnings`, tests, wasm lint) |
| Format everything  | `cargo xtask fmt` (Prettier 3.9.9 through npx for Markdown, YAML, JSON, HTML, CSS)           |
| Server end to end  | `cargo test -p tma-server --test api` with the `TMA_TEST_*` vars                             |
| Web app            | `cd apps/tma-cloud-web && trunk build --release`                                             |
| Desktop installers | `cargo xtask package` (needs `cargo install cargo-packager`)                                 |
| Dependencies       | `cargo deny check` (advisories, licenses, sources; see `deny.toml`)                          |
| Root scripts       | `shellcheck setup.sh update.sh rotate.sh scripts/db-backup-restore.sh`                       |

## Git

- **Hooks** live in `.githooks/`. Turn them on once per clone with `make hooks`.
  - `pre-commit` checks staged files: rustfmt and Prettier, and blocks `.env`
    files, conflict markers and files over 5 MB.
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
