# Backups

Backup and restore procedures for TMA Cloud.

## What to Backup

- **Database:** PostgreSQL database (all schemas including `pgboss`)
- **Files:** Upload directory or S3 bucket contents
- **Configuration:** `.env` file

## Backup Script

TMA Cloud includes a backup/restore script at `scripts/db-backup-restore.sh`. It handles full PostgreSQL backups and restores through Docker or host-level `pg_dump`/`pg_restore`.

### How It Works

- Uses `pg_dump` with custom format (compressed binary, supports selective and parallel restore)
- Takes a `--serializable-deferrable` snapshot (consistent read without blocking writes)
- Verifies the dump with `pg_restore --list` immediately after creation
- Computes a SHA-256 checksum and writes a `.meta` sidecar file
- Records per-table row counts at backup time
- Auto-prunes old backups based on `BACKUP_RETAIN_COUNT` (default 10)

### Container Detection

The script auto-detects the PostgreSQL Docker container in this order:

1. `DB_CONTAINER` env var (explicit override)
2. `tma-cloud-postgres` (project docker-compose container name)
3. Any running container with a `postgres` image

If no container is found, it falls back to host PostgreSQL client tools.

## Database Backup

### Create a Backup

```bash
./scripts/db-backup-restore.sh backup
```

Output is saved to `backups/<DB_NAME>_<TIMESTAMP>.dump` with a `.meta` file alongside it.

### Example Output

```code
── Full Database Backup ──
[INFO]  Connected to 'tma_cloud_storage' via Docker container 'tma-cloud-postgres'
[INFO]  Database   : tma_cloud_storage
[INFO]  Collecting table statistics …
[INFO]  Running pg_dump (custom format, serializable snapshot) …
[INFO]  Verifying backup integrity (pg_restore --list) …
[OK]    Backup contains 145 TOC entries.
[INFO]  Computing SHA-256 checksum …

── Backup Complete ──
[OK]    File       : backups/tma_cloud_storage_20260115T020000Z.dump
[OK]    Size       : 12M
[OK]    Duration   : 4s
[OK]    TOC entries: 145
[OK]    SHA-256    : a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2
```

### Metadata File

Each backup has a `.meta` file with:

```code
timestamp=20260115T020000Z
database=tma_cloud_storage
user=postgres
mode=docker
format=custom
compression=--compress=6
toc_entries=145
file_size=12M
duration_seconds=4
sha256=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2

# Table row counts at backup time
public.users=5
public.files=218
public.audit_log=1340
pgboss.job_common=64
```

## Database Restore

### Restore from Backup

```bash
./scripts/db-backup-restore.sh restore backups/tma_cloud_storage_20260115T020000Z.dump
```

The restore process:

1. Validates the backup file (SHA-256 checksum + TOC inspection) before touching the database
2. Asks for confirmation by typing the database name
3. Terminates active connections to the database
4. Drops and recreates the database
5. Restores in `--single-transaction` mode (atomic — rolls back entirely on error)
6. Runs `ANALYZE` to update query planner statistics
7. Reports table and row counts for verification

## Verify a Backup

```bash
./scripts/db-backup-restore.sh verify backups/tma_cloud_storage_20260115T020000Z.dump
```

Checks the SHA-256 checksum against the `.meta` file and inspects the dump TOC without restoring.

## List Backups

```bash
./scripts/db-backup-restore.sh list
```

Lists all `.dump` files in the `backups/` directory with file size and date.

## Configuration

The script reads `.env` from the project root. Relevant variables:

| Variable              | Default             | Description                              |
| --------------------- | ------------------- | ---------------------------------------- |
| `DB_HOST`             | `localhost`         | PostgreSQL host                          |
| `DB_PORT`             | `5432`              | PostgreSQL port                          |
| `DB_USER`             | `postgres`          | Database username                        |
| `DB_PASSWORD`         | -                   | Database password                        |
| `DB_NAME`             | `tma_cloud_storage` | Database name                            |
| `DB_CONTAINER`        | auto-detected       | Docker container name override           |
| `BACKUP_RETAIN_COUNT` | `10`                | Number of backups to keep before pruning |

## File Backups

The backup script only covers the PostgreSQL database. It does **not** back up uploaded files or folders.

You must back up file storage separately:

### Upload Directory (local)

Back up the `UPLOAD_DIR` directory (default `./uploads`). Preserve the full directory structure.

```bash
tar -czf uploads_backup_$(date +%Y%m%d).tar.gz uploads/
```

### S3-compatible (when STORAGE_DRIVER=s3)

Use your storage vendor's replication or snapshot tools. The application stores object keys in the database; the bucket holds the blobs. Both must be backed up together to stay in sync.

## Backup Schedule

Recommended cron schedule for automated backups:

```bash
# Daily database backup at 02:00 UTC
0 2 * * * cd /path/to/cloud_sol && ./scripts/db-backup-restore.sh backup >> /var/log/tma-backup.log 2>&1
```

## Related Topics

- [Database Schema](/reference/database-schema) - Table structure
- [Environment Variables](/reference/environment-variables) - Full variable reference
- [CLI Commands](/reference/cli-commands) - All available commands
- [Storage Management](/concepts/storage-management) - Storage overview
