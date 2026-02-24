# Electron wrapper (TMA Cloud)

Desktop client for TMA Cloud. Structure follows common Electron app conventions:

```code
electron/
├── src/
│   ├── main/                 # Main process
│   │   ├── index.cjs         # Entry: app lifecycle, window, cleanup
│   │   ├── config.cjs        # Server URL, data-page HTML
│   │   ├── window.cjs        # BrowserWindow creation
│   │   ├── ipc/              # IPC handlers
│   │   │   ├── clipboard.cjs # clipboard:* channels
│   │   │   └── files.cjs     # files:editWithDesktop
│   │   └── utils/
│   │       ├── powershell.cjs # Windows PowerShell helpers
│   │       └── file-utils.cjs # Temp dirs, download/upload, clipboard paths
│   ├── preload/
│   │   ├── index.cjs         # Preload: inlined API via contextBridge
│   │   └── api.cjs           # Reference shape only (live API in index.cjs)
│   ├── config/               # Runtime config (build-config.json; dev only)
│   └── build/                # Packaging: electron-builder configs + icon
├── scripts/                  # Build tooling (prepare-client-build.js)
└── dist-electron/            # Staging for packaging (generated)
```

See [Desktop App](https://tma-cloud.github.io/TMA/docs/getting-started/desktop-app) in the wiki for setup and build instructions.
