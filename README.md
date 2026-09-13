# TMA Cloud

A self-hosted cloud storage platform with file storage and management capabilities.

## Features

- **[Encrypted storage](https://tma-cloud.github.io/Wiki/docs/concepts/file-system#storage)** --- Encrypt files with AES-256-GCM in any S3-compatible bucket
- **[Windows cloud drive](https://tma-cloud.github.io/Wiki/docs/getting-started/desktop-app#cloud-drive-mounted-windows-drive)** --- Open and save cloud files from any Windows app
- **[Document editing](https://tma-cloud.github.io/Wiki/docs/getting-started/desktop-app#open-on-desktop)** --- Edit with OnlyOffice or desktop apps and sync changes back
- **[Controlled sharing](https://tma-cloud.github.io/Wiki/docs/concepts/sharing-model)** --- Create read-only links with expiry and a separate domain
- **[Sub-user access](https://tma-cloud.github.io/Wiki/docs/guides/user/sub-users)** --- Give each login separate permissions over the same files
- **[Large-file workflows](https://tma-cloud.github.io/Wiki/docs/concepts/file-system#large-file-handling)** --- Stream transfers and queue bulk file operations

## Quick Start

Create a directory and download the files

```bash
mkdir tma-cloud && cd tma-cloud
curl -sSL -o compose.yml https://raw.githubusercontent.com/TMA-Cloud/TMA/main/docker-compose.yml
curl -sSL -o .env https://raw.githubusercontent.com/TMA-Cloud/TMA/main/.env.example
```

Start all services

```bash
docker compose up -d
```

For detailed setup instructions, see the [Documentation Wiki](https://tma-cloud.github.io/Wiki).

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
