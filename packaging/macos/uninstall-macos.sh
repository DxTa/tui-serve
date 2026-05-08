#!/bin/bash
# uninstall-macos.sh — Uninstall TUI Serve from macOS

set -euo pipefail

INSTALL_BASE="/usr/local/opt/tui-serve"
CONFIG_DIR="/usr/local/etc/tui-serve"
DATA_DIR="/usr/local/var/lib/tui-serve"
PLIST="$HOME/Library/LaunchAgents/com.tui-serve.plist"

echo "=== TUI Serve — macOS Uninstall ==="
echo ""

# Stop service
if [ -f "$PLIST" ]; then
  echo ">>> Stopping service..."
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "    Service stopped and plist removed ✓"
fi

# Remove application files
if [ -d "$INSTALL_BASE" ]; then
  echo ">>> Removing application files..."
  sudo rm -rf "$INSTALL_BASE"
  echo "    Application files removed ✓"
fi

# Ask about config and data
echo ""
read -p "Remove config and data too? [y/N] " -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
  sudo rm -rf "$CONFIG_DIR"
  sudo rm -rf "$DATA_DIR"
  sudo rm -rf "/usr/local/var/log/tui-serve"
  sudo rm -f /usr/local/var/log/tui-serve.log
  sudo rm -f /usr/local/var/log/tui-serve.err
  echo "    Config and data removed ✓"
else
  echo "    Config kept at: $CONFIG_DIR"
  echo "    Data kept at:  $DATA_DIR"
fi

echo ""
echo "=== Uninstall Complete ==="