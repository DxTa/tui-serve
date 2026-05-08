#!/usr/bin/env bash
# uninstall.sh — Clean uninstall of tui-serve
# Removes the package and optionally all data and config.
#
# Usage: sudo ./packaging/scripts/uninstall.sh [--purge]
#
#   --purge  Also remove config files and data directory

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Error: This script must be run as root (sudo)." >&2
  exit 1
fi

PURGE=false
if [ "${1:-}" = "--purge" ]; then
  PURGE=true
fi

echo "=== Uninstalling TUI Serve ==="
echo ""

# Stop service first
if systemctl is-active tui-serve >/dev/null 2>&1; then
  echo "Stopping service..."
  systemctl stop tui-serve
fi

if systemctl is-enabled tui-serve >/dev/null 2>&1; then
  echo "Disabling service..."
  systemctl disable tui-serve
fi

# Remove systemd override if present
if [ -d /etc/systemd/system/tui-serve.service.d ]; then
  echo "Removing systemd overrides..."
  rm -rf /etc/systemd/system/tui-serve.service.d
fi

systemctl daemon-reload

# Remove the package
echo "Removing package..."
if dpkg -s tui-serve >/dev/null 2>&1; then
  if $PURGE; then
    apt-get purge -y tui-serve
  else
    apt-get remove -y tui-serve
  fi
else
  echo "Package not installed via dpkg."
fi

# Handle remaining files
if $PURGE; then
  echo "Purging data and config..."
  rm -rf /var/lib/tui-serve
  rm -rf /var/log/tui-serve
  rm -rf /etc/tui-serve
  echo "All data, config, and logs removed."
else
  echo "Config and data preserved in:"
  echo "  /etc/tui-serve/"
  echo "  /var/lib/tui-serve/"
  echo "  /var/log/tui-serve/"
  echo "Use --purge to remove these as well."
fi

echo ""
echo "=== Uninstall Complete ==="