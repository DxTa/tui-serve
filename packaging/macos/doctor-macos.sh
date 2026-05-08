#!/usr/bin/env bash
# doctor-macos.sh — Health check script for remote-agent-tui on macOS
#
# Run this to diagnose common installation issues on macOS.
#
# Usage: ./packaging/macos/doctor-macos.sh
#     or: /usr/local/opt/remote-agent-tui/deploy/scripts/doctor-macos.sh (after install)

set -euo pipefail

PASS=0
FAIL=0
WARN=0

INSTALL_BASE="/usr/local/opt/remote-agent-tui"
CONFIG_DIR="/usr/local/etc/remote-agent-tui"
APP_LOG_DIR="/usr/local/var/log/remote-agent-tui"
DATA_DIR="/usr/local/var/lib/remote-agent-tui"
LOG_DIR="/usr/local/var/log"

# Detect if we're running from the installed package or from source
if [ -x "${INSTALL_BASE}/node/bin/node" ]; then
  NODE_BIN="${INSTALL_BASE}/node/bin/node"
  APP_DIR="${INSTALL_BASE}/server"
  LAUNCHER="${INSTALL_BASE}/bin/remote-agent-tui.sh"
else
  echo "  ⚠️  Running in development mode (no installed package found)"
  NODE_BIN="$(command -v node 2>/dev/null || echo "")"
  APP_DIR=""
  LAUNCHER=""
fi

check() {
  local label="$1"
  local cmd="$2"
  local expected="${3:-}"

  if eval "$cmd" >/dev/null 2>&1; then
    if [ -n "$expected" ]; then
      result="$(eval "$cmd" 2>/dev/null || true)"
      if echo "$result" | grep -q "$expected"; then
        echo "  ✅ $label"
        PASS=$((PASS + 1))
      else
        echo "  ❌ $label (got: $result, expected: $expected)"
        FAIL=$((FAIL + 1))
      fi
    else
      echo "  ✅ $label"
      PASS=$((PASS + 1))
    fi
  else
    echo "  ❌ $label"
    FAIL=$((FAIL + 1))
  fi
}

warn() {
  local label="$1"
  echo "  ⚠️  $label"
  WARN=$((WARN + 1))
}

echo "=== Remote Agent TUI — macOS Doctor ==="
echo ""

# ── macOS version ──
echo "── macOS version ──"
MACOS_VERSION="$(sw_vers -productVersion 2>/dev/null || echo "unknown")"
if [ "$MACOS_VERSION" != "unknown" ]; then
  MACOS_MAJOR="$(echo "$MACOS_VERSION" | cut -d. -f1)"
  if [ "$MACOS_MAJOR" -ge 12 ] 2>/dev/null; then
    echo "  ✅ macOS ${MACOS_VERSION} (minimum: 12.0 Monterey)"
    PASS=$((PASS + 1))
  else
    echo "  ❌ macOS ${MACOS_VERSION} (minimum: 12.0 Monterey — TOO OLD)"
    echo "     Apple Silicon Macs require macOS 12+. Intel Macs may work but are unsupported."
    FAIL=$((FAIL + 1))
  fi
else
  warn "Could not determine macOS version"
fi

MACOS_ARCH="$(uname -m)"
echo "  ℹ️  Architecture: ${MACOS_ARCH}"
echo ""

# ── Bundled Node.js ──
echo "── Bundled Node.js ──"
if [ -x "${INSTALL_BASE}/node/bin/node" ]; then
  BUNDLED_VERSION="$("${INSTALL_BASE}/node/bin/node" --version 2>/dev/null || echo "unknown")"
  BUNDLED_ARCH="$("${INSTALL_BASE}/node/bin/node" -e "console.log(process.arch)" 2>/dev/null || echo "unknown")"
  echo "  ✅ Bundled Node.js: ${BUNDLED_VERSION} (${BUNDLED_ARCH})"
  PASS=$((PASS + 1))

  if [ "$BUNDLED_ARCH" = "arm64" ] && [ "$MACOS_ARCH" = "arm64" ]; then
    echo "  ✅ Node.js architecture matches system (arm64)"
    PASS=$((PASS + 1))
  elif [ "$BUNDLED_ARCH" = "x64" ] && [ "$MACOS_ARCH" = "x86_64" ]; then
    echo "  ✅ Node.js architecture matches system (x64)"
    PASS=$((PASS + 1))
  elif [ "$BUNDLED_ARCH" = "arm64" ] && [ "$MACOS_ARCH" = "x86_64" ]; then
    echo "  ⚠️  Node.js is arm64 but system is x86_64 (running under Rosetta?)"
    WARN=$((WARN + 1))
  else
    echo "  ❌ Node.js ${BUNDLED_ARCH} may not match system ${MACOS_ARCH}"
    FAIL=$((FAIL + 1))
  fi
else
  echo "  ❌ Bundled Node.js not found at ${INSTALL_BASE}/node/bin/node"
  FAIL=$((FAIL + 1))
  check "System Node.js" "which node"
  check "System Node.js >= 22" "node --version" "v22\|v23\|v24"
fi
echo ""

# ── Native modules ──
echo "── Native modules ──"
if [ -n "$NODE_BIN" ] && [ -n "$APP_DIR" ]; then
  # Test node-pty loadability
  if [ -d "${APP_DIR}/node_modules/node-pty" ]; then
    if (cd "${APP_DIR}" && "$NODE_BIN" -e "import('node-pty').then(() => console.log('ok'))") 2>/dev/null | grep -q ok; then
      echo "  ✅ node-pty: loads successfully"
      PASS=$((PASS + 1))
    else
      echo "  ❌ node-pty: FAILED to load"
      echo "     This usually means a deployment target or architecture mismatch."
      echo "     Run: ${NODE_BIN} -e \"import('node-pty')\" for details"
      FAIL=$((FAIL + 1))
    fi
  else
    warn "node-pty not found in node_modules"
  fi
else
  warn "Cannot test native modules (bundled node/app not found)"
fi
echo ""

# ── Runtime dependencies ──
echo "── Runtime dependencies ──"
check "tmux installed" "which tmux"
check "tmux >= 3.0" "tmux -V" "3."

if [ -n "$NODE_BIN" ] && [ -n "$APP_DIR" ]; then
  if [ -d "${APP_DIR}/node_modules" ]; then
    if [ -d "${APP_DIR}/node_modules/node_modules" ]; then
      echo "  ❌ Invalid nested node_modules layout"
      FAIL=$((FAIL + 1))
    else
      echo "  ✅ node_modules layout is flat"
      PASS=$((PASS + 1))
    fi

    for DEP in fastify @fastify/static; do
      if [ -f "${APP_DIR}/node_modules/${DEP}/package.json" ]; then
        if (cd "${APP_DIR}" && "$NODE_BIN" -e "import('${DEP}')") 2>/dev/null; then
          echo "  ✅ ${DEP}: imports successfully"
          PASS=$((PASS + 1))
        else
          echo "  ❌ ${DEP}: FAILED to import"
          FAIL=$((FAIL + 1))
        fi
      else
        echo "  ❌ ${DEP}: missing from node_modules"
        FAIL=$((FAIL + 1))
      fi
    done
  fi
fi
echo ""

# ── Launcher wrapper ──
echo "── Launcher wrapper ──"
if [ -n "${LAUNCHER}" ] && [ -f "${LAUNCHER}" ]; then
  echo "  ✅ Launcher wrapper: ${LAUNCHER}"
  PASS=$((PASS + 1))
  if [ -x "${LAUNCHER}" ]; then
    echo "  ✅ Launcher wrapper is executable"
    PASS=$((PASS + 1))
  else
    echo "  ❌ Launcher wrapper is NOT executable"
    echo "     Fix: chmod 755 ${LAUNCHER}"
    FAIL=$((FAIL + 1))
  fi
  # Check launcher references correct paths
  if grep -q 'INSTALL_BASE="/usr/local/opt/remote-agent-tui"' "${LAUNCHER}"; then
    echo "  ✅ Launcher references correct install base"
    PASS=$((PASS + 1))
  else
    echo "  ⚠️  Launcher may reference wrong install base"
    WARN=$((WARN + 1))
  fi
elif [ -n "${LAUNCHER}" ]; then
  echo "  ❌ Launcher wrapper not found at ${LAUNCHER}"
  FAIL=$((FAIL + 1))
else
  warn "Cannot check launcher (no installed package)"
fi
echo ""

# ── Configuration ──
echo "── Configuration ──"
if [ -f "${CONFIG_DIR}/env" ]; then
  echo "  ✅ Config env file: ${CONFIG_DIR}/env"
  PASS=$((PASS + 1))

  AUTH_LINE="$(grep '^AUTH_TOKEN=' "${CONFIG_DIR}/env" 2>/dev/null || true)"
  AUTH_VALUE="${AUTH_LINE#AUTH_TOKEN=}"
  if [ -z "$AUTH_VALUE" ]; then
    echo "  ⚠️  No auth token set — service is open to the network"
    WARN=$((WARN + 1))
  else
    echo "  ✅ Auth token is set"
    PASS=$((PASS + 1))
  fi
else
  echo "  ❌ Config env file not found at ${CONFIG_DIR}/env"
  FAIL=$((FAIL + 1))
fi

check "Config file" "test -f ${CONFIG_DIR}/default-config.json"
echo ""

# ── launchd service ──
echo "── launchd service ──"
PLIST_PATH="$HOME/Library/LaunchAgents/com.remote-agent-tui.plist"
if [ -f "$PLIST_PATH" ]; then
  echo "  ✅ launchd plist: ${PLIST_PATH}"
  PASS=$((PASS + 1))

  # Check plist uses launcher wrapper, not direct node invocation
  if grep -q 'remote-agent-tui.sh' "$PLIST_PATH"; then
    echo "  ✅ plist invokes launcher wrapper"
    PASS=$((PASS + 1))
  else
    echo "  ⚠️  plist uses direct node invocation (consider updating to launcher wrapper)"
    WARN=$((WARN + 1))
  fi

  # Check launchctl service status
  SERVICE_STATUS="$(launchctl list 2>/dev/null | grep 'com.remote-agent-tui' || true)"
  if [ -n "$SERVICE_STATUS" ]; then
    echo "  ✅ Service is loaded in launchctl"
    PASS=$((PASS + 1))

    # Extract PID
    PID="$(echo "$SERVICE_STATUS" | awk '{print $1}')"
    if [ "$PID" != "-" ] && [ "$PID" != "0" ] 2>/dev/null; then
      echo "  ✅ Service is running (PID: ${PID})"
      PASS=$((PASS + 1))
    else
      echo "  ⚠️  Service is loaded but may not be running"
      WARN=$((WARN + 1))
    fi
  else
    echo "  ⚠️  Service plist exists but is not loaded"
    echo "     Load with: launchctl load ${PLIST_PATH}"
    WARN=$((WARN + 1))
  fi
else
  echo "  ❌ launchd plist not found at ${PLIST_PATH}"
  echo "     Run ./deploy/scripts/install-macos.sh to install"
  FAIL=$((FAIL + 1))
fi
echo ""

# ── Quarantine ──
echo "── macOS quarantine ──"
check_xattr() {
  local file="$1"
  local label="$2"
  if [ -e "$file" ]; then
    QUARANTINE="$(xattr -p com.apple.quarantine "$file" 2>/dev/null || true)"
    if [ -n "$QUARANTINE" ]; then
      echo "  ❌ ${label}: has quarantine attribute"
      echo "     Fix: xattr -cr /usr/local/opt/remote-agent-tui"
      FAIL=$((FAIL + 1))
    else
      echo "  ✅ ${label}: no quarantine attribute"
      PASS=$((PASS + 1))
    fi
  fi
}

if [ -d "${INSTALL_BASE}" ]; then
  # Check key binaries for quarantine
  check_xattr "${INSTALL_BASE}/node/bin/node" "Node.js binary"
  check_xattr "${INSTALL_BASE}/bin/remote-agent-tui.sh" "Launcher wrapper"

  # Check if any .node files have quarantine
  NODE_FILES="$(find "${INSTALL_BASE}" -name '*.node' -type f 2>/dev/null || true)"
  QUARANTINE_COUNT=0
  for f in $NODE_FILES; do
    QUARANTINE="$(xattr -p com.apple.quarantine "$f" 2>/dev/null || true)"
    if [ -n "$QUARANTINE" ]; then
      QUARANTINE_COUNT=$((QUARANTINE_COUNT + 1))
      echo "  ❌ $(basename "$f"): has quarantine attribute"
    fi
  done
  if [ "$QUARANTINE_COUNT" -eq 0 ] && [ -n "$NODE_FILES" ]; then
    echo "  ✅ No .node files have quarantine attributes"
    PASS=$((PASS + 1))
  elif [ "$QUARANTINE_COUNT" -gt 0 ]; then
    echo "     Fix: xattr -cr ${INSTALL_BASE}"
    FAIL=$((FAIL + 1))
  fi
else
  warn "Install base not found — cannot check quarantine"
fi
echo ""

# ── Network ──
echo "── Network ──"
if [ -f "${CONFIG_DIR}/env" ]; then
  CONFIG_PORT="$(grep '^PORT=' "${CONFIG_DIR}/env" 2>/dev/null | head -1 | cut -d= -f2 || true)"
  CONFIG_PORT="${CONFIG_PORT:-5555}"
else
  CONFIG_PORT="${PORT:-5555}"
fi
echo "  ℹ️  Configured port: ${CONFIG_PORT}"
if command -v lsof >/dev/null 2>&1; then
  PORT_CHECK="$(lsof -i :"${CONFIG_PORT}" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$PORT_CHECK" ]; then
    LISTEN_PROC="$(echo "$PORT_CHECK" | awk 'NR==2 {print $1}' || true)"
    echo "  ✅ Port ${CONFIG_PORT} is listening (${LISTEN_PROC})"
    PASS=$((PASS + 1))
  else
    echo "  ⚠️  Port ${CONFIG_PORT} is not listening"
    echo "  ⚠️  Start the service: launchctl kickstart -k gui/$(id -u)/com.remote-agent-tui"
    WARN=$((WARN + 1))
  fi
else
  warn "lsof not available — cannot check port"
fi

if command -v curl >/dev/null 2>&1; then
  HEALTH="$(curl -sf "http://localhost:${CONFIG_PORT}/api/health" 2>/dev/null || true)"
  if echo "$HEALTH" | grep -q 'ok'; then
    echo "  ✅ Health endpoint responding"
    PASS=$((PASS + 1))
  else
    echo "  ⚠️  Health endpoint not responding on port ${CONFIG_PORT}"
    WARN=$((WARN + 1))
  fi
fi
echo ""

# ── Data directory ──
echo "── Data ──"
check "Data directory" "test -d ${DATA_DIR}"
if [ -d "${DATA_DIR}" ]; then
  OWNER="$(stat -f '%Su:%Sg' "${DATA_DIR}" 2>/dev/null || echo "unknown")"
  echo "  ℹ️  Data directory owner: ${OWNER}"
fi
echo ""

# ── Recent errors ──
echo "── Recent errors ──"
ERR_LOG="${APP_LOG_DIR}/remote-agent-tui.err"
if [ -f "$ERR_LOG" ]; then
  RECENT_ERRORS="$(tail -5 "$ERR_LOG" 2>/dev/null || true)"
  if [ -n "$RECENT_ERRORS" ]; then
    echo "  Recent error log entries:"
    echo "$RECENT_ERRORS" | sed 's/^/    /'
    WARN=$((WARN + 1))
  else
    echo "  ✅ No recent errors in log"
    PASS=$((PASS + 1))
  fi
else
  echo '  No error log found (service may not have started yet)'
fi
echo ""

# ── Optional ──
echo "── Optional ──"
check "Tailscale installed" "which tailscale"
echo ""

# ── Summary ──
echo "=== Summary ==="
echo "  Passed:   $PASS"
echo "  Failed:   $FAIL"
echo "  Warnings: $WARN"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo "❌ Some checks failed. Fix the issues above, then re-run this script."
  exit 1
elif [ "$WARN" -gt 0 ]; then
  echo "⚠️  All critical checks passed, but there are warnings."
  exit 0
else
  echo "✅ All checks passed! Remote Agent TUI is healthy."
  exit 0
fi