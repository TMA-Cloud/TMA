# OnlyOffice Issues

Troubleshooting OnlyOffice integration problems.

## Editor Not Loading

### Configuration Missing

**Check:**

1. OnlyOffice server URL is configured
2. `BACKEND_URL` environment variable is set
3. Settings page configuration

**Solutions:**

1. Configure OnlyOffice in Settings (admin)
2. Set `BACKEND_URL` in `.env`
3. Verify OnlyOffice server is accessible

### File Not Opening

**Check:**

1. File type is supported (.docx, .xlsx, .pptx, .pdf)
2. File exists and is accessible
3. OnlyOffice server is running
4. File MIME type matches extension

**Solutions:**

1. Verify file type is supported
2. Check file permissions
3. Verify OnlyOffice server is accessible
4. Ensure file content matches extension (e.g., .txt renamed to .docx will fail)

### MIME Type Mismatch

**Error:** "Cannot open file: type mismatch (expected .docx format)"

**Cause:**

- File content does not match extension
- File was renamed with incorrect extension

**Solutions:**

1. Upload file with correct extension
2. Do not rename files to different types
3. File content must match declared type

## Callback Issues

### Callback Not Working

**Check:**

1. `BACKEND_URL` is correct and accessible
2. OnlyOffice server can reach backend
3. Callback endpoint is working

**Solutions:**

1. Verify `BACKEND_URL` is publicly accessible
2. Check firewall rules
3. Test callback endpoint manually

## Related Topics

- [OnlyOffice API](/api/onlyoffice) - API endpoints
- [Architecture](/concepts/architecture) - System architecture
