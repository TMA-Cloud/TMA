# Desktop App (Electron)

Optional Windows desktop client for TMA Cloud. Loads the same web app from your server URL; no separate frontend build.

## Prerequisites

- **Node.js** (v25+)
- **TMA Cloud server** running and reachable (e.g. `https://your-tma-cloud.example.com`)
- **npm**

## Run from Source

Useful for development or testing without building an installer.

1. Clone the repo and go to the Electron app:

   ```bash
   cd electron
   npm install
   ```

2. Set the server URL. Create `electron/src/config/build-config.json` (copy from `src/config/build-config.example.json` if present) with:

   ```json
   { "serverUrl": "https://your-tma-cloud.example.com" }
   ```

   Replace with your actual TMA Cloud URL.

3. Start the app:

   ```bash
   npm start
   ```

   The window opens and loads the server URL. If `serverUrl` is missing, the app shows a "Server URL not configured" page.

## Build Installer (Windows)

Builds a Windows installer with the server URL embedded so users do not need a config file.

**Admin privilege required:** Run your terminal (or IDE) **as Administrator** when building.

1. In `electron/`, ensure `src/config/build-config.json` exists and contains your `serverUrl` (same format as above).

2. Run the build:

   ```bash
   npm run build:client
   ```

   This runs `prepare-client-build.js` (copies `src/main` and `src/preload` into `dist-electron/` and injects `serverUrl` into main config), then runs electron-builder. Output is in `electron/dist-client/` (NSIS installer by default).

3. For a portable executable (no installer):

   ```bash
   npm run build:client:win:portable
   ```

4. For an unpacked folder (no installer, run exe from folder):

   ```bash
   npm run build:client:win:unpacked
   ```

Builds are unsigned by default. To sign the app, configure code signing and use the same `build:client` flow.

## Install on Windows

- **NSIS installer:** Run the `.exe` from `dist-client/`. Choose installation directory and complete the wizard.
- **Portable:** Copy the portable build and run the executable. No install step.
- **Unpacked:** Run the executable inside the unpacked folder.

The server URL is embedded at build time only. No config file is needed after install.

## Version and updates

- The desktop app version comes from `electron/package.json` and is shown under **Settings → Updates → Desktop app**.
- The app uses the same update feed as the web UI (`/api/version/latest`), which returns `frontend`, `backend`, and `electron` versions.
- When an admin user opens the app, a one-time background check compares the current versions to the feed.
- If any component is outdated, an **Updates Available** notice appears in the left sidebar above **Settings**, listing the latest versions for backend, frontend, and Electron.

## Desktop Editing and Open on Desktop (Windows)

When you run the Windows desktop app, you can open supported files in their desktop applications and have changes sync back automatically.

- **Supported:** `.docx`, `.xlsx`, `.pptx`, `.pdf`, and other types that Windows can open (including common image and video formats)
- **Where it works:** Electron desktop app on Windows only

### Open on Desktop

- Right-click a supported file (document, image, or video) → **Open on desktop**
- Double-click behavior in the desktop app:
  - Office/OnlyOffice-supported files open in the default desktop application
  - Image and video files open in the default viewer for that type

### How Sync Works

- The desktop app downloads an encrypted copy of the file to a temporary location.
- The file is opened using the default application registered in Windows (for example, Word, Excel, PowerPoint, or another associated editor).
- While the file is open, the desktop app watches it for changes.
- When you press **Save** in the desktop editor, the updated content is uploaded back to TMA Cloud in the background.
- The same file entry is updated (ID stays the same); the modified time and size reflect the new version.

If you open a document and close it without saving, no upload is performed and the stored version is unchanged.

## Clipboard Integration (Windows desktop app)

The Windows desktop app adds OS-level clipboard support on top of the standard browser behavior.

### Context Menu

- **Copy:** Right-click one or more files → **Copy** to place them on the Windows clipboard, then paste in Explorer to save them (200 MB total limit; folders not supported; not available in Trash).
- **Paste:** Right-click in a folder → **Paste** to upload files from the Windows clipboard into the current folder (same upload limits as regular uploads). Supports Explorer copy, Outlook attachments, Snipping Tool, and similar sources.
- **Copy in cloud:** Uses the in-app clipboard to copy items between folders inside TMA Cloud.
- **Paste in cloud:** Pastes from the in-app clipboard into the current folder.

### Keyboard Shortcuts

- **Ctrl+A / Cmd+A:** Select all files and folders in the current view.
- **Ctrl+C / Cmd+C:** Copy selected files to the Windows clipboard (same as context menu **Copy** in the desktop app).
- **Ctrl+V / Cmd+V:** Upload files from the Windows clipboard into the current folder (same as context menu **Paste** in the desktop app).
- **Ctrl+Shift+C / Cmd+Shift+C:** Copy selected items using the in-app clipboard (same as **Copy in cloud**).
- **Ctrl+Shift+V / Cmd+Shift+V:** Paste from the in-app clipboard into the current folder (same as **Paste in cloud**).
- **Ctrl+Shift+I / Cmd+Shift+I:** Open **Get Info** for the currently selected file or folder (desktop app only and single selection).

## Desktop-only mode (optional)

- When the administrator enables **Desktop app only access** in **Settings → Administration** from the desktop app, the backend rejects browser access to the main app.
- The desktop app continues to work because it sends the required HTTP header on its requests.
- Share links (`/s/*`), `/health`, and `/metrics` still respond as normal.
- Browsers that open the main URL see a simple page stating that the instance is configured for desktop app access only.

## Related Topics

- [Architecture — Electron Desktop App](/concepts/architecture#electron-desktop-app) - How the desktop app fits in the system
- [Upload Files](/guides/user/upload-files) - Upload, copy to computer, and clipboard usage
