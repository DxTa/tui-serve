#!/usr/bin/env bash
# build-macos.sh — Build a macOS .tar.gz bundle for remote-agent-tui
#
# Bundles Node.js 22 LTS so the package is fully self-contained.
# Produces: packaging/dist/remote-agent-tui_VERSION_macos-arm64.tar.gz
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

PKG_NAME="remote-agent-tui"
BUNDLE_NAME="${PKG_NAME}-${VERSION}-macos-${PKG_ARCH}"
BUILD_DIR="${PROJECT_DIR}/packaging/build"
BUNDLE_DIR="${BUILD_DIR}/${BUNDLE_NAME}"
NODE_CACHE="${BUILD_DIR}/node-cache"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Building ${BUNDLE_NAME}.tar.gz                          "
echo "║  Bundled Node.js: v${NODE_VERSION} (darwin-${NODE_ARCH})  "
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

# ── Stage 1: Build frontend ──
echo ">>> Building frontend..."
cd "${PROJECT_DIR}/tui-web"
npm ci --ignore-scripts 2>/dev/null || npm ci
npm run build
echo "    Frontend built ✓"

# ── Stage 2: Build backend ──
echo ">>> Building backend..."
cd "${PROJECT_DIR}/server"
npm ci 2>/dev/null || npm install
npm run build
echo "    Backend built ✓"

# ── Stage 3: Prune devDependencies ──
echo ">>> Pruning devDependencies..."
cd "${PROJECT_DIR}/server"
npm prune --omit=dev 2>/dev/null || true
# Ensure @fastify/static is present (runtime dep)
if ! node -e "require.resolve('@fastify/static')" 2>/dev/null; then
  echo "    Installing @fastify/static (runtime dep)..."
  npm install @fastify/static 2>/dev/null
fi
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
cp -a "${PROJECT_DIR}/server/node_modules/." "${BUNDLE_DIR}/server/node_modules/"
cp "${PROJECT_DIR}/server/default-config.json" "${BUNDLE_DIR}/server/"

# -- Frontend --
mkdir -p "${BUNDLE_DIR}/web"
cp -R "${PROJECT_DIR}/tui-web/dist/"* "${BUNDLE_DIR}/web/"

# -- macOS-specific deploy files --
mkdir -p "${BUNDLE_DIR}/deploy/launchd"
mkdir -p "${BUNDLE_DIR}/deploy/scripts"
cp "${PROJECT_DIR}/packaging/macos/com.remote-agent-tui.plist" \
   "${BUNDLE_DIR}/deploy/launchd/"
cp "${PROJECT_DIR}/packaging/macos/install-macos.sh" \
   "${BUNDLE_DIR}/deploy/scripts/"
cp "${PROJECT_DIR}/packaging/macos/uninstall-macos.sh" \
   "${BUNDLE_DIR}/deploy/scripts/"
chmod +x "${BUNDLE_DIR}/deploy/scripts/install-macos.sh"
chmod +x "${BUNDLE_DIR}/deploy/scripts/uninstall-macos.sh"

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
  echo "   Copy node_modules contents with: cp -a server/node_modules/. DEST/" >&2
  exit 1
fi

(
  cd "${SERVER_DIR}"
  "${BUNDLE_DIR}/node/bin/node" -e "import('fastify').then(() => console.log('fastify import ok'))"
) >/dev/null

echo "    Bundle layout sane ✓"

# ── Stage 5: Create .tar.gz ──
echo ">>> Creating .tar.gz archive..."

OUTPUT_DIR="${PROJECT_DIR}/packaging/dist"
mkdir -p "${OUTPUT_DIR}"

cd "${BUILD_DIR}"
tar -czf "${OUTPUT_DIR}/${BUNDLE_NAME}.tar.gz" "${BUNDLE_NAME}"

ARCHIVE_PATH="${OUTPUT_DIR}/${BUNDLE_NAME}.tar.gz"
ARCHIVE_SIZE=$(du -sh "$ARCHIVE_PATH" | cut -f1)

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║            Build Complete!                               ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  Archive:  ${ARCHIVE_PATH}"
echo "║  Size:     ${ARCHIVE_SIZE}"
echo "║  Node.js:  v${NODE_VERSION} (darwin-${NODE_ARCH}, bundled)"
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
echo "╚══════════════════════════════════════════════════════════╝"