# Setup & Installation

Quick setup guide for TMA Cloud.

## Prerequisites

- Node.js (v25+)
- PostgreSQL (v17+)
- Redis (v6+) - Optional but recommended
- npm or yarn

## Installation

### 1. Clone Repository

```bash
git clone https://github.com/TMA-Cloud/TMA.git
cd TMA
```

### 2. Backend Setup

```bash
cd backend
npm install
cp ../.env.example ../.env
# Edit ../.env with your configuration
```

**Required variables:**

- `JWT_SECRET` - Secret key for JWT tokens
- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` - Database connection
- `REDIS_HOST`, `REDIS_PORT` - Redis connection (optional)
- `BPORT` - Backend port (default: 3000)
- `UPLOAD_DIR` - Upload directory

**Optional:**

- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` - Google OAuth
- `BACKEND_URL` - Public backend URL (for OnlyOffice)
- `STORAGE_LIMIT` - Per-user storage limit in bytes

### 3. Create Database

```sql
CREATE DATABASE cloud_storage;
```

Migrations run automatically on startup.

### 4. Setup Redis (Optional)

**Linux/macOS:**

```bash
# Ubuntu/Debian
sudo apt-get install redis-server

# macOS
brew install redis
brew services start redis

redis-server
```

**Windows:** Use Docker or WSL

**Verify:** `redis-cli ping` (should return PONG)

### 5. Frontend Setup

```bash
cd ../frontend
npm install
npm run build
```

### 6. Start Application

**Production:**

```bash
# Terminal 1 - Backend
cd backend
npm start

# Terminal 2 - Audit Worker (required)
cd backend
npm run worker
```

Access at `http://localhost:3000`

**Development:**

```bash
# Terminal 1 - Backend
cd backend
npm run dev

# Terminal 2 - Frontend
cd frontend
npm run dev
```

Access at `http://localhost:5173`

## Verification

1. Backend shows: "Database connected successfully", "Server running on port 3000"
2. Open browser: `http://localhost:3000` (production) or `http://localhost:5173` (development)
3. Create first account (becomes admin)

## Troubleshooting

**Database:** Verify PostgreSQL is running, check credentials in `.env`

**Redis:** Verify with `redis-cli ping`. App works without Redis but caching is disabled.

**Port:** Change `BPORT` in `.env` if port is in use

**OnlyOffice:** Configure via Settings page (admin-only). Requires `BACKEND_URL` environment variable.

**Audit Worker:** Must run `npm run worker` in production. See [Audit Documentation](audit.md).
