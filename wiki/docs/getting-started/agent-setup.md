# Agent Setup

Setup guide for the TMA Cloud agent (`tma-agent`).

## Overview

The agent is a standalone Go binary that provides file system access for custom drives. **The agent is required for custom drive functionality in both bare metal and Docker setups.**

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

## Agent Commands

### `add` - Add Drive Path

```bash
tma-agent add --path <absolute_path>
```

- `--path` (required): Absolute path to directory
- Path must exist and be a directory

**Examples:**

```bash
tma-agent add --path /mnt/nas_drive
tma-agent add --path C:/Users/username/my_drive
```

### `list` - List Configured Paths

```bash
tma-agent list
```

### `remove` - Remove Drive Path

```bash
tma-agent remove --path <absolute_path>
```

### `token` - Manage Authentication Token

```bash
tma-agent token [--generate]
```

- `--generate`: Generate new token (shows existing if omitted)

### `start` - Start Agent Server

```bash
tma-agent start [--port <port>] [--token <token>]
```

- `--port`: Port to listen on (default: `8080`)
- `--token`: Authentication token (overrides saved token)

## UI Configuration

1. Configure agent in Settings → Custom Drive Management:
   - Set agent URL:
     - **Bare Metal Setup:** `http://localhost:8080`
     - **Docker Setup:** `http://host.docker.internal:8080`
   - Set agent token (from step 2 above)

2. Configure per-user custom drives in Settings → Users

## Setup-Specific Configuration

### Bare Metal Setup

When running on bare metal (without Docker):

- Agent runs on the same host as the application
- Use `http://localhost:8080` as the agent URL
- Agent must be started before using custom drives

### Docker Setup

When running in Docker, ensure the agent is accessible from the container:

- Agent runs on the Docker host (not inside containers)
- Use `http://host.docker.internal:8080` as the agent URL
- Configure `extra_hosts` in `docker-compose.yml` for Linux:

  ```yaml
  extra_hosts:
    - "host.docker.internal:host-gateway"
  ```

**Note:** The agent must be running on the host system before starting Docker containers.

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
