#!/usr/bin/env bash
# tui-serve.sh — Launcher wrapper for macOS launchd
#
# Sources the environment config file, then exec's node with the server.
# This replaces the broken approach of hardcoding env vars in the plist,
# because launchd <EnvironmentVariables> are static and don't support
# sourcing shell files.
#
# The plist invokes this script instead of node directly.
#
# Usage (via launchd):
#   This script is called by com.tui-serve.plist as the ProgramArguments.
#
# Manual invocation:
#   /usr/local/opt/tui-serve/bin/tui-serve.sh

set -euo pipefail

INSTALL_BASE="/usr/local/opt/tui-serve"
CONFIG_DIR="/usr/local/etc/tui-serve"
NODE_BIN="${INSTALL_BASE}/node/bin/node"
SERVER_ENTRY="${INSTALL_BASE}/server/dist/index.js"

# ── Preflight checks ──
if [ ! -x "$NODE_BIN" ]; then
  echo "[tui-serve] ERROR: Node.js binary not found or not executable: $NODE_BIN" >&2
  echo "[tui-serve] Re-install or run: /usr/local/opt/tui-serve/deploy/scripts/doctor-macos.sh" >&2
  exit 1
fi

if [ ! -f "$SERVER_ENTRY" ]; then
  echo "[tui-serve] ERROR: Server entry point not found: $SERVER_ENTRY" >&2
  echo "[tui-serve] Re-install the application." >&2
  exit 1
fi

# ── Source environment config (AUTH_TOKEN, PORT, BIND_HOST, etc.) ──
set -a
if [ -f "${CONFIG_DIR}/env" ]; then
  . "${CONFIG_DIR}/env"
fi
set +a

exec "${NODE_BIN}" "${SERVER_ENTRY}"