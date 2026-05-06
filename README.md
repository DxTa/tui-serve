# Remote Agent TUI Manager

A lightweight system to remotely manage long-running coding-agent TUI sessions (Claude, Codex, Pi, etc.) running on Raspberry Pis. Browser-based terminal access with mobile PWA support, powered by tmux for persistent sessions.

## Quick Start (Development)

### Prerequisites

- Node.js 22 LTS
- tmux (`sudo apt install -y tmux`)
- build-essential, python3, make, g++ (for native modules: `sudo apt install -y build-essential python3 make g++`)

### Install & Run

```bash
# Backend — Terminal 1
cd server
cp .env.example .env                  # Set AUTH_TOKEN in .env
npm install
npm run dev

# Frontend — Terminal 2
cd web
npm install
npm run dev
```

Open **http://localhost:5173**, enter your auth token, create a session, and attach.

### Configuration

| Variable | Default | Description |
|---|---|---|
| `AUTH_TOKEN` | `dev-token-change-me` | Required auth token for all API and WebSocket calls |
| `PORT` | `3000` | Server listen port |

**Command allowlist** — Edit `server/default-config.json` to add/remove agent types:

```json
{
  "id": "pi",
  "label": "Pi Coding Agent",
  "command": "pi",
  "allowedCwdRoots": ["/home/pi", "/tmp"]
}
```

Clients send `commandId` (e.g., `"pi"`). The server resolves it to the actual command. Raw commands are never accepted from clients — this prevents RCE.

**CWD allowlist** — Each command has its own list of allowed working directories. The server also automatically adds `$HOME` to every command's allowed roots at startup.

## Architecture

```
Browser (xterm.js in React PWA)
    ⇅ WebSocket (binary I/O + JSON control) + REST over HTTPS
Node.js daemon (one per machine)
    ⇅ node-pty → tmux attach-session
    ⇅ tmux sessions (persistent — survive disconnects & server restarts)
    ⇐ SQLite (session metadata, reconciled on startup)
```

- **One daemon per machine** — no SSH complexity, no central gateway
- **tmux owns the agent process** — sessions survive browser disconnects and server restarts
- **node-pty bridges the current viewer only** — spawns `tmux attach-session`, not the agent
- **Binary WebSocket protocol** — `0x00` prefix for terminal I/O, `0x01` for control JSON
- **PWA is the mobile app** — no native wrappers needed

## API Reference

All REST endpoints require `Authorization: Bearer <token>`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Server health (no auth required) |
| `GET` | `/api/sessions` | List all sessions |
| `GET` | `/api/sessions/:id` | Get session details |
| `POST` | `/api/sessions` | Create session (`{commandId, cwd, title?, id?}`) |
| `PATCH` | `/api/sessions/:id` | Update session (title, restartPolicy) |
| `POST` | `/api/sessions/:id/kill` | Kill session (`{confirm: true}` required) |
| `POST` | `/api/sessions/:id/restart` | Restart stopped/crashed session |
| `DELETE` | `/api/sessions/:id` | Delete session from DB |
| `GET` | `/api/hosts` | List configured hosts |
| `GET` | `/api/commands` | List available command IDs |

WebSocket: connect to `/ws?token=<token>` — binary frames for terminal I/O, JSON for control.

## Deployment to Raspberry Pi

### Option 1: Automated Setup Script

```bash
# From your development machine:
./deploy/pi-setup.sh pi@raspberrypi your-secure-auth-token
```

This script:
1. Builds frontend and backend locally
2. Copies files to the Pi via rsync
3. Rebuilds native modules (node-pty, better-sqlite3) on ARM
4. Configures `.env` with your auth token
5. Installs and starts the systemd service

### Option 2: Manual Setup

```bash
# On the Pi:
git clone <your-repo> /opt/remote-agent-tui
cd /opt/remote-agent-tui/server
cp .env.example .env
# Edit .env — set AUTH_TOKEN to a secure random string!
npm install
npm run build

cd /opt/remote-agent-tui/web
npm install
npm run build

# Install systemd service
sudo cp /opt/remote-agent-tui/deploy/systemd/remote-agent-tui.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now remote-agent-tui

# Check status
sudo systemctl status remote-agent-tui
journalctl -u remote-agent-tui -f    # follow logs
```

### Configure Auth Token

```bash
# Create an override file (don't edit the installed unit directly)
sudo mkdir -p /etc/systemd/system/remote-agent-tui.service.d
sudo tee /etc/systemd/system/remote-agent-tui.service.d/override.conf << 'EOF'
[Service]
Environment=AUTH_TOKEN=your-secure-random-token-here
EOF
sudo systemctl daemon-reload
sudo systemctl restart remote-agent-tui
```

### Add HTTPS with Caddy

```bash
# Install Caddy
sudo apt install -y caddy

# Copy the config
sudo cp /opt/remote-agent-tui/deploy/caddy/Caddyfile /etc/caddy/Caddyfile

# Edit the Caddyfile to add your domain (for auto-HTTPS) or use Tailscale
sudo systemctl restart caddy
```

For **Tailscale HTTPS**: enable in the Tailscale admin console, then Caddy will auto-provision certificates.

### Adding Additional Agent Types

Edit `/opt/remote-agent-tui/server/default-config.json`:

```json
{
  "commands": [
    {
      "id": "pi",
      "label": "Pi Coding Agent",
      "command": "pi",
      "allowedCwdRoots": ["/home/pi", "/tmp"]
    },
    {
      "id": "claude",
      "label": "Claude Coding Agent",
      "command": "claude",
      "allowedCwdRoots": ["/home/pi/projects", "/home/pi/code", "/home/pi", "/tmp"]
    },
    {
      "id": "shell",
      "label": "Interactive Shell",
      "command": "bash",
      "allowedCwdRoots": ["/home/pi", "/tmp"],
      "requiresConfirmation": true
    }
  ],
  "hosts": [
    { "id": "local", "name": "This Machine", "address": "localhost", "port": 3000 }
  ]
}
```

Then restart: `sudo systemctl restart remote-agent-tui`

## Security

- **Auth required** — Bearer token on all endpoints and WebSocket connections
- **Command allowlist** — only pre-approved commands can be launched, by ID not by raw string
- **CWD allowlist** — working directories restricted to configured roots per command
- **`$HOME` auto-included** — the current user's home directory is always in the allowed roots at runtime
- **Input validation** — sessionId must match `^[a-z0-9][a-z0-9-]{0,63}$`
- **Kill requires confirmation** — `confirm: true` must be sent to prevent accidental kills
- **Tailscale/private network** — designed for private networks, not public internet
- **HTTPS** — use Caddy or Tailscale HTTPS for TLS

## Project Structure

```
remote-agent-tui/
  server/src/
    index.ts              # Fastify server entry + REST routes
    auth.ts               # Bearer token auth middleware
    config.ts             # Server config (env vars + defaults)
    protocol.ts           # WebSocket protocol types (binary + JSON)
    db.ts                 # SQLite session store (WAL mode, schema-on-startup)
    sessions.ts           # Session manager + state machine + reconciliation
    tmux.ts               # tmux CLI wrappers
    ptyBridge.ts          # node-pty bridge (primary) + polling fallback
    ws.ts                 # WebSocket handler (binary I/O, heartbeat, attach/detach)
    allowlist.ts          # Command + CWD validation
  web/src/
    App.tsx               # Main app (routing, auth)
    components/
      Dashboard.tsx      # Session list + create + kill
      TerminalView.tsx     # xterm.js terminal + controls
    lib/
      terminalSocket.ts   # WebSocket client (binary protocol, reconnect, heartbeat)
      apiClient.ts        # REST API client
      auth.ts             # Token management
      types.ts            # TypeScript type definitions
      pwa-utils.ts        # Wake-lock, visibility, connectivity helpers
  deploy/
    systemd/remote-agent-tui.service  # systemd unit file
    caddy/Caddyfile                   # HTTPS reverse proxy config
    pi-setup.sh                       # Automated Pi deployment script
```

## Troubleshooting

| Problem | Solution |
|---|---|
| `node-pty` build fails on Pi | `sudo apt install -y build-essential python3 make g++` then `npm rebuild` |
| tmux not found | `sudo apt install -y tmux` |
| Auth token rejected | Check `.env` file matches the token you enter in the browser |
| Session shows "stopped" after server restart | Normal — server reconciles with tmux on startup |
| Terminal blank after attach | Reload the page; check browser console for WebSocket errors |
| Can't create session in specific directory | Add the path to `allowedCwdRoots` in `default-config.json` |
| Port 3000 already in use | Change `PORT` in `.env` and restart |
| View logs | `journalctl -u remote-agent-tui -f` |