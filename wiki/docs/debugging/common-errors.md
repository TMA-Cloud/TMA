# Common Errors

Frequently encountered errors and step-by-step diagnosis.

:::tip[How to read this page]
Each section lists the symptom, then a numbered checklist you can run top-to-bottom. Stop as soon as one step surfaces the cause — later steps assume earlier ones passed.
:::

## Database connection errors

### Symptom: "Database connection failed" on startup

1. **Is Postgres actually up?**

   ```bash
   pg_isready -h "$DB_HOST" -p "${DB_PORT:-5432}"
   ```

   If this fails, start Postgres (Docker users: `docker compose up -d postgres`) before continuing.

2. **Are the credentials in `.env` the ones Postgres actually expects?**

   ```bash
   psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME"
   ```

   If this prompts for a password and fails, `DB_PASSWORD` is wrong.

3. **Is the backend pointing at the right host?** Inside Docker Compose, the host is the service name (e.g. `postgres`), not `localhost`.

4. **Firewall / network.** If Postgres runs on another machine, confirm the port is reachable: `nc -zv $DB_HOST 5432`.

## Redis connection errors

### Symptom: "Redis connection failed"

:::note
The app runs without Redis — caching, rate limits, and the SSE event stream degrade, but uploads and downloads still work. If you don't need those features, you can ignore the error.
:::

1. **Is Redis running?** `redis-cli -h "$REDIS_HOST" -p "${REDIS_PORT:-6379}" ping` — should print `PONG`.
2. **Auth enabled?** If Redis requires a password, set `REDIS_PASSWORD` in `.env`.
3. **Right host in Docker?** Use the compose service name (`redis`), not `localhost`, from inside containers.

## Storage limit errors

### Symptom: "Storage limit exceeded"

1. **Check the user's quota in Settings → Storage.** If it's close to full, delete files or empty trash — trash counts toward quota.
2. **Is it the per-user quota or the disk?** If the backend host itself is out of disk (`df -h` shows 100%), no quota increase will help — free disk first.
3. **Admin override.** An admin can raise the limit for a specific user in **Settings → Registered Users**.

### Symptom: "This file is too large" on a single upload

The file exceeds the per-request max upload size (separate from storage quota).

1. **Admin → Settings → Storage → Max upload size.** Raise it if appropriate.
2. **Reverse proxy limits.** If you run nginx in front of the backend, `client_max_body_size` must also be raised — otherwise nginx rejects the request before it reaches the backend.
3. **Split the file** if you can't change the limits.

## Upload errors

### Symptom: "Upload failed" (generic)

1. **Check disk space** on the backend host: `df -h`.
2. **Check `UPLOAD_DIR` permissions** — the backend process must be able to write to it.
3. **Network stability** — retry once; transient drops cause this too.
4. **MIME detection failure** — very small or truncated files can fail magic-byte detection. Try re-exporting the file.

See [Upload Issues](upload-issues.md) for upload-specific problems.

## Authentication errors

### Symptom: "Invalid credentials"

1. **Confirm email + password** — passwords are case-sensitive.
2. **Is MFA enabled?** If yes, the login flow needs a TOTP code; a missing code surfaces as this error.
3. **Account disabled?** Admin can check **Settings → Registered Users**.
4. **Rate limit.** After 25 failed attempts in 15 minutes, further attempts are rejected until the window expires. Wait or reset from another network.

See [Auth Issues](auth-issues.md) for deeper auth troubleshooting.

## Related Topics

- [Auth Issues](auth-issues.md) - Authentication problems
- [Upload Issues](upload-issues.md) - Upload problems
- [API Errors](/api/errors) - Error codes
