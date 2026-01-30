# Backups

Backup strategies for TMA Cloud.

## Backup Overview

### What to Backup

- **Database:** PostgreSQL database
- **Files:** Upload directory contents
- **Configuration:** Environment variables

## Database Backups

### PostgreSQL Backup

```bash
# Full backup
pg_dump -h localhost -U postgres cloud_storage > backup.sql

# Restore
psql -h localhost -U postgres cloud_storage < backup.sql
```

### Automated Backups

- Schedule regular backups
- Store backups securely
- Test restore procedures

## File Backups

### Upload Directory

- Backup `UPLOAD_DIR` directory
- Preserve file structure
- Include all user files

## Backup Strategies

### Full Backups

- Complete system backup
- Database + files
- Regular schedule

### Incremental Backups

- Only changed data
- Faster backup process
- Requires full backup base

### Backup Storage

- Off-site storage
- Multiple copies
- Encrypted backups

## Restore Procedures

### Database Restore

1. Stop application
2. Restore database
3. Verify data
4. Start application

### File Restore

1. Stop application
2. Restore files
3. Verify permissions
4. Start application

## Best Practices

- Regular backup schedule
- Test restore procedures
- Store backups securely
- Monitor backup success
- Document restore procedures

## Related Topics

- [Database Schema](/reference/database-schema) - Database structure
- [Storage Management](/concepts/storage-management) - Storage overview
