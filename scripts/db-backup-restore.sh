#!/usr/bin/env bash
# ============================================================
#  TMA Cloud – PostgreSQL Full Backup & Restore
# ============================================================
#  Usage:
#    scripts/db-backup-restore.sh backup                  Full DB backup
#    scripts/db-backup-restore.sh restore <file>          Restore from backup
#    scripts/db-backup-restore.sh verify  <file>          Verify backup integrity
#    scripts/db-backup-restore.sh list                    List available backups
#
#  Environment:
#    Reads .env from project root automatically.
#    Override with: DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
#
#  Backup retention:
#    Set BACKUP_RETAIN_COUNT (default 10) to auto-prune old backups.
# ============================================================

set -euo pipefail

# ── Colours & helpers ────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
die()     { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }
header()  { echo -e "\n${BOLD}── $* ──${NC}"; }

# ── Paths ────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BACKUP_DIR="${PROJECT_ROOT}/backups"
LOCK_FILE="${BACKUP_DIR}/.db-operation.lock"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# ── Load .env from project root ─────────────────────────────
if [[ -f "${PROJECT_ROOT}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${PROJECT_ROOT}/.env"
  set +a
  info "Loaded .env from ${PROJECT_ROOT}/.env"
fi

# ── Database config ──────────────────────────────────────────
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-postgres}"
DB_PASSWORD="${DB_PASSWORD:-}"
DB_NAME="${DB_NAME:-tma_cloud_storage}"
BACKUP_RETAIN_COUNT="${BACKUP_RETAIN_COUNT:-10}"

# ── Detect Docker vs host mode ───────────────────────────────
# Container lookup order:
#   1. DB_CONTAINER env var (explicit override)
#   2. tma-cloud-postgres  (this project's docker-compose)
#   3. Any running container whose image contains "postgres"
USE_DOCKER=false
CONTAINER_NAME="${DB_CONTAINER:-}"

find_postgres_container() {
  # Try the project's own container name first
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^tma-cloud-postgres$"; then
    echo "tma-cloud-postgres"
    return
  fi
  # Fall back: find any running container with a postgres image
  docker ps --format '{{.Names}}\t{{.Image}}' 2>/dev/null \
    | grep -i postgres \
    | head -n1 \
    | cut -f1
}

if [[ -n "${CONTAINER_NAME}" ]]; then
  # Explicit override — verify it exists
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER_NAME}$"; then
    USE_DOCKER=true
  else
    die "DB_CONTAINER='${CONTAINER_NAME}' is set but no running container with that name was found."
  fi
else
  CONTAINER_NAME=$(find_postgres_container)
  if [[ -n "${CONTAINER_NAME}" ]]; then
    USE_DOCKER=true
  fi
fi

# Wrappers: run pg commands either via docker or host
pg_exec() {
  if ${USE_DOCKER}; then
    docker exec -e PGPASSWORD="${DB_PASSWORD}" "${CONTAINER_NAME}" "$@"
  else
    PGPASSWORD="${DB_PASSWORD}" "$@"
  fi
}

pg_exec_stdin() {
  if ${USE_DOCKER}; then
    docker exec -i -e PGPASSWORD="${DB_PASSWORD}" "${CONTAINER_NAME}" "$@"
  else
    PGPASSWORD="${DB_PASSWORD}" "$@"
  fi
}

# ── Pre-flight checks ───────────────────────────────────────
preflight() {
  if ! ${USE_DOCKER}; then
    command -v pg_dump    >/dev/null 2>&1 || die "pg_dump not found. Install PostgreSQL client tools or start the Docker container."
    command -v pg_restore >/dev/null 2>&1 || die "pg_restore not found. Install PostgreSQL client tools or start the Docker container."
    command -v psql       >/dev/null 2>&1 || die "psql not found. Install PostgreSQL client tools."
  fi

  # Verify DB connectivity
  pg_exec psql -U "${DB_USER}" -d "${DB_NAME}" -c "SELECT 1;" >/dev/null 2>&1 \
    || die "Cannot connect to database '${DB_NAME}'. Is PostgreSQL running?"

  if ${USE_DOCKER}; then
    info "Connected to '${DB_NAME}' via Docker container '${CONTAINER_NAME}'"
  else
    info "Connected to '${DB_NAME}' on ${DB_HOST}:${DB_PORT} (host mode)"
  fi
}

# ── Locking (prevent concurrent backup / restore) ───────────
acquire_lock() {
  mkdir -p "${BACKUP_DIR}"
  if [[ -f "${LOCK_FILE}" ]]; then
    local pid
    pid=$(<"${LOCK_FILE}")
    if kill -0 "${pid}" 2>/dev/null; then
      die "Another backup/restore operation is running (PID ${pid}). If stale, remove ${LOCK_FILE}"
    else
      warn "Removing stale lock file (PID ${pid} is gone)"
      rm -f "${LOCK_FILE}"
    fi
  fi
  echo $$ > "${LOCK_FILE}"
}

release_lock() {
  rm -f "${LOCK_FILE}"
}

# Cleanup on exit / error
cleanup() {
  release_lock
}
trap cleanup EXIT

# ── SHA-256 checksum helper ──────────────────────────────────
compute_sha256() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${file}" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "${file}" | awk '{print $1}'
  else
    warn "No sha256sum/shasum found. Skipping checksum."
    echo "n/a"
  fi
}

# ============================================================
#  BACKUP
# ============================================================
do_backup() {
  header "Full Database Backup"
  warn "This backs up the PostgreSQL database only."
  warn "Uploaded files/folders are NOT included. Back them up separately."
  echo ""

  preflight
  acquire_lock
  mkdir -p "${BACKUP_DIR}"

  local dump_file="${BACKUP_DIR}/${DB_NAME}_${TIMESTAMP}.dump"
  local meta_file="${dump_file}.meta"

  info "Database   : ${DB_NAME}"
  info "User       : ${DB_USER}"
  info "Container  : $(${USE_DOCKER} && echo "${CONTAINER_NAME}" || echo 'n/a (host)')"
  info "Output     : ${dump_file}"
  echo ""

  # ── Capture pre-backup stats (row counts per table) ──
  info "Collecting table statistics …"
  local table_stats
  table_stats=$(pg_exec psql -U "${DB_USER}" -d "${DB_NAME}" -t -A -c "
    SELECT schemaname || '.' || relname || '=' || n_live_tup
    FROM   pg_stat_user_tables
    ORDER  BY schemaname, relname;
  " 2>/dev/null || echo "")

  # ── pg_dump: custom format ──
  #   --format=custom    : compressed binary, supports parallel restore & selective restore
  #   --compress=zstd:6  : zstandard compression (PG16+), falls back to gzip if unavailable
  #   --lock-wait-timeout: don't hang if a table is locked
  #   --no-owner/privs   : portable across environments
  #   --serializable-deferrable : consistent snapshot WITHOUT blocking concurrent writes
  info "Running pg_dump (custom format, serializable snapshot) …"

  local dump_start
  dump_start=$(date +%s)

  # Try zstd compression first (PG16+), fall back to gzip-level 6
  local compress_flag="--compress=6"
  if pg_exec pg_dump --help 2>/dev/null | grep -q "zstd"; then
    compress_flag="--compress=zstd:6"
  fi

  if ${USE_DOCKER}; then
    docker exec -e PGPASSWORD="${DB_PASSWORD}" "${CONTAINER_NAME}" \
      pg_dump \
        -U "${DB_USER}" \
        -d "${DB_NAME}" \
        --format=custom \
        ${compress_flag} \
        --lock-wait-timeout=15000 \
        --no-owner \
        --no-privileges \
        --serializable-deferrable \
      > "${dump_file}"
  else
    PGPASSWORD="${DB_PASSWORD}" pg_dump \
      -h "${DB_HOST}" \
      -p "${DB_PORT}" \
      -U "${DB_USER}" \
      -d "${DB_NAME}" \
      --format=custom \
      ${compress_flag} \
      --lock-wait-timeout=15000 \
      --no-owner \
      --no-privileges \
      --serializable-deferrable \
      -f "${dump_file}"
  fi

  local dump_end elapsed
  dump_end=$(date +%s)
  elapsed=$((dump_end - dump_start))

  [[ -s "${dump_file}" ]] || die "Backup file is empty – pg_dump may have failed."

  # ── Verify dump is readable ──
  info "Verifying backup integrity (pg_restore --list) …"
  local toc_count
  if ${USE_DOCKER}; then
    toc_count=$(docker exec -i -e PGPASSWORD="${DB_PASSWORD}" "${CONTAINER_NAME}" \
      pg_restore --list < "${dump_file}" 2>/dev/null | wc -l)
  else
    toc_count=$(pg_restore --list "${dump_file}" 2>/dev/null | wc -l)
  fi

  if [[ "${toc_count}" -lt 1 ]]; then
    die "Backup verification failed – pg_restore cannot read the dump."
  fi
  success "Backup contains ${toc_count} TOC entries."

  # ── SHA-256 checksum ──
  info "Computing SHA-256 checksum …"
  local checksum
  checksum=$(compute_sha256 "${dump_file}")

  # ── Write metadata file ──
  local file_size
  file_size=$(du -sh "${dump_file}" | cut -f1)

  cat > "${meta_file}" <<METAEOF
# TMA Cloud Backup Metadata
timestamp=${TIMESTAMP}
database=${DB_NAME}
user=${DB_USER}
mode=$(${USE_DOCKER} && echo 'docker' || echo 'host')
format=custom
compression=${compress_flag}
toc_entries=${toc_count}
file_size=${file_size}
duration_seconds=${elapsed}
sha256=${checksum}

# Table row counts at backup time
${table_stats}
METAEOF

  # ── Prune old backups ──
  prune_old_backups

  # ── Summary ──
  header "Backup Complete"
  success "File       : ${dump_file}"
  success "Size       : ${file_size}"
  success "Duration   : ${elapsed}s"
  success "TOC entries: ${toc_count}"
  success "SHA-256    : ${checksum}"
  success "Metadata   : ${meta_file}"
  echo ""
}

# ============================================================
#  RESTORE
# ============================================================
do_restore() {
  local backup_file="${1:-}"

  [[ -z "${backup_file}" ]] && die "Usage: $0 restore <backup-file>"

  # Resolve relative paths from project root
  if [[ ! -f "${backup_file}" ]] && [[ -f "${PROJECT_ROOT}/${backup_file}" ]]; then
    backup_file="${PROJECT_ROOT}/${backup_file}"
  fi
  [[ -f "${backup_file}" ]] || die "File not found: ${backup_file}"

  header "Database Restore"

  preflight
  acquire_lock

  info "Database   : ${DB_NAME}"
  info "User       : ${DB_USER}"
  info "Source     : ${backup_file}"
  info "Container  : $(${USE_DOCKER} && echo "${CONTAINER_NAME}" || echo 'n/a (host)')"
  echo ""

  # ── Verify backup file before touching the database ──
  info "Verifying backup file integrity …"

  # Check SHA-256 if .meta file exists
  local meta_file="${backup_file}.meta"
  if [[ -f "${meta_file}" ]]; then
    local stored_hash current_hash
    stored_hash=$(grep "^sha256=" "${meta_file}" | cut -d= -f2)
    current_hash=$(compute_sha256 "${backup_file}")
    if [[ -n "${stored_hash}" && "${stored_hash}" != "n/a" ]]; then
      if [[ "${current_hash}" == "${stored_hash}" ]]; then
        success "SHA-256 checksum matches."
      else
        die "SHA-256 MISMATCH! Backup file may be corrupted.\n  Expected: ${stored_hash}\n  Got:      ${current_hash}"
      fi
    fi
  fi

  # Verify dump is readable
  local toc_count
  if ${USE_DOCKER}; then
    toc_count=$(docker exec -i -e PGPASSWORD="${DB_PASSWORD}" "${CONTAINER_NAME}" \
      pg_restore --list < "${backup_file}" 2>/dev/null | wc -l)
  else
    toc_count=$(pg_restore --list "${backup_file}" 2>/dev/null | wc -l)
  fi

  if [[ "${toc_count}" -lt 1 ]]; then
    die "Cannot read backup file – it may be corrupt or not in custom format."
  fi
  success "Backup is valid (${toc_count} TOC entries)."
  echo ""

  # ── Confirmation ──
  warn "This will DROP and RECREATE the database '${DB_NAME}'."
  warn "ALL existing data will be permanently lost."
  echo ""
  read -rp "Type the database name to confirm: " confirm
  [[ "${confirm}" == "${DB_NAME}" ]] || { info "Restore cancelled."; exit 0; }
  echo ""

  local restore_start
  restore_start=$(date +%s)

  # ── Step 1: Terminate all connections ──
  info "Terminating active connections to '${DB_NAME}' …"
  pg_exec psql -U "${DB_USER}" -d postgres -c "
    SELECT pg_terminate_backend(pid)
    FROM   pg_stat_activity
    WHERE  datname = '${DB_NAME}'
      AND  pid <> pg_backend_pid();
  " >/dev/null 2>&1 || true

  # ── Step 2: Drop and recreate the database ──
  info "Dropping database '${DB_NAME}' …"
  pg_exec psql -U "${DB_USER}" -d postgres -c \
    "DROP DATABASE IF EXISTS \"${DB_NAME}\";" >/dev/null

  info "Creating fresh database '${DB_NAME}' …"
  pg_exec psql -U "${DB_USER}" -d postgres -c \
    "CREATE DATABASE \"${DB_NAME}\" OWNER \"${DB_USER}\" ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0;" >/dev/null

  # ── Step 3: Restore with pg_restore ──
  #   --single-transaction : all-or-nothing — rolls back on any error
  #   --no-owner/privs     : portable
  #   --exit-on-error      : stop immediately on first error
  info "Restoring from backup (single-transaction mode) …"

  local restore_exit=0
  if ${USE_DOCKER}; then
    docker exec -i -e PGPASSWORD="${DB_PASSWORD}" "${CONTAINER_NAME}" \
      pg_restore \
        -U "${DB_USER}" \
        -d "${DB_NAME}" \
        --single-transaction \
        --no-owner \
        --no-privileges \
        --exit-on-error \
      < "${backup_file}" || restore_exit=$?
  else
    PGPASSWORD="${DB_PASSWORD}" pg_restore \
      -h "${DB_HOST}" \
      -p "${DB_PORT}" \
      -U "${DB_USER}" \
      -d "${DB_NAME}" \
      --single-transaction \
      --no-owner \
      --no-privileges \
      --exit-on-error \
      "${backup_file}" || restore_exit=$?
  fi

  if [[ ${restore_exit} -ne 0 ]]; then
    die "pg_restore exited with code ${restore_exit}. The restore was rolled back (single-transaction mode)."
  fi

  local restore_end elapsed
  restore_end=$(date +%s)
  elapsed=$((restore_end - restore_start))

  # ── Step 4: Post-restore verification ──
  info "Running post-restore verification …"

  # Check table count
  local restored_tables
  restored_tables=$(pg_exec psql -U "${DB_USER}" -d "${DB_NAME}" -t -A -c "
    SELECT count(*) FROM information_schema.tables
    WHERE  table_schema NOT IN ('pg_catalog', 'information_schema');
  " 2>/dev/null | tr -d '[:space:]')

  # Check row counts
  local restored_rows
  restored_rows=$(pg_exec psql -U "${DB_USER}" -d "${DB_NAME}" -t -A -c "
    SELECT coalesce(sum(n_live_tup), 0)
    FROM   pg_stat_user_tables;
  " 2>/dev/null | tr -d '[:space:]')

  # Run ANALYZE to update planner statistics after bulk load
  info "Running ANALYZE to update query planner statistics …"
  pg_exec psql -U "${DB_USER}" -d "${DB_NAME}" -c "ANALYZE;" >/dev/null 2>&1

  # ── Summary ──
  header "Restore Complete"
  success "Database   : ${DB_NAME}"
  success "Tables     : ${restored_tables}"
  success "Rows (est) : ${restored_rows}"
  success "Duration   : ${elapsed}s"
  echo ""
  info "Restart the application to refresh connection pools."
}

# ============================================================
#  VERIFY
# ============================================================
do_verify() {
  local backup_file="${1:-}"

  [[ -z "${backup_file}" ]] && die "Usage: $0 verify <backup-file>"

  if [[ ! -f "${backup_file}" ]] && [[ -f "${PROJECT_ROOT}/${backup_file}" ]]; then
    backup_file="${PROJECT_ROOT}/${backup_file}"
  fi
  [[ -f "${backup_file}" ]] || die "File not found: ${backup_file}"

  header "Backup Verification"
  info "File: ${backup_file}"
  echo ""

  # ── SHA-256 check ──
  local meta_file="${backup_file}.meta"
  if [[ -f "${meta_file}" ]]; then
    local stored_hash current_hash
    stored_hash=$(grep "^sha256=" "${meta_file}" | cut -d= -f2)
    current_hash=$(compute_sha256 "${backup_file}")

    if [[ -n "${stored_hash}" && "${stored_hash}" != "n/a" ]]; then
      if [[ "${current_hash}" == "${stored_hash}" ]]; then
        success "SHA-256 checksum PASSED"
      else
        die "SHA-256 checksum FAILED\n  Expected: ${stored_hash}\n  Got:      ${current_hash}"
      fi
    else
      warn "No checksum stored in metadata."
    fi

    echo ""
    info "Metadata:"
    grep -v "^#" "${meta_file}" | grep -v "^$" | while IFS= read -r line; do
      echo "  ${line}"
    done
    echo ""
  else
    warn "No .meta file found – SHA-256 check skipped."
  fi

  # ── pg_restore --list ──
  info "Inspecting dump TOC …"
  local toc_count
  if ${USE_DOCKER}; then
    toc_count=$(docker exec -i -e PGPASSWORD="${DB_PASSWORD}" "${CONTAINER_NAME}" \
      pg_restore --list < "${backup_file}" 2>/dev/null | wc -l)
  else
    if command -v pg_restore >/dev/null 2>&1; then
      toc_count=$(pg_restore --list "${backup_file}" 2>/dev/null | wc -l)
    else
      warn "pg_restore not available on host – cannot inspect TOC."
      return
    fi
  fi

  if [[ "${toc_count}" -gt 0 ]]; then
    success "Dump is readable: ${toc_count} TOC entries"
  else
    die "Dump appears corrupt or empty."
  fi

  local file_size
  file_size=$(du -sh "${backup_file}" | cut -f1)
  success "File size: ${file_size}"
  echo ""
}

# ============================================================
#  LIST
# ============================================================
do_list() {
  header "Available Backups"

  if [[ ! -d "${BACKUP_DIR}" ]] || [[ -z "$(ls -A "${BACKUP_DIR}" 2>/dev/null)" ]]; then
    warn "No backups found in ${BACKUP_DIR}"
    return
  fi

  printf "  %-55s  %8s  %s\n" "FILENAME" "SIZE" "DATE"
  printf "  %-55s  %8s  %s\n" "$(printf '%.0s─' {1..55})" "────────" "───────────────────"

  for f in "${BACKUP_DIR}"/*.dump; do
    [[ -f "${f}" ]] || continue
    local name size date_mod
    name="$(basename "${f}")"
    size="$(du -sh "${f}" | cut -f1)"
    date_mod="$(date -r "${f}" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || stat -c '%y' "${f}" 2>/dev/null | cut -d. -f1)"
    printf "  %-55s  %8s  %s\n" "${name}" "${size}" "${date_mod}"
  done
  echo ""
}

# ============================================================
#  PRUNE OLD BACKUPS
# ============================================================
prune_old_backups() {
  local count
  count=$(find "${BACKUP_DIR}" -maxdepth 1 -name "*.dump" -type f 2>/dev/null | wc -l)

  if [[ "${count}" -le "${BACKUP_RETAIN_COUNT}" ]]; then
    return
  fi

  local to_remove=$((count - BACKUP_RETAIN_COUNT))
  info "Pruning ${to_remove} old backup(s) (retaining last ${BACKUP_RETAIN_COUNT}) …"

  # Sort by name (which embeds the timestamp) and remove oldest
  find "${BACKUP_DIR}" -maxdepth 1 -name "*.dump" -type f -print0 \
    | sort -z \
    | head -z -n "${to_remove}" \
    | while IFS= read -r -d '' old_file; do
        rm -f "${old_file}" "${old_file}.meta"
        info "  Removed: $(basename "${old_file}")"
      done
}

# ============================================================
#  USAGE
# ============================================================
usage() {
  cat <<'USAGE'

TMA Cloud – Database Backup & Restore

Usage:
  scripts/db-backup-restore.sh backup                  Create a full database backup
  scripts/db-backup-restore.sh restore <backup-file>   Restore database from a backup
  scripts/db-backup-restore.sh verify  <backup-file>   Verify a backup file's integrity
  scripts/db-backup-restore.sh list                    List available backups

Backup strategy:
  - Uses pg_dump custom format (compressed, supports selective & parallel restore)
  - Serializable-deferrable snapshot (consistent without blocking writes)
  - SHA-256 checksum + metadata file alongside each backup
  - Verified with pg_restore --list immediately after creation
  - Automatic rotation: keeps the last BACKUP_RETAIN_COUNT (default 10)

Restore strategy:
  - Validates backup integrity (checksum + TOC) BEFORE touching the database
  - Drops and recreates the database for a clean slate
  - Restores in --single-transaction mode (atomic: all-or-nothing)
  - Runs ANALYZE after restore to update query planner statistics
  - Reports table/row counts for verification

Environment variables (auto-loaded from .env):
  DB_HOST               default: localhost
  DB_PORT               default: 5432
  DB_USER               default: postgres
  DB_PASSWORD            (required)
  DB_NAME               default: tma_cloud_storage
  DB_CONTAINER          override Docker container name (auto-detected if unset)
  BACKUP_RETAIN_COUNT   default: 10

USAGE
}

# ============================================================
#  MAIN
# ============================================================
case "${1:-}" in
  backup)  do_backup ;;
  restore) do_restore "${2:-}" ;;
  verify)  do_verify  "${2:-}" ;;
  list)    do_list ;;
  -h|--help|help) usage ;;
  *)       usage ;;
esac
