#!/usr/bin/env bash
# uninstall-macos.sh — Uninstall TUI Serve from macOS
#
# Supports both system (--system, default) and user (--user) install modes.
# Auto-detects mode if .install-mode marker exists.

set -euo pipefail

# ── Detect install mode ──
INSTALL_MODE=""
if [ -f "$HOME/.local/opt/tui-serve/.install-mode" ]; then
  INSTALL_MODE="$(cat "$HOME/.local/opt/tui-serve/.install-mode")"
elif [ -f "/usr/local/opt/tui-serve/.install-mode" ]; then
  INSTALL_MODE="$(cat "/usr/local/opt/tui-serve/.install-mode")"
fi

# Allow override via flag
while [ $# -gt 0 ]; do
  case "$1" in
    --user) INSTALL_MODE="user"; shift ;;
    --system) INSTALL_MODE="system"; shift ;;
    *) shift ;;
  esac
done

# Default to system if not detected
INSTALL_MODE="${INSTALL_MODE:-system}"

# ── Set paths based on mode ──
if [ "$INSTALL_MODE" = "user" ]; then
  INSTALL_BASE="$HOME/.local/opt/tui-serve"
  CONFIG_DIR="$HOME/.config/tui-serve"
  DATA_DIR="$HOME/.local/share/tui-serve"
  APP_LOG_DIR="$HOME/Library/Logs/tui-serve"
  NEEDS_SUDO=false
else
  INSTALL_BASE="/usr/local/opt/tui-serve"
  CONFIG_DIR="/usr/local/etc/tui-serve"
  DATA_DIR="/usr/local/var/lib/tui-serve"
  APP_LOG_DIR="/usr/local/var/log/tui-serve"
  NEEDS_SUDO=true
fi

PLIST="$HOME/Library/LaunchAgents/com.tui-serve.plist"

echo "=== TUI Serve — macOS Uninstall ==="
echo "Mode: $INSTALL_MODE"
echo ""

# ── Stop service ──
if [ -f "$PLIST" ]; then
  echo ">>> Stopping service..."
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "    Service stopped and plist removed ✓"
fi

# ── Remove application files ──
if [ -d "$INSTALL_BASE" ]; then
  echo ">>> Removing application files..."
  if $NEEDS_SUDO; then
    sudo rm -rf "$INSTALL_BASE"
  else
    rm -rf "$INSTALL_BASE"
  fi
  echo "    Application files removed ✓"
fi

# ── Ask about config and data ──
echo ""
read -p "Remove config and data too? [y/N] " -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
  if $NEEDS_SUDO; then
    sudo rm -rf "$CONFIG_DIR"
    sudo rm -rf "$DATA_DIR"
    sudo rm -rf "$APP_LOG_DIR"
  else
    rm -rf "$CONFIG_DIR"
    rm -rf "$DATA_DIR"
    rm -rf "$APP_LOG_DIR"
  fi
  echo "    Config and data removed ✓"
else
  echo "    Config kept at: $CONFIG_DIR"
  echo "    Data kept at:  $DATA_DIR"
fi

echo ""
echo "=== Uninstall Complete ==="