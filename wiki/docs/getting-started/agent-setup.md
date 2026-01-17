# Agent Setup

Setup guide for the TMA Cloud agent (`tma-agent`).

## Overview

The agent is a standalone Go binary that provides file system access for custom drives. It's required for custom drive functionality.

## Installation

1. Build or download the agent binary (`tma-agent`)

2. Make it executable:

   ```bash
   chmod +x tma-agent
   ```

## Configuration

1. Add drive paths to the agent:

   ```bash
   tma-agent add --path /mnt/storage
   tma-agent add --path /data/drive
   ```

2. Generate authentication token:

   ```bash
   tma-agent token --generate
   ```

3. Start the agent server:

   ```bash
   tma-agent start
   ```

## UI Configuration

1. Configure agent in Settings → Custom Drive Management:
   - Set agent URL (default: `http://localhost:8080` for local, `http://host.docker.internal:8080` for Docker)
   - Set agent token (from step 2 above)

2. Configure per-user custom drives in Settings → Users

## Docker Environment

When running in Docker, ensure the agent is accessible from the container:

- Use `host.docker.internal:8080` as the agent URL
- Configure `extra_hosts` in `docker-compose.yml` for Linux:

  ```yaml
  extra_hosts:
    - "host.docker.internal:host-gateway"
  ```

## Agent Features

- HTTP API for file operations
- Real-time file system watching
- Webhook notifications for file changes
- Streaming support for large files
- OS-level rename operations

## File Operations

All file operations on custom drives use the agent API:

- **Read:** Streams files directly without buffering
- **Write:** Streams uploads directly to destination
- **Rename:** Uses OS-level rename (instant, even for large files)
- **Delete:** Removes files and directories
- **List:** Enumerates directory contents

## Verification

Check agent status:

```bash
# List configured paths
tma-agent list

# Check agent health
curl http://localhost:8080/health
```

## Related Topics

- [Custom Drives](/guides/admin/custom-drives) - Custom drive configuration
- [Docker Setup](docker.md) - Docker deployment
