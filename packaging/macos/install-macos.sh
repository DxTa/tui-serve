#!/usr/bin/env bash
# install-macos.sh — Install TUI Serve on macOS
#
# Usage: ./install-macos.sh [--user]
#
#   --user    Install to user home directory (no sudo required).
#             Paths: ~/.local/opt/tui-serve, ~/.config/tui-serve, etc.
#             Default (without --user): system install to /usr/local (requires sudo).
#
# Prerequisites:
#   - tmux (brew install tmux)
#
# Run from inside the extracted tarball directory.

set -euo pipefail

# ── Install mode detection ──
INSTALL_MODE="system"
while [ $# -gt 0 ]; do
  case "$1" in
    --user) INSTALL_MODE="user"; shift ;;
    --system) INSTALL_MODE="system"; shift ;;
    *) shift ;;
  esac
done

# ── Set paths based on install mode ──
if [ "$INSTALL_MODE" = "user" ]; then
  INSTALL_BASE="$HOME/.local/opt/tui-serve"
  CONFIG_DIR="$HOME/.config/tui-serve"
  DATA_DIR="$HOME/.local/share/tui-serve"
  LOG_DIR="$HOME/Library/Logs"
  APP_LOG_DIR="$HOME/Library/Logs/tui-serve"
  NEEDS_SUDO=false
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║  TUI Serve — macOS Install (user mode)                   ║"
  echo "║  No sudo required — installing to your home directory    ║"
  echo "╚══════════════════════════════════════════════════════════╝"
else
  INSTALL_BASE="/usr/local/opt/tui-serve"
  CONFIG_DIR="/usr/local/etc/tui-serve"
  DATA_DIR="/usr/local/var/lib/tui-serve"
  LOG_DIR="/usr/local/var/log"
  APP_LOG_DIR="/usr/local/var/log/tui-serve"
  NEEDS_SUDO=true
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║  TUI Serve — macOS Install (system mode)                 ║"
  echo "║  Requires sudo — installing to /usr/local                ║"
  echo "╚══════════════════════════════════════════════════════════╝"
fi

# ── Guard: don't run as root ──
if [ "$(id -u)" -eq 0 ]; then
  echo "❌ Do not run this script as root or with sudo." >&2
  echo "   The script uses sudo internally where needed (system mode)." >&2
  exit 1
fi

INSTALL_USER="$(whoami)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUNDLE_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
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

run_mkdir()   { if $NEEDS_SUDO; then sudo mkdir -p "$@"; else mkdir -p "$@"; fi; }
run_cp()      { if $NEEDS_SUDO; then sudo cp "$@"; else cp "$@"; fi; }
run_cpR()     { if $NEEDS_SUDO; then sudo cp -R "$@"; else cp -R "$@"; fi; }
run_chown()   { if $NEEDS_SUDO; then sudo chown "$@"; else chown "$@" 2>/dev/null || true; fi; }
run_chownR()  { if $NEEDS_SUDO; then sudo chown -R "$@"; else chown -R "$@" 2>/dev/null || true; fi; }
run_chmod()   { if $NEEDS_SUDO; then sudo chmod "$@"; else chmod "$@"; fi; }
run_xattr()   { if $ -NEEDS_SUDO; then sudo xattr -cr "$@" 2>/dev/null || true; else xattr -cr "$@" 2>/dev/null || true; fi; }
run_rm_rf()   { if $NEEDS_SUDO; then sudo rm -rf "$@"; else rm -rf "$@"; fi; }
run_sed()     { sed -i '' "$@"; }

echo ""
echo "Install base:  $INSTALL_BASE"
echo "Config dir:    $CONFIG_DIR"
echo "Data dir:      $DATA_DIR"
echo "Log dir:       $APP_LOG_DIR"
echo "Service user:  $INSTALL_USER"
echo "Install mode:  $INSTALL_MODE"
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

# ── Stop existing service ──
EXISTING_PLIST="$HOME/Library/LaunchAgents/com.tui-serve.plist"
if [ -f "$EXISTING_PLIST" ]; then
  echo ">>> Stopping existing service..."
  launchctl unload "$EXISTING_PLIST" 2>/dev/null || true
fi

# ── Copy application files ──
echo ">>> Installing to $INSTALL_BASE..."

# Remove previous install to prevent stale files
if [ -d "$INSTALL_BASE" ]; then
  echo "    Removing previous installation..."
  run_rm_rf "$INSTALL_BASE"
fi

run_mkdir "$INSTALL_BASE"
run_cpR "$BUNDLE_DIR/node" "$INSTALL_BASE/"
run_cpR "$BUNDLE_DIR/server" "$INSTALL_BASE/"
run_cpR "$BUNDLE_DIR/web" "$INSTALL_BASE/"

# Copy launcher, doctor, and deploy scripts
run_mkdir "$INSTALL_BASE/bin"
run_mkdir "$INSTALL_BASE/deploy/scripts"
if [ -f "$BUNDLE_DIR/bin/tui-serve.sh" ]; then
  run_cp "$BUNDLE_DIR/bin/tui-serve.sh" "$INSTALL_BASE/bin/"
  run_chmod 755 "$INSTALL_BASE/bin/tui-serve.sh"
fi
if [ -f "$BUNDLE_DIR/deploy/scripts/doctor-macos.sh" ]; then
  run_cp "$BUNDLE_DIR/deploy/scripts/doctor-macos.sh" "$INSTALL_BASE/deploy/scripts/"
  run_chmod 755 "$INSTALL_BASE/deploy/scripts/doctor-macos.sh"
fi
if [ -f "$BUNDLE_DIR/deploy/scripts/uninstall-macos.sh" ]; then
  run_cp "$BUNDLE_DIR/deploy/scripts/uninstall-macos.sh" "$INSTALL_BASE/deploy/scripts/"
  run_chmod 755 "$INSTALL_BASE/deploy/scripts/uninstall-macos.sh"
fi

# Copy launchd plist
run_mkdir "$INSTALL_BASE/deploy/launchd"
if [ -f "$BUNDLE_DIR/deploy/launchd/com.tui-serve.plist" ]; then
  run_cp "$BUNDLE_DIR/deploy/launchd/com.tui-serve.plist" "$INSTALL_BASE/deploy/launchd/"
fi

# Copy default config & env template
run_cp "$BUNDLE_DIR/server/default-config.json" "$INSTALL_BASE/server/"

if $NEEDS_SUDO; then
  run_chownR root:wheel "$INSTALL_BASE"
fi
echo "    Application files installed ✓"

# ── Strip quarantine attributes ──
echo ">>> Removing macOS quarantine attributes..."
run_xattr "$INSTALL_BASE"
echo "    Quarantine attributes removed ✓"

# ── Configuration ──
echo ">>> Setting up configuration..."
run_mkdir "$CONFIG_DIR"
if [ ! -f "$CONFIG_DIR/default-config.json" ]; then
  run_cp "$BUNDLE_DIR/server/default-config.json" "$CONFIG_DIR/"
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
  if $NEEDS_SUDO; then
    sudo cp "$ENV_TMP" "$CONFIG_DIR/env"
    sudo chown "$INSTALL_USER" "$CONFIG_DIR/env"
    sudo chmod 600 "$CONFIG_DIR/env"
  else
    cp "$ENV_TMP" "$CONFIG_DIR/env"
    chown "$INSTALL_USER" "$CONFIG_DIR/env" 2>/dev/null || true
    chmod 600 "$CONFIG_DIR/env"
  fi
  rm -f "$ENV_TMP"
else
  if ! grep -q '^BIND_HOST=' "$CONFIG_DIR/env"; then
    if $NEEDS_SUDO; then
      echo "BIND_HOST=$BIND_HOST" | sudo tee -a "$CONFIG_DIR/env" >/dev/null
    else
      echo "BIND_HOST=$BIND_HOST" >> "$CONFIG_DIR/env"
    fi
  fi
fi
echo "    Configuration ready ✓"

# ── Data and log directories ──
echo ">>> Setting up data directory..."
run_mkdir "$DATA_DIR"
run_mkdir "$LOG_DIR"
run_mkdir "$APP_LOG_DIR"
if $NEEDS_SUDO; then
  sudo chown -R "$INSTALL_USER" "$DATA_DIR"
  sudo chown -R "$INSTALL_USER" "$APP_LOG_DIR"
fi
echo "    Data directory ready ✓"

# ── Write mode-aware launcher wrapper ──
echo ">>> Writing launcher wrapper..."
mkdir -p "$INSTALL_BASE/bin"
cat > "$INSTALL_BASE/bin/tui-serve.sh" << LAUNCHER
#!/usr/bin/env bash
set -euo pipefail
INSTALL_BASE="$INSTALL_BASE"
CONFIG_DIR="$CONFIG_DIR"
NODE_BIN="\${INSTALL_BASE}/node/bin/node"
SERVER_ENTRY="\${INSTALL_BASE}/server/dist/index.js"

# ── Preflight checks ──
if [ ! -x "\$NODE_BIN" ]; then
  echo "[tui-serve] ERROR: Node.js binary not found or not executable: \$NODE_BIN" >&2
  echo "[tui-serve] Re-install or run: \$INSTALL_BASE/deploy/scripts/doctor-macos.sh" >&2
  exit 1
fi

if [ ! -f "\$SERVER_ENTRY" ]; then
  echo "[tui-serve] ERROR: Server entry point not found: \$SERVER_ENTRY" >&2
  echo "[tui-serve] Re-install the application." >&2
  exit 1
fi

# ── Source environment config (AUTH_TOKEN, PORT, BIND_HOST, etc.) ──
set -a
if [ -f "\${CONFIG_DIR}/env" ]; then
  . "\${CONFIG_DIR}/env"
fi
set +a

exec "\${NODE_BIN}" "\${SERVER_ENTRY}"
LAUNCHER
chmod 755 "$INSTALL_BASE/bin/tui-serve.sh"
echo "    Launcher wrapper written ✓"

# ── launchd service ──
echo ">>> Installing launchd service..."
PLIST_SRC="$BUNDLE_DIR/deploy/launchd/com.tui-serve.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.tui-serve.plist"

# If a system-wide plist exists, remove it
if [ -f "/Library/LaunchDaemons/com.tui-serve.plist" ]; then
  if $NEEDS_SUDO; then
    sudo launchctl bootout system/com.tui-serve 2>/dev/null || true
    sudo rm /Library/LaunchDaemons/com.tui-serve.plist
  fi
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

  # Update paths in plist for this install location
  sed -i '' "s|/usr/local/opt/tui-serve/server|${INSTALL_BASE}/server|g" "$PLIST_DST" 2>/dev/null || true
  sed -i '' "s|/usr/local/opt/tui-serve/bin/tui-serve.sh|${INSTALL_BASE}/bin/tui-serve.sh|g" "$PLIST_DST" 2>/dev/null || true
  sed -i '' "s|/usr/local/var/log/tui-serve|${APP_LOG_DIR}|g" "$PLIST_DST" 2>/dev/null || true
else
  echo "    Warning: launchd plist template not found at $PLIST_SRC"
  PLIST_DST=""
fi

echo "    launchd plist installed ✓"

# ── Start the service ──
if [ -n "$PLIST_DST" ] && [ -f "$PLIST_DST" ]; then
  echo ">>> Starting service..."
  launchctl load "$PLIST_DST" 2>/dev/null || true
  sleep 2
  echo "    Service started ✓"
fi

# ── Write install mode marker ──
echo "$INSTALL_MODE" > "$INSTALL_BASE/.install-mode"

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║            Install Complete!                             ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║                                                          ║"
echo "║  Mode:    $INSTALL_MODE"
echo "║  Open:    http://localhost:${PORT}"
echo "║                                                          ║"
if [ "$INSTALL_MODE" = "user" ]; then
echo "║  ⓘ  User mode: no sudo was used.                         ║"
echo "║     Files are in your home directory.                     ║"
fi
echo "║                                                          ║"
echo "║  Network mode requires auth by default.                   ║"
echo "║  To edit auth/bind settings:                             ║"
echo "║    nano $CONFIG_DIR/env"
if [ -n "$GENERATED_AUTH_TOKEN" ]; then
echo "║    Generated token was written to env file.                ║"
fi
echo "║    launchctl kickstart -k gui/$(id -u)/com.tui-serve"
echo "║                                                          ║"
echo "║  Config:  $CONFIG_DIR/default-config.json"
echo "║  Logs:    $APP_LOG_DIR/"
echo "║                                                          ║"
echo "║  Stop:    launchctl unload $PLIST_DST"
echo "║  Restart: launchctl kickstart -k gui/$(id -u)/com.tui-serve"
echo "║  Uninstall: $INSTALL_BASE/deploy/scripts/uninstall-macos.sh"
echo "║  Doctor:   $INSTALL_BASE/deploy/scripts/doctor-macos.sh"
echo "╚══════════════════════════════════════════════════════════╝"