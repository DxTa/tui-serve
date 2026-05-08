#!/usr/bin/env bash
# remote-agent-tui.sh — Launcher wrapper for macOS launchd
#
# Sources the environment config file, then exec's node with the server.
# This replaces the broken approach of hardcoding env vars in the plist,
# because launchd <EnvironmentVariables> are static and don't support
# sourcing shell files.
#
# The plist invokes this script instead of node directly.
#
# Usage (via launchd):
#   This script is called by com.remote-agent-tui.plist as the ProgramArguments.
#
# Manual invocation:
#   /usr/local/opt/remote-agent-tui/bin/remote-agent-tui.sh

set -euo pipefail

INSTALL_BASE="/usr/local/opt/remote-agent-tui"
CONFIG_DIR="/usr/local/etc/remote-agent-tui"
NODE_BIN="${INSTALL_BASE}/node/bin/node"
SERVER_ENTRY="${INSTALL_BASE}/server/dist/index.js"

# ── Preflight checks ──
if [ ! -x "$NODE_BIN" ]; then
  echo "[remote-agent-tui] ERROR: Node.js binary not found or not executable: $NODE_BIN" >&2
  echo "[remote-agent-tui] Re-install or run: /usr/local/opt/remote-agent-tui/deploy/scripts/doctor-macos.sh" >&2
  exit 1
fi

if [ ! -f "$SERVER_ENTRY" ]; then
  echo "[remote-agent-tui] ERROR: Server entry point not found: $SERVER_ENTRY" >&2
  echo "[remote-agent-tui] Re-install the application." >&2
  exit 1
fi

# ── Source environment config (AUTH_TOKEN, PORT, BIND_HOST, etc.) ──
set -a
if [ -f "${CONFIG_DIR}/env" ]; then
  . "${CONFIG_DIR}/env"
fi
set +a

exec "${NODE_BIN}" "${SERVER_ENTRY}"