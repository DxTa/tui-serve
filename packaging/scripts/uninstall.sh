#!/usr/bin/env bash
# uninstall.sh — Clean uninstall of remote-agent-tui
# Removes the package and optionally all data and config.
#
# Usage: sudo ./packaging/scripts/uninstall.sh [--purge]
#
#   --purge  Also remove config files, data directory, and SQLite database

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Error: This script must be run as root (sudo)." >&2
  exit 1
fi

PURGE=false
if [ "${1:-}" = "--purge" ]; then
  PURGE=true
fi

echo "=== Uninstalling Remote Agent TUI ==="
echo ""

# Stop service first
if systemctl is-active remote-agent-tui >/dev/null 2>&1; then
  echo "Stopping service..."
  systemctl stop remote-agent-tui
fi

if systemctl is-enabled remote-agent-tui >/dev/null 2>&1; then
  echo "Disabling service..."
  systemctl disable remote-agent-tui
fi

# Remove systemd override if present
if [ -d /etc/systemd/system/remote-agent-tui.service.d ]; then
  echo "Removing systemd overrides..."
  rm -rf /etc/systemd/system/remote-agent-tui.service.d
fi

systemctl daemon-reload

# Remove the package
echo "Removing package..."
if dpkg -s remote-agent-tui >/dev/null 2>&1; then
  if $PURGE; then
    apt-get purge -y remote-agent-tui
  else
    apt-get remove -y remote-agent-tui
  fi
else
  echo "Package not installed via dpkg."
fi

# Handle remaining files
if $PURGE; then
  echo "Purging data and config..."
  rm -rf /var/lib/remote-agent-tui
  rm -rf /var/log/remote-agent-tui
  rm -rf /etc/remote-agent-tui
  echo "All data, config, and logs removed."
else
  echo "Config and data preserved in:"
  echo "  /etc/remote-agent-tui/"
  echo "  /var/lib/remote-agent-tui/"
  echo "  /var/log/remote-agent-tui/"
  echo "Use --purge to remove these as well."
fi

echo ""
echo "=== Uninstall Complete ==="