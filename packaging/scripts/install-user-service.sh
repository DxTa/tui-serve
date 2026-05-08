#!/usr/bin/env bash
# Install TUI Serve as a per-user systemd service.
# Preferred for desktop/dev machines: agents run as the real user, with the
# user's HOME, PATH, tmux socket, dotfiles, SSH keys, and agent config.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
PACKAGED_PREFIX="/usr/lib/tui-serve"
PACKAGED_WEB_DIR="/usr/share/tui-serve/web"
PACKAGED_USER_SERVICE="/usr/share/tui-serve/systemd/tui-serve-user.service"

if [ ! -d "$PROJECT_DIR/server" ] && [ -d "$PACKAGED_PREFIX/server" ]; then
  PROJECT_DIR=""
fi

PREFIX="${TUI_SERVE_USER_PREFIX:-$HOME/.local/share/tui-serve}"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/tui-serve"
SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_NAME="tui-serve.service"
PORT="${PORT:-5555}"
NODE_VERSION="${NODE_VERSION:-22.15.0}"
BIND_HOST="${BIND_HOST:-${TUI_SERVE_BIND_HOST:-0.0.0.0}}"
GENERATED_AUTH_TOKEN=""

is_interactive() {
  [ -t 0 ] && [ -t 1 ] && [ "${TUI_SERVE_NONINTERACTIVE:-}" != "1" ]
}

generate_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
  else
    "$PREFIX/node/bin/node" -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
  fi
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

roots_json_from_csv() {
  csv="$1"
  old_ifs="$IFS"
  IFS=','
  out=""
  for raw in $csv; do
    root="$(printf '%s' "$raw" | sed 's/^ *//; s/ *$//')"
    [ -n "$root" ] || continue
    escaped="$(json_escape "$root")"
    if [ -z "$out" ]; then
      out="\"$escaped\""
    else
      out="$out, \"$escaped\""
    fi
  done
  IFS="$old_ifs"
  printf '%s' "$out"
}

default_allowed_roots() {
  roots=""
  [ -d "$HOME/projects" ] && roots="$HOME/projects"
  [ -d "$HOME/code" ] && roots="${roots:+$roots,}$HOME/code"
  [ -d "$HOME/dev" ] && roots="${roots:+$roots,}$HOME/dev"
  [ -n "$roots" ] || roots="$HOME"
  printf '%s' "$roots"
}

onboard_config() {
  default_roots="${TUI_SERVE_ALLOWED_ROOTS:-$(default_allowed_roots)}"
  ALLOWED_ROOTS="$default_roots"

  if is_interactive; then
    echo ""
    echo "TUI Serve network setup"
    echo "1) Network/LAN/Tailscale (0.0.0.0, auth required)"
    echo "2) Local only (127.0.0.1, auth optional)"
    printf "Choose bind mode [1]: "
    read -r bind_choice || bind_choice=""
    if [ "$bind_choice" = "2" ]; then
      BIND_HOST="127.0.0.1"
    else
      BIND_HOST="0.0.0.0"
    fi

    if [ -z "${AUTH_TOKEN:-}" ] && [ "$BIND_HOST" = "0.0.0.0" ]; then
      AUTH_TOKEN="$(generate_token)"
      GENERATED_AUTH_TOKEN="$AUTH_TOKEN"
      echo "Generated AUTH_TOKEN for network access."
    fi

    printf "Allowed workspace roots (comma-separated) [$default_roots]: "
    read -r roots_input || roots_input=""
    [ -n "$roots_input" ] && ALLOWED_ROOTS="$roots_input"
  else
    if [ -z "${AUTH_TOKEN:-}" ] && [ "$BIND_HOST" != "127.0.0.1" ] && [ "$BIND_HOST" != "localhost" ] && [ "$BIND_HOST" != "::1" ]; then
      AUTH_TOKEN="$(generate_token)"
      GENERATED_AUTH_TOKEN="$AUTH_TOKEN"
    fi
  fi
}

case "$(uname -m)" in
  x86_64) NODE_ARCH="x64" ;;
  aarch64|arm64) NODE_ARCH="arm64" ;;
  armv7l) NODE_ARCH="armv7l" ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

NODE_TARBALL="node-v${NODE_VERSION}-linux-${NODE_ARCH}"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}.tar.gz"
NODE_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/tui-serve/node-cache"
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
  echo "Installing workspace dependencies..."
  ( cd "$PROJECT_DIR" && npm ci 2>/dev/null || npm install )

  echo "Building shared package..."
  ( cd "$PROJECT_DIR/packages/shared" && npm run build )

  echo "Building frontend..."
  ( cd "$PROJECT_DIR/tui-web" && npm run build )

  echo "Building backend..."
  ( cd "$PROJECT_DIR/server" && npm run build )

  echo "Pruning devDependencies..."
  ( cd "$PROJECT_DIR" && npm prune --omit=dev 2>/dev/null || true )

  mkdir -p "$PREFIX/server/dist"
  cp -R "$PROJECT_DIR/server/dist/"* "$PREFIX/server/dist/"
  cp "$PROJECT_DIR/server/package.json" "$PREFIX/server/"
  cp "$PROJECT_DIR/server/package-lock.json" "$PREFIX/server/" 2>/dev/null || true

  # Copy root node_modules (hoisted production deps) then overlay server's
  cp -a "$PROJECT_DIR/node_modules/." "$PREFIX/server/node_modules/"
  if [ -d "$PROJECT_DIR/server/node_modules" ]; then
    cp -a "$PROJECT_DIR/server/node_modules/." "$PREFIX/server/node_modules/"
  fi

  # Resolve workspace symlinks that would be broken in the install directory
  if [ -L "$PREFIX/server/node_modules/@tui-serve/shared" ]; then
    SHARED_TARGET="$(readlink -f "$PROJECT_DIR/node_modules/@tui-serve/shared")"
    rm "$PREFIX/server/node_modules/@tui-serve/shared"
    cp -a "$SHARED_TARGET" "$PREFIX/server/node_modules/@tui-serve/shared"
  fi
  rm -f "$PREFIX/server/node_modules/tui-serve-server"

  cp -a "$PROJECT_DIR/tui-web/dist/." "$PREFIX/web/"
else
  echo "Could not find packaged files or source checkout." >&2
  exit 1
fi

default_roots="${TUI_SERVE_ALLOWED_ROOTS:-$(default_allowed_roots)}"
ALLOWED_ROOTS="$default_roots"

if [ -f "$CONFIG_DIR/default-config.json" ] || [ -f "$CONFIG_DIR/env" ]; then
  echo "Existing TUI Serve configuration found."
  [ -f "$CONFIG_DIR/default-config.json" ] && echo "  Config: $CONFIG_DIR/default-config.json"
  [ -f "$CONFIG_DIR/env" ] && echo "  Env: $CONFIG_DIR/env"
  echo "Using existing configuration paths; skipping interactive setup."
else
  onboard_config
fi

ROOTS_JSON="$(roots_json_from_csv "$ALLOWED_ROOTS")"
[ -n "$ROOTS_JSON" ] || ROOTS_JSON="\"$HOME\""

if [ ! -f "$CONFIG_DIR/default-config.json" ]; then
  cat > "$CONFIG_DIR/default-config.json" << EOF
{
  "commands": [
    { "id": "pi", "label": "Pi Coding Agent", "command": "pi", "allowedCwdRoots": [$ROOTS_JSON] },
    { "id": "claude", "label": "Claude Coding Agent", "command": "claude", "allowedCwdRoots": [$ROOTS_JSON] },
    { "id": "opencode", "label": "OpenCode", "command": "opencode", "allowedCwdRoots": [$ROOTS_JSON] },
    { "id": "codex", "label": "Codex Coding Agent", "command": "codex", "allowedCwdRoots": [$ROOTS_JSON] }
  ],
  "hosts": [
    { "id": "local", "name": "This Machine", "address": "localhost", "port": $PORT }
  ]
}
EOF
fi

if [ ! -f "$CONFIG_DIR/env" ]; then
  cat > "$CONFIG_DIR/env" << EOF
# TUI Serve per-user environment
AUTH_TOKEN=${AUTH_TOKEN:-}
BIND_HOST=$BIND_HOST
PORT=$PORT
NODE_ENV=production
TUI_SERVE_CONFIG=$CONFIG_DIR/default-config.json
TUI_SERVE_DATA_DIR=$PREFIX/data
TUI_SERVE_WEB_DIR=$PREFIX/web

# Add user-local bins so pi/claude/codex installed under HOME are found.
PATH=$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin
EOF
  chmod 600 "$CONFIG_DIR/env"
elif ! grep -q '^BIND_HOST=' "$CONFIG_DIR/env"; then
  printf '\nBIND_HOST=%s\n' "$BIND_HOST" >> "$CONFIG_DIR/env"
fi

# ── Ensure AUTH_TOKEN is set for network-reachable binds ──
# If BIND_HOST is 0.0.0.0 or similar (network-reachable), AUTH_TOKEN must be
# a strong random token (32+ chars). Without it, the server refuses to start.
if [ -f "$CONFIG_DIR/env" ]; then
  ENV_BIND_HOST="$(grep '^BIND_HOST=' "$CONFIG_DIR/env" | head -1 | cut -d= -f2- | xargs)"
  ENV_AUTH_TOKEN="$(grep '^AUTH_TOKEN=' "$CONFIG_DIR/env" | head -1 | cut -d= -f2-)"

  # Detect network-reachable bind (0.0.0.0, ::, *, or any non-loopback IP)
  case "${ENV_BIND_HOST:-127.0.0.1}" in
    0.0.0.0|::|\*|'')
      NETWORK_BIND=true ;;
    127.0.0.1|localhost|::1)
      NETWORK_BIND=false ;;
    127.*)
      NETWORK_BIND=false ;;
    *)
      NETWORK_BIND=true ;;
  esac

  if [ "$NETWORK_BIND" = true ] && [ -z "$ENV_AUTH_TOKEN" ]; then
    GENERATED_AUTH_TOKEN="$(generate_token)"
    if grep -q '^AUTH_TOKEN=$' "$CONFIG_DIR/env" 2>/dev/null; then
      # Replace empty AUTH_TOKEN= with generated token
      tmp_env="$(mktemp)"
      sed "s|^AUTH_TOKEN=.*|AUTH_TOKEN=${GENERATED_AUTH_TOKEN}|" "$CONFIG_DIR/env" > "$tmp_env"
      cat "$tmp_env" > "$CONFIG_DIR/env"
      rm -f "$tmp_env"
    else
      # AUTH_TOKEN line doesn't exist at all — append it
      printf '\nAUTH_TOKEN=%s\n' "$GENERATED_AUTH_TOKEN" >> "$CONFIG_DIR/env"
    fi
    chmod 600 "$CONFIG_DIR/env"
  fi
fi

if [ -f "$PACKAGED_USER_SERVICE" ]; then
  cp "$PACKAGED_USER_SERVICE" "$SYSTEMD_USER_DIR/$SERVICE_NAME"
elif [ -n "$PROJECT_DIR" ] && [ -f "$PROJECT_DIR/packaging/systemd/tui-serve-user.service" ]; then
  cp "$PROJECT_DIR/packaging/systemd/tui-serve-user.service" "$SYSTEMD_USER_DIR/$SERVICE_NAME"
else
  echo "User service template not found." >&2
  exit 1
fi
systemctl --user daemon-reload
if systemctl --user is-active --quiet "$SERVICE_NAME"; then
  systemctl --user restart "$SERVICE_NAME"
else
  systemctl --user enable --now "$SERVICE_NAME"
fi

echo ""
echo "TUI Serve user service installed."
echo "URL: http://localhost:$PORT"
if [ -n "$GENERATED_AUTH_TOKEN" ]; then
  echo "AUTH_TOKEN: $GENERATED_AUTH_TOKEN"
  echo "  written to: $CONFIG_DIR/env"
  echo "  ⚠  Save this token — it is not stored anywhere else."
fi
EFFECTIVE_BIND_HOST="$BIND_HOST"
if [ -f "$CONFIG_DIR/env" ]; then
  ENV_BIND_HOST_DISPLAY="$(grep '^BIND_HOST=' "$CONFIG_DIR/env" | head -1 | cut -d= -f2- | xargs || true)"
  [ -n "$ENV_BIND_HOST_DISPLAY" ] && EFFECTIVE_BIND_HOST="$ENV_BIND_HOST_DISPLAY"
fi
echo "Bind host: $EFFECTIVE_BIND_HOST"
echo "Status: systemctl --user status $SERVICE_NAME"
echo "Logs: journalctl --user -u $SERVICE_NAME -f"
echo "Config: $CONFIG_DIR/default-config.json"
echo "Env: $CONFIG_DIR/env"
