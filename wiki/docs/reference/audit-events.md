# Audit Events

Complete list of audit event types in TMA Cloud.

## Authentication Events

- `auth.signup` - User creates account
- `auth.login` - User logs in
- `auth.login.failure` - Failed login attempt
- `auth.logout` - Session logout
- `auth.logout_all` - Logout from all devices
- `auth.suspicious_token` - Token fingerprint mismatch
- `auth.session_revoked` - Single session revoked
- `auth.other_sessions_revoked` - All other sessions revoked

## File Events

- `file.upload` - File uploaded
- `file.upload.bulk` - Multiple files uploaded in a single bulk operation
- `file.download` - File downloaded (single)
- `file.download.bulk` - Multiple files/folders downloaded as ZIP
- `file.delete` - File moved to trash
- `file.delete.permanent` - File permanently deleted
- `file.restore` - File restored from trash
- `file.rename` - File/folder renamed
- `file.move` - Files/folders moved
- `file.copy` - Files/folders copied
- `file.star` - File starred
- `file.unstar` - File unstarred

## Folder Events

- `folder.create` - Folder created

## Share Events

- `share.create` - Share link created
- `share.delete` - Share link removed
- `share.access` - Public view of share (anonymous access)
- `share.download` - File or folder downloaded from share

## Document Events (OnlyOffice)

- `document.open` - Document opened in OnlyOffice
- `document.save` - Document saved from OnlyOffice

## Admin Events

- `admin.settings.update` - Admin setting changed (metadata: `setting`, e.g. `signup_enabled`, `hide_file_extensions`; `newValue` or `hidden`)
- `admin.settings.read` - Admin viewed protected settings (failure when unauthorized)
- `admin.user.list` - Admin listed all users
- `admin.user.update` - Admin updated user (e.g. storage limit)

## Event Metadata

Each event includes metadata with relevant information:

- **File Events:** `fileId`, `fileName`, `fileSize`, `fileType`. For `file.upload.bulk` and `file.download.bulk`, metadata also includes `fileIds` and `fileCount`.
- **User Events:** `userId`, `email`, `ipAddress`
- **Share Events:** `shareLinkId`, `token`, `fileIds`

## Related Topics

- [Audit Logs](/guides/operations/audit-logs) - Audit system guide
- [Database Schema](database-schema.md) - Database structure
