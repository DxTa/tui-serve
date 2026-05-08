#!/usr/bin/env bash
# install-node.sh — Install Node.js 22 LTS via NodeSource
# Must be run before installing the .deb if nodejs >= 22 is not available.
#
# Usage: sudo ./packaging/scripts/install-node.sh

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Error: This script must be run as root (sudo)." >&2
  exit 1
fi

echo "=== Installing Node.js 22 LTS via NodeSource ==="

# Install prerequisites
apt update
apt install -y curl

# Add NodeSource repository
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -

# Install Node.js
apt install -y nodejs

# Verify
echo ""
echo "Installed Node.js: $(node --version)"
echo "Installed npm:     $(npm --version)"
echo ""
echo "You can now install the remote-agent-tui .deb package."