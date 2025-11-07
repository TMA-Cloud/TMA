# Architecture Overview

This document provides an overview of the TMA Cloud architecture, including system design, components, and data flow.

## System Architecture

TMA Cloud follows a traditional client-server architecture with a React frontend and Express.js backend.

```bash
┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│   Browser   │◄──────►│   Frontend  │◄──────►│   Backend   │
│  (React)    │         │  (Vite)     │         │  (Express)  │
└─────────────┘         └─────────────┘         └─────────────┘
                                                       │
                                                       ▼
                                                ┌─────────────┐
                                                │ PostgreSQL  │
                                                │  Database   │
                                                └─────────────┘
```

## Backend Architecture

### Backend Directory Structure

```bash
backend/
├── config/          # Configuration files (database, paths)
├── controllers/     # Request handlers (business logic)
├── middleware/      # Express middleware (auth, error handling)
├── migrations/      # Database migration files
├── models/          # Data models and database queries
├── routes/          # API route definitions
├── services/        # Background services (cleanup, scanning)
├── utils/           # Utility functions
└── uploads/         # File storage directory
```

### Backend Key Components

#### 1. **Controllers**

Handle HTTP requests and implement business logic:

- `auth.controller.js` - Authentication and user management
- `file.controller.js` - File operations (CRUD, move, copy, share)
- `share.controller.js` - Share link handling
- `onlyoffice.controller.js` - OnlyOffice integration
- `user.controller.js` - User profile and storage

#### 2. **Middleware**

- `auth.middleware.js` - JWT token verification
- `error.middleware.js` - Centralized error handling

#### 3. **Models**

Database abstraction layer:

- `user.model.js` - User data operations
- `file.model.js` - File and folder operations
- `share.model.js` - Share link operations

#### 4. **Services**

Background processes:

- `trashCleanup.js` - Automatic trash deletion
- `orphanCleanup.js` - Cleanup of orphaned files
- `customDriveScanner.js` - Custom drive synchronization

#### 5. **Routes**

API endpoint definitions:

- `/api` - Authentication endpoints
- `/api/files` - File management endpoints
- `/api/user` - User endpoints
- `/api/onlyoffice` - OnlyOffice endpoints
- `/s` - Public share endpoints

## Frontend Architecture

### Frontend Directory Structure

```bash
frontend/
├── src/
│   ├── components/   # React components
│   │   ├── auth/     # Authentication components
│   │   ├── dashboard/# Dashboard components
│   │   ├── fileManager/ # File management UI
│   │   ├── folder/   # Folder creation
│   │   ├── layout/   # Layout components
│   │   ├── settings/ # Settings page
│   │   ├── upload/   # Upload functionality
│   │   ├── viewer/   # File viewers
│   │   └── ui/       # Reusable UI components
│   ├── contexts/     # React contexts (state management)
│   ├── hooks/        # Custom React hooks
│   └── utils/        # Utility functions
```

### Frontend Key Components

#### 1. **Contexts**

Global state management:

- `AuthContext` - User authentication state
- `AppContext` - Application state (current path, sidebar, etc.)
- `ThemeContext` - Dark/light theme

#### 2. **Components**

- **Layout**: `Header`, `Sidebar` - Main layout structure
- **File Manager**: `FileManager`, `FileItem`, `Breadcrumbs` - File browsing
- **Modals**: `UploadModal`, `RenameModal`, `ShareLinkModal` - User interactions
- **Viewers**: `ImageViewerModal`, `DocumentViewerModal` - File preview

#### 3. **Utils**

- `api.ts` - API client functions
- `fileUtils.ts` - File-related utilities
- `debounce.ts` - Debounce utility

## Data Flow

### Authentication Flow

```bash
1. User submits login form
2. Frontend sends POST /api/login
3. Backend validates credentials
4. Backend generates JWT token
5. Token stored in httpOnly cookie
6. Frontend receives success response
7. AuthContext updates user state
8. User redirected to dashboard
```

### File Upload Flow

```bash
1. User selects file(s) to upload
2. Frontend creates FormData
3. POST /api/files/upload with file and path
4. Backend validates file and user storage
5. File saved to uploads/ directory
6. Database record created
7. Response with file metadata
8. Frontend refreshes file list
```

### Share Link Flow

```bash
1. User selects file/folder to share
2. POST /api/files/share
3. Backend creates share_link record
4. Unique token generated
5. Response with share URL
6. User can copy/share the link
7. Public access via /s/:token
```

## Database Schema

See [Database Schema](database.md) for detailed table structures.

Key tables:

- `users` - User accounts
- `files` - Files and folders
- `share_links` - Share link metadata
- `share_link_files` - Files included in share links
- `migrations` - Migration tracking

## Security

### Authentication

- JWT tokens stored in httpOnly cookies
- Tokens expire after a set duration
- Middleware validates tokens on protected routes

### File Security

- Files stored outside web root
- Access controlled by user ownership
- Share links use cryptographically secure tokens

### API Security

- CORS configured for specific origins
- Security headers (XSS protection, frame options)
- Input validation and sanitization
- Error messages don't expose sensitive information

## Background Services

### Trash Cleanup

- Automatically deletes files from trash after 30 days
- Runs periodically via scheduler

### Orphan Cleanup

- Removes files without valid database records
- Prevents storage bloat

### Custom Drive Scanner

- Optional service to sync external directory
- Watches for file changes and syncs to database

## Scalability Considerations

### Current Limitations

- Single server deployment
- File storage on local filesystem
- No load balancing

### Potential Improvements

- Object storage (S3, Azure Blob) for files
- Redis for session management
- CDN for static assets
- Horizontal scaling with load balancer
- Database read replicas

## Technology Choices

### Backend

- **Express.js**: Mature, flexible web framework
- **PostgreSQL**: Reliable relational database
- **JWT**: Stateless authentication
- **Multer**: File upload handling

### Frontend

- **React 19**: Modern UI library
- **TypeScript**: Type safety
- **Vite**: Fast build tool
- **Tailwind CSS**: Utility-first styling

### Integration

- **OnlyOffice**: Document editing capabilities
- **Google OAuth**: Social authentication option
