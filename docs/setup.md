# Setup & Installation Guide

This guide will walk you through setting up TMA Cloud on your local machine or server.

## Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js** (v25 or higher)
- **PostgreSQL** (v17 or higher)
- **npm** or **yarn** package manager

## Installation Steps

### 1. Clone the Repository

```bash
git clone https://github.com/TMA-Cloud/TMA.git
cd TMA
```

### 2. Backend Setup

#### Install Backend Dependencies

```bash
cd backend
npm install
```

#### Configure Backend Environment Variables

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` with your configuration. See [Environment Variables](environment.md) for detailed information about each variable.

**Required variables:**

- `JWT_SECRET` - Secret key for JWT tokens
- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` - Database connection details
- `BPORT` - Backend server port (default: 3000)
- `UPLOAD_DIR` - Directory to store uploaded files

**Optional variables:**

- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` - For Google OAuth
- `ONLYOFFICE_JWT_SECRET`, `ONLYOFFICE_URL`, `BACKEND_URL` - For OnlyOffice integration
- `CUSTOM_DRIVE`, `CUSTOM_DRIVE_PATH` - For custom drive scanning
- `STORAGE_LIMIT` - Per-user storage limit in bytes

#### Create Database

Create a PostgreSQL database:

```sql
CREATE DATABASE cloud_storage;
```

The application will automatically run migrations on startup to create the necessary tables.

### 3. Frontend Setup

#### Install Frontend Dependencies

```bash
cd ../frontend
npm install
```

#### Build for Production

```bash
npm run build
```

The built files will be in the `dist` directory and will be served by the backend.

**Note:** No frontend environment variables are needed! The frontend uses relative URLs and is served from the same origin as the backend (Single-Origin Architecture).

### 4. Start the Application

#### Production Mode (Recommended)

```bash
cd ../backend
npm start
```

Access the application at `http://localhost:3000` (or your configured BPORT).

The backend serves both:

- Frontend static files at `/`
- API endpoints at `/api/*` and `/s/*`

#### Development Mode (with Hot Reload)

For active development with frontend hot module replacement:

**Terminal 1 - Backend:**

```bash
cd backend
npm run dev
```

**Terminal 2 - Frontend Dev Server:**

```bash
cd frontend
npm run dev
```

Access at `http://localhost:5173`

The Vite dev server automatically proxies API requests to `http://localhost:3000`.

## Verification

### 1. Backend Health Check

When you start the backend, you should see:

- ✅ "Database connected successfully"
- ✅ "Database query test successful"
- ✅ "Server running on port 3000"

### 2. Frontend Access

Open your browser and navigate to:

- **Production**: `http://localhost:3000`
- **Development**: `http://localhost:5173`

You should see the login/signup page.

### 3. Create First Account

Sign up with a new account to test the system. The first user automatically becomes the admin and can control signup settings.

## Troubleshooting

### Database Connection Issues

- Verify PostgreSQL is running: `pg_isready`
- Check database credentials in `.env`
- Ensure the database exists: `psql -l`
- Verify the database user has CREATE TABLE permissions

### Port Already in Use

- Change `BPORT` in backend `.env` to use a different port
- In development, Vite will automatically use the next available port after 5173

### Migration Errors

- Ensure the database user has CREATE TABLE permissions
- Check that the `migrations` table was created successfully
- Review migration files in `backend/migrations/` for SQL errors
- Check backend console for specific error messages

### Frontend Build Errors

- Ensure all dependencies are installed: `npm install`
- Clear the build cache: `rm -rf dist node_modules/.vite`
- Reinstall dependencies: `npm install`
- Try building again: `npm run build`

### Google OAuth Issues

- Verify `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are correct
- Ensure `GOOGLE_REDIRECT_URI` is set to `http://YOUR_DOMAIN/api/google/callback`
- Check that the redirect URI matches exactly in Google Cloud Console
- Ensure your domain is authorized in Google Cloud Console

### OnlyOffice Integration Issues

- Verify `ONLYOFFICE_URL` points to your Document Server
- Ensure `ONLYOFFICE_JWT_SECRET` matches your Document Server configuration
- Check that the Document Server can reach your backend via `BACKEND_URL`
- Verify firewall rules allow communication between servers

## Next Steps

- Read the [Architecture Overview](architecture.md) to understand the system design
- Check [API Documentation](api.md) for available endpoints
- Review [Features](features.md) to learn about available functionality
- Configure [Environment Variables](environment.md) for your deployment
