# Remote Agent TUI Manager

A lightweight system to remotely manage long-running coding-agent TUI sessions (Claude, Codex, Pi, etc.) running on Raspberry Pis or other developer machines. Browser-based terminal access with mobile PWA support, powered by tmux for persistent sessions.

## Installation (Production)

Recommended production model: **one Node/Fastify daemon serves API, WebSocket, and built frontend assets on one port**. Caddy/nginx are optional for HTTPS or public reverse proxy only; local/LAN/Tailscale installs can connect directly to the daemon.

### Supported Targets

| Target | Status | Autostart |
|---|---|---|
| Raspberry Pi OS / Debian / Ubuntu | Supported | systemd recommended |
| Ubuntu in WSL2 | Supported for local use | systemd only if enabled in WSL; otherwise manual/Windows startup |
| macOS | Supported for local use | launchd recommended |

### Prerequisites

#### Debian / Ubuntu / Raspberry Pi OS

```bash
sudo apt update
sudo apt install -y curl git tmux build-essential python3 make g++

# Node.js 22 LTS, example via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

#### Ubuntu in WSL2

Use the Debian/Ubuntu prerequisites. For boot autostart, enable systemd in WSL first:

```ini
# /etc/wsl.conf
[boot]
systemd=true
```

Then restart WSL from Windows:

```powershell
wsl --shutdown
```

#### macOS

```bash
xcode-select --install
brew install node@22 tmux
which node   # use this absolute path in launchd; Apple Silicon Homebrew is usually /opt/homebrew/bin/node, Intel is usually /usr/local/bin/node
```

### Build Production Assets

From repo root:

```bash
cd remote-agent-tui

# Server
cd server
# Use full npm ci for now: @fastify/static is currently a runtime import in devDependencies.
# Do not use npm ci --omit=dev until @fastify/static moves to dependencies.
npm ci
npm run build

# Frontend
cd ../tui-web
npm ci
npm run build
```

Current server implementation serves production static files from `remote-agent-tui/web/dist`. The Vite source app currently lives in `remote-agent-tui/tui-web`, so copy built assets into the runtime `web/dist` path:

```bash
cd remote-agent-tui
mkdir -p web
rm -rf web/dist
cp -R tui-web/dist web/dist
```

> Note: `@fastify/static` is currently in `server/devDependencies`, but production static serving imports it at runtime. Until this is moved to `dependencies`, use `npm ci` (not `npm ci --omit=dev`) for the server, or install `@fastify/static` explicitly in production.

### Install on Linux with systemd

#### Recommended for desktop/dev machines: per-user service

Use a per-user service when the agents should run with your real `$HOME`, shell tools, dotfiles, SSH keys, and tmux socket. This is the best local-dev experience and avoids cross-user confusion on shared machines.

After installing the `.deb`, the package does **not** enable or start the system service by default. Run this as the target user (no `sudo`):

```bash
/usr/share/doc/remote-agent-tui/install-user-service.sh
```

Manage it with:

```bash
systemctl --user status remote-agent-tui
journalctl --user -u remote-agent-tui -f
systemctl --user restart remote-agent-tui
```

User-mode files:

```text
~/.config/remote-agent-tui/default-config.json
~/.config/remote-agent-tui/env
~/.local/share/remote-agent-tui/
```

Default allowed roots are your `$HOME` and `/tmp`, so paths like `~/dev/project` and `~/.dotfiles` work without editing system config.

Use the system service only for appliance/headless installs where one daemon account owns all sessions. Enable it manually when you want that mode.

#### System service / appliance mode

Example install path: `/opt/remote-agent-tui`.

```bash
sudo mkdir -p /opt/remote-agent-tui
sudo rsync -a remote-agent-tui/ /opt/remote-agent-tui/

cd /opt/remote-agent-tui/server
npm ci
npm rebuild
sudo tee .env >/dev/null << 'EOF'
AUTH_TOKEN=replace-with-a-long-random-token
PORT=5555
NODE_ENV=production
EOF
sudo chmod 600 .env
```

Install service using the `.deb` package's built-in systemd unit, or for manual/appliance installs, use the unit from the packaging directory:

```bash
# If installing via .deb package, the service is already installed:
# /usr/lib/remote-agent-tui/server is the working directory
# /etc/remote-agent-tui/env holds environment config
sudo systemctl enable --now remote-agent-tui
sudo systemctl status remote-agent-tui
journalctl -u remote-agent-tui -f
```

For **manual/source installs** to `/opt/remote-agent-tui`, copy the packaged unit and adjust paths:

```bash
sudo cp packaging/debian/systemd/remote-agent-tui.service /etc/systemd/system/
# Edit User, WorkingDirectory, and ExecStart paths to match your install
sudo systemctl daemon-reload
sudo systemctl enable --now remote-agent-tui
```

The packaged service uses a dedicated `remote-agent-tui` system user with security hardening. If you need to override settings:

```bash
sudo mkdir -p /etc/systemd/system/remote-agent-tui.service.d
sudo tee /etc/systemd/system/remote-agent-tui.service.d/override.conf >/dev/null << 'EOF'
[Service]
# Override any EnvironmentFile or Environment entries
Environment=AUTH_TOKEN=replace-with-a-long-random-token
Environment=PORT=5555
EOF
sudo systemctl daemon-reload
sudo systemctl restart remote-agent-tui
```

Open `http://<host>:5555` and enter the auth token.

### Install on macOS with launchd

Build assets as above, then run foreground first:

```bash
cd remote-agent-tui/server
AUTH_TOKEN=replace-with-a-long-random-token PORT=5555 NODE_ENV=production npm start
```

For autostart, create `~/Library/LaunchAgents/com.remote-agent-tui.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.remote-agent-tui</string>
  <key>WorkingDirectory</key><string>/absolute/path/to/remote-agent-tui/server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/absolute/path/from/which-node</string>
    <string>dist/index.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AUTH_TOKEN</key><string>replace-with-a-long-random-token</string>
    <key>PORT</key><string>5555</string>
    <key>NODE_ENV</key><string>production</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/remote-agent-tui.log</string>
  <key>StandardErrorPath</key><string>/tmp/remote-agent-tui.err</string>
</dict>
</plist>
```

Load it:

```bash
launchctl load ~/Library/LaunchAgents/com.remote-agent-tui.plist
launchctl start com.remote-agent-tui
```

## Built-in Web Serving

Production serving path:

```text
Browser -> remote-agent-tui server :5555 -> REST /api + WebSocket /ws + static frontend /
```

Use direct HTTP only on trusted local/LAN/Tailscale networks. For public internet or untrusted networks, add TLS via one of:

- Tailscale HTTPS
- Caddy/nginx reverse proxy
- future Node HTTPS configuration

Basic production install does **not** require Caddy/nginx.

## Packaging / Single Executable

Current repo does **not** build a single executable. Packing server + frontend into one executable is possible in theory, but not recommended as the first production path.

Reason: server uses native Node modules (`node-pty`, `better-sqlite3`) and external runtime tools (`tmux`, agent CLIs). Node single-executable tooling (`node --experimental-sea-config`, `pkg`, `nexe`) does not reliably solve native addon loading, per-platform ABI compatibility, or required host tools. Users still need tmux and native build/runtime dependencies.

Recommended packaging roadmap:

1. **Now:** release directory or tarball containing `server/dist`, `server/package*.json`, `web/dist`, deploy templates, and install scripts.
2. **Next:** `install.sh`, `doctor.sh`, `update.sh`, systemd template, launchd template.
3. **Linux production:** `.deb` package and apt repository once install flow stabilizes.
4. **macOS convenience:** Homebrew formula with `brew services` support.
5. **Later:** per-platform self-extracting bundle if native addon constraints are acceptable.

Suggested release layout:

```text
remote-agent-tui/
  server/
    dist/
    package.json
    package-lock.json
    default-config.json
  web/
    dist/                 # copied from tui-web/dist for runtime serving
  packaging/
    debian/
      control
      postinst, prerm, postrm
      conffiles
      systemd/remote-agent-tui.service
    macos/
      com.remote-agent-tui.plist
      install-macos.sh
      uninstall-macos.sh
    scripts/
      install-node.sh
      install-user-service.sh
      doctor.sh
      uninstall.sh
    systemd/
      remote-agent-tui-user.service
  README.md
```

## Updates

Simple source/tarball update:

```bash
sudo systemctl stop remote-agent-tui
cd /opt/remote-agent-tui
# replace files or git pull
cd server
npm ci
npm rebuild
npm run build
cd ../tui-web
npm ci
npm run build
cd ..
rm -rf web/dist && mkdir -p web && cp -R tui-web/dist web/dist
sudo systemctl start remote-agent-tui
```

For safer production updates, install each version into `/opt/remote-agent-tui/releases/<version>`, keep config/data outside release dirs, and point `/opt/remote-agent-tui/current` at the active version for rollback.

## Quick Start (Development)

### Prerequisites

- Node.js 22 LTS
- tmux (`sudo apt install -y tmux`)
- build-essential, python3, make, g++ (for native modules: `sudo apt install -y build-essential python3 make g++`)

### Quick Start (Development, unified)

From `remote-agent-tui/` root:

```bash
# One-time setup
cd remote-agent-tui
npm install            # installs concurrently at root

cd server
npm install
cp .env.example .env  # Set AUTH_TOKEN in .env

cd ../tui-web
npm install

# Start both server + frontend (server on :3100, Vite on :5173)
cd ..
npm run dev
```

### Or start individually

```bash
# Backend — Terminal 1 (defaults to PORT=3100 for dev)
cd remote-agent-tui/server
cp .env.example .env                        # Set AUTH_TOKEN in .env
npm install
npm run dev

# Frontend — Terminal 2 (Vite dev server, auto-increments port if busy)
cd remote-agent-tui/tui-web
npm install
npm run dev
```

Open **http://localhost:5173**, enter your auth token, create a session, and attach.

### Dev port configuration

| Component | Default Port | Env Var | Notes |
|---|---|---|---|
| Backend (dev) | `3100` | `PORT` | `npm run dev` in server sets `PORT=3100` |
| Frontend (dev) | `5173` | `VITE_DEV_PORT` | Vite auto-increments if busy |
| Frontend proxy target | `3100` | `VITE_API_PORT` | Must match backend PORT |
| Frontend proxy host | `127.0.0.1` | `VITE_API_HOST` | Change if backend on different host |
| Production | `5555` | `PORT` | Single port serves API + static frontend |

### Configuration

| Variable | Default | Description |
|---|---|---|
| `AUTH_TOKEN` | `dev-token-change-me` | Required auth token for all API and WebSocket calls |
| `PORT` | `5555` | Server listen port. Dev script (`npm run dev`) defaults to `3100` |
| `VITE_DEV_PORT` | `5173` | Vite dev server port (auto-increments if busy) |
| `VITE_API_PORT` | `3100` | Vite proxy target port (must match backend `PORT`) |
| `VITE_API_HOST` | `127.0.0.1` | Vite proxy target host |

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

```text
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
| `GET` | `/api/sessions/:sessionId` | Get session details |
| `POST` | `/api/sessions` | Create session (`{commandId, cwd, title?, id?}`) |
| `PATCH` | `/api/sessions/:sessionId` | Update session (title, restartPolicy) |
| `POST` | `/api/sessions/:sessionId/kill` | Kill session (`{confirm: true}` required) |
| `POST` | `/api/sessions/:sessionId/restart` | Restart stopped/crashed session |
| `POST` | `/api/sessions/:sessionId/resume` | Resume using agent native resume support |
| `DELETE` | `/api/sessions/:sessionId` | Delete session from DB |
| `GET` | `/api/hosts` | List configured hosts |
| `GET` | `/api/commands` | List available command IDs |

WebSocket: connect to `/ws?token=<token>` — binary frames for terminal I/O, JSON for control.

## Deployment to Raspberry Pi

Use the Linux production install above. Raspberry Pi OS follows the same systemd path — install the `.deb` package or do a manual install.

Native modules (`node-pty`, `better-sqlite3`) must be rebuilt on the Pi:

```bash
cd /opt/remote-agent-tui/server
npm rebuild
sudo systemctl restart remote-agent-tui
```

### Add HTTPS with Caddy

Install Caddy and create a reverse proxy config:

```bash
sudo apt install -y caddy
```

Create `/etc/caddy/Caddyfile`:

```caddyfile
:443 {
    reverse_proxy localhost:5555
}

# HTTP redirect (optional)
:80 {
    redir https://{host}{uri} permanent
}
```

For **Tailscale HTTPS**: enable HTTPS in the Tailscale admin console, then configure Caddy with your Tailscale domain or use Tailscale's built-in HTTPS.

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
      "allowedCwdRoots": ["/home/pi", "/tmp"]
    },
    {
      "id": "opencode",
      "label": "OpenCode",
      "command": "opencode",
      "allowedCwdRoots": ["/home/pi", "/tmp"]
    },
    {
      "id": "codex",
      "label": "Codex Coding Agent",
      "command": "codex",
      "allowedCwdRoots": ["/home/pi", "/tmp"]
    }
  ],
  "hosts": [
    { "id": "local", "name": "This Machine", "address": "localhost", "port": 5555 }
  ]
}
```

Then restart: `sudo systemctl restart remote-agent-tui`.

## Security

- **Auth required** — Bearer token on all endpoints and WebSocket connections
- **Command allowlist** — only pre-approved commands can be launched, by ID not by raw string
- **CWD allowlist** — working directories restricted to configured roots per command
- **`$HOME` auto-included** — current user's home directory is always in allowed roots at runtime
- **Input validation** — sessionId must match `^[a-z0-9][a-z0-9-]{0,63}$`
- **Kill requires confirmation** — `confirm: true` must be sent to prevent accidental kills
- **Tailscale/private network** — designed for private networks, not public internet
- **HTTPS** — use Tailscale HTTPS or a reverse proxy for TLS outside trusted networks

## Project Structure

```text
remote-agent-tui/
  server/src/
    index.ts              # Fastify server entry + REST routes
    auth.ts               # Bearer token auth middleware
    config.ts             # Server config (env vars + defaults)
    protocol.ts           # WebSocket protocol types (binary + JSON)
    db.ts                 # SQLite DB setup (WAL mode, schema-on-startup)
    SessionStore.ts       # Session data store
    sessions.ts           # Session manager + state machine + reconciliation
    agentSessionId.ts     # Agent session ID extraction/resume helpers
    eventLog.ts           # Structured event logging
    tmux.ts               # tmux CLI wrappers
    ptyBridge.ts          # node-pty bridge (primary) + polling fallback
    ws.ts                 # WebSocket handler (binary I/O, heartbeat, attach/detach)
    allowlist.ts          # Command + CWD validation
  tui-web/src/
    App.tsx               # Main app (routing, auth)
    components/
      Dashboard.tsx       # Session list + create + kill
      TerminalView.tsx    # xterm.js terminal + controls
    lib/
      terminalSocket.ts   # WebSocket client (binary protocol, reconnect, heartbeat)
      apiClient.ts        # REST API client
      auth.ts             # Token management
      types.ts            # TypeScript type definitions
      pwa-utils.ts        # Wake-lock, visibility, connectivity helpers
  web/dist/               # Production runtime static assets copied from tui-web/dist
  packaging/
    debian/
      control, postinst, prerm, postrm, conffiles
      systemd/remote-agent-tui.service      # systemd unit for system/appliance mode
    macos/
      com.remote-agent-tui.plist
      install-macos.sh, uninstall-macos.sh
    scripts/
      install-node.sh
      install-user-service.sh
      doctor.sh, uninstall.sh
    systemd/
      remote-agent-tui-user.service          # per-user systemd unit
```

## Troubleshooting

| Problem | Solution |
|---|---|
| `node-pty` or `better-sqlite3` build fails | Install build tools (`build-essential python3 make g++` on Linux, Xcode CLI tools on macOS), then run `npm rebuild` in `server/` |
| tmux not found | Install tmux (`sudo apt install -y tmux`, `brew install tmux`) |
| Auth token rejected | Check `.env` or service environment matches token entered in browser |
| Frontend returns 404 in production | Ensure `tui-web/dist` was copied to `web/dist` and server was restarted |
| Static serving disabled | Ensure `@fastify/static` is installed in production server dependencies |
| WSL service does not start on boot | Enable WSL systemd or use manual/Windows-side startup |
| macOS launchd service fails | Check absolute `WorkingDirectory`, Node path, and `xcode-select --install` |
| Service runs as wrong user | Override `User=` and `WorkingDirectory=` with a systemd drop-in |
| Session shows "stopped" after server restart | Normal — server reconciles with tmux on startup |
| Terminal blank after attach | Reload page; check browser console and WebSocket connection |
| Can't create session in specific directory | Add path to `allowedCwdRoots` in `default-config.json` |
| Port 5555 already in use | Change `PORT` in `.env` or service override and restart |
| Public internet exposure needed | Put Tailscale HTTPS or Caddy/nginx in front; do not expose plain HTTP publicly |
| View logs | `journalctl -u remote-agent-tui -f` on Linux; `/tmp/remote-agent-tui.log` on macOS launchd example |
