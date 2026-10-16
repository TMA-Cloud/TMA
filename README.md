# TMA Cloud

A self-hosted cloud storage platform with file storage and management capabilities.

## Features

- **[Encrypted storage](https://tma-cloud.github.io/Wiki/docs/concepts/file-system#storage)** --- Encrypt files with AES-256-GCM in any S3-compatible bucket
- **[Desktop app](https://tma-cloud.github.io/Wiki/docs/getting-started/desktop-app)** --- A native app for Windows, macOS and Linux, and the same interface in the browser
- **[Cloud Drive](https://tma-cloud.github.io/Wiki/docs/getting-started/desktop-app#cloud-drive-mounted-windows-drive)** --- Open and save cloud files from any app, as a folder that needs no extra driver on Windows, Linux or macOS
- **[Document editing](https://tma-cloud.github.io/Wiki/docs/getting-started/desktop-app#edit-in-desktop-app)** --- Edit with OnlyOffice or desktop apps and sync changes back
- **[Controlled sharing](https://tma-cloud.github.io/Wiki/docs/concepts/sharing-model)** --- Create read-only links with expiry and a separate domain
- **[Sub-user access](https://tma-cloud.github.io/Wiki/docs/guides/user/sub-users)** --- Give each login separate permissions over the same files
- **[Large-file workflows](https://tma-cloud.github.io/Wiki/docs/concepts/file-system#large-file-handling)** --- Stream transfers and queue bulk file operations

## Quick Start

Download and run the installation script

```bash
curl -fsSL https://raw.githubusercontent.com/TMA-Cloud/TMA/main/setup.sh | bash
```

For detailed setup instructions, see the [Documentation Wiki](https://tma-cloud.github.io/Wiki).

## Building from source

TMA Cloud is written in Rust: the server, the web app (WebAssembly) and the desktop app share one workspace.

```bash
cargo run -p tma-server -- serve --with-worker   # API, web app and background worker
cd apps/tma-cloud-web && trunk build --release   # the web app the server serves
cargo run -p tma-cloud                           # the desktop app
cargo xtask ci                                   # format, lints and tests, as CI runs them
```

The server reads its settings from `.env` (see `.env.example`).

## UI Preview

A quick preview of the TMA Cloud interface.  
Full gallery available in the [Documentation Wiki](https://tma-cloud.github.io/Wiki/docs/gallery).

### Dashboard & File Manager

| Dashboard                                                        | File Manager                                                           |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
| ![Dashboard](https://tma-cloud.github.io/Wiki/img/dashboard.png) | ![File Manager](https://tma-cloud.github.io/Wiki/img/file-manager.png) |

## Documentation

**Full documentation is available in the [Documentation Wiki](https://tma-cloud.github.io/Wiki)**

## Contributing

Contributions, issues, and feature requests are welcome!\
Feel free to open a pull request or create an issue.

## License

This project is released under the [MIT License](LICENSE).

## Credits

- **[Zinadin Zidan](https://github.com/ZIDAN44)** --- Developer & creator
