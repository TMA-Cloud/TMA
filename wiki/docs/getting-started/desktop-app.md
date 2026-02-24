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

## Desktop Editing with Office (Windows)

When you run the Windows desktop app, you can open documents in the locally installed Office applications and have changes sync back automatically.

- **Supported:** `.docx`, `.xlsx`, `.pptx`, `.pdf` (and other types that your OS can open)
- **Where it works:** Electron desktop app on Windows only

### Open on Desktop

- Right-click a document → **Open on desktop** (desktop app only), or
- Double-click a document when:
  - It is an OnlyOffice-supported type, and
  - OnlyOffice is **not** configured in the server settings, and
  - You are using the Windows desktop app

### How Sync Works

- The desktop app downloads an encrypted copy of the file to a temporary location.
- The file is opened using the default application registered in Windows (for example, Word, Excel, PowerPoint, or another associated editor).
- While the file is open, the desktop app watches it for changes.
- When you press **Save** in the desktop editor, the updated content is uploaded back to TMA Cloud in the background.
- The same file entry is updated (ID stays the same); the modified time and size reflect the new version.

If you open a document and close it without saving, no upload is performed and the stored version is unchanged.

## Related Topics

- [Architecture — Electron Desktop App](/concepts/architecture#electron-desktop-app) - How the desktop app fits in the system
- [Upload Files](/guides/user/upload-files) - Paste from computer, copy to computer (desktop only)
