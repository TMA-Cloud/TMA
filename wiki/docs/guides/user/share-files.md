# Share Files

Create shareable links for files and folders in TMA Cloud.

## Creating Share Links

### Single File Share

1. Right-click on a file
2. Select **"Share"**
3. Choose an expiry option (7 days, 30 days, or no expiration)
4. Copy the generated link

### Folder Share

1. Right-click on a folder
2. Select **"Share"**
3. Choose an expiry option
4. All folder contents accessible via link

### Bulk Share

1. Select multiple files/folders
2. Click **"Share"** button in the toolbar
3. Choose an expiry option
4. A share link is created for each selected item

## Share Link Expiry

### Expiry Options

When sharing, you choose one of:

- **7 days** (default) - link expires after 7 days
- **30 days** - link expires after 30 days
- **No expiration** - link stays active until manually revoked

Re-sharing an already-shared file lets you change the expiry.

### Expired Links

- Expired links remain visible in the **Shared** section with a red clock icon and **"Link expired"** label
- Anyone visiting an expired link sees a "Link expired" page
- A background job automatically cleans up expired share links every 7 days

## Share Link Management

### Viewing Shares

- Go to **"Shared"** section
- Active links show the green share icon
- Expired links show a red clock icon and "Link expired" label

### Copying Links

- Click **"Copy Link"** button
- Link copied to clipboard
- Share via email, messaging, etc.

### Revoking Shares

- Right-click and select **"Unshare"**, or use the toolbar
- Immediate access revocation
- Link becomes invalid

## Share Link Features

### Public Access

- No authentication required
- Accessible to anyone with link
- Read-only access

### Custom Domain

- Optional custom share domain
- Isolated from main application
- Configure in Settings → Share Base URL (admin only)

## Accessing Shared Files

### Via Share Link

1. Click share link (or paste in browser)
2. View shared files/folders
3. Download files as needed

### Download Options

- **Single File:** Direct download
- **Folder:** Download as ZIP archive
- **Multiple Files:** Select and download

## Security Considerations

- Share links are public (no authentication)
- Use expiration dates for sensitive files
- Revoke shares when no longer needed
- Be cautious with sensitive information

## Related Topics

- [Sharing Model](/concepts/sharing-model) - How sharing works
- [API: Sharing](/api/sharing) - API endpoints
- [Security Model](/concepts/security-model) - Security best practices
