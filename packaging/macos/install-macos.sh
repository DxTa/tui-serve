#!/bin/bash
# install-macos.sh — Install Remote Agent TUI on macOS
#
# Usage: ./install-macos.sh [--user USER]
#
#   --user USER  Run the service as this user (default: current user)
#
# Prerequisites:
#   - tmux (brew install tmux)
#
# Run from inside the extracted tarball directory.

set -euo pipefail

INSTALL_USER="${1:-}"
if [ -z "$INSTALL_USER" ]; then
  # Default to current user (not root)
  INSTALL_USER="$(whoami)"
fi

# Resolve the install base directory relative to this script
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUNDLE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_BASE="/usr/local/opt/remote-agent-tui"
CONFIG_DIR="/usr/local/etc/remote-agent-tui"
DATA_DIR="/usr/local/var/lib/remote-agent-tui"
LOG_DIR="/usr/local/var/log"
PORT="${PORT:-5555}"
BIND_HOST="${BIND_HOST:-${REMOTE_AGENT_TUI_BIND_HOST:-0.0.0.0}}"
GENERATED_AUTH_TOKEN=""

generate_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
  else
    "$INSTALL_BASE/node/bin/node" -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
  fi
}

is_interactive() {
  [ -t 0 ] && [ -t 1 ] && [ "${REMOTE_AGENT_TUI_NONINTERACTIVE:-}" != "1" ]
}

echo "=== Remote Agent TUI — macOS Install ==="
echo ""
echo "Install base:  $INSTALL_BASE"
echo "Config dir:    $CONFIG_DIR"
echo "Data dir:      $DATA_DIR"
echo "Service user:  $INSTALL_USER"
echo ""

# ── Copy application files ──
echo ">>> Installing to $INSTALL_BASE..."
sudo mkdir -p "$INSTALL_BASE"
sudo cp -R "$BUNDLE_DIR/node" "$INSTALL_BASE/"
sudo cp -R "$BUNDLE_DIR/server" "$INSTALL_BASE/"
sudo cp -R "$BUNDLE_DIR/web" "$INSTALL_BASE/"
sudo mkdir -p "$INSTALL_BASE/bin"
sudo tee "$INSTALL_BASE/bin/remote-agent-tui-server" >/dev/null << EOF
#!/bin/sh
if [ -f "$CONFIG_DIR/env" ]; then
  set -a
  . "$CONFIG_DIR/env"
  set +a
fi
exec "$INSTALL_BASE/node/bin/node" "$INSTALL_BASE/server/dist/index.js"
EOF
sudo chmod 755 "$INSTALL_BASE/bin/remote-agent-tui-server"
sudo chown -R root:wheel "$INSTALL_BASE"
echo "    Application files installed ✓"

# ── Configuration ──
echo ">>> Setting up configuration..."
sudo mkdir -p "$CONFIG_DIR"
if [ ! -f "$CONFIG_DIR/default-config.json" ]; then
  sudo cp "$BUNDLE_DIR/server/default-config.json" "$CONFIG_DIR/"
fi

if is_interactive; then
  echo ""
  echo "Remote Agent TUI network setup"
  echo "1) Network/LAN/Tailscale (0.0.0.0, auth required)"
  echo "2) Local only (127.0.0.1, auth optional)"
  printf "Choose bind mode [1]: "
  read -r bind_choice || bind_choice=""
  if [ "$bind_choice" = "2" ]; then
    BIND_HOST="127.0.0.1"
  else
    BIND_HOST="0.0.0.0"
  fi
fi

if [ -z "${AUTH_TOKEN:-}" ] && [ "$BIND_HOST" != "127.0.0.1" ] && [ "$BIND_HOST" != "localhost" ] && [ "$BIND_HOST" != "::1" ]; then
  AUTH_TOKEN="$(generate_token)"
  GENERATED_AUTH_TOKEN="$AUTH_TOKEN"
fi

if [ ! -f "$CONFIG_DIR/env" ]; then
  cat > /tmp/remote-agent-tui-env << EOF
# Remote Agent TUI environment configuration
# Edit this file to change settings, then:
#   launchctl kickstart -k gui/\$(id -u)/com.remote-agent-tui

# Network mode requires a strong AUTH_TOKEN. For local-only no-auth mode,
# set BIND_HOST=127.0.0.1 and AUTH_TOKEN=, then restart.
AUTH_TOKEN=${AUTH_TOKEN:-}
BIND_HOST=$BIND_HOST
PORT=$PORT
NODE_ENV=production
REMOTE_AGENT_TUI_CONFIG=$CONFIG_DIR/default-config.json
REMOTE_AGENT_TUI_DATA_DIR=$DATA_DIR
REMOTE_AGENT_TUI_WEB_DIR=$INSTALL_BASE/web
EOF
  sudo cp /tmp/remote-agent-tui-env "$CONFIG_DIR/env"
  sudo chown "$INSTALL_USER" "$CONFIG_DIR/env"
  sudo chmod 600 "$CONFIG_DIR/env"
  rm /tmp/remote-agent-tui-env
else
  if ! grep -q '^BIND_HOST=' "$CONFIG_DIR/env"; then
    echo "BIND_HOST=$BIND_HOST" | sudo tee -a "$CONFIG_DIR/env" >/dev/null
  fi
fi
echo "    Configuration ready ✓"

# ── Data directory ──
echo ">>> Setting up data directory..."
sudo mkdir -p "$DATA_DIR"
sudo mkdir -p "$LOG_DIR"
sudo chown -R "$INSTALL_USER" "$DATA_DIR"
sudo chown -R "$INSTALL_USER" "$LOG_DIR"
echo "    Data directory ready ✓"

# ── launchd service ──
echo ">>> Installing launchd service..."
PLIST_SRC="$BUNDLE_DIR/deploy/launchd/com.remote-agent-tui.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.remote-agent-tui.plist"

# If a system-wide plist exists, remove it first
if [ -f "/Library/LaunchDaemons/com.remote-agent-tui.plist" ]; then
  sudo launchctl unload /Library/LaunchDaemons/com.remote-agent-tui.plist 2>/dev/null || true
  sudo rm /Library/LaunchDaemons/com.remote-agent-tui.plist
fi

mkdir -p "$HOME/Library/LaunchAgents"

# Update plist for this user and port
if [ -f "$PLIST_SRC" ]; then
  cp "$PLIST_SRC" "$PLIST_DST"
else
  echo "    Warning: launchd plist template not found at $PLIST_SRC"
  echo "    You'll need to create it manually."
  PLIST_DST=""
fi

# Update WorkingDirectory and user-specific paths in plist
if [ -n "$PLIST_DST" ] && [ -f "$PLIST_DST" ]; then
  # Use sed to fix up paths for this user
  sed -i '' "s|/usr/local/opt/remote-agent-tui/server|$INSTALL_BASE/server|g" "$PLIST_DST" 2>/dev/null || true
  sed -i '' "s|/usr/local/opt/remote-agent-tui/node/bin/node|$INSTALL_BASE/node/bin/node|g" "$PLIST_DST" 2>/dev/null || true
  sed -i '' "s|/usr/local/opt/remote-agent-tui/bin/remote-agent-tui-server|$INSTALL_BASE/bin/remote-agent-tui-server|g" "$PLIST_DST" 2>/dev/null || true
fi

echo "    launchd plist installed ✓"

# ── Start the service ──
if [ -n "$PLIST_DST" ] && [ -f "$PLIST_DST" ]; then
  echo ">>> Starting service..."
  launchctl load "$PLIST_DST" 2>/dev/null || true
  sleep 2
  echo "    Service started ✓"
fi

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║            Install Complete!                             ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║                                                          ║"
echo "║  Open:  http://localhost:5555                            ║"
echo "║                                                          ║"
echo "║  Network mode requires auth by default.                  ║"
echo "║  To edit auth/bind settings:                             ║"
echo "║    nano $CONFIG_DIR/env"
if [ -n "$GENERATED_AUTH_TOKEN" ]; then
  echo "║    Generated token was written to env file.              ║"
fi
echo "║    launchctl kickstart -k gui/$(id -u)/com.remote-agent-tui"
echo "║                                                          ║"
echo "║  Config:  $CONFIG_DIR/default-config.json"
echo "║  Logs:    $LOG_DIR/remote-agent-tui.log"
echo "║                                                          ║"
echo "║  Stop:    launchctl unload $PLIST_DST"
echo "║  Restart: launchctl kickstart -k gui/$(id -u)/com.remote-agent-tui"
echo "║  Uninstall: ./uninstall-macos.sh                         ║"
echo "╚══════════════════════════════════════════════════════════╝"