#!/usr/bin/env bash
# Lightweight checks for packaging script regressions.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

assert_contains() {
  local file="$1"
  local pattern="$2"
  local label="$3"

  if grep -Fq "$pattern" "$file"; then
    echo "✅ $label"
  else
    echo "❌ $label" >&2
    echo "   Missing pattern: $pattern" >&2
    exit 1
  fi
}

BUILD_DEB="$PROJECT_DIR/packaging/build-deb.sh"
BUILD_MACOS="$PROJECT_DIR/packaging/build-macos.sh"
POSTINST="$PROJECT_DIR/packaging/debian/postinst"
SERVICE="$PROJECT_DIR/packaging/debian/systemd/remote-agent-tui.service"
DOCTOR="$PROJECT_DIR/packaging/scripts/doctor.sh"
USER_INSTALL="$PROJECT_DIR/packaging/scripts/install-user-service.sh"
USER_SERVICE="$PROJECT_DIR/packaging/systemd/remote-agent-tui-user.service"

assert_contains "$BUILD_DEB" 'server/node_modules/." "${PKG_DIR}/usr/lib/remote-agent-tui/server/node_modules/"' \
  ".deb copies node_modules contents, not nested directory"
assert_contains "$BUILD_DEB" 'node_modules/fastify/package.json' \
  ".deb validates fastify package layout"
assert_contains "$BUILD_DEB" 'node_modules/node_modules' \
  ".deb rejects nested node_modules"

assert_contains "$BUILD_MACOS" 'server/node_modules/." "${BUNDLE_DIR}/server/node_modules/"' \
  "macOS bundle copies node_modules contents, not nested directory"
assert_contains "$BUILD_MACOS" 'node_modules/fastify/package.json' \
  "macOS bundle validates fastify package layout"
assert_contains "$BUILD_MACOS" 'node_modules/node_modules' \
  "macOS bundle rejects nested node_modules"

assert_contains "$POSTINST" 'SUDO_USER' \
  "postinst derives installer user workspace root"
assert_contains "$POSTINST" 'allowedCwdRoots' \
  "postinst generates allowed workspace roots"
assert_contains "$POSTINST" 'ensure_installer_home_in_config' \
  "postinst migrates existing config with installer home"
assert_contains "$POSTINST" '/usr/share/doc/remote-agent-tui/install-user-service.sh' \
  "postinst prints user service install command"
assert_contains "$POSTINST" 'systemctl --system daemon-reload' \
  "postinst registers system unit without autostart"
if awk '
  /# ── systemd unit registration ──/ { in_block = 1 }
  in_block && /;;/ { in_block = 0 }
  in_block && /systemctl (enable|start|restart) remote-agent-tui/ { found = 1 }
  END { exit found ? 0 : 1 }
' "$POSTINST"; then
  echo "❌ postinst must not enable/start system service by default" >&2
  exit 1
else
  echo "✅ postinst does not enable/start system service by default"
fi

assert_contains "$SERVICE" 'StartLimitIntervalSec=60' \
  "systemd limits restart-loop interval"
assert_contains "$SERVICE" 'StartLimitBurst=5' \
  "systemd limits restart-loop burst"

assert_contains "$DOCTOR" 'fastify' \
  "doctor checks fastify runtime dependency"
assert_contains "$DOCTOR" '@fastify/static' \
  "doctor checks @fastify/static runtime dependency"
assert_contains "$DOCTOR" 'node_modules/node_modules' \
  "doctor detects nested node_modules layout"

assert_contains "$USER_INSTALL" 'systemctl --user enable --now' \
  "user installer enables user service"
assert_contains "$USER_INSTALL" '"commands": [' \
  "user installer writes array-based config"
assert_contains "$USER_INSTALL" 'allowedCwdRoots": ["$HOME", "/tmp"]' \
  "user installer defaults roots to user home"
assert_contains "$USER_SERVICE" 'WorkingDirectory=%h/.local/share/remote-agent-tui/server' \
  "user service runs from user-local server dir"
assert_contains "$USER_SERVICE" 'REMOTE_AGENT_TUI_DATA_DIR=%h/.local/share/remote-agent-tui/data' \
  "user service stores data in user-local dir"

echo "Packaging script checks passed."
