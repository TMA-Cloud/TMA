# Documentation Index

Welcome to the TMA Cloud documentation. This directory contains comprehensive documentation for all aspects of the project.

## Getting Started

- **[Setup & Installation](setup.md)** - Step-by-step guide to set up TMA Cloud on your system
- **[Docker Deployment](docker.md)** - Complete guide for Docker and Docker Compose deployment
- **[Architecture Overview](architecture.md)** - System architecture and design patterns
- **[Environment Variables](environment.md)** - Complete reference for all configuration options

## API & Development

- **[API Documentation](api.md)** - Complete REST API reference with all endpoints
- **[Database Schema](database.md)** - Database structure, tables, and relationships

## Features

- **[Features Documentation](features.md)** - Detailed documentation of all features

## Monitoring & Security

- **[Logging System](logging.md)** - Structured logging, secret masking, and log formats
- **[Audit Trail](audit.md)** - Comprehensive audit logging and event tracking

## Documentation Structure

```bash
docs/
├── README.md           # This file - documentation index
├── setup.md            # Installation and setup guide
├── docker.md           # Docker deployment guide
├── architecture.md     # System architecture overview
├── api.md              # Backend API documentation
├── features.md         # Feature documentation
├── database.md         # Database schema reference
├── environment.md      # Environment variables reference
├── logging.md          # Logging system documentation
└── audit.md            # Audit trail documentation
```

## Quick Links

### For New Users

1. Start with [Setup & Installation](setup.md) or [Docker Deployment](docker.md)
2. Review [Architecture Overview](architecture.md) to understand the system
3. Check [Environment Variables](environment.md) for configuration
4. Ensure Redis is installed and running for optimal performance

### For Developers

1. Read [Architecture Overview](architecture.md)
2. Review [API Documentation](api.md) for backend endpoints
3. Reference [Database Schema](database.md) for data structure
4. Understand [Logging System](logging.md) for debugging and monitoring
5. Review [Audit Trail](audit.md) for tracking user actions

### For Feature Understanding

1. Read [Features Documentation](features.md) for feature details
2. Check [API Documentation](api.md) for implementation details

### For Security & Compliance

1. Review [Audit Trail](audit.md) for compliance tracking
2. Check [Logging System](logging.md) for secret masking and security
3. See [Features - Security](features.md#security-features) for security features
4. See [Features - Session Security](features.md#session-security) for session hijacking protection

## Contributing

When adding new features or making changes:

1. Update relevant documentation files
2. Add API endpoints to [api.md](api.md)
3. Update [features.md](features.md) if adding new features
4. Update [database.md](database.md) if schema changes
5. Update [environment.md](environment.md) if new env vars are added
6. Update [logging.md](logging.md) if logging configuration changes
7. Update [audit.md](audit.md) if new audit events are added

## Need Help?

- Check the [Setup Guide](setup.md) for installation issues
- Review [Environment Variables](environment.md) for configuration problems
- See [API Documentation](api.md) for endpoint usage
- Check [Features Documentation](features.md) for feature-specific questions
