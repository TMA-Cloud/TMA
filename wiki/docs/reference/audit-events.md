# Audit Events

Complete list of audit event types in TMA Cloud.

## Authentication Events

- `user.signup` - User creates account
- `user.login` - User logs in
- `user.logout` - User logs out
- `user.login.failed` - Failed login attempt
- `auth.logout` - Session logout
- `auth.logout_all` - Logout from all devices
- `auth.suspicious_token` - Token fingerprint mismatch
- `auth.session_revoked` - Session revoked

## File Events

- `file.upload` - File uploaded
- `file.download` - File downloaded
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
- `share.access` - Public access to shared file/folder

## Document Events (OnlyOffice)

- `document.open` - Document opened in OnlyOffice
- `document.save` - Document saved from OnlyOffice

## Settings Events

- `settings.signup.toggle` - Signup enabled/disabled

## Event Metadata

Each event includes metadata with relevant information:

- **File Events:** `fileId`, `fileName`, `fileSize`, `fileType`
- **User Events:** `userId`, `email`, `ipAddress`
- **Share Events:** `shareLinkId`, `token`, `fileIds`

## Related Topics

- [Audit Logs](/guides/operations/audit-logs) - Audit system guide
- [Database Schema](database-schema.md) - Database structure
