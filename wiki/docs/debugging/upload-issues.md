# Upload Issues

Troubleshooting file upload problems.

## Upload Failures

### File Not Uploading

**Check:**

1. Storage limit not exceeded
2. File size within max upload size (admin-configurable in **Settings** → **Storage**)
3. Network connection stable
4. Disk space available

### Storage Limit

**Solutions:**

1. Check current storage usage
2. Delete unnecessary files
3. Empty trash
4. Admin: Increase storage limit

### File Too Large

The file exceeds the max upload size setting.

**Solutions:**

1. Check the current max upload size in **Settings** → **Storage**
2. Admin: Increase the max upload size
3. Split the file into smaller parts

## Upload Errors

### "Storage limit exceeded"

**Solutions:**

1. Free up storage space
2. Delete old files
3. Empty trash permanently
4. Admin: Increase storage limit (if custom limit set)
5. Check actual disk space available

### "Upload failed"

**Check:**

1. File size limits
2. Disk space: `df -h`
3. File permissions on upload directory
4. Network connectivity
5. MIME type detection (file content must be readable)

## File Permissions

### Permission Denied

**Solutions:**

1. Check upload directory permissions
2. Verify user has write access
3. Docker: Check volume mount permissions
4. Set correct ownership: `chown -R user:user uploads/`

## Related Topics

- [Common Errors](common-errors.md) - General troubleshooting
- [Files API](/api/files) - Upload endpoints
- [Storage Management](/concepts/storage-management) - Storage concepts
