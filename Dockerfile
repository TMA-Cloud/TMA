# =============================================================================
# Production Dockerfile for TMA Cloud
# =============================================================================
# Multi-stage Dockerfile that builds both frontend and backend into a single
# production-ready image.
#
# Build:
#   docker build -t tma-cloud:latest .
#
# Run:
#   docker run -p 3000:3000 -e DB_HOST=postgres -e DB_USER=user ... tma-cloud:latest
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Build Frontend (React + Vite)
# -----------------------------------------------------------------------------
FROM node:25-alpine AS frontend-builder

# Set working directory
WORKDIR /app/frontend

# Copy package files first for better layer caching
COPY frontend/package*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci && \
    npm cache clean --force

# Copy frontend source code
COPY frontend/ ./

# Build frontend for production
# This creates optimized static files in frontend/dist/
RUN npm run build

# -----------------------------------------------------------------------------
# Stage 2: Install Backend Dependencies
# -----------------------------------------------------------------------------
FROM node:25-alpine AS backend-builder

WORKDIR /app/backend

# Copy package files
COPY backend/package*.json ./

# Install only production dependencies
RUN npm ci --only=production && \
    npm cache clean --force

# -----------------------------------------------------------------------------
# Stage 3: Production Image
# -----------------------------------------------------------------------------
FROM node:25-alpine AS production

# Build argument for version (passed from Makefile)
ARG VERSION

# Add metadata labels
LABEL maintainer="ZIDAN44"
LABEL description="TMA Cloud"
LABEL version="${VERSION}"

# Install system dependencies
RUN apk add --no-cache \
    dumb-init \
    curl \
    && rm -rf /var/cache/apk/*

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Set working directory
WORKDIR /app

# Copy backend dependencies from builder stage
COPY --from=backend-builder --chown=nodejs:nodejs /app/backend/node_modules ./backend/node_modules

# Copy backend source code
COPY --chown=nodejs:nodejs backend/ ./backend/

# Copy built frontend static files
COPY --from=frontend-builder --chown=nodejs:nodejs /app/frontend/dist ./frontend/dist

# Copy database migrations
COPY --chown=nodejs:nodejs backend/migrations ./backend/migrations

# Create uploads directory with proper permissions
RUN mkdir -p /app/uploads && \
    chown -R nodejs:nodejs /app/uploads

# Set production environment
ENV NODE_ENV=production

# Switch to non-root user for security
USER nodejs

# Expose the application port
EXPOSE 3000

# Health check configuration
# Checks the /health endpoint every 30 seconds
# Start period allows time for application to initialize
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]

# Start the server
CMD ["node", "backend/server.js"]
