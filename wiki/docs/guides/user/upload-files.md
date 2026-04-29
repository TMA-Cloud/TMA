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
- In the Upload modal, folder uploads show as **Folders to Upload** with one row per root folder (folder icon, name, item count, total size)

### Drag and Drop

- **In the file manager (My Files):** Drag files or folders from your computer onto the file list and the Upload modal opens with the dropped items then click **Upload** (Folder structure is preserved when supported)
- **In the Upload modal:** Use the drop zone to add more files or folders. If the list already has items, a compact "Add more" strip is shown
- **Queue display:** File uploads show **Files to Upload** with one row per file and Folder uploads show **Folders to Upload** with one row per root folder (folder icon, name, item count, total size)

### Paste from Clipboard (Ctrl+V)

- Copy files on your computer (for example, in Explorer with **Ctrl+C**)
- Open **My Files** and go to the folder where you want to upload
- Press **Ctrl+V** in the file list; if you haven't recently copied something inside TMA Cloud, the OS-clipboard files upload to the current folder
- Single file uses standard upload; multiple files use bulk upload with progress
- Same size and quota limits apply as for Upload
- In the Windows desktop app, **Paste** is unified with the in-app clipboard: if you also did a Copy/Cut inside TMA Cloud, that takes priority. If you copy something new in Explorer afterwards, Paste detects the change and uploads the newer Explorer files instead

### Copy to Computer (Windows desktop app)

- The desktop-app **Copy** (right-click → **Copy** or **Ctrl+C**) writes the selection to the Windows clipboard in the background, in addition to the in-app clipboard. You can then paste in Explorer to save them
- Limit for the Windows-clipboard side: 200 MB total per action and no single file over 200 MB. Larger selections and folders still work for in-app pastes — they just aren't written to the Windows clipboard
- Not available in Trash view

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

### Upload Progress and Cancel

- A floating progress panel shows active uploads (single file or bulk)
- **Single file / flat multi-file uploads:** Each file has its own **Cancel upload** button
- **Folder uploads (bulk):** All files in the folder are sent as one batch. A **Cancel all** button appears in the Upload modal
- **Remove:** Before upload starts, use **Remove** in the queue to drop a file or folder from the list
- **After cancel:** Files and folders already created before cancel appear in the file list

## File Management

### Viewing Files

- **Grid View:** Thumbnail view of files
- **List View:** Detailed list with metadata
- **Sort Options:** Name, date, size, type

### File Operations

- **Download:** Click to download single file
- **Bulk Download:** Select multiple files → Download (creates ZIP archive)
- **Copy:** Right-click → Copy (or **Ctrl+C**). One action: copies between folders inside TMA Cloud and (in the desktop app) also writes to the Windows clipboard so you can paste in Explorer. The 200 MB limit only affects the Windows-clipboard side
- **Cut:** Right-click → Cut (or **Ctrl+X**). In-app only — cut items appear faded until you paste
- **Rename:** Right-click → Rename
- **Move:** Drag and drop or use Cut + Paste
- **Paste:** Right-click → Paste (or **Ctrl+V**). Smart paste: cloud clipboard wins if you copied/cut inside TMA Cloud, otherwise files from the Windows clipboard are uploaded. If you copied externally after a cloud Copy, Paste detects that and uses the newer Windows-clipboard files
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
- **Export / Save As (desktop app):** When a document is opened via **Open on desktop** in the Windows app and you use Save As / Export to create a new file in the temporary folder opened by the desktop app (for example a `.pdf`, `.docx`, `.xlsx`, `.pptx`, `.csv`, or `.rtf`), the new file is uploaded automatically as a separate file in the same cloud folder. If you save the new file to another location (for example Desktop or Documents), it is not uploaded automatically.
- **Image Viewing (browser):** View images with zoom in the built-in viewer
- **Image, Video, and Audio (desktop app):** In the Electron app, double-clicking images, videos, or audio files opens them in the default desktop application

## Best Practices

- Organize files in folders
- Use descriptive file names
- Star important files for quick access
- Regularly clean up trash

## Related Topics

- [Manage Folders](manage-folders.md) - Organize your files
- [Starred Files](starred-files.md) - Quick access to favorites
- [Trash & Restore](trash-restore.md) - Recover deleted files
