# Share Base URL

Configure custom domain for share links in TMA Cloud (admin only).

## Share Base URL Settings

### Configuration

1. Navigate to **Settings** → **Share Base URL**
2. Enter custom base URL (e.g., `https://share.example.com`)
3. Click **Save Settings**

### Default Behavior

When not configured:

- Share links use request origin
- Format: `http://your-domain.com/s/{token}`

### Custom Domain

When configured:

- Share links use custom domain
- Format: `http://share.example.com/s/{token}`
- Share domain middleware blocks all routes except `/s/*`, `/health`, and `/metrics`

## Domain Isolation

### Route Blocking

Share domain middleware blocks:

- Main application routes (`/`, `/api/*`)
- Static files
- All routes except share links and system endpoints

### Allowed Routes

- `/s/*` - Share link access
- `/health` - Health check
- `/metrics` - Metrics endpoint

## Use Cases

### Traffic Isolation

- Separate share traffic from main app
- Dedicated domain for public links
- Improved security isolation

### CDN Integration

- Point custom domain to CDN
- Faster share link delivery
- Reduced main server load

## Related Topics

- [Sharing Model](/concepts/sharing-model) - How sharing works
- [Share Files](/guides/user/share-files) - User guide
- [Architecture](/concepts/architecture) - System architecture
