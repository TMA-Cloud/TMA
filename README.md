# TMA Cloud

A self-hosted cloud storage platform with file storage and management capabilities.

## Features

- **Authentication** --- JWT-based auth with optional Google OAuth and MFA
- **Signup Control** --- Self-hosted deployments can control user registration
- **File Management** --- Upload, download, organize, and manage files and folders
- **Sharing** --- Create shareable links for files and folders
- **Custom Share Domain** --- Dedicated domain for share links to isolate traffic
- **Document Editing** --- OnlyOffice integration for online document editing
- **Redis Caching** --- High-performance caching layer for improved response times
- **Modern UI** --- React + TypeScript frontend with Tailwind CSS
- **PostgreSQL** --- Robust database with automatic migrations
- **Background Services** --- Automatic cleanup of trash and orphaned files
- **Audit Logging** --- Comprehensive audit trail with queue-based event tracking

## Quick Start

Create a directory and download the files

```bash
mkdir tma-cloud && cd tma-cloud
curl -sSL -o docker-compose.yml https://raw.githubusercontent.com/TMA-Cloud/TMA/main/docker-compose.yml
curl -sSL -o .env.example https://raw.githubusercontent.com/TMA-Cloud/TMA/main/.env.example
```

Configure environment

```bash
cp .env.example .env
# Edit .env with your configuration.
```

Start all services

```bash
docker compose up -d
```

For detailed setup instructions, see the [Documentation Wiki](https://tma-cloud.github.io/TMA).

## UI Preview

A quick preview of the TMA Cloud interface.  
Full gallery available in the [Documentation Wiki](https://tma-cloud.github.io/TMA/gallery).

### Dashboard & File Manager

| Dashboard                                   | File Manager                                       |
|---------------------------------------------|----------------------------------------------------|
| ![Dashboard](wiki/static/img/dashboard.png) | ![File Manager](wiki/static/img/file-manager.png)  |

## Documentation

**Full documentation is available in the [Documentation Wiki](https://tma-cloud.github.io/TMA)**

## Contributing

Contributions, issues, and feature requests are welcome!\
Feel free to open a pull request or create an issue.

## License

This project is released under the [MIT License](LICENSE).

## Credits

- **[Zinadin Zidan](https://github.com/ZIDAN44)** --- Developer & creator
