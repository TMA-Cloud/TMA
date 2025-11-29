# TMA Cloud

A self-hosted cloud storage platform providing robust file storage and management capabilities.

## Features

- 🔐 **Authentication**: JWT-based auth with optional Google OAuth
- 🔒 **Signup Control**: Self-hosted deployments can control user registration
- 📁 **File Management**: Upload, download, organize, and manage files and folders
- 🔗 **Sharing**: Create shareable links for files and folders
- 📝 **Document Editing**: OnlyOffice integration for online document editing
- 🎨 **Modern UI**: React + TypeScript frontend with Tailwind CSS
- 🗄️ **PostgreSQL**: Robust database with automatic migrations
- 🧹 **Background Services**: Automatic cleanup of trash and orphaned files
- 📊 **Audit Logging**: Comprehensive audit trail with queue-based event tracking

## Quick Start

### Prerequisites

- Node.js (v25+)
- PostgreSQL (v17+)
- npm or yarn

### Installation

```bash
git clone https://github.com/TMA-Cloud/TMA.git
cd TMA
```

#### Frontend Setup & Build

```bash
cd ../frontend
npm install
npm run build
# Frontend will be built to dist/ dir
```

#### Backend Setup

```bash
cd backend
npm install
cp .env.example .env
# Edit .env with your configuration
npm start
# Access the application at http://localhost:3000
```

For detailed setup instructions, see [docs/setup.md](docs/setup.md).

## Documentation

- [Features](docs/features.md)
- [Audit Trail](docs/audit.md)
- [Logging System](docs/logging.md)
- [Database Schema](docs/database.md)
- [API Documentation](docs/api.md)
- [Setup & Installation](docs/setup.md)
- [Architecture Overview](docs/architecture.md)
- [Environment Variables](docs/environment.md)

## Contributing

Pull requests are welcome! Feel free to open issues for any bugs or feature requests.

## License

This project is released under the [MIT License](LICENSE).

## Credits

- [**Zinadin Zidan**](https://github.com/ZIDAN44) - Developer and creator.
