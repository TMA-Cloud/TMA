# Setup & Installation Guide

This guide will walk you through setting up TMA Cloud on your local machine or server.

## Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js** (v25 or higher)
- **PostgreSQL** (v17 or higher)
- **npm** or **yarn** package manager

## Backend Setup

### 1. Install Backend Dependencies

```bash
cd backend
npm install
```

### 2. Configure Backend Environment Variables

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` with your configuration. See [Environment Variables](environment.md) for detailed information about each variable.

**Required variables:**

- `JWT_SECRET` - Secret key for JWT tokens
- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` - Database connection details
- `CLIENT_URL` - Frontend URL (e.g., `http://localhost:5173`)

**Optional variables:**

- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` - For Google OAuth
- `ONLYOFFICE_JWT_SECRET`, `BACKEND_URL` - For OnlyOffice integration
- `CUSTOM_DRIVE`, `CUSTOM_DRIVE_PATH` - For custom drive scanning

### 3. Create Database

Create a PostgreSQL database:

```sql
CREATE DATABASE cloud_storage;
```

The application will automatically run migrations on startup to create the necessary tables.

### 4. Start the Server

**Development mode:**

```bash
npm run dev
```

**Production mode:**

```bash
npm start
```

The server will start on the port specified in `BPORT` (default: 3000).

## Frontend Setup

### 1. Install Frontend Dependencies

```bash
cd frontend
npm install
```

### 2. Configure Frontend Environment Variables

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` with your configuration:

- `VITE_API_URL` - Backend API URL (e.g., `http://localhost:3000`)
- `ONLYOFFICE_JS_URL` - OnlyOffice Document Server JS URL (optional)

### 3. Start Development Server

```bash
npm run dev
```

The frontend will start on `http://localhost:5173` (or the next available port).

### 4. Build for Production

```bash
npm run build
```

The built files will be in the `dist` directory.

## Verification

1. **Backend**: Check that the server is running and database is connected
   - Look for "Server running on port 3000" and "Database connected successfully" messages

2. **Frontend**: Open `http://localhost:5173` in your browser
   - You should see the login/signup page

3. **Create an account**: Sign up with a new account to test the system

## Troubleshooting

### Database Connection Issues

- Verify PostgreSQL is running: `pg_isready`
- Check database credentials in `.env`
- Ensure the database exists: `psql -l`

### Port Already in Use

- Change `BPORT` in backend `.env` for a different backend port
- Change the frontend port by editing `vite.config.ts` or using `npm run dev -- --port 5174`

### Migration Errors

- Ensure the database user has CREATE TABLE permissions
- Check that the `migrations` table was created successfully
- Review migration files in `backend/migrations/` for SQL errors

### CORS Issues

- Verify `CLIENT_URL` in backend `.env` matches your frontend URL
- Check that CORS is properly configured in `backend/server.js`

## Next Steps

- Read the [Architecture Overview](architecture.md) to understand the system design
- Check [API Documentation](api.md) for available endpoints
- Review [Features](features.md) to learn about available functionality
