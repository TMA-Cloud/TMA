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

## Auto-Save Issues

### Changes Not Saving Until Close

**Expected behavior:** Documents save to storage every 30 seconds while being edited.

**Check:**

1. Backend logs show `[ONLYOFFICE-AUTOSAVE] Auto-save started` when document is opened
2. Backend logs show `[ONLYOFFICE-AUTOSAVE] Triggering forcesave` every 30 seconds
3. Callback logs show status 6 with `forcesavetype: 0`

**If no auto-save logs appear:**

1. Verify `onlyofficeAutoSave.js` is loaded (check for import errors on startup)
2. Check that document registration runs in viewer/config controllers

**If forcesave commands fail silently:**

1. Check OnlyOffice URL is correct and reachable from the backend
2. If OnlyOffice uses HTTPS with a self-signed certificate, verify `rejectUnauthorized: false` is set in the request options
3. Check OnlyOffice container logs: `docker logs onlyoffice_documentserver`

**If forcesave commands return non-200:**

1. Status 403: JWT secret mismatch between backend and OnlyOffice server
2. Status 404: Wrong command service URL (should be `/coauthoring/CommandService.ashx`)
3. Check backend logs for `[ONLYOFFICE-AUTOSAVE] Forcesave command failed` with status code

### Auto-Save Running After Document Closed

**Cause:** Callback with status 2 or 4 was not received, so the document was not unregistered.

**Check:**

1. OnlyOffice server can reach the callback URL (`BACKEND_URL`)
2. Callback endpoint returns `{ "error": 0 }` (required for OnlyOffice to stop retrying)
3. No network/firewall issues between OnlyOffice container and backend

### Only Manual Saves (Ctrl+S) Work

**Cause:** The auto-save service is not sending forcesave commands, or they are being rejected.

**Check:**

1. Backend logs for `[ONLYOFFICE-AUTOSAVE] Request error` or `Forcesave command failed`
2. OnlyOffice JWT secret matches between backend settings and OnlyOffice server config
3. OnlyOffice server is accessible from the backend host (not just from the browser)

## Related Topics

- [OnlyOffice API](/api/onlyoffice) - API endpoints
- [Architecture](/concepts/architecture) - System architecture
