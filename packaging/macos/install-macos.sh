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
sudo chown -R root:wheel "$INSTALL_BASE"
echo "    Application files installed ✓"

# ── Configuration ──
echo ">>> Setting up configuration..."
sudo mkdir -p "$CONFIG_DIR"
if [ ! -f "$CONFIG_DIR/default-config.json" ]; then
  sudo cp "$BUNDLE_DIR/server/default-config.json" "$CONFIG_DIR/"
fi
if [ ! -f "$CONFIG_DIR/env" ]; then
  cat > /tmp/remote-agent-tui-env << 'EOF'
# Remote Agent TUI environment configuration
# Edit this file to change settings, then:
#   launchctl kickstart -k gui/$(id -u)/com.remote-agent-tui

# Auth token: leave empty for no auth (trusted networks only)
# Set a token to require authentication: AUTH_TOKEN=your-long-random-token-here
AUTH_TOKEN=
PORT=5555
NODE_ENV=production
EOF
  sudo cp /tmp/remote-agent-tui-env "$CONFIG_DIR/env"
  sudo chown "$INSTALL_USER" "$CONFIG_DIR/env"
  sudo chmod 600 "$CONFIG_DIR/env"
  rm /tmp/remote-agent-tui-env
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
echo "║  No auth required by default.                            ║"
echo "║  To enable auth, edit:                                   ║"
echo "║    nano $CONFIG_DIR/env"
echo "║    # Set: AUTH_TOKEN=your-long-random-token              ║"
echo "║    launchctl kickstart -k gui/$(id -u)/com.remote-agent-tui"
echo "║                                                          ║"
echo "║  Config:  $CONFIG_DIR/default-config.json"
echo "║  Logs:    $LOG_DIR/remote-agent-tui.log"
echo "║                                                          ║"
echo "║  Stop:    launchctl unload $PLIST_DST"
echo "║  Restart: launchctl kickstart -k gui/$(id -u)/com.remote-agent-tui"
echo "║  Uninstall: ./uninstall-macos.sh                         ║"
echo "╚══════════════════════════════════════════════════════════╝"