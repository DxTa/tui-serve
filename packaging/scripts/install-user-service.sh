#!/usr/bin/env bash
# Install Remote Agent TUI as a per-user systemd service.
# Preferred for desktop/dev machines: agents run as the real user, with the
# user's HOME, PATH, tmux socket, dotfiles, SSH keys, and agent config.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
PACKAGED_PREFIX="/usr/lib/remote-agent-tui"
PACKAGED_WEB_DIR="/usr/share/remote-agent-tui/web"
PACKAGED_USER_SERVICE="/usr/share/remote-agent-tui/systemd/remote-agent-tui-user.service"

if [ ! -d "$PROJECT_DIR/server" ] && [ -d "$PACKAGED_PREFIX/server" ]; then
  PROJECT_DIR=""
fi

PREFIX="${REMOTE_AGENT_TUI_USER_PREFIX:-$HOME/.local/share/remote-agent-tui}"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/remote-agent-tui"
SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_NAME="remote-agent-tui.service"
PORT="${PORT:-5555}"
NODE_VERSION="${NODE_VERSION:-22.15.0}"

case "$(uname -m)" in
  x86_64) NODE_ARCH="x64" ;;
  aarch64|arm64) NODE_ARCH="arm64" ;;
  armv7l) NODE_ARCH="armv7l" ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

NODE_TARBALL="node-v${NODE_VERSION}-linux-${NODE_ARCH}"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}.tar.gz"
NODE_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/remote-agent-tui/node-cache"
NODE_TARBALL_PATH="${NODE_CACHE}/${NODE_TARBALL}.tar.gz"

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl not found. User service install requires systemd." >&2
  exit 1
fi

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux not found. Install tmux first." >&2
  exit 1
fi

mkdir -p "$PREFIX/node/bin" "$PREFIX/server" "$PREFIX/web" "$PREFIX/data" "$CONFIG_DIR" "$SYSTEMD_USER_DIR" "$NODE_CACHE"

if [ ! -x "$PREFIX/node/bin/node" ]; then
  if [ -x "$PACKAGED_PREFIX/node/bin/node" ]; then
    cp "$PACKAGED_PREFIX/node/bin/node" "$PREFIX/node/bin/node"
  else
    if [ ! -f "$NODE_TARBALL_PATH" ]; then
      echo "Downloading Node.js v${NODE_VERSION} (${NODE_ARCH})..."
      curl -fSL --progress-bar -o "$NODE_TARBALL_PATH" "$NODE_URL"
    fi
    tmp_node_dir="$(mktemp -d)"
    trap 'rm -rf "$tmp_node_dir"' EXIT
    tar -xzf "$NODE_TARBALL_PATH" -C "$tmp_node_dir" --strip-components=1 "${NODE_TARBALL}/bin/node"
    cp "$tmp_node_dir/bin/node" "$PREFIX/node/bin/node"
  fi
  chmod 755 "$PREFIX/node/bin/node"
fi

rm -rf "$PREFIX/server/dist" "$PREFIX/server/node_modules" "$PREFIX/web"
mkdir -p "$PREFIX/server" "$PREFIX/web"

if [ -d "$PACKAGED_PREFIX/server/dist" ] && [ -d "$PACKAGED_PREFIX/server/node_modules" ] && [ -d "$PACKAGED_WEB_DIR" ]; then
  echo "Installing from packaged application files..."
  cp -a "$PACKAGED_PREFIX/server/dist" "$PREFIX/server/"
  cp "$PACKAGED_PREFIX/server/package.json" "$PREFIX/server/"
  cp "$PACKAGED_PREFIX/server/package-lock.json" "$PREFIX/server/" 2>/dev/null || true
  cp -a "$PACKAGED_PREFIX/server/node_modules" "$PREFIX/server/"
  cp -a "$PACKAGED_WEB_DIR/." "$PREFIX/web/"
elif [ -n "$PROJECT_DIR" ]; then
  echo "Building frontend..."
  (
    cd "$PROJECT_DIR/tui-web"
    npm ci --ignore-scripts 2>/dev/null || npm ci
    npm run build
  )

  echo "Building backend..."
  (
    cd "$PROJECT_DIR/server"
    npm ci 2>/dev/null || npm install
    npm run build
    npm prune --omit=dev 2>/dev/null || true
  )

  cp -a "$PROJECT_DIR/server/dist" "$PREFIX/server/"
  cp "$PROJECT_DIR/server/package.json" "$PREFIX/server/"
  cp "$PROJECT_DIR/server/package-lock.json" "$PREFIX/server/" 2>/dev/null || true
  cp -a "$PROJECT_DIR/server/node_modules" "$PREFIX/server/"
  cp -a "$PROJECT_DIR/tui-web/dist/." "$PREFIX/web/"
else
  echo "Could not find packaged files or source checkout." >&2
  exit 1
fi

if [ ! -f "$CONFIG_DIR/default-config.json" ]; then
  cat > "$CONFIG_DIR/default-config.json" << EOF
{
  "commands": [
    { "id": "pi", "label": "Pi Coding Agent", "command": "pi", "allowedCwdRoots": ["$HOME", "/tmp"] },
    { "id": "claude", "label": "Claude Coding Agent", "command": "claude", "allowedCwdRoots": ["$HOME", "/tmp"] },
    { "id": "opencode", "label": "OpenCode", "command": "opencode", "allowedCwdRoots": ["$HOME", "/tmp"] },
    { "id": "codex", "label": "Codex Coding Agent", "command": "codex", "allowedCwdRoots": ["$HOME", "/tmp"] }
  ],
  "hosts": [
    { "id": "local", "name": "This Machine", "address": "localhost", "port": $PORT }
  ]
}
EOF
fi

if [ ! -f "$CONFIG_DIR/env" ]; then
  cat > "$CONFIG_DIR/env" << EOF
# Remote Agent TUI per-user environment
AUTH_TOKEN=
PORT=$PORT
NODE_ENV=production
REMOTE_AGENT_TUI_CONFIG=$CONFIG_DIR/default-config.json
REMOTE_AGENT_TUI_DATA_DIR=$PREFIX/data
REMOTE_AGENT_TUI_WEB_DIR=$PREFIX/web

# Add user-local bins so pi/claude/codex installed under HOME are found.
PATH=$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin
EOF
  chmod 600 "$CONFIG_DIR/env"
fi

if [ -f "$PACKAGED_USER_SERVICE" ]; then
  cp "$PACKAGED_USER_SERVICE" "$SYSTEMD_USER_DIR/$SERVICE_NAME"
elif [ -n "$PROJECT_DIR" ] && [ -f "$PROJECT_DIR/packaging/systemd/remote-agent-tui-user.service" ]; then
  cp "$PROJECT_DIR/packaging/systemd/remote-agent-tui-user.service" "$SYSTEMD_USER_DIR/$SERVICE_NAME"
else
  echo "User service template not found." >&2
  exit 1
fi
systemctl --user daemon-reload
systemctl --user enable --now "$SERVICE_NAME"

echo ""
echo "Remote Agent TUI user service installed."
echo "URL: http://localhost:$PORT"
echo "Status: systemctl --user status $SERVICE_NAME"
echo "Logs: journalctl --user -u $SERVICE_NAME -f"
echo "Config: $CONFIG_DIR/default-config.json"
echo "Env: $CONFIG_DIR/env"
