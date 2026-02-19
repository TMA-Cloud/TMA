# Sharing Model

How file sharing works in TMA Cloud.

## Share Links

### Overview

Share links provide public access to files and folders without requiring authentication.

### Share Link Structure

- **Token:** Cryptographically secure random token
- **Files:** One or more files/folders linked
- **Expiration:** Configurable expiration (`7 days`, `30 days`, or `never`).
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

## Link Expiration

### Expiry Options

When creating or re-sharing a link, the user selects one of:

- **7 days** (default)
- **30 days**
- **No expiration**

Re-sharing an existing link updates its expiry to the newly selected value.

### Expired Link Behavior

- Expired links return **410 Gone** on the public page with an "Link expired" message
- The **Shared** page in the file manager still lists expired files with a red clock icon and "Link expired" label
- Downloads and ZIP exports for expired links are blocked with the same 410 response

### Auto-Cleanup

A background job removes expired share links from the database. It runs once at server startup and then every 7 days. Cleanup deletes the `share_links` and `share_link_files` rows and sets `shared = false` on files that no longer have an active share link.

## Share Management

### Viewing Shares

- Go to the **Shared** section in the file manager
- Active links show the green share icon
- Expired links show a red clock icon and "Link expired" label
- Copy share links from the share modal

### Revoking Shares

- Unshare via context menu or toolbar
- Immediate access revocation
- Link becomes invalid

## Security Considerations

- Tokens are cryptographically secure
- No authentication required (by design)
- Expiration enforced on every access (not just cleanup)
- Redis cache TTL is capped at the link's remaining lifetime to prevent stale access
- Share domain isolation (optional)

## Related Topics

- [File System](file-system.md) - How files are organized
- [User Guide: Share Files](/guides/user/share-files) - How to create shares
- [API: Sharing](/api/sharing) - API endpoints
