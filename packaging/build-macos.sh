#!/usr/bin/env bash
# build-macos.sh — Build a macOS .tar.gz bundle for tui-serve
#
# Bundles Node.js 22 LTS so the package is fully self-contained.
# Produces: packaging/dist/tui-serve_VERSION_macos-arm64.tar.gz
#
# Usage:
#   ./packaging/build-macos.sh [VERSION] [NODE_VERSION]
#
#   VERSION      — Package version (default: from server/package.json or git tag)
#   NODE_VERSION — Node.js version to bundle (default: 22.15.0)
#
# Prerequisites (macOS):
#   - Node.js 22+ and npm (for build only)
#   - Xcode Command Line Tools
#   - tmux (brew install tmux — for dev/test, not needed for build)
#   - build tools for native modules (handled by Xcode CLI tools)
#
# Run on macOS (arm64 recommended for Apple Silicon bundle).

set -euo pipefail

# ── macOS deployment target ──
# Ensures native modules (node-pty) target macOS 12+ (Monterey).
# All Apple Silicon Macs run macOS 12+, so this is a safe minimum.
export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-12.0}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VERSION="${1:-}"
NODE_VERSION="${2:-${NODE_VERSION:-22.15.0}}"

# ── Detect macOS architecture ──
MACOS_ARCH="$(uname -m)"
case "$MACOS_ARCH" in
  arm64) NODE_ARCH="arm64"; PKG_ARCH="arm64" ;;
  x86_64) NODE_ARCH="x64"; PKG_ARCH="x64" ;;
  *) echo "Error: unsupported architecture '$MACOS_ARCH'" >&2; exit 1 ;;
esac

# ── Resolve version ──
if [ -z "$VERSION" ]; then
  if git -C "$PROJECT_DIR" describe --tags --exact-match >/dev/null 2>&1; then
    VERSION="$(git -C "$PROJECT_DIR" describe --tags --exact-match | sed 's/^v//')"
  else
    VERSION="$(node -e "console.log(require('$PROJECT_DIR/server/package.json').version)")"
  fi
fi
VERSION="${VERSION#v}"

NODE_TARBALL="node-v${NODE_VERSION}-darwin-${NODE_ARCH}"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}.tar.gz"

PKG_NAME="tui-serve"
BUNDLE_NAME="${PKG_NAME}-${VERSION}-macos-${PKG_ARCH}"
BUILD_DIR="${PROJECT_DIR}/packaging/build"
BUNDLE_DIR="${BUILD_DIR}/${BUNDLE_NAME}"
NODE_CACHE="${BUILD_DIR}/node-cache"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Building ${BUNDLE_NAME}.tar.gz                          "
echo "║  Bundled Node.js: v${NODE_VERSION} (darwin-${NODE_ARCH})  "
echo "║  Deployment target: macOS ${MACOSX_DEPLOYMENT_TARGET}    "
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "Project dir:  $PROJECT_DIR"
echo "Bundle dir:   $BUNDLE_DIR"
echo ""

# ── Clean previous build ──
if [ -d "${BUNDLE_DIR}" ]; then
  chmod -R u+w "${BUNDLE_DIR}" 2>/dev/null || true
  rm -rf "${BUNDLE_DIR}"
fi

# ── Stage 0: Download/bundle Node.js ──
echo ">>> Bundling Node.js v${NODE_VERSION} (darwin-${NODE_ARCH})..."
mkdir -p "${NODE_CACHE}"
NODE_TARBALL_PATH="${NODE_CACHE}/${NODE_TARBALL}.tar.gz"

if [ -f "$NODE_TARBALL_PATH" ]; then
  echo "    Using cached: ${NODE_TARBALL_PATH}"
else
  echo "    Downloading: ${NODE_URL}"
  curl -fSL --progress-bar -o "$NODE_TARBALL_PATH" "$NODE_URL"
fi

# Extract ONLY the node binary
NODE_EXTRACT="${NODE_CACHE}/${NODE_TARBALL}"
mkdir -p "$NODE_EXTRACT"
tar -xzf "$NODE_TARBALL_PATH" -C "$NODE_EXTRACT" \
  --strip-components=1 \
  "${NODE_TARBALL}/bin/node"

NODE_BIN_SIZE=$(du -sh "${NODE_EXTRACT}/bin/node" | cut -f1)
echo "    Node.js binary: ${NODE_BIN_SIZE} ✓"

# ── Stage 1: Install all workspace dependencies ──
# This project uses npm workspaces (root package.json defines workspaces for
# packages/shared, server, and tui-web). Dependencies are hoisted to the root
# node_modules/ by npm, so install and prune from the project root.
echo ">>> Installing workspace dependencies..."
cd "${PROJECT_DIR}"
npm ci 2>/dev/null || npm install
echo "    Workspace dependencies installed ✓"

# ── Stage 1.5: Build shared package ──
echo ">>> Building shared package..."
cd "${PROJECT_DIR}/packages/shared"
npm run build
echo "    Shared package built ✓"

# ── Stage 2: Build frontend ──
echo ">>> Building frontend..."
cd "${PROJECT_DIR}/tui-web"
npm run build
cd "${PROJECT_DIR}"
npm run validate:web-dist
echo "    Frontend built ✓"

# ── Stage 3: Build backend ──
echo ">>> Building backend..."
cd "${PROJECT_DIR}/server"

# Clean stale artifacts (e.g., old better-sqlite3 db.* from removed dependency)
rm -f dist/db.js dist/db.d.ts dist/db.js.map

npm run build
echo "    Backend built ✓"

# ── Stage 4: Prune devDependencies ──
echo ">>> Pruning devDependencies..."
cd "${PROJECT_DIR}"
npm prune --omit=dev 2>/dev/null || true
echo "    Production node_modules ready ✓"

# ── Stage 4: Assemble bundle ──
echo ">>> Assembling macOS bundle..."

# -- Bundled Node.js --
mkdir -p "${BUNDLE_DIR}/node/bin"
cp "${NODE_EXTRACT}/bin/node" "${BUNDLE_DIR}/node/bin/node"
chmod 755 "${BUNDLE_DIR}/node/bin/node"

# -- Application code --
mkdir -p "${BUNDLE_DIR}/server/dist"
mkdir -p "${BUNDLE_DIR}/server/node_modules"
cp -R "${PROJECT_DIR}/server/dist/"* "${BUNDLE_DIR}/server/dist/"
cp "${PROJECT_DIR}/server/package.json" "${BUNDLE_DIR}/server/"
cp "${PROJECT_DIR}/server/package-lock.json" "${BUNDLE_DIR}/server/"
# Copy root node_modules first (contains hoisted production deps like fastify,
# ws, zod, node-pty) then overlay server/node_modules if present.
cp -a "${PROJECT_DIR}/node_modules/." "${BUNDLE_DIR}/server/node_modules/"
if [ -d "${PROJECT_DIR}/server/node_modules" ]; then
  cp -a "${PROJECT_DIR}/server/node_modules/." "${BUNDLE_DIR}/server/node_modules/"
fi

# Resolve workspace symlinks that would be broken inside the bundle.
BUNDLE_NM="${BUNDLE_DIR}/server/node_modules"
if [ -L "${BUNDLE_NM}/@tui-serve/shared" ]; then
  SHARED_TARGET="$(readlink -f "${PROJECT_DIR}/node_modules/@tui-serve/shared")"
  rm "${BUNDLE_NM}/@tui-serve/shared"
  cp -a "${SHARED_TARGET}" "${BUNDLE_NM}/@tui-serve/shared"
fi

# Remove root workspace self-link (not needed at runtime)
rm -f "${BUNDLE_NM}/tui-serve-server"
cp "${PROJECT_DIR}/server/default-config.json" "${BUNDLE_DIR}/server/"

# -- Frontend --
mkdir -p "${BUNDLE_DIR}/web"
cp -R "${PROJECT_DIR}/tui-web/dist/"* "${BUNDLE_DIR}/web/"

# -- macOS-specific deploy files --
mkdir -p "${BUNDLE_DIR}/deploy/launchd"
mkdir -p "${BUNDLE_DIR}/deploy/scripts"
cp "${PROJECT_DIR}/packaging/macos/com.tui-serve.plist" \
   "${BUNDLE_DIR}/deploy/launchd/"
cp "${PROJECT_DIR}/packaging/macos/install-macos.sh" \
   "${BUNDLE_DIR}/deploy/scripts/"
cp "${PROJECT_DIR}/packaging/macos/uninstall-macos.sh" \
   "${BUNDLE_DIR}/deploy/scripts/"
cp "${PROJECT_DIR}/packaging/macos/doctor-macos.sh" \
   "${BUNDLE_DIR}/deploy/scripts/"
chmod +x "${BUNDLE_DIR}/deploy/scripts/install-macos.sh"
chmod +x "${BUNDLE_DIR}/deploy/scripts/uninstall-macos.sh"
chmod +x "${BUNDLE_DIR}/deploy/scripts/doctor-macos.sh"

# -- Launcher wrapper --
mkdir -p "${BUNDLE_DIR}/bin"
cp "${PROJECT_DIR}/packaging/macos/tui-serve.sh" \
   "${BUNDLE_DIR}/bin/tui-serve.sh"
chmod 755 "${BUNDLE_DIR}/bin/tui-serve.sh"

# -- Documentation --
cp "${PROJECT_DIR}/README.md" "${BUNDLE_DIR}/"

echo "    Bundle assembled ✓"

# ── Stage 4.5: Bundle layout sanity checks ──
echo ">>> Bundle layout sanity checks..."
SERVER_DIR="${BUNDLE_DIR}/server"

if [ ! -f "${SERVER_DIR}/node_modules/fastify/package.json" ]; then
  echo "❌ Missing runtime dependency: ${SERVER_DIR}/node_modules/fastify/package.json" >&2
  echo "   Check node_modules copy layout and production dependency pruning." >&2
  exit 1
fi

if [ -d "${SERVER_DIR}/node_modules/node_modules" ]; then
  echo "❌ Invalid nested node_modules layout: ${SERVER_DIR}/node_modules/node_modules" >&2
  echo "   This indicates a broken overlap of root + server node_modules." >&2
  exit 1
fi

(
  cd "${SERVER_DIR}"
  "${BUNDLE_DIR}/node/bin/node" -e "import('fastify').then(() => console.log('fastify import ok'))"
) >/dev/null

# Verify broken workspace symlinks were fully resolved
if [ -L "${BUNDLE_DIR}/server/node_modules/@tui-serve/shared" ]; then
  SHARED_LINK_TARGET="$(readlink "${BUNDLE_DIR}/server/node_modules/@tui-serve/shared")"
  echo "❌ Broken workspace symlink still present: @tui-serve/shared -> ${SHARED_LINK_TARGET}" >&2
  echo "   This symlink points outside node_modules and will not resolve at runtime." >&2
  exit 1
fi

# Check for stale better-sqlite3 artifacts
for STALE in db.js db.d.ts db.js.map; do
  if [ -f "${SERVER_DIR}/dist/${STALE}" ]; then
    echo "❌ Stale artifact found: ${SERVER_DIR}/dist/${STALE}" >&2
    echo "   This should have been cleaned during build. Removing now." >&2
    rm -f "${SERVER_DIR}/dist/${STALE}"
  fi
done

echo "    Bundle layout sane ✓"

# ── Stage 4.6: Ad-hoc code signing ──
echo ">>> Ad-hoc signing native binaries..."
# Ad-hoc signing provides integrity verification but does NOT bypass Gatekeeper.
# The install script handles Gatekeeper with xattr -cr.
CODESIGN_ERRORS=0
if command -v codesign >/dev/null 2>&1; then
  codesign -s - "${BUNDLE_DIR}/node/bin/node" 2>/dev/null || CODESIGN_ERRORS=$((CODESIGN_ERRORS + 1))
  find "${BUNDLE_DIR}" -name '*.node' -exec codesign -s - {} \; 2>/dev/null || CODESIGN_ERRORS=$((CODESIGN_ERRORS + 1))
  if [ "$CODESIGN_ERRORS" -eq 0 ]; then
    echo "    Ad-hoc signatures applied ✓"
  else
    echo "    ⚠️  Some binaries could not be signed (non-fatal)"
  fi
else
  echo "    ⚠️  codesign not available — skipping ad-hoc signing"
fi

# ── Stage 4.7: macOS ABI audit ──
echo ">>> macOS deployment target audit..."
MIN_MACOS_VERSION="${MACOSX_DEPLOYMENT_TARGET}"

audit_minos() {
  local file="$1" label="$2"
  # vtool shows LC_BUILD_VERSION minos for macOS 10.14+
  local minos
  minos=$(vtool -show "$file" 2>/dev/null | awk '/minos/ {print $2"."$3}' | head -1 || true)
  if [ -z "$minos" ]; then
    # Fallback: otool -l for older Mach-O format
    minos=$(otool -l "$file" 2>/dev/null | awk '/LC_VERSION_MIN_MACOSX/,+/' | awk '/version/ {print $2}' | head -1 || true)
  fi
  if [ -n "$minos" ]; then
    echo "  ✅ $label: minimum macOS $minos (target: $MIN_MACOS_VERSION)"
  else
    echo "  ⚠️  $label: could not determine deployment target"
  fi
}

audit_minos "${BUNDLE_DIR}/node/bin/node" "Node.js binary"
find "${BUNDLE_DIR}" -name '*.node' -type f | while read -r nodefile; do
  audit_minos "$nodefile" "$(basename "$nodefile")"
done

# ── Stage 5: Create .tar.gz ──
echo ">>> Creating .tar.gz archive..."

OUTPUT_DIR="${PROJECT_DIR}/packaging/dist"
mkdir -p "${OUTPUT_DIR}"

cd "${BUILD_DIR}"
tar -czf "${OUTPUT_DIR}/${BUNDLE_NAME}.tar.gz" "${BUNDLE_NAME}"

ARCHIVE_PATH="${OUTPUT_DIR}/${BUNDLE_NAME}.tar.gz"
ARCHIVE_SIZE=$(du -sh "$ARCHIVE_PATH" | cut -f1)

# ── Generate SHA256 checksum ──
echo ">>> Generating SHA256 checksum..."
cd "${OUTPUT_DIR}"
shasum -a 256 "${BUNDLE_NAME}.tar.gz" > "${BUNDLE_NAME}.tar.gz.sha256"
echo "    Checksum written to ${BUNDLE_NAME}.tar.gz.sha256 ✓"

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║            Build Complete!                               ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  Archive:  ${ARCHIVE_PATH}"
echo "║  Size:     ${ARCHIVE_SIZE}"
echo "║  Node.js:  v${NODE_VERSION} (darwin-${NODE_ARCH}, bundled)"
echo "║  Target:   macOS ${MACOSX_DEPLOYMENT_TARGET}+ (${PKG_ARCH})"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║                                                          ║"
echo "║  Install on macOS:                                      ║"
echo "║    tar xzf ${BUNDLE_NAME}.tar.gz"
echo "║    cd ${BUNDLE_NAME}"
echo "║    ./deploy/scripts/install-macos.sh                     ║"
echo "║                                                          ║"
echo "║  Open: http://localhost:5555                             ║"
echo "║                                                          ║"
echo "║  Uninstall:                                              ║"
echo "║    ./deploy/scripts/uninstall-macos.sh                   ║"
echo "║  Doctor:                                                 ║"
echo "║    /usr/local/opt/tui-serve/deploy/scripts/doctor-macos.sh ║"
echo "╚══════════════════════════════════════════════════════════╝"