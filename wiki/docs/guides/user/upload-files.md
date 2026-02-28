# Upload Files

Learn how to upload and manage files in TMA Cloud.

## Uploading Files

### Basic Upload

1. Navigate to the folder where you want to upload
2. Click the **"Upload"** button
3. Select **Upload files**
4. Choose one or more files from your computer
5. Files upload to the current folder

### Upload a Folder

- Click the **"Upload"** button → **Upload folder**
- Select a folder from your computer
- All subfolders and files under that folder are uploaded
- The folder structure is recreated under the current folder

### Drag and Drop

- Drag files or folders directly into the file manager
- Drop them in the desired folder
- Upload progress is shown in real-time

### Paste from Clipboard (Ctrl+V)

- Copy files on your computer (for example, in Explorer with **Ctrl+C**)
- Open **My Files** and go to the folder where you want to upload
- Press **Ctrl+V** in the file list; files from the clipboard upload to the current folder
- Single file uses standard upload; multiple files use bulk upload with progress
- Same size and quota limits apply as for Upload
- In the Windows desktop app, this uses the desktop client's OS clipboard integration

### Copy to Computer (Windows desktop app)

- Available in the Electron desktop app (Windows)
- Right-click one or more files → **Copy** (desktop app); files are placed on the OS clipboard and can be pasted in Explorer to save
- Limit: 200 MB total per action; no single file over 200 MB
- Folders are not supported; only files; not available in Trash view

### Duplicate file names

When you upload a file and one with the same name already exists in the folder, the app asks before uploading:

- **Replace the File** – overwrites the existing file (same ID and name).
- **Upload with Renamed** – uploads as a new file with a unique name (e.g. `document (1).pdf`).

You choose an action for each conflicting file; nothing is uploaded until you confirm.

### Upload Limits

- Per-file size limited by the max upload size setting (default 10 GB, configurable by admin in **Settings** → **Storage**)
- Total upload size limited by your storage quota
- Upload rate limited to 20000 uploads per 30 minutes per user
- Both limits enforced before upload starts

## File Management

### Viewing Files

- **Grid View:** Thumbnail view of files
- **List View:** Detailed list with metadata
- **Sort Options:** Name, date, size, type

### File Operations

- **Download:** Click to download single file
- **Bulk Download:** Select multiple files → Download (creates ZIP archive)
- **Copy:** (desktop app) Right-click files → Copy to put them on the OS clipboard and paste in Explorer (200 MB total limit)
- **Copy in cloud:** In-app copy between folders inside TMA Cloud
- **Rename:** Right-click → Rename
- **Move:** Drag and drop or use Move option
- **Paste:** Right-click → Paste to upload files from the OS clipboard into the current folder (desktop app)
- **Paste in cloud:** Right-click → Paste in cloud to paste from the in-app clipboard
- **Delete:** Right-click → Delete (moves to trash)
- **Star:** Mark files as favorites
- **Select all (desktop app):** Press **Ctrl+A** / **Cmd+A** in the file list to select all items in the current folder

## File Types

### Supported Files

- All file types supported
- MIME type detected from file content (magic bytes)
- Actual file type stored regardless of filename extension
- Preview for images and documents

### Document Editing and Viewers

- **OnlyOffice Integration (browser):** Edit `.docx`, `.xlsx`, `.pptx` files in the browser when OnlyOffice is configured
- **Desktop Editing (desktop app):** In the electron app, open supported documents on your computer (Word, Excel, PowerPoint, and other associated editors) and changes sync back automatically when you save
- **Image Viewing (browser):** View images with zoom in the built-in viewer
- **Image and Video Viewing (desktop app):** In the electron app, double-clicking images and videos opens them in the default desktop application

## Best Practices

- Organize files in folders
- Use descriptive file names
- Star important files for quick access
- Regularly clean up trash

## Related Topics

- [Manage Folders](manage-folders.md) - Organize your files
- [Starred Files](starred-files.md) - Quick access to favorites
- [Trash & Restore](trash-restore.md) - Recover deleted files
