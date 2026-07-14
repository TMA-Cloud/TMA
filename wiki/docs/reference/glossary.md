# Glossary

Short definitions for terms that appear throughout the TMA Cloud docs.

### Admin / first user

The first account created on a fresh deployment. Permanently stored in `app_settings.first_user_id`. Sees the Administration section in Settings and controls signup, storage, and MFA settings.

### Audit log

Append-only record of notable events (logins, uploads, shares, admin changes). See [Audit Events](audit-events.md) for the full catalog.

### Bulk operation

Any endpoint that accepts an `ids` array and processes multiple files in one request (move, copy, delete, star, share, download).

### Cloud Drive

A Windows drive the desktop app can mount (via WinFsp) so files can be opened and saved from any application's file dialogs. Backed by the `desktop-fs` host and `clouddrive.cjs` in the main process. See [Desktop App](../getting-started/desktop-app.md#cloud-drive-mounted-windows-drive).

### Derived file

A new file exported from an existing one — e.g. saving a `.docx` as `.pdf` from the desktop app. Created as a sibling of the source via `POST /api/files/:id/derived`.

### Forcesave

An OnlyOffice command that tells the document server to flush the current editor state to storage immediately, rather than waiting for the user to close the document. TMA Cloud triggers a forcesave every 30 seconds while a document is open.

### Heartbeat

A periodic signal the desktop app (or a long-running client) sends so the server knows the client is still connected. Absence of heartbeats is how stale sessions get cleaned up.

### JWT (JSON Web Token)

The signed token used to authenticate API requests. Delivered as an httpOnly cookie, not a header.

### MFA (Multi-Factor Authentication)

Optional second factor (TOTP) on top of the password. Managed per user; admins can enforce it — see [MFA Management](../guides/admin/mfa-management.md).

### MIME type / magic bytes

The actual file format, detected by reading the first few bytes of the file content (not the file extension). TMA Cloud rejects uploads whose content doesn't match a supported type, regardless of what the file is named.

### OnlyOffice

The third-party document server that powers in-browser editing of `.docx`, `.xlsx`, `.pptx`, and `.pdf` files. Optional — the rest of TMA Cloud works without it.

### pg-boss

The PostgreSQL-backed job queue used for background work (audit event writes, trash cleanup). You don't interact with it directly; it runs inside the backend process.

### Share domain

An optional separate domain you can point at `/s/*` routes, so share links don't expose the main app's domain. Configured via `SHARE_BASE_URL` — see [Share Base URL](../guides/admin/share-base-url.md).

### Share link / share token

A public URL (e.g. `https://example.com/s/abc123`) that lets anyone with the link view or download a file or folder, without a TMA Cloud account.

### Signup control

The admin toggle that decides whether new accounts can be created. See [Signup Control](../guides/admin/signup-control.md).

### Soft delete

Moving a file to trash rather than removing it from storage. Trashed files are auto-purged after 15 days.

### Storage driver

How and where uploaded files live. `local` stores them in `UPLOAD_DIR` on the backend host; `s3` streams them to an S3-compatible bucket. Controlled by `STORAGE_DRIVER`.

### Token version (`token_version`)

A per-user counter that increments when the user logs out of all devices or changes password. Existing JWTs are rejected if their embedded version is older than the current one — this is how "logout everywhere" works without a token denylist.

### Trash

The per-user soft-delete area. Deleting a file moves it here; files auto-purge after 15 days. Trash counts toward the user's storage quota.

### WinFsp

Windows File System Proxy — a user-mode filesystem driver for Windows. The desktop app uses it to provide the [Cloud Drive](#cloud-drive). Installed by the desktop installer if not already present. GPLv3 with a FLOSS exception; see [winfsp.dev](https://winfsp.dev).
