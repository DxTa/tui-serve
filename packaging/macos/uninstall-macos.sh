#!/bin/bash
# uninstall-macos.sh — Uninstall Remote Agent TUI from macOS

set -euo pipefail

INSTALL_BASE="/usr/local/opt/remote-agent-tui"
CONFIG_DIR="/usr/local/etc/remote-agent-tui"
DATA_DIR="/usr/local/var/lib/remote-agent-tui"
PLIST="$HOME/Library/LaunchAgents/com.remote-agent-tui.plist"

echo "=== Remote Agent TUI — macOS Uninstall ==="
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
  sudo rm -f /usr/local/var/log/remote-agent-tui.log
  sudo rm -f /usr/local/var/log/remote-agent-tui.err
  echo "    Config and data removed ✓"
else
  echo "    Config kept at: $CONFIG_DIR"
  echo "    Data kept at:  $DATA_DIR"
fi

echo ""
echo "=== Uninstall Complete ==="