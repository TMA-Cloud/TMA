# Welcome to TMA Cloud

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

Get TMA Cloud running locally in three commands.

**1. Grab the compose file and example env:**

```bash
curl -sSL -o docker-compose.yml https://raw.githubusercontent.com/TMA-Cloud/TMA/main/docker-compose.yml
curl -sSL -o .env https://raw.githubusercontent.com/TMA-Cloud/TMA/main/.env.example
```

**2. (Optional) Edit `.env`** to set a strong `JWT_SECRET`, `ENCRYPTION_KEY`, and database password before first boot. See [Environment Variables](reference/environment-variables.md) for the full list.

**3. Start the stack:**

```bash
docker compose up -d
```

Once the containers are healthy, open [http://localhost:3000](http://localhost:3000) and create the first account — that account becomes the admin.

:::tip[Production setup]
For HTTPS, custom share domain, S3 storage, and OnlyOffice, see the full [Docker Deployment](getting-started/docker.md) guide.
:::

## Where to go next

1. **[UI Gallery](gallery.mdx)** — Screenshots of the TMA Cloud interface
2. **[Getting Started](getting-started/overview.md)** — Installation and setup
3. **[Docker Deployment](getting-started/docker.md)** — Docker Compose (curl, no clone) or prebuilt
4. **[Concepts](concepts/architecture.md)** — System architecture
5. **[User Guides](guides/user/upload-files.md)** — How to use TMA Cloud day-to-day
6. **[API Reference](api/overview.md)** — REST API
7. **[API Examples](api/examples.md)** — Copy-paste request samples
8. **[Glossary](reference/glossary.md)** — Terms used throughout the docs

## Documentation Structure

- **Getting Started** --- Installation, setup, and first steps
- **Concepts** --- Core concepts and architecture
- **Guides** --- Step-by-step instructions for users and admins
- **API** --- Complete API reference
- **Debugging** --- Troubleshooting common issues
- **Reference** --- Environment variables, schemas, and technical details
- **Changelog** --- Version history and updates

---

**Ready to get started?** Head to [Getting Started →](getting-started/overview.md)
