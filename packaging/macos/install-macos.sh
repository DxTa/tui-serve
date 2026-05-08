#!/usr/bin/env bash
# install-macos.sh — Install TUI Serve on macOS
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

# ── Guard: don't run as root ──
if [ "${EUID:-$(id -u)}" -eq 0 ] 2>/dev/null || [ "$(id -u)" -eq 0 ]; then
  echo "❌ Do not run this script as root or with sudo." >&2
  echo "   The script uses sudo internally where needed." >&2
  exit 1
fi

# ── Argument parsing ──
INSTALL_USER="$(whoami)"
while [ $# -gt 0 ]; do
  case "$1" in
    --user) INSTALL_USER="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# Validate: --user must match current user (launchd runs as installing user)
if [ "$INSTALL_USER" != "$(whoami)" ]; then
  echo "⚠️  Warning: --user '$INSTALL_USER' differs from current user '$(whoami)'" >&2
  echo "   The launchd service will run as the installing user ($(whoami))." >&2
  echo "   Setting INSTALL_USER to $(whoami) for correct file ownership." >&2
  INSTALL_USER="$(whoami)"
fi

# Resolve the install base directory relative to this script
# Script is at: <bundle>/deploy/scripts/install-macos.sh
# Bundle root: <bundle>/
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUNDLE_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
INSTALL_BASE="/usr/local/opt/tui-serve"
CONFIG_DIR="/usr/local/etc/tui-serve"
DATA_DIR="/usr/local/var/lib/tui-serve"
LOG_DIR="/usr/local/var/log"
APP_LOG_DIR="/usr/local/var/log/tui-serve"
PORT="${PORT:-5555}"
BIND_HOST="${BIND_HOST:-${TUI_SERVE_BIND_HOST:-0.0.0.0}}"
GENERATED_AUTH_TOKEN=""

generate_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
  else
    "$INSTALL_BASE/node/bin/node" -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
  fi
}

is_interactive() {
  [ -t 0 ] && [ -t 1 ] && [ "${TUI_SERVE_NONINTERACTIVE:-}" != "1" ]
}

echo "=== TUI Serve — macOS Install ==="
echo ""
echo "Install base:  $INSTALL_BASE"
echo "Config dir:    $CONFIG_DIR"
echo "Data dir:      $DATA_DIR"
echo "Service user:  $INSTALL_USER"
echo ""

# ── Validate bundle directory ──
if [ ! -f "$BUNDLE_DIR/server/dist/index.js" ]; then
  echo "❌ Cannot find server/dist/index.js in $BUNDLE_DIR" >&2
  echo "   Make sure you're running this from inside the extracted tarball." >&2
  exit 1
fi

# ── Prerequisites ──
echo ">>> Checking prerequisites..."
if ! command -v tmux >/dev/null 2>&1; then
  echo "❌ tmux is required but not installed." >&2
  echo "   Install with: brew install tmux" >&2
  exit 1
fi
echo "    tmux $(tmux -V 2>/dev/null | sed 's/tmux //' || echo "detected") ✓"

# ── Copy application files ──
echo ">>> Installing to $INSTALL_BASE..."

# Stop existing service and unload plist before removing files
EXISTING_PLIST="$HOME/Library/LaunchAgents/com.tui-serve.plist"
if [ -f "$EXISTING_PLIST" ]; then
  echo "    Stopping existing service..."
  launchctl unload "$EXISTING_PLIST" 2>/dev/null || true
fi

# Remove previous install to prevent stale file accumulation
if [ -d "$INSTALL_BASE" ]; then
  echo "    Removing previous installation..."
  sudo rm -rf "$INSTALL_BASE"
fi

sudo mkdir -p "$INSTALL_BASE"
sudo cp -R "$BUNDLE_DIR/node" "$INSTALL_BASE/"
sudo cp -R "$BUNDLE_DIR/server" "$INSTALL_BASE/"
sudo cp -R "$BUNDLE_DIR/web" "$INSTALL_BASE/"

# Copy launcher wrapper
sudo mkdir -p "$INSTALL_BASE/bin"
if [ -f "$BUNDLE_DIR/bin/tui-serve.sh" ]; then
  sudo cp "$BUNDLE_DIR/bin/tui-serve.sh" "$INSTALL_BASE/bin/"
  sudo chmod 755 "$INSTALL_BASE/bin/tui-serve.sh"
else
  # Fallback: create launcher wrapper inline (for source builds)
  sudo tee "$INSTALL_BASE/bin/tui-serve.sh" >/dev/null << 'LAUNCHER'
#!/usr/bin/env bash
set -euo pipefail
INSTALL_BASE="/usr/local/opt/tui-serve"
CONFIG_DIR="/usr/local/etc/tui-serve"
set -a
if [ -f "${CONFIG_DIR}/env" ]; then
  . "${CONFIG_DIR}/env"
fi
set +a
exec "${INSTALL_BASE}/node/bin/node" \
  "${INSTALL_BASE}/server/dist/index.js"
LAUNCHER
  sudo chmod 755 "$INSTALL_BASE/bin/tui-serve.sh"
fi

# Copy doctor script
sudo mkdir -p "$INSTALL_BASE/deploy/scripts"
if [ -f "$BUNDLE_DIR/deploy/scripts/doctor-macos.sh" ]; then
  sudo cp "$BUNDLE_DIR/deploy/scripts/doctor-macos.sh" "$INSTALL_BASE/deploy/scripts/"
  sudo chmod 755 "$INSTALL_BASE/deploy/scripts/doctor-macos.sh"
fi

sudo chown -R root:wheel "$INSTALL_BASE"
echo "    Application files installed ✓"

# ── Strip quarantine attributes ──
echo ">>> Removing macOS quarantine attributes..."
sudo xattr -cr "$INSTALL_BASE" 2>/dev/null || true
echo "    Quarantine attributes removed ✓"

# ── Configuration ──
echo ">>> Setting up configuration..."
sudo mkdir -p "$CONFIG_DIR"
if [ ! -f "$CONFIG_DIR/default-config.json" ]; then
  sudo cp "$BUNDLE_DIR/server/default-config.json" "$CONFIG_DIR/"
fi

if is_interactive; then
  echo ""
  echo "TUI Serve network setup"
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

# Use mktemp for secure env file creation
if [ ! -f "$CONFIG_DIR/env" ]; then
  ENV_TMP="$(mktemp)"
  chmod 600 "$ENV_TMP"
  cat > "$ENV_TMP" << EOF
# TUI Serve environment configuration
# Edit this file to change settings, then:
#   launchctl kickstart -k gui/\$(id -u)/com.tui-serve

# Network mode requires a strong AUTH_TOKEN. For local-only no-auth mode,
# set BIND_HOST=127.0.0.1 and AUTH_TOKEN=, then restart.
AUTH_TOKEN=${AUTH_TOKEN:-}
BIND_HOST=$BIND_HOST
PORT=$PORT
NODE_ENV=production
TUI_SERVE_CONFIG=$CONFIG_DIR/default-config.json
TUI_SERVE_DATA_DIR=$DATA_DIR
TUI_SERVE_WEB_DIR=$INSTALL_BASE/web
EOF
  sudo cp "$ENV_TMP" "$CONFIG_DIR/env"
  sudo chown "$INSTALL_USER" "$CONFIG_DIR/env"
  sudo chmod 600 "$CONFIG_DIR/env"
  rm -f "$ENV_TMP"
else
  if ! grep -q '^BIND_HOST=' "$CONFIG_DIR/env"; then
    echo "BIND_HOST=$BIND_HOST" | sudo tee -a "$CONFIG_DIR/env" >/dev/null
  fi
fi
echo "    Configuration ready ✓"

# ── Data and log directories ──
echo ">>> Setting up data directory..."
sudo mkdir -p "$DATA_DIR"
sudo mkdir -p "$APP_LOG_DIR"
sudo chown -R "$INSTALL_USER" "$DATA_DIR"
sudo chown -R "$INSTALL_USER" "$APP_LOG_DIR"
echo "    Data directory ready ✓"

# ── launchd service ──
echo ">>> Installing launchd service..."
PLIST_SRC="$BUNDLE_DIR/deploy/launchd/com.tui-serve.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.tui-serve.plist"

# If a system-wide plist exists, remove it first
if [ -f "/Library/LaunchDaemons/com.tui-serve.plist" ]; then
  sudo launchctl bootout system/com.tui-serve 2>/dev/null || true
  sudo rm /Library/LaunchDaemons/com.tui-serve.plist
fi

mkdir -p "$HOME/Library/LaunchAgents"

if [ -f "$PLIST_SRC" ]; then
  cp "$PLIST_SRC" "$PLIST_DST"

  # Validate plist
  if command -v plutil >/dev/null 2>&1; then
    if ! plutil -lint "$PLIST_DST" >/dev/null 2>&1; then
      echo "❌ Invalid plist: $PLIST_DST" >&2
      exit 1
    fi
  fi
else
  echo "    Warning: launchd plist template not found at $PLIST_SRC"
  echo "    You'll need to create it manually."
  PLIST_DST=""
fi

# Update paths in plist for this user's install
if [ -n "$PLIST_DST" ] && [ -f "$PLIST_DST" ]; then
  sed -i '' "s|/usr/local/opt/tui-serve/server|$INSTALL_BASE/server|g" "$PLIST_DST" 2>/dev/null || true
  sed -i '' "s|/usr/local/opt/tui-serve/bin/tui-serve.sh|$INSTALL_BASE/bin/tui-serve.sh|g" "$PLIST_DST" 2>/dev/null || true
  sed -i '' "s|/usr/local/var/log/tui-serve|$APP_LOG_DIR|g" "$PLIST_DST" 2>/dev/null || true
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
echo "║  Open:  http://localhost:${PORT}                           ║"
echo "║                                                          ║"
echo "║  Network mode requires auth by default.                  ║"
echo "║  To edit auth/bind settings:                             ║"
echo "║    nano $CONFIG_DIR/env"
if [ -n "$GENERATED_AUTH_TOKEN" ]; then
  echo "║    Generated token was written to env file.              ║"
fi
echo "║    launchctl kickstart -k gui/$(id -u)/com.tui-serve"
echo "║                                                          ║"
echo "║  Config:  $CONFIG_DIR/default-config.json"
echo "║  Logs:    $APP_LOG_DIR/"
echo "║                                                          ║"
echo "║  Stop:    launchctl unload $PLIST_DST"
echo "║  Restart: launchctl kickstart -k gui/$(id -u)/com.tui-serve"
echo "║  Uninstall: ./deploy/scripts/uninstall-macos.sh           ║"
echo "║  Doctor:   $INSTALL_BASE/deploy/scripts/doctor-macos.sh   ║"
echo "╚══════════════════════════════════════════════════════════╝"