#!/bin/bash
# Deploy Remote Agent TUI Manager to a Raspberry Pi
#
# Usage: ./deploy/pi-setup.sh [HOST] [AUTH_TOKEN]
#   HOST       — SSH hostname (default: pi@raspberrypi)
#   AUTH_TOKEN — Auth token for the server (default: generates random)
#
# Prerequisites on the Pi:
#   - Node.js 22 LTS (install via: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs)
#   - tmux (sudo apt install -y tmux)
#   - build tools (sudo apt install -y build-essential python3 make g++)
#
# After running this script, the service will be installed and running.

set -euo pipefail

HOST="${1:-pi@raspberrypi}"
AUTH_TOKEN="${2:-$(openssl rand -hex 24)}"
REMOTE_DIR="/opt/remote-agent-tui"

echo "=== Remote Agent TUI Manager — Pi Setup ==="
echo "Host:      $HOST"
echo "Token:     $AUTH_TOKEN"
echo "Remote:    $REMOTE_DIR"
echo ""

# 1. Build frontend locally (needs Vite, not installed on Pi)
echo ">>> Building frontend..."
cd "$(dirname "$0")/../web"
npm install --silent
npm run build
echo "    Frontend built: web/dist/"

# 2. Build backend locally (TypeScript compile)
echo ">>> Building backend..."
cd "$(dirname "$0")/../server"
npm install --silent
npx tsc
echo "    Backend built: server/dist/"

# 3. Copy files to Pi
echo ">>> Copying files to $HOST:$REMOTE_DIR ..."
ssh "$HOST" "sudo mkdir -p $REMOTE_DIR && sudo chown \$(whoami):\$(whoami) $REMOTE_DIR"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Copy server dist + package.json + node_modules + default-config + .env
rsync -az --delete \
  --include='dist/***' \
  --include='node_modules/***' \
  --include='package.json' \
  --include='package-lock.json' \
  --include='default-config.json' \
  --include='.env.example' \
  --exclude='*' \
  "$SCRIPT_DIR/server/" "$HOST:$REMOTE_DIR/server/"

# Copy web dist (for serving static files)
rsync -az "$SCRIPT_DIR/web/dist/" "$HOST:$REMOTE_DIR/web/dist/"

# Copy deploy configs
rsync -az "$SCRIPT_DIR/deploy/" "$HOST:$REMOTE_DIR/deploy/"

# Copy README
rsync -az "$SCRIPT_DIR/README.md" "$HOST:$REMOTE_DIR/"

echo "    Files copied"

# 4. Re-install native modules on the Pi (node-pty, better-sqlite3 must build on ARM)
echo ">>> Rebuilding native modules on Pi..."
ssh "$HOST" "cd $REMOTE_DIR/server && npm rebuild 2>&1 | tail -5"
echo "    Native modules rebuilt"

# 5. Create .env with the auth token
echo ">>> Writing .env..."
ssh "$HOST" "cat > $REMOTE_DIR/server/.env << 'ENVEOF'
AUTH_TOKEN=$AUTH_TOKEN
PORT=3000
NODE_ENV=production
ENVEOF"
echo "    .env created"

# 6. Install and start systemd service
echo ">>> Installing systemd service..."
ssh "$HOST" << 'SSHEOF'
sudo cp /opt/remote-agent-tui/deploy/systemd/remote-agent-tui.service /etc/systemd/system/

# Create override directory for auth token if needed
sudo mkdir -p /etc/systemd/system/remote-agent-tui.service.d

# Reload and enable
sudo systemctl daemon-reload
sudo systemctl enable remote-agent-tui
sudo systemctl restart remote-agent-tui

echo "Service status:"
sudo systemctl status remote-agent-tui --no-pager -l | head -15
SSHEOF

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Your auth token:  $AUTH_TOKEN"
echo "Server URL:      http://$(echo $HOST | cut -d@ -f2):3000"
echo "Service:         sudo systemctl status remote-agent-tui"
echo "Logs:            journalctl -u remote-agent-tui -f"
echo ""
echo "If using Tailscale, the URL will be: https://$(echo $HOST | cut -d@ -f2).tailnet.ts.net:3000"