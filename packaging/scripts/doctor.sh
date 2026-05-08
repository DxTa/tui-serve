#!/usr/bin/env bash
# doctor.sh — Health check script for tui-serve
# Run this to diagnose common installation issues.
#
# Usage: sudo ./packaging/scripts/doctor.sh
#     or: sudo /usr/share/doc/tui-serve/doctor.sh (after .deb install)

set -euo pipefail

PASS=0
FAIL=0
WARN=0

# Detect if we're running from the installed package or from source
if [ -x /usr/lib/tui-serve/node/bin/node ]; then
  NODE_BIN="/usr/lib/tui-serve/node/bin/node"
  APP_DIR="/usr/lib/tui-serve/server"
else
  echo "  ⚠️  Running in development mode (no installed package found)"
  NODE_BIN="$(command -v node 2>/dev/null || echo "")"
  APP_DIR=""
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

echo "=== TUI Serve — Doctor ==="
echo ""

echo "── Node.js ──"
if [ -x /usr/lib/tui-serve/node/bin/node ]; then
  BUNDLED_VERSION=$(/usr/lib/tui-serve/node/bin/node --version 2>/dev/null || echo "unknown")
  echo "  ✅ Bundled Node.js: ${BUNDLED_VERSION}"
  PASS=$((PASS + 1))
else
  echo "  ❌ Bundled Node.js not found at /usr/lib/tui-serve/node/bin/node"
  FAIL=$((FAIL + 1))
  # Fall back to system Node
  check "System Node.js" "which node"
  check "System Node.js >= 22" "node --version" "v22\|v23\|v24"
fi
echo ""

echo "── glibc / libstdc++ compatibility ──"
# Check glibc version (minimum 2.31 for Ubuntu 20.04 / Debian 11)
GLIBC_VER=$(ldd --version 2>&1 | head -1 | grep -oP '[\d.]+$' || echo "unknown")
GLIBC_MAJOR=$(echo "$GLIBC_VER" | cut -d. -f1)
GLIBC_MINOR=$(echo "$GLIBC_VER" | cut -d. -f2)

if [ "$GLIBC_VER" != "unknown" ]; then
  # Compare: need >= 2.31
  GLIBC_OK=true
  if [ "$GLIBC_MAJOR" -lt 2 ] 2>/dev/null; then
    GLIBC_OK=false
  elif [ "$GLIBC_MAJOR" -eq 2 ] && [ "$GLIBC_MINOR" -lt 31 ] 2>/dev/null; then
    GLIBC_OK=false
  fi

  if [ "$GLIBC_OK" = true ]; then
    echo "  ✅ glibc version: ${GLIBC_VER} (minimum: 2.31)"
    PASS=$((PASS + 1))
  else
    echo "  ❌ glibc version: ${GLIBC_VER} (minimum: 2.31 — TOO OLD)"
    echo "     This system's glibc is too old. Native modules require glibc >= 2.31."
    echo "     Supported: Ubuntu 20.04+, Debian 11+, or any glibc >= 2.31 system."
    FAIL=$((FAIL + 1))
  fi
else
  warn "Could not determine glibc version"
fi

# Check libstdc++ version (minimum GCC 10 / GLIBCXX_3.4.28)
if [ -f /usr/lib/x86_64-linux-gnu/libstdc++.so.6 ]; then
  GLIBCXX_MAX=$(strings /usr/lib/x86_64-linux-gnu/libstdc++.so.6 | grep -E '^GLIBCXX_[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1 | sed 's/GLIBCXX_//')
  if [ -n "$GLIBCXX_MAX" ]; then
    # Need GLIBCXX >= 3.4.28 (GCC 10)
    GLIBCXX_OK=true
    MAJOR=$(echo "$GLIBCXX_MAX" | cut -d. -f1)
    MINOR=$(echo "$GLIBCXX_MAX" | cut -d. -f2)
    PATCH=$(echo "$GLIBCXX_MAX" | cut -d. -f3)

    # Compare 3.4.28
    if [ "$MAJOR" -lt 3 ] 2>/dev/null; then
      GLIBCXX_OK=false
    elif [ "$MAJOR" -eq 3 ] && [ "$MINOR" -lt 4 ] 2>/dev/null; then
      GLIBCXX_OK=false
    elif [ "$MAJOR" -eq 3 ] && [ "$MINOR" -eq 4 ] && [ "$PATCH" -lt 28 ] 2>/dev/null; then
      GLIBCXX_OK=false
    fi

    if [ "$GLIBCXX_OK" = true ]; then
      echo "  ✅ libstdc++ GLIBCXX max: ${GLIBCXX_MAX} (minimum: 3.4.28 / GCC 10)"
      PASS=$((PASS + 1))
    else
      echo "  ❌ libstdc++ GLIBCXX max: ${GLIBCXX_MAX} (minimum: 3.4.28 — TOO OLD)"
      echo "     This system's libstdc++ is too old. Native modules require GLIBCXX >= 3.4.28."
      FAIL=$((FAIL + 1))
    fi
  else
    warn "Could not determine GLIBCXX version from libstdc++.so.6"
  fi
else
  warn "libstdc++.so.6 not found at standard path (non-x86_64 or unusual install)"
fi
echo ""

echo "── Runtime dependencies ──"
if [ -n "$NODE_BIN" ] && [ -n "$APP_DIR" ]; then
  if [ -d "${APP_DIR}/node_modules/node_modules" ]; then
    echo "  ❌ Invalid nested node_modules layout: ${APP_DIR}/node_modules/node_modules"
    echo "     Package was built with node_modules copied into itself. Rebuild package."
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
        echo "     Run: cd ${APP_DIR} && ${NODE_BIN} -e \"import('${DEP}')\""
        FAIL=$((FAIL + 1))
      fi
    else
      echo "  ❌ ${DEP}: missing from node_modules"
      FAIL=$((FAIL + 1))
    fi
  done
else
  warn "Cannot test runtime dependencies (bundled node/app not found)"
fi
echo ""

echo "── Native modules ──"
if [ -n "$NODE_BIN" ] && [ -n "$APP_DIR" ]; then
  # Test node-pty loadability
  if [ -d "${APP_DIR}/node_modules/node-pty" ]; then
    if (cd "${APP_DIR}" && "$NODE_BIN" -e "try { require('@homebridge/node-pty-prebuilt-multiarch') } catch (_) { require('node-pty') }") 2>/dev/null; then
      echo "  ✅ node-pty: loads successfully"
      PASS=$((PASS + 1))
    else
      echo "  ❌ node-pty: FAILED to load"
      echo "     This usually means a glibc ABI mismatch (forkpty requires glibc >= 2.31)."
      echo "     Run: ${NODE_BIN} -e \"require('node-pty')\" for details"
      FAIL=$((FAIL + 1))
    fi
  else
    warn "node-pty not found in node_modules"
  fi
else
  warn "Cannot test native modules (bundled node/app not found)"
fi
echo ""

echo "── System ──"
check "tmux installed" "which tmux"
check "tmux >= 3.0" "tmux -V" "3."
echo ""

echo "── Package ──"
check "App directory" "test -d /usr/lib/tui-serve/server"
check "Web assets" "test -d /usr/share/tui-serve/web"
check "Config file" "test -f /etc/tui-serve/default-config.json"
check "Env file" "test -f /etc/tui-serve/env"
echo ""

echo "── File ownership ──"
for DIR in /var/lib/tui-serve /var/log/tui-serve; do
  if [ -d "$DIR" ]; then
    OWNER=$(stat -c '%U:%G' "$DIR" 2>/dev/null || echo "unknown")
    if [ "$OWNER" = "tui-serve:tui-serve" ]; then
      echo "  ✅ $DIR owned by tui-serve:tui-serve"
      PASS=$((PASS + 1))
    else
      echo "  ⚠️  $DIR owned by $OWNER (expected tui-serve:tui-serve)"
      echo "     Fix: sudo chown -R tui-serve:tui-serve $DIR"
      WARN=$((WARN + 1))
    fi
  fi
done
echo ""

echo "── Auth ──"
if [ -f /etc/tui-serve/env ]; then
  AUTH_LINE=$(grep '^AUTH_TOKEN=' /etc/tui-serve/env 2>/dev/null || true)
  AUTH_VALUE="${AUTH_LINE#AUTH_TOKEN=}"
  if [ -z "$AUTH_VALUE" ]; then
    echo "  ⚠️  No auth token set — service is open to the network"
    WARN=$((WARN + 1))
  else
    echo "  ✅ Auth token is set"
    PASS=$((PASS + 1))
  fi
else
  warn "Env file not found — cannot check auth config"
fi
echo ""

echo "── Service ──"
check "systemd unit" "test -f /lib/systemd/system/tui-serve.service"
check "service enabled" "systemctl is-enabled tui-serve" "enabled"
check "service running" "systemctl is-active tui-serve" "active"
echo ""

echo "── Network ──"
check "Port 5555 listening" "ss -tlnp | grep ':5555'" "5555"
check "Health endpoint" "curl -sf http://localhost:5555/api/health" '"ok"'
echo ""

echo "── Data ──"
check "Data directory" "test -d /var/lib/tui-serve"
if [ -f /var/lib/tui-serve/sessions.db ]; then
  echo "  ✅ Database file"
  PASS=$((PASS + 1))
else
  warn "No sessions database yet (normal until the service starts or creates first session)"
fi
echo ""

echo "── Recent errors ──"
if command -v journalctl >/dev/null 2>&1; then
  ERRORS=$(journalctl -u tui-serve --no-pager -n 10 -p err 2>/dev/null || true)
  if [ -n "$ERRORS" ]; then
    echo "  Recent error logs:"
    echo "$ERRORS" | head -10 | sed 's/^/    /'
  else
    echo "  ✅ No recent error logs"
    PASS=$((PASS + 1))
  fi
else
  warn "journalctl not available"
fi
echo ""

echo "── Optional ──"
check "Caddy installed" "which caddy" "" || warn "Caddy not installed (needed for HTTPS)"
check "Tailscale installed" "which tailscale" "" || warn "Tailscale not installed (recommended for private networking)"
echo ""

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
  echo "✅ All checks passed! TUI Serve is healthy."
  exit 0
fi