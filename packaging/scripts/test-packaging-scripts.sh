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
SERVICE="$PROJECT_DIR/packaging/debian/systemd/tui-serve.service"
DOCTOR="$PROJECT_DIR/packaging/scripts/doctor.sh"
USER_INSTALL="$PROJECT_DIR/packaging/scripts/install-user-service.sh"
USER_SERVICE="$PROJECT_DIR/packaging/systemd/tui-serve-user.service"

assert_contains "$BUILD_DEB" 'server/node_modules/." "${PKG_DIR}/usr/lib/tui-serve/server/node_modules/"' \
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
assert_contains "$POSTINST" '/usr/share/doc/tui-serve/install-user-service.sh' \
  "postinst prints user service install command"
assert_contains "$POSTINST" 'systemctl --system daemon-reload' \
  "postinst registers system unit without autostart"
if awk '
  /# ── systemd unit registration ──/ { in_block = 1 }
  in_block && /;;/ { in_block = 0 }
  in_block && /systemctl (enable|start|restart) tui-serve/ { found = 1 }
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
assert_contains "$USER_INSTALL" 'default_allowed_roots()' \
  "user installer computes default roots"
assert_contains "$USER_INSTALL" 'TUI_SERVE_ALLOWED_ROOTS' \
  "user installer allows env override for roots"
assert_contains "$USER_SERVICE" 'WorkingDirectory=%h/.local/share/tui-serve/server' \
  "user service runs from user-local server dir"
assert_contains "$USER_SERVICE" 'TUI_SERVE_DATA_DIR=%h/.local/share/tui-serve/data' \
  "user service stores data in user-local dir"

# ── macOS build script assertions ──
assert_contains "$BUILD_MACOS" 'MACOSX_DEPLOYMENT_TARGET' \
  "macOS build sets deployment target"
assert_contains "$BUILD_MACOS" 'codesign' \
  "macOS build ad-hoc signs native binaries"
assert_contains "$BUILD_MACOS" 'tui-serve.sh' \
  "macOS build includes launcher wrapper"
assert_contains "$BUILD_MACOS" 'doctor-macos' \
  "macOS build includes doctor script"
assert_contains "$BUILD_MACOS" 'shasum' \
  "macOS build generates SHA256 checksums"
assert_contains "$BUILD_MACOS" 'audit_minos' \
  "macOS build runs ABI audit"

# ── macOS installer assertions ──
MACOS_INSTALL="$PROJECT_DIR/packaging/macos/install-macos.sh"
assert_contains "$MACOS_INSTALL" 'xattr -cr' \
  "macOS installer strips quarantine"
assert_contains "$MACOS_INSTALL" 'tmux' \
  "macOS installer checks tmux prerequisite"
assert_contains "$MACOS_INSTALL" 'tui-serve.sh' \
  "macOS installer installs launcher wrapper"
assert_contains "$MACOS_INSTALL" 'xattr -cr' \
  "macOS installer strips quarantine"
assert_contains "$MACOS_INSTALL" '/../..' \
  "macOS installer resolves bundle root via deploy/scripts path"

# ── macOS plist assertions ──
PLIST="$PROJECT_DIR/packaging/macos/com.tui-serve.plist"
assert_contains "$PLIST" 'tui-serve.sh' \
  "plist invokes launcher wrapper"
assert_contains "$PLIST" 'KeepAlive' \
  "plist has KeepAlive key"

# ── macOS doctor assertions ──
MACOS_DOCTOR="$PROJECT_DIR/packaging/macos/doctor-macos.sh"
assert_contains "$MACOS_DOCTOR" 'node-pty' \
  "macOS doctor checks node-pty loadability"
assert_contains "$MACOS_DOCTOR" 'launchctl' \
  "macOS doctor checks launchd service status"
assert_contains "$MACOS_DOCTOR" 'xattr' \
  "macOS doctor checks quarantine attributes"
assert_contains "$MACOS_DOCTOR" 'lsof' \
  "macOS doctor checks port availability"
assert_contains "$MACOS_DOCTOR" 'AUTH_TOKEN' \
  "macOS doctor checks auth token from env file"
assert_contains "$MACOS_DOCTOR" 'sw_vers' \
  "macOS doctor checks macOS version"

# ── macOS launcher wrapper assertions ──
LAUNCHER="$PROJECT_DIR/packaging/macos/tui-serve.sh"
assert_contains "$LAUNCHER" '. "${CONFIG_DIR}/env"' \
  "launcher wrapper sources env file"
assert_contains "$LAUNCHER" 'set -a' \
  "launcher wrapper exports env variables"
assert_contains "$LAUNCHER" 'exec' \
  "launcher wrapper execs into node"
assert_contains "$LAUNCHER" 'NODE_BIN' \
  "launcher wrapper checks node binary exists"

# ── macOS uninstaller assertions ──
MACOS_UNINSTALL="$PROJECT_DIR/packaging/macos/uninstall-macos.sh"
assert_contains "$MACOS_UNINSTALL" 'launchctl unload' \
  "macOS uninstaller stops launchd service"
assert_contains "$MACOS_UNINSTALL" 'rm -rf' \
  "macOS uninstaller removes application files"

echo "Packaging script checks passed."
