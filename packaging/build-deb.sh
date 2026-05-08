#!/usr/bin/env bash
# build-deb.sh — Build a .deb package for remote-agent-tui
#
# Bundles Node.js 22 LTS so the package is fully self-contained
# (no external Node.js dependency required).
#
# Usage:
#   ./packaging/build-deb.sh [--docker] [VERSION] [ARCH] [NODE_VERSION]
#
#   --docker     — Build inside a Docker ubuntu:20.04 container for maximum
#                  glibc compatibility (native modules work on Ubuntu 20.04+)
#   VERSION      — Package version (default: from server/package.json or git tag)
#   ARCH         — Target architecture: amd64, arm64, armhf (default: native)
#   NODE_VERSION — Node.js version to bundle (default: 22.15.0)
#
# Prerequisites (native build):
#   - Node.js 22+ and npm (for build only; not needed on target)
#   - dpkg-dev, fakeroot
#   - curl (to download Node.js binaries)
#   - build-essential, python3, make, g++ (for native modules)
#
# On Ubuntu/Debian:
#   sudo apt install -y dpkg-dev fakeroot build-essential python3 make g++ curl
#
# Prerequisites (--docker build):
#   - Docker or Podman
#   - Internet access (to pull ubuntu:20.04 image and install g++-10)
#
# Cross-compilation for ARM:
#   Set ARCH=arm64 and the script downloads the arm64 Node.js binary.
#   Native modules (node-pty, better-sqlite3) must be compiled for the target.
#   Recommended: build on the target device or in a VM/container.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Parse --docker flag ──
USE_DOCKER=false
args=()
for arg in "$@"; do
  case "$arg" in
    --docker) USE_DOCKER=true ;;
    *) args+=("$arg") ;;
  esac
done

VERSION="${args[0]:-}"
ARCH="${args[1]:-$(dpkg --print-architecture 2>/dev/null || echo amd64)}"
NODE_VERSION="${args[2]:-${NODE_VERSION:-22.15.0}}"

# ── glibc/GLIBCXX compatibility thresholds for ABI audit ──
# Built on Ubuntu 20.04 (glibc 2.31)
# These are the maximum versions allowed in .node binaries
GLIBC_MAX="2.31"
GLIBCXX_MAX="3.4.28"
# Fail build if thresholds exceeded (set to false to warn only)
ABI_STRICT=true

# ── Resolve version ──
if [ -z "$VERSION" ]; then
  if git -C "$PROJECT_DIR" describe --tags --exact-match >/dev/null 2>&1; then
    VERSION="$(git -C "$PROJECT_DIR" describe --tags --exact-match | sed 's/^v//')"
  else
    VERSION="$(node -e "console.log(require('$PROJECT_DIR/server/package.json').version)")"
  fi
fi
VERSION="${VERSION#v}"

# ── Map architecture to Node.js download arch ──
case "$ARCH" in
  amd64)  NODE_ARCH="x64" ;;
  arm64)  NODE_ARCH="arm64" ;;
  armhf)  NODE_ARCH="armv7l" ;;
  *)      echo "Error: unsupported architecture '$ARCH'" >&2; exit 1 ;;
esac

NODE_TARBALL="node-v${NODE_VERSION}-linux-${NODE_ARCH}"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}.tar.gz"

PKG_NAME="remote-agent-tui"
PKG_VERSION="${VERSION}"
BUILD_DIR="${PROJECT_DIR}/packaging/build"
PKG_DIR="${BUILD_DIR}/${PKG_NAME}_${PKG_VERSION}_${ARCH}"
NODE_CACHE="${BUILD_DIR}/node-cache"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Building ${PKG_NAME}_${PKG_VERSION}_${ARCH}.deb         "
echo "║  Bundled Node.js: v${NODE_VERSION} (linux-${NODE_ARCH})  "
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "Project dir:  $PROJECT_DIR"
echo "Package dir:  $PKG_DIR"
echo "Docker build:  $USE_DOCKER"
echo ""

# ── Docker build mode ──
# Build inside ubuntu:20.04 container for maximum glibc compatibility.
# Native modules (better-sqlite3, node-pty) compiled against glibc 2.31
# will run on Ubuntu 20.04+ and Debian 11+.
if [ "$USE_DOCKER" = true ]; then
  echo ""
  echo ">>> Docker build mode: building inside ubuntu:20.04 container..."
  echo "    This ensures native modules link against glibc 2.31 for max compatibility."
  echo ""

  DOCKER_CMD="${DOCKER_CMD:-docker}"
  if ! command -v "$DOCKER_CMD" >/dev/null 2>&1; then
    echo "Error: $DOCKER_CMD not found. Install Docker or Podman, or build without --docker." >&2
    exit 1
  fi

  # Build inside container — pass all non-docker args through.
  # The container installs g++-10 (needed for better-sqlite3's C++20 requirement)
  # as root, then runs the actual package build as the host uid/gid so bind-mounted
  # node_modules, dist, packaging/build, and packaging/dist stay writable locally.
  HOST_UID="$(id -u)"
  HOST_GID="$(id -g)"
  echo "    Pulling ubuntu:20.04 and building as host uid:gid ${HOST_UID}:${HOST_GID}..."
  "$DOCKER_CMD" run --rm \
    -v "${PROJECT_DIR}:/src:rw" \
    -e NODE_VERSION="${NODE_VERSION}" \
    -e ARCH="${ARCH}" \
    -e HOST_UID="${HOST_UID}" \
    -e HOST_GID="${HOST_GID}" \
    -w /src \
    ubuntu:20.04 \
    bash -c '
      set -euo pipefail
      export DEBIAN_FRONTEND=noninteractive
      echo "  Installing build dependencies (g++-10 for C++20 support)..."
      apt-get update -qq
      apt-get install -y -qq \
        build-essential g++-10 python3 make curl \
        dpkg-dev fakeroot \
        ca-certificates \
        >/dev/null

      # Ensure g++-10 is used for native module compilation
      export CXX=g++-10
      export CC=gcc-10

      echo "  Installing Node.js ${NODE_VERSION}..."
      NODE_TARBALL="node-v${NODE_VERSION}-linux-x64"
      curl -fSL https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}.tar.gz | tar xz --strip-components=1 -C /usr/local
      node --version

      echo "  Creating build user ${HOST_UID}:${HOST_GID}..."
      groupadd --gid "${HOST_GID}" builder 2>/dev/null || true
      useradd --uid "${HOST_UID}" --gid "${HOST_GID}" --create-home --shell /bin/bash builder 2>/dev/null || true

      echo "  Building package as host user..."
      cd /src
      runuser -u builder -- env \
        HOME=/home/builder \
        PATH="${PATH}" \
        NODE_VERSION="${NODE_VERSION}" \
        ARCH="${ARCH}" \
        CXX="${CXX}" \
        CC="${CC}" \
        ./packaging/build-deb.sh "" "${ARCH}" "${NODE_VERSION}"
      echo "  Docker build complete!"
    '

  echo ""
  echo "✅ Docker build finished. Package is in packaging/dist/"
  exit 0
fi

# ── Clean previous build ──
if [ -d "${PKG_DIR}" ]; then
  chmod -R u+w "${PKG_DIR}" 2>/dev/null || true
  rm -rf "${PKG_DIR}"
fi

# ── Stage 0: Download/bundle Node.js ──
echo ">>> Bundling Node.js v${NODE_VERSION} (linux-${NODE_ARCH})..."
mkdir -p "${NODE_CACHE}"
NODE_TARBALL_PATH="${NODE_CACHE}/${NODE_TARBALL}.tar.gz"

if [ -f "$NODE_TARBALL_PATH" ]; then
  echo "    Using cached: ${NODE_TARBALL_PATH}"
else
  echo "    Downloading: ${NODE_URL}"
  curl -fSL --progress-bar -o "$NODE_TARBALL_PATH" "$NODE_URL"
fi

# Extract ONLY the node binary (skip npm, man pages, etc.)
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

# ── Stage 3: Prune devDependencies for production ──
echo ">>> Pruning devDependencies..."
cd "${PROJECT_DIR}/server"
npm prune --omit=dev 2>/dev/null || true
# Ensure @fastify/static is present (runtime dep, was previously in devDeps)
if ! node -e "require.resolve('@fastify/static')" 2>/dev/null; then
  echo "    Installing @fastify/static (runtime dep)..."
  npm install @fastify/static 2>/dev/null
fi
echo "    Production node_modules ready ✓"

# ── Stage 4: Assemble package directory ──
echo ">>> Assembling package directory..."

# -- Bundled Node.js runtime: /usr/lib/remote-agent-tui/node/ --
mkdir -p "${PKG_DIR}/usr/lib/remote-agent-tui/node/bin"
cp "${NODE_EXTRACT}/bin/node" "${PKG_DIR}/usr/lib/remote-agent-tui/node/bin/node"
chmod 755 "${PKG_DIR}/usr/lib/remote-agent-tui/node/bin/node"

# -- Application code: /usr/lib/remote-agent-tui/server/ --
mkdir -p "${PKG_DIR}/usr/lib/remote-agent-tui/server/dist"
mkdir -p "${PKG_DIR}/usr/lib/remote-agent-tui/server/node_modules"

cp -R "${PROJECT_DIR}/server/dist/"* "${PKG_DIR}/usr/lib/remote-agent-tui/server/dist/"
cp "${PROJECT_DIR}/server/package.json" "${PKG_DIR}/usr/lib/remote-agent-tui/server/"
cp "${PROJECT_DIR}/server/package-lock.json" "${PKG_DIR}/usr/lib/remote-agent-tui/server/"
cp -a "${PROJECT_DIR}/server/node_modules/." "${PKG_DIR}/usr/lib/remote-agent-tui/server/node_modules/"

# -- Frontend static assets: /usr/share/remote-agent-tui/web/ --
mkdir -p "${PKG_DIR}/usr/share/remote-agent-tui/web"
cp -R "${PROJECT_DIR}/tui-web/dist/"* "${PKG_DIR}/usr/share/remote-agent-tui/web/"

# -- Default config (reference copy) --
cp "${PROJECT_DIR}/server/default-config.json" "${PKG_DIR}/usr/share/remote-agent-tui/default-config.json"

# -- Config directory: /etc/remote-agent-tui/ --
mkdir -p "${PKG_DIR}/etc/remote-agent-tui"
cp "${PROJECT_DIR}/server/default-config.json" "${PKG_DIR}/etc/remote-agent-tui/default-config.json"
cp "${PROJECT_DIR}/server/.env.example" "${PKG_DIR}/etc/remote-agent-tui/env.template"

# -- Data directory: /var/lib/remote-agent-tui/ --
mkdir -p "${PKG_DIR}/var/lib/remote-agent-tui"

# -- Log directory: /var/log/remote-agent-tui/ --
mkdir -p "${PKG_DIR}/var/log/remote-agent-tui"

# -- systemd unit --
mkdir -p "${PKG_DIR}/lib/systemd/system"
cp "${PROJECT_DIR}/packaging/debian/systemd/remote-agent-tui.service" \
   "${PKG_DIR}/lib/systemd/system/remote-agent-tui.service"

# -- user service helper --
mkdir -p "${PKG_DIR}/usr/share/remote-agent-tui/systemd"
cp "${PROJECT_DIR}/packaging/systemd/remote-agent-tui-user.service" \
   "${PKG_DIR}/usr/share/remote-agent-tui/systemd/remote-agent-tui-user.service"

# -- Documentation --
mkdir -p "${PKG_DIR}/usr/share/doc/remote-agent-tui"
cp "${PROJECT_DIR}/README.md" "${PKG_DIR}/usr/share/doc/remote-agent-tui/"
cp "${PROJECT_DIR}/PLAN.md" "${PKG_DIR}/usr/share/doc/remote-agent-tui/" 2>/dev/null || true

# -- Doctor and install helper scripts --
cp "${PROJECT_DIR}/packaging/scripts/doctor.sh" "${PKG_DIR}/usr/share/doc/remote-agent-tui/doctor.sh"
chmod 755 "${PKG_DIR}/usr/share/doc/remote-agent-tui/doctor.sh"
cp "${PROJECT_DIR}/packaging/scripts/install-user-service.sh" "${PKG_DIR}/usr/share/doc/remote-agent-tui/install-user-service.sh"
chmod 755 "${PKG_DIR}/usr/share/doc/remote-agent-tui/install-user-service.sh"

echo "    Files assembled ✓"

# ── Stage 4.5: Package layout sanity checks ──
echo ">>> Package layout sanity checks..."
SERVER_DIR="${PKG_DIR}/usr/lib/remote-agent-tui/server"

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
  "${PKG_DIR}/usr/lib/remote-agent-tui/node/bin/node" -e "import('fastify').then(() => console.log('fastify import ok'))"
) >/dev/null

echo "    Package layout sane ✓"

# ── Stage 5: Create DEBIAN control files ──
echo ">>> Creating DEBIAN control files..."

mkdir -p "${PKG_DIR}/DEBIAN"

INSTALLED_SIZE=$(du -sk "${PKG_DIR}" | cut -f1)

cat > "${PKG_DIR}/DEBIAN/control" << EOF
Package: ${PKG_NAME}
Version: ${PKG_VERSION}
Section: web
Priority: optional
Architecture: ${ARCH}
Depends: tmux (>= 3.0), libc6 (>= 2.31), libstdc++6 (>= 10)
Recommends: caddy
Suggests: tailscale
Installed-Size: ${INSTALLED_SIZE}
Maintainer: Remote Agent TUI <noreply@example.com>
Homepage: https://github.com/example/remote-agent-tui
Description: Remote Agent TUI Manager
 Browser-based terminal manager for long-running coding agent sessions
 (Claude, Codex, Pi, etc.) on Raspberry Pis and Linux machines.
 .
 Bundles Node.js ${NODE_VERSION} — no external Node.js install needed.
 Features persistent tmux sessions, mobile PWA, REST + WebSocket API,
 command allowlist security, and systemd auto-start.

EOF

# conffiles
cat > "${PKG_DIR}/DEBIAN/conffiles" << 'EOF'
/etc/remote-agent-tui/default-config.json
EOF

# postinst
cp "${PROJECT_DIR}/packaging/debian/postinst" "${PKG_DIR}/DEBIAN/postinst"
chmod 755 "${PKG_DIR}/DEBIAN/postinst"

# prerm
cp "${PROJECT_DIR}/packaging/debian/prerm" "${PKG_DIR}/DEBIAN/prerm"
chmod 755 "${PKG_DIR}/DEBIAN/prerm"

# postrm
cp "${PROJECT_DIR}/packaging/debian/postrm" "${PKG_DIR}/DEBIAN/postrm"
chmod 755 "${PKG_DIR}/DEBIAN/postrm"

echo "    DEBIAN control files ✓"

# ── Stage 5.5: ABI audit ──
# Scan all .node files for GLIBC_/GLIBCXX_ version symbols that exceed our
# minimum targets. This catches native modules built on a newer glibc that
# would crash on older systems at runtime.
echo ">>> ABI audit: checking native module compatibility..."

ABI_OK=true
NODE_FILES=$(find "${PKG_DIR}" -name '*.node' -type f 2>/dev/null || true)

if [ -n "$NODE_FILES" ]; then
  for NODE_FILE in $NODE_FILES; do
    REL_PATH="${NODE_FILE#${PKG_DIR}}"

    # Extract GLIBC_ version requirements
    GLIBC_MAX_FOUND=$(objdump -T "$NODE_FILE" 2>/dev/null \
      | grep -oP 'GLIBC_\K[0-9.]+' \
      | sort -V \
      | tail -1 || echo "0")

    if [ -n "$GLIBC_MAX_FOUND" ] && [ "$GLIBC_MAX_FOUND" != "0" ]; then
      # Compare versions (using sort -V trick)
      HIGHER=$(printf '%s\n%s\n' "$GLIBC_MAX" "$GLIBC_MAX_FOUND" | sort -V | tail -1)
      if [ "$GLIBC_MAX_FOUND" = "$HIGHER" ] && [ "$GLIBC_MAX_FOUND" != "$GLIBC_MAX" ]; then
        echo "  ⚠️  $REL_PATH: requires GLIBC_$GLIBC_MAX_FOUND (max allowed: $GLIBC_MAX)"
        ABI_OK=false
      else
        echo "  ✅ $REL_PATH: max GLIBC_$GLIBC_MAX_FOUND (threshold: $GLIBC_MAX)"
      fi
    else
      echo "  ✅ $REL_PATH: no GLIBC_ version requirements found"
    fi

    # Extract GLIBCXX_ version requirements
    GLIBCXX_MAX_FOUND=$(objdump -T "$NODE_FILE" 2>/dev/null \
      | grep -oP 'GLIBCXX_\K[0-9.]+' \
      | sort -V \
      | tail -1 || echo "0")

    if [ -n "$GLIBCXX_MAX_FOUND" ] && [ "$GLIBCXX_MAX_FOUND" != "0" ]; then
      HIGHER=$(printf '%s\n%s\n' "$GLIBCXX_MAX" "$GLIBCXX_MAX_FOUND" | sort -V | tail -1)
      if [ "$GLIBCXX_MAX_FOUND" = "$HIGHER" ] && [ "$GLIBCXX_MAX_FOUND" != "$GLIBCXX_MAX" ]; then
        echo "  ⚠️  $REL_PATH: requires GLIBCXX_$GLIBCXX_MAX_FOUND (max allowed: $GLIBCXX_MAX)"
        ABI_OK=false
      else
        echo "  ✅ $REL_PATH: max GLIBCXX_$GLIBCXX_MAX_FOUND (threshold: $GLIBCXX_MAX)"
      fi
    else
      echo "  ✅ $REL_PATH: no GLIBCXX_ version requirements found"
    fi
  done

  if [ "$ABI_OK" = false ]; then
    if [ "$ABI_STRICT" = true ]; then
      echo ""
      echo "❌ ABI audit FAILED: native modules require newer glibc/libstdc++ than threshold."
      echo "   Build with --docker to compile against glibc $GLIBC_MAX for compatibility."
      echo "   Or set ABI_STRICT=false to make this a warning instead."
      exit 1
    else
      echo ""
      echo "⚠️  ABI audit WARNING: native modules may not work on older systems."
      echo "   Recommended: build with --docker for maximum compatibility."
    fi
  else
    echo "  ABI audit passed ✓"
  fi
else
  echo "  No .node files found — skipping ABI audit"
fi

# ── Stage 6: Build the .deb ──
echo ">>> Building .deb package..."

OUTPUT_DIR="${PROJECT_DIR}/packaging/dist"
mkdir -p "${OUTPUT_DIR}"

fakeroot dpkg-deb --build "${PKG_DIR}" "${OUTPUT_DIR}/${PKG_NAME}_${PKG_VERSION}_${ARCH}.deb"

DEB_PATH="${OUTPUT_DIR}/${PKG_NAME}_${PKG_VERSION}_${ARCH}.deb"
DEB_SIZE=$(du -sh "$DEB_PATH" | cut -f1)

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║            Build Complete!                               ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  Package:  ${DEB_PATH}"
echo "║  Size:     ${DEB_SIZE}"
echo "║  Node.js:  v${NODE_VERSION} (bundled)"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║                                                          ║"
echo "║  Install (no Node.js needed on target!):                ║"
echo "║    sudo dpkg -i ${PKG_NAME}_${PKG_VERSION}_${ARCH}.deb"
echo "║    sudo apt-get install -f   # fix any missing libs     ║"
echo "║                                                          ║"
echo "║  View your auth token:                                   ║"
echo "║    sudo cat /etc/remote-agent-tui/env | grep AUTH_TOKEN  ║"
echo "║                                                          ║"
echo "║  Manage the service:                                     ║"
echo "║    sudo systemctl status remote-agent-tui                ║"
echo "║    sudo systemctl restart remote-agent-tui               ║"
echo "║    journalctl -u remote-agent-tui -f                     ║"
echo "║                                                          ║"
echo "║  Health check:                                           ║"
echo "║    sudo /usr/share/doc/remote-agent-tui/doctor.sh       ║"
echo "║    (or: ./packaging/scripts/doctor.sh)                   ║"
echo "║                                                          ║"
echo "║  Uninstall:                                              ║"
echo "║    sudo apt remove remote-agent-tui                      ║"
echo "║    sudo apt purge remote-agent-tui  # removes data+conf  ║"
echo "╚══════════════════════════════════════════════════════════╝"