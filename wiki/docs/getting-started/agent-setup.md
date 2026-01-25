# Agent Setup

Setup guide for the TMA Cloud agent (`tma-agent`).

## Overview

The agent is a small Go binary that gives TMA Cloud access to custom drive paths on your host. **Custom drives do not work without the agent.**

## Quick Start (Recommended)

1. **Download binary**
   - Get the right binary from [GitHub Releases](https://github.com/TMA-Cloud/TMA/releases):
     - Linux: `tma-agent-linux-amd64`
     - Windows: `tma-agent-windows-amd64.exe`
     - macOS: `tma-agent-darwin-amd64`
   - On Linux/macOS:

     ```bash
     chmod +x ./tma-agent-linux-amd64
     ```

2. **Install agent**

   From the directory where you downloaded the file:

   ```bash
   # Linux/macOS
   ./tma-agent-linux-amd64 install

   # Windows (PowerShell)
   .\tma-agent-windows-amd64.exe install
   ```

   - Requires admin/root rights.
   - On Windows the agent is installed under Program Files and added to `PATH`.

3. **Add one or more base paths**

   ```bash
   tma-agent add --path /mnt/storage
   ```

   To remove a path later:

   ```bash
   tma-agent remove --path /mnt/storage
   ```

4. **Get or Generate a token**

   ```bash
   # Get existing token
   tma-agent token

   # Generate a new token
   tma-agent token --generate
   ```

5. **Start the agent**

   ```bash
   # Linux/macOS (as a service)
   sudo tma-agent service-start

   # Windows (PowerShell, as a service)
   Start-Service tma-agent

   # Manual/Interactive run (all platforms)
   tma-agent start
   ```

   - Default port: `8080`.
   - If no token is set, `start` generates one and saves it to `tma-agent.json`.
   - Use `tma-agent start` for manual/interactive testing (press Ctrl+C to stop).

6. **Configure custom drives in the app**
   - In **Settings → Custom Drive Management**:
     - **Bare metal:** `http://localhost:8080`
     - **Docker:** `http://host.docker.internal:8080`
   - Paste the token from step 4.
   - Set drive paths for the users who should use custom drives.

## Verify

Run these from the host where the agent is running:

```bash
# List configured drives
tma-agent list

# Check agent health
curl http://localhost:8080/health
```

## Service Management

### Check Service Status

```bash
# Windows (PowerShell)
Get-Service tma-agent

# Linux
systemctl status tma-agent

# macOS
sudo launchctl list | grep tma-agent
```

### Stop Service

```bash
# Linux/macOS
sudo tma-agent service-stop

# Windows (PowerShell)
Stop-Service tma-agent
```

### Update Agent

To update an installed agent:

```bash
# Download the new binary to a different folder
# Then run from that folder:
tma-agent update
```

- Requires admin/root rights.
- Auto stops the service, replaces the binary, and restarts the service.
- Preserves existing configuration.

### Uninstall Agent

```bash
tma-agent uninstall
```

**Note:** Requires admin/root rights.

## Related Topics

- [Agent Architecture](/concepts/architecture#agent-architecture) - Architecture and token flow
- [Custom Drives](/guides/admin/custom-drives) - Custom drive configuration
- [Docker Setup](docker.md) - Docker deployment with prebuilt images
- [GitHub Releases](https://github.com/TMA-Cloud/TMA/releases) - Download prebuilt agent binaries
- [tma-agent Repository](https://github.com/TMA-Cloud/TMA/tree/main/agent) - Agent source code
