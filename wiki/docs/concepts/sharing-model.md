# Sharing Model

How file sharing works in TMA Cloud.

## Share Links

### Overview

Share links provide public access to files and folders without requiring authentication.

### Share Link Structure

- **Token:** Cryptographically secure random token
- **Files:** One or more files/folders linked
- **Expiration:** Optional expiration date
- **Owner:** User who created the share

### Access Control

- **Public Access:** No authentication required
- **Token-Based:** Access via unique token
- **Read-Only:** Share links provide read access only
- **Download:** Files can be downloaded via share link

## Creating Share Links

### Single File Share

Share a single file with a unique link.

### Folder Share

Share entire folders, including all contents.

### Multiple Files Share

Link multiple files to a single share link.

## Share Link URLs

### Default Format

```bash
http://your-domain.com/s/{token}
```

### Custom Share Domain

Configure a custom share base URL in Settings → Share Base URL (admin only).

When configured:

```bash
http://share.your-domain.com/s/{token}
```

Share domain middleware blocks all routes except `/s/*`, `/health`, and `/metrics`.

## Share Management

### Viewing Shares

- List all shares created by user
- View share link URLs
- Copy share links

### Revoking Shares

- Delete share links
- Immediate access revocation
- No access to previously shared files

## Security Considerations

- Tokens are cryptographically secure
- No authentication required (by design)
- Expiration dates supported
- Share domain isolation (optional)

## Related Topics

- [File System](file-system.md) - How files are organized
- [User Guide: Share Files](/guides/user/share-files) - How to create shares
- [API: Sharing](/api/sharing) - API endpoints
