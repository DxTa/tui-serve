# Remote Coding Agent TUI Manager — Implementation Plan

> **Plan revision: v2** — Hardened after antagonistic self-reflection and architecture review.
> Key changes: MVP architecture clarified (local daemon per Pi), security moved early, protocol strengthened,
> single-writer policy dropped for MVP, Capacitor replaced with PWA, ops/testing/error-handling sections added,
> session model and state machine specified, command injection risk eliminated.

## 1. Goal

Build a lightweight system to remotely manage several long-running coding-agent TUI sessions running on Raspberry Pis or similar Linux hosts.

The system should support:

- Persistent terminal sessions.
- Browser-based terminal access.
- Mobile browser access (PWA — no native app needed).
- Multiple Pis.
- Multiple coding-agent sessions per Pi.
- Attach/detach behavior without killing the session.
- Keyboard input from client to server.
- Terminal screen output from server to client.
- Basic session management: create, attach, detach, stop, restart, rename.

---

## 2. Core Architecture

### 2.1 MVP Architecture — Local Daemon per Pi

**Each Pi runs its own Node.js daemon that manages local tmux sessions.**
A central dashboard (optional, can be served by any Pi's daemon) routes the browser to the right Pi over Tailscale.

```text
Browser (xterm.js in React PWA)
    ⇅ WebSocket + REST over HTTPS
Node.js daemon (one per Pi)
    ⇅ child_process.spawn('tmux attach-session -t X') via node-pty
    ⇅ tmux sessions (persistent)
    ⇅ SQLite (session metadata)
```

### 2.2 Why Local Daemon First (Not Central SSH)

The original plan recommended a central gateway + SSH + tmux as the "first serious version."
After review, this is the wrong priority:

| Concern | Central SSH | Local Daemon per Pi |
|---|---|---|
| SSH connection drops | Terminal freezes, needs reconnect loop | No SSH → no drop |
| SSH key management | Must store/rotate keys on gateway | None needed |
| Host key verification | Must handle fingerprint changes | None needed |
| Single point of failure | Gateway down → all Pis unreachable | Each Pi is independent |
| Terminal fidelity | Nested PTY/tmux/SSH can garble | Direct tmux attach, clean PTY |
| Deployment | Simple — one endpoint | Trivial — `scp` + `systemctl enable` per Pi |
| Routing to each Pi | Central routes automatically | Tailscale hostnames → done |

**SSH mode is deferred** to a later milestone. It can be added later for scenarios where
installing a daemon on each Pi is undesirable, but it is not the MVP path.

### 2.3 Technology Choices

| Layer | Technology | Rationale |
|---|---|---|
| Backend runtime | Node.js (LTS) | Good WebSocket ecosystem, npm packages |
| HTTP framework | Fastify | Better TS support and perf than Express; built-in schema validation |
| PTY bridge | node-pty | Spawns `tmux attach-session` — single PTY layer, not dual |
| Terminal persistence | tmux | Owns the agent process lifecycle; survives disconnects |
| Browser terminal renderer | xterm.js | Only real choice for browser terminals |
| Transport | WebSocket (binary frames for I/O, JSON for control) | Hybrid protocol — binary is hard to retrofit later |
| Web frontend | React + Vite | Simple, well-understood |
| Mobile frontend | PWA (same React app) | No Capacitor needed; PWA gives install/icon/fullscreen/wake-lock |
| Private networking | Tailscale | Zero-config mesh, built-in HTTPS option |
| Reverse proxy / TLS | Caddy or Tailscale HTTPS | Auto-TLS |
| Metadata storage | SQLite (better-sqlite3) | Synchronous, fast, no connection pool drama |

### 2.4 Important: Single PTY Layer

Do **not** use `node-pty` as a general PTY bridge that spawns the coding agent directly.
Use `node-pty` **only** to spawn `tmux attach-session`. This gives one PTY layer:

```text
node-pty → spawns: tmux attach-session -t X
  → tmux → owns: coding-agent process + scrollback
```

This avoids a dual-PTY layer (node-pty → process, then also node-pty → tmux → process).
tmux is the source of truth for the running agent. node-pty is just the pipe for the current viewer.

### 2.5 Considered and Rejected: `ttyd`

Tools like `ttyd` and `gotty` already provide browser-terminal-over-tmux with zero custom code.
They were evaluated and rejected for the MVP because:

- We need a custom session management API (create, list, kill, restart with metadata).
- We need a dashboard UI with host/session grouping.
- We need authenticated, allowlisted access control.
- We need protocol features (snapshots, reconnect, multi-session multiplexing) that ttyd doesn't provide.

`node-pty` spawning `tmux attach` is essentially a minimal `ttyd`-like bridge, but one we control.
If in the future we decide the custom bridge isn't worth it, we can swap it for `ttyd`
behind the dashboard layer.

---

## 3. Important Technical Decisions

### 3.1 Do Not Use `node:tty`

`node:tty` is for detecting the terminal attached to the current Node process.
It is not the right abstraction for spawning and managing independent remote terminal sessions.

### 3.2 Do Not Accept Raw Commands From Clients

The original plan accepted a `command` field in the session creation API — this is an RCE gateway.
Even on a private network, any compromised device can execute arbitrary shell commands.

**Use a command allowlist with IDs only:**

```json
{ "commandId": "claude", "cwd": "/home/pi/projects/app" }
```

The server maps `commandId` to the actual command. The client never specifies a raw command string.
`cwd` must be validated against an allowed-roots list on the server.
`sessionId` must match a strict regex (e.g., `^[a-z0-9][a-z0-9-]{0,63}$`).

### 3.3 Do Not Use a Custom Single-Writer Policy (for MVP)

The original plan proposed controller/viewer roles with lease semantics.
tmux already handles multi-client attach natively — all attached clients can type.
For MVP, this is fine. Drop the custom single-writer policy.

If exclusive control is needed later, it can be added as an optional mode.
But it should not be in the MVP — it adds server-side state, client negotiation,
and edge cases (stale controller after mobile disconnect, split-brain after server restart)
that are not justified by current requirements.

### 3.4 Do Not Build a Native Mobile App (Capacitor Is Overkill)

A PWA provides: home-screen install, standalone/fullscreen mode, wake-lock,
and the same WebSocket reconnect behavior. Capacitor additionally gives you:
App Store review, certificate management, two more build targets,
and background process suspension (iOS kills it anyway).

PWA is the mobile path. If something truly needs native later, add it then.

### 3.5 Binary Frames for Terminal I/O

The original plan started with JSON-only WebSocket messages.
This is a protocol design choice that's hard to retrofit — terminal output can
be hundreds of KB/sec and JSON-parsing every keystroke's output is wasteful.

Use **binary WebSocket frames for terminal I/O** and **JSON for control messages**.
This is straightforward to implement from the start and avoids a painful migration later.

---

## 4. MVP Scope

### 4.1 MVP Features

The MVP must include (security from day one):

- **Authentication** — device token or Tailscale identity.
- **HTTPS/WSS** — Caddy or Tailscale HTTPS.
- **Command allowlist** — only pre-approved commands can be launched.
- **CWD allowlist** — only allowed directories as working dirs.
- **Input validation** — strict `sessionId`, `commandId`, `cwd` validation.
- Session list.
- Create new session (from allowlist only).
- Attach to an existing session.
- Terminal view using xterm.js.
- Send keyboard input to the server.
- Receive terminal output from the server.
- Resize terminal.
- Detach without killing the session.
- Stop/kill session (with confirmation).
- Restart session.
- Basic session metadata.
- Reconnect handling (snapshot before live output).

### 4.2 Explicitly Defer

Do not implement these in the MVP:

- Native mobile app (PWA is the path).
- Custom single-writer / controller policy.
- Central SSH gateway mode.
- Multi-user collaboration.
- Complex ACLs.
- Full audit log.
- File manager.
- WebRTC.
- Recording/replay system.
- Complex plugin system.
- Public internet exposure without VPN.
- SSH connection multiplexing.
- Binary protocol migration (start with binary from day one).

---

## 5. Backend Design

### 5.1 Backend Responsibilities

The backend (one Node.js daemon per Pi) should:

- Authenticate clients (device token or Tailscale identity).
- Maintain session metadata in SQLite.
- Create tmux sessions (from command allowlist only).
- Attach to existing tmux sessions via node-pty (`tmux attach-session`).
- Forward PTY output to WebSocket clients (binary frames).
- Forward WebSocket input to PTY.
- Handle terminal resize.
- Cleanly detach clients without killing tmux.
- Keep tmux sessions alive across client disconnects.
- Capture tmux scrollback on reconnect.
- Enforce command and CWD allowlists.
- Validate all input strictly.
- Reconcile DB state with actual tmux sessions on startup.
- Expose a health endpoint.
- Emit structured logs for create/kill/restart actions.

### 5.2 Session Model

```json
{
  "id": "pi-1-claude-agent",
  "hostId": "pi-1",
  "title": "Claude coding agent",
  "commandId": "claude",
  "command": "claude",
  "cwd": "/home/pi/projects/my-app",
  "tmuxSessionName": "pi-1-claude-agent",
  "status": "running",
  "pid": 12345,
  "exitCode": null,
  "attachedClients": 0,
  "restartPolicy": "manual",
  "env": {},
  "createdAt": "2026-05-05T12:00:00Z",
  "updatedAt": "2026-05-05T12:30:00Z",
  "lastAttachedAt": "2026-05-05T12:30:00Z"
}
```

**New fields vs. original plan:**
- `commandId` — allowlist key, never accept raw commands from clients.
- `command` — resolved from allowlist on server side only.
- `tmuxSessionName` — explicit; `id` and tmux name can diverge after rename.
- `pid` — agent process ID; needed to distinguish "tmux alive but agent exited."
- `exitCode` — populated when agent exits.
- `attachedClients` — count for UI badges.
- `restartPolicy` — `manual` or `on-crash`
- `env` — environment variables for the agent (e.g., API keys).
- `updatedAt` — for caching/ETags.

### 5.3 Session State Machine

```text
           tmux new-session
  [none] ──────────────────► starting
                                 │
                                 │ agent process detected
                                 ▼
                             running ◄─────── restart
                               │ │                ▲
    agent exited (code 0)  │   │ agent exited    │
                               │   │ (non-zero)      │
                               ▼   ▼                │
                           stopped  crashed ─────────┘
                               │                     (if restartPolicy=on-crash)
                               │ kill │ delete
                               ▼       ▼
                           killed   [removed from DB]

  Any state ─── server cannot reach tmux ──► unknown
```

States:
- `starting` — tmux session created, waiting for agent process to appear.
- `running` — agent process is alive inside tmux.
- `stopped` — agent exited cleanly (exit code 0).
- `crashed` — agent exited with non-zero code.
- `killed` — session was explicitly killed.
- `unknown` — server lost contact with tmux (should reconcile on recovery).

REST and WebSocket operations must be idempotent and valid only from certain states.
For example, `restart` from `stopped` or `crashed` is valid; from `running` it should return 409.

### 5.4 Host Model

For the local-daemon-first architecture, the host model is initially simple:

```json
{
  "id": "pi-1",
  "name": "Pi 1",
  "address": "pi-1.tailnet.ts.net",
  "port": 3000,
  "status": "online"
}
```

The dashboard discovers hosts from a static config file or auto-detects from Tailscale.
Each host's daemon is independent — no SSH between them. The dashboard just routes
the browser directly to `https://pi-1.tailnet.ts.net:3000`.

### 5.5 REST + WebSocket State Consistency

- REST operations are authoritative for session lifecycle (create, kill, restart, delete).
- WebSocket `kill` is a convenience shortcut but must call the same internal logic and update DB.
- After any REST mutation, push a `session_update` event to all connected WebSocket clients.
- WebSocket `status` updates reflect DB state. Don't derive status only from PTY state.
- Use per-session locks to prevent race conditions (e.g., two clients killing the same session).

---

## 6. WebSocket Protocol

### 6.1 Hybrid Protocol Design

Use **binary WebSocket frames for terminal I/O** and **JSON for control messages**.
Binary frames carry raw ANSI output bytes. JSON frames carry structured control messages.
This avoids the overhead of JSON-parsing every terminal output byte and is hard to retrofit later.

**Frame type discrimination:** First byte of each WebSocket message:
- `0x01` = JSON control message
- `0x00` = binary terminal I/O

### 6.2 Protocol Envelope

All JSON control messages use a versioned envelope:

```json
{
  "v": 1,
  "type": "attach",
  "sessionId": "pi-1-claude-agent",
  "requestId": "req-abc123"
}
```

- `v` — protocol version. Required on every message. Server rejects unknown versions.
- `requestId` — optional. Server echoes it back on the corresponding response/error.
- `sessionId` — required on all session-scoped messages.

### 6.3 Client → Server Messages

**Control messages (JSON, prefix `0x01`):**

| type | fields | notes |
|---|---|---|
| `attach` | `sessionId`, `requestId` | Attach to tmux session; server sends snapshot then live output |
| `input` | `sessionId`, `data` | Keystrokes to forward. For MVP, this is JSON since input is small. |
| `resize` | `sessionId`, `cols`, `rows` | Resize tmux client |
| `detach` | `sessionId`, `requestId` | Detach from session (tmux stays alive) |
| `kill` | `sessionId`, `requestId`, `confirm: true` | Kill tmux session. Must include confirm. |
| `restart` | `sessionId`, `requestId` | Restart session from stopped/crashed state |
| `ping` | `requestId` | Keep-alive; server responds with `pong` |

**Terminal input (binary, prefix `0x00`):**

Alternative to JSON `input` for efficiency. First 8 bytes = sessionId length + sessionId,
then raw UTF-8 keystroke bytes. For MVP, JSON `input` is fine — binary input can be added later.

### 6.4 Server → Client Messages

**Terminal output (binary, prefix `0x00`):**

First 8 bytes = UTF-8 length-prefixed sessionId, then raw ANSI output bytes.
Client writes directly to xterm.js: `term.write(outputBytes)`.

**Control messages (JSON, prefix `0x01`):**

| type | fields | notes |
|---|---|---|
| `pong` | `requestId` | Response to client ping |
| `attached` | `sessionId`, `requestId` | Confirm attach succeeded; includes snapshot next |
| `snapshot` | `sessionId`, `data` | Scrollback captured from `tmux capture-pane`. JSON since it's a one-time operation. |
| `status` | `sessionId`, `status`, `pid`, `exitCode` | Session status change |
| `session_update` | `sessionId` + session fields | Pushed to all clients when session metadata changes |
| `error` | `sessionId` (optional), `requestId`, `code`, `message` | Structured errors |
| `kill_ack` | `sessionId`, `requestId` | Confirms kill completed |
| `detach_ack` | `sessionId`, `requestId` | Confirms detach completed |

### 6.5 Error Codes

| code | meaning |
|---|---|
| `SESSION_NOT_FOUND` | tmux session does not exist |
| `SESSION_ALREADY_RUNNING` | cannot restart a running session |
| `SESSION_NOT_STOPPED` | cannot restart from this state |
| `INVALID_SESSION_ID` | sessionId fails validation regex |
| `INVALID_COMMAND_ID` | commandId not in allowlist |
| `INVALID_CWD` | cwd not in allowed roots |
| `AUTH_REQUIRED` | authentication missing or invalid |
| `ATTACH_FAILED` | tmux attach failed |
| `KILL_CONFIRM_REQUIRED` | kill missing confirm flag |
| `PROTOCOL_VERSION` | unsupported protocol version |
| `RATE_LIMITED` | too many requests |
| `INTERNAL` | unexpected server error |

### 6.6 Heartbeat and Keep-Alive

- Client sends `ping` every 30 seconds.
- Server responds with `pong`.
- Server sends `ping` if no client activity for 60 seconds.
- If no response within 10 seconds, close the connection.
- This prevents zombie WebSocket connections from accumulating.

### 6.7 Backpressure and Output Flow Control

- Per-client output queue: max 1MB. If exceeded, drop the oldest buffered frames and log a warning.
- tmux scrollback limit: 10,000 lines (configurable per session or globally).
- Snapshot on reconnect: max 2,000 lines (`tmux capture-pane -S -2000`).
- If browser tab is hidden, xterm.js may not render efficiently. Consider `requestAnimationFrame` throttling.
- Compression: deflate per-message (WebSocket `perMessageDeflate`) can be enabled — measure first.

### 6.8 Reconnect and Snapshot Race

Original plan: capture snapshot, then start streaming. Problem: output between capture
and live attach can be lost or duplicated.

**Revised flow:**
1. Server receives `attach` message.
2. Server spawns `tmux attach-session` via node-pty (or reuses existing bridge).
3. Server sends `snapshot` from `tmux capture-pane -S -2000`.
4. Server immediately begins forwarding live output from the PTY.
5. **Accept the race:** some output may duplicate between the snapshot tail and the first
   live bytes. xterm.js handles duplicate ANSI output reasonably — terminal TUIs redraw.
6. Document this as a known limitation. For correctness-critical use, `tmux -C` (control mode)
   or `pipe-pane` can be evaluated later.

---

## 7. REST API

Use REST for management and WebSocket for terminal streaming.
All endpoints require authentication.
All input is validated server-side.

### 7.1 Health

```http
GET /api/health
```

Returns: `{ status: "ok", tmux: true, uptime: 12345 }`

### 7.2 Sessions

```http
GET    /api/sessions
GET    /api/sessions/:sessionId
POST   /api/sessions
PATCH  /api/sessions/:sessionId
POST   /api/sessions/:sessionId/restart
POST   /api/sessions/:sessionId/kill
DELETE /api/sessions/:sessionId
```

### 7.3 Hosts

```http
GET /api/hosts
```

For local-daemon mode, this returns the daemon's own host info plus configured peer hosts.

### 7.4 Example Create Session Request

```json
{
  "id": "claude-agent",
  "title": "Claude agent",
  "commandId": "claude",
  "cwd": "/home/pi/projects/app"
}
```

- `id` — optional. Auto-generated if omitted. Must match `^[a-z0-9][a-z0-9-]{0,63}$`.
- `commandId` — required. Must exist in the server's command allowlist.
- `cwd` — required. Must be within an allowed-roots list configured on the server.
- **No `command` field** — the server resolves the actual command from `commandId`.
- **No raw shell strings** — the server constructs the tmux command using argv, never shell interpolation.

### 7.5 Create Session Server Behavior

1. Validate `commandId` against allowlist → resolve to actual command string.
2. Validate `cwd` against allowed roots.
3. Validate `id` against regex.
4. Check for tmux session name collision.
5. Run: `tmux new-session -d -s <sessionName> -c <cwd> -- <resolvedCommand>`
   — Use `--` separator to avoid shell interpolation of the command.
6. Insert session record into SQLite.
7. Return 201 with session object.

### 7.6 Kill Session

- Requires `confirm: true` in request body.
- Kills the tmux session (`tmux kill-session -t <name>`).
- Updates DB status to `killed`.
- If `DELETE`, also removes from DB. If `kill`, keeps record for history.

### 7.7 Idempotency

- `kill` on already-killed session → 200 (idempotent).
- `restart` on already-running session → 409 `SESSION_ALREADY_RUNNING`.
- `delete` on non-existent session → 404 or 204 (choose and be consistent).

---

## 8. Frontend Web App (PWA)

### 8.1 Stack

```text
React + Vite + xterm.js + PWA manifest
```

This is also the mobile app. PWA gives: home-screen install, standalone mode,
wake-lock, and the same reconnect model. No separate mobile build needed.

### 8.2 Main Screens

#### Dashboard

Shows:

- Host selector (for multi-Pi setups, routes to each Pi's daemon).
- Sessions for the selected host.
- Session status (with distinct `running` / `stopped` / `crashed` / `unknown` states).
- Process alive indicator (distinct from tmux session alive).
- Attached clients count.
- Last active time.
- Quick actions.

Example layout:

```text
Pi 1 (pi-1.tailnet.ts.net)
  claude-agent       running ● 1 viewer    Attach
  codex-agent        stopped ■ exit 0      Restart
  shell              crashed ▲ exit 137    Restart | Kill

Pi 2 (pi-2.tailnet.ts.net)
  refactor-agent     running ●             Attach
```

#### Terminal Screen

Shows:

- Session title + host name.
- Connection status (connected / reconnecting / disconnected).
- Terminal viewport.
- Quick action buttons.

Actions:

- Detach.
- Restart (only if stopped/crashed).
- Kill (with confirmation dialog).
- Rename.
- Copy output.
- Send Ctrl-C / Ctrl-D / Esc (desktop and mobile key bar).
- Resize preset.
- Font size control.

### 8.3 xterm.js Usage

Use xterm.js for rendering.

Core flow:

```ts
term.onData((data) => {
  socket.send(JSON.stringify({
    v: 1,
    type: "input",
    sessionId,
    data
  }));
});

socket.onmessage = (event) => {
  if (event.data instanceof ArrayBuffer) {
    // Binary frame: extract sessionId prefix, write ANSI bytes to terminal
    const { sessionId, output } = parseBinaryFrame(event.data);
    term.write(output);
  } else {
    const msg = JSON.parse(event.data);
    if (msg.type === "snapshot") {
      term.write(msg.data);
    } else if (msg.type === "status") {
      // Update UI indicators
    }
  }
};
```

Resize flow:

```ts
fitAddon.fit();

socket.send(JSON.stringify({
  v: 1,
  type: "resize",
  sessionId,
  cols: term.cols,
  rows: term.rows
}));
```

### 8.4 Browser UX Requirements

Include:

- Reconnect indicator with auto-reconnect (exponential backoff).
- Explicit detached state.
- Warning before killing a session (must include `confirm: true`).
- Stable terminal size.
- Copy terminal text.
- Paste support.
- Keyboard shortcuts.
- Session search/filter.
- xterm.js safety: disable dangerous OSC sequences (title injection, clipboard, hyperlinks).

---

## 9. Persistence, Reconnect, and Crash Recovery

### 9.1 Why tmux Is Required

Mobile and browser clients disconnect frequently. The client must not own the real session lifecycle.

Use:

```text
tmux owns the long-running coding-agent process.
node-pty bridges only the current viewing/input session.
client owns only the WebSocket connection.
```

### 9.2 Reconnect Flow

When a browser reconnects:

1. Authenticate.
2. Fetch session list via REST.
3. User selects session.
4. Client sends `attach` over WebSocket.
5. Server spawns `tmux attach-session` via node-pty.
6. Server captures scrollback: `tmux capture-pane -t <name> -p -S -2000`.
7. Server sends `snapshot` message.
8. Server immediately begins forwarding live output (binary frames).
9. Accept minor snapshot/live overlap (see §6.8).

### 9.3 Session Survival Rules

- Closing browser tab should not stop tmux.
- Losing network should not stop tmux.
- Restarting frontend should not stop tmux.
- **Restarting Node server should not stop tmux** — tmux sessions are independent processes.
- **On Node server restart, reconcile DB with actual tmux sessions** (see §9.4).
- `kill` should be explicit and confirmed.

### 9.4 Crash Recovery — Server Restart Reconciliation

When the Node server starts up, it must reconcile its SQLite database with reality:

1. Run `tmux list-sessions` to discover all existing tmux sessions.
2. For each DB session:
   a. If matching tmux session exists → mark `status: running` (or check pid).
   b. If no matching tmux session → mark `status: stopped` or `crashed` (check if process exited).
3. For each tmux session not in DB:
   a. Log a warning: orphan tmux session found.
   b. Option A: Add to DB as discovered session.
   c. Option B: Leave it alone, show as "unmanaged" in dashboard.
4. Start health check loop (periodic `tmux has-session` + pid checks).

### 9.5 Stale Session Cleanup

- Periodically scan for tmux sessions with no process alive and no client attached for > N hours.
- Log and optionally auto-clean based on policy.
- Pi disk/RAM is limited — don't let zombie tmux sessions accumulate.

---

## 10. Security Model

This system is remote shell access. Treat it as sensitive.
**Security is not a milestone — it's part of every milestone from day one.**

### 10.1 Threat Model

| Threat | Mitigation |
|---|---|
| Compromised device on Tailscale network | Auth + command allowlist + input validation |
| Stolen auth token | Token revocation + short TTL |
| Malicious terminal output (ANSI escape abuse) | xterm.js safety options; disable title/hyperlink/clipboard OSC sequences |
| Command injection via session API | Allowlist only; no raw commands from clients; argv not shell strings |
| Path traversal via `cwd` | Allowed-roots validation; no `..` resolution outside roots |
| Session ID injection | Strict regex validation |
| WebSocket cross-session hijacking | sessionId bound to authenticated connection |
| Brute-force | Rate limiting on REST and WebSocket |
| CSRF on REST | Token-based auth (not cookies) or CSRF token |
| Data exfiltration via terminal output | Private network only; no public exposure |

### 10.2 MVP Security (Required from Milestone 0)

- Run only over private network (Tailscale).
- Use HTTPS/WSS (Caddy or Tailscale HTTPS).
- Require authentication (device token or Tailscale identity).
- Do not expose unauthenticated terminal endpoints.
- Command allowlist — **no raw `command` field in API**.
- CWD allowlist — **only allowed directories**.
- Input validation — strict regex on `sessionId`, `commandId`, `cwd`.
- Log create/kill/restart actions with structured format.
- xterm.js safety: `allowProposedApi: false`, disable dangerous OSC sequences.

### 10.3 Recommended Personal Setup

```text
Tailscale
+ Caddy HTTPS (or Tailscale built-in HTTPS)
+ Node daemon (per Pi)
+ tmux
+ SQLite
```

### 10.4 Command Allowlist Configuration

Defined in server config, not in client requests:

```json
[
  {
    "id": "claude",
    "label": "Claude coding agent",
    "command": "claude",
    "allowedCwdRoots": ["/home/pi/projects", "/home/pi/code"]
  },
  {
    "id": "codex",
    "label": "Codex coding agent",
    "command": "codex",
    "allowedCwdRoots": ["/home/pi/projects"]
  },
  {
    "id": "shell",
    "label": "Shell",
    "command": "bash",
    "allowedCwdRoots": ["/home/pi"],
    "requiresConfirmation": true
  }
]

```

Shell sessions should require explicit confirmation. Consider disabling them entirely in shared deployments.

### 10.5 Authorization (Minimal)

Even for personal use, define:
- **read** — can view sessions and terminal output.
- **control** — can create, restart, kill sessions.
- All authenticated users get both by default.
- Destructive actions (kill, delete) require explicit `confirm: true` in request body.
- This is a simple baseline that can be extended to RBAC later.

### 10.6 Secrets Management

- Auth tokens: environment variables or file-based.
- API keys for coding agents (e.g., `ANTHROPIC_API_KEY`): stored in a `.env` file
  on the Pi, referenced in session `env` config — never sent from client.
- Token revocation: support a deny-list file or DB table.

---

## 11. Mobile Strategy — PWA

### 11.1 PWA, Not Capacitor

The original plan proposed Capacitor for mobile. After review, **PWA is the right choice:**

| Feature | PWA | Capacitor |
|---|---|---|
| Home-screen install | ✅ | ✅ |
| Full-screen / standalone | ✅ `display: standalone` | ✅ |
| Wake-lock | ✅ `navigator.wakeLock` | ✅ |
| Push notifications | ✅ (limited) | ✅ |
| App Store review | ❌ Not needed | ✅ Painful |
| Extra build targets | ❌ | iOS + Android |
| Background persistence | ❌ Suspended anyway | ❌ Also suspended |
| Codebase | Same React app | Wrapper + native code |

**Key fact:** iOS and Android both suspend background apps' WebSocket connections.
Capacitor does NOT solve this. The tmux-on-server reconnect model handles it regardless.
Therefore, the cost of Capacitor (App Store, certificates, two build targets) is not justified.

### 11.2 PWA Requirements

- `manifest.json` with `display: standalone`, icons, theme color.
- Service worker for offline page caching (not for terminal — terminal requires network).
- Register `navigator.wakeLock` when terminal is active.
- Handle `visibilitychange` and `online`/`offline` events for reconnect.

### 11.3 Mobile-Specific UI Features

All implemented in the same React PWA:

- Custom terminal key bar (essential on mobile).
- Landscape-first terminal mode.
- Pinch-to-zoom or font-size control.
- Session cards optimized for touch.
- Reconnect handling.
- Copy/paste controls.
- Quick send buttons for common control keys.

Suggested key bar:

```text
Esc | Tab | Ctrl-C | Ctrl-D | ↑ | ↓ | ← | → | / | ~ | Enter
```

### 11.4 Mobile Reconnect Rules

- Never depend on the mobile client to keep a session alive.
- Always keep sessions alive in tmux.
- On app resume / visibility change: reconnect WebSocket, re-fetch session list, reattach.
- Handle Safari/iOS WebSocket quirks (aggressive connection close on background).
- Debounce reconnect attempts with exponential backoff.

---

## 12. Implementation Milestones

### Milestone 0 — Local Terminal Spike + Security Baseline

Goal: prove terminal bridge works, with security from day one.

Tasks:

- Create Node project (Fastify + ws + node-pty + better-sqlite3).
- **Verify node-pty and better-sqlite3 build on target Pi/ARM** — this is the highest-risk dependency; spike it first.
- Implement HTTPS (Caddy or Tailscale HTTPS) from the start.
- Implement basic auth (device token in header).
- Spawn `tmux attach-session` via node-pty (not raw shell).
- Connect browser xterm.js client with binary frame support for output.
- Send input from browser to PTY.
- Render output from PTY to browser.
- Implement terminal resize.
- Add command allowlist config.
- Add input validation (sessionId regex, commandId allowlist).

Success criteria:

- Browser can control a tmux session over HTTPS with auth.
- Ctrl-C, arrow keys, resize work.
- No unauthenticated access.
- node-pty builds successfully on ARM.

---

### Milestone 1 — tmux Persistence + Session Management

Goal: sessions survive disconnects; can be created/managed via API.

Tasks:

- Add session create endpoint (with commandId allowlist, cwd validation).
- Add session list/get/kill/restart/delete endpoints.
- Implement tmux session creation with `--` separator (no shell interpolation).
- Add tmux capture-pane snapshot on reconnect.
- Confirm browser detach does not kill tmux session.
- Confirm browser reconnect can reattach with snapshot.
- Add SQLite schema (session model with full fields from §5.2).
- Add session state machine logic.
- Add per-session locking for concurrent operations.
- Add structured action logging.

Success criteria:

- Closing browser does not kill session.
- Reopening browser reconnects with snapshot before live output.
- Sessions can be created, listed, killed, restarted via REST.
- Kill requires confirmation.
- No raw commands accepted from clients.

---

### Milestone 2 — Dashboard + Multi-Session UX

Goal: manage multiple sessions comfortably from a browser.

Tasks:

- Build React dashboard (session list, status, actions).
- Build create-session form (commandId dropdown, cwd picker).
- Build terminal view with xterm.js.
- Add WebSocket protocol: attach, input, resize, detach, kill, ping/pong.
- Add snapshot + live output on attach.
- Add reconnect UI (connection status indicator, auto-reconnect).
- Add quick buttons: Ctrl-C, Ctrl-D, Esc.
- Add font-size control.
- Add copy/paste support.
- Add search/filter sessions.
- Add confirmation dialogs for kill/delete.
- Add session status with distinct running/stopped/crashed/unknown states.
- Add attached-clients indicator.

Success criteria:

- User can create, view, attach, detach, restart, and kill sessions from web UI.
- Reconnect after tab close works.
- Terminal is comfortable for daily use from laptop browser.

---

### Milestone 3 — Multi-Pi Support (Local Daemon Model)

Goal: manage sessions on more than one Pi.

Architecture: each Pi runs its own Node daemon. Dashboard routes to the right Pi.

Tasks:

- Add host config (static file or auto-detect from Tailscale).
- Dashboard shows host selector + sessions grouped by host.
- Browser connects directly to selected Pi's daemon over Tailscale.
- Add per-host health endpoint polling.
- Add host offline/unknown state handling.
- Add systemd unit file for each Pi's daemon.
- Add crash recovery: on daemon start, reconcile DB with `tmux list-sessions`.
- Add stale session cleanup policy.

Success criteria:

- Dashboard can manage sessions on at least two Pis.
- One Pi going down does not affect the other.
- Daemon restart does not lose tmux sessions.
- Orphan tmux sessions are detected and logged.

---

### Milestone 4 — Web + Mobile PWA Polish

Goal: make the PWA usable daily from both laptop and mobile browsers.

Tasks:

- Add PWA manifest and service worker.
- Add responsive layout.
- Add mobile terminal key bar.
- Add landscape-first terminal mode on mobile.
- Add touch-friendly session cards.
- Add `navigator.wakeLock` when terminal is active.
- Add mobile-safe reconnect (visibility change, online/offline events, Safari quirks).
- Add reconnect with exponential backoff.
- Add viewport resize debounce.
- Add rate limiting on REST and WebSocket.
- Add health endpoint with tmux status.
- Add logs/errors panel in dashboard.

Success criteria:

- iPhone and Android browser can attach, send keys, and reconnect.
- PWA installs to home screen and runs standalone.
- Wake-lock keeps terminal alive while active.
- All security controls operational.

---

### Milestone 5 — Advanced Features

Goal: quality-of-life improvements for daily use.

Tasks:

- Add saved prompts/snippets feature.
- Add session pinning/favorites.
- Add orientation lock option.
- Add haptic feedback for special keys (mobile, optional).
- Add command palette.
- Add copy/share terminal output.
- Add saved connection configuration per host.
- Add auto-restart policy (`on-crash` option).

Success criteria:

- Mobile PWA is practical for monitoring and light intervention.
- Frequently-used prompts are one tap away.

---

### Milestone 6 — SSH Gateway (Optional / Advanced)

Goal: support central gateway mode for scenarios where installing a daemon per Pi is undesirable.

**This milestone is optional.** Do not start it until the local daemon model is proven and stable.

Tasks:

- Add SSH connection management: `ControlMaster`, `ServerAliveInterval=15`, `ServerAliveCountMax=3`.
- Add SSH key storage and rotation.
- Add host key verification policy.
- Add SSH reconnect loop with backoff.
- Central gateway creates and attaches to tmux sessions over SSH.
- Handle nested PTY/tmux resize issues.
- Test terminal fidelity through SSH → tmux → node-pty → WebSocket chain.

Success criteria:

- Central gateway can manage sessions on at least two Pis over SSH.
- SSH disconnect does not freeze the terminal for more than a few seconds.
- SSH connection restores automatically.

---

### Milestone 7 — Advanced Protocol and Scale

Goal: optimize for heavier use patterns.

Tasks:

- Evaluate `perMessageDeflate` WebSocket compression.
- Evaluate `tmux -C` (control mode) for more reliable reconnect snapshots.
- Evaluate `µWebSockets.js` or Node 22 native `WebSocketServer` for performance.
- Add per-client output backpressure metrics.
- Add multi-user auth with read vs control roles (if needed).
- Add optional single-writer/controller policy for exclusive input.

Success criteria:

- Terminal output handles high-throughput agents without browser lag.
- System handles 5+ concurrent sessions per Pi without degradation.

---

## 13. Testing Strategy

### 13.1 Unit Tests

- Protocol message parsing and serialization.
- Session state machine transitions.
- Input validation (sessionId regex, commandId allowlist, cwd roots).
- Allowlist resolution.
- Error code generation.

### 13.2 Integration Tests

- tmux session lifecycle (create → attach → detach → reattach → kill).
- SQLite CRUD operations.
- WebSocket connect → attach → input → output → detach flow.
- REST API create → list → kill → restart → delete cycle.
- Crash recovery: DB reconciliation with `tmux list-sessions` after server restart.
- Kill idempotency.

### 13.3 End-to-End Tests

- Automated browser test: open dashboard → create session → attach → type → see output → detach → reattach.
- Reconnect test: attach → kill WebSocket → verify no terminal freeze → reconnect → verify snapshot appears.
- Mobile browser test (emulated): attach with mobile viewport → use key bar → background → resume → reconnect.

### 13.4 Security Tests

- Unauthenticated request rejected on every endpoint.
- Invalid sessionId rejected.
- Invalid commandId rejected.
- cwd outside allowed roots rejected.
- Kill without `confirm: true` rejected.
- WebSocket cross-session hijacking prevented.
- Rate limiting verified.

### 13.5 Platform-Specific Tests

- node-pty build on ARM (Raspberry Pi OS, Ubuntu ARM64).
- Safari/iOS WebSocket reconnect behavior.
- Tailscale DNS resolution timing.

---

## 14. Operational Model

### 14.1 Process Management

- `systemd` unit file for each Pi's Node daemon.
- Auto-restart on crash (`Restart=on-failure`).
- Log output to journald (`StandardOutput=journal`).

### 14.2 Health Monitoring

- `GET /api/health` — checks Node process, tmux availability, SQLite.
- Periodic cron or systemd timer: check health, alert on failure.
- Dashboard polls each host's health endpoint.

### 14.3 Logging

- Structured JSON logs.
- Fields: timestamp, level, action, sessionId, hostId, requestId, durationMs, error.
- Actions logged: session create, kill, restart, attach, detach, auth failure, validation failure.
- Logs go to journald via systemd.

### 14.4 Backup

- SQLite WAL mode for crash resilience.
- Periodic `sqlite3 .backup` or `.dump` to a backup file.
- tmux sessions are not backed up (they're ephemeral by nature).
- Session metadata in SQLite can be reconstructed from tmux if lost.

### 14.5 Deployment

```bash
# Initial setup per Pi
scp -r tui-serve/ pi-1:/opt/tui-serve/
ssh pi-1 'cd /opt/tui-serve/server && npm install && npm run build'
ssh pi-1 'sudo cp deploy/systemd/tui-serve.service /etc/systemd/system/'
ssh pi-1 'sudo systemctl enable --now tui-serve'
```

- Update: git pull → npm install → npm run build → `sudo systemctl restart tui-serve`.
- Rollback: `sudo systemctl revert tui-serve` or redeploy previous version.

### 14.6 Resource Limits

- Max concurrent WebSocket connections per daemon: 50 (configurable).
- Max sessions per Pi: 20 (configurable).
- Max tmux scrollback: 10,000 lines.
- Max snapshot: 2,000 lines.
- Per-client output queue: 1MB.

---

## 15. Project Structure

**Flat structure for MVP.** Decompose when you have the code to decompose.

```text
tui-serve/
  server/
    index.ts              # Fastify + ws server entry point
    auth.ts               # Authentication middleware
    db.ts                 # SQLite setup, schema-on-startup
    sessions.ts           # Session CRUD, state machine, locking
    tmux.ts               # tmux command wrappers (create, attach, kill, capture, list)
    ptyBridge.ts          # node-pty bridge: spawns tmux attach-session
    ws.ts                 # WebSocket handler (protocol, heartbeat, routing)
    hosts.ts              # Host config and health checks
    allowlist.ts          # Command and CWD allowlist config + validation
    config.ts             # Server configuration (ports, TLS, auth tokens, allowlists)
    protocol.ts           # Protocol types: envelope, message types, error codes
  web/
    src/
      App.tsx
      Dashboard.tsx
      TerminalView.tsx
      HostList.tsx
      SessionList.tsx
      MobileKeyBar.tsx
      lib/
        terminalSocket.ts # WebSocket client: binary frames, reconnect, heartbeat
        apiClient.ts      # REST API client
    public/
      manifest.json       # PWA manifest
      sw.js               # Service worker
    index.html
  deploy/
    systemd/
      tui-serve.service  # systemd unit file
    caddy/
      Caddyfile                 # Reverse proxy config
  README.md
```

No `apps/mobile/` — the web app IS the mobile app (PWA).
No `shared/` — protocol types are in `server/protocol.ts`, duplicated into `web/src/lib/` for MVP.
  If duplication becomes painful, extract a `shared/` package later.
No `migrations/` — use schema-on-startup for SQLite in MVP.

---

## 16. Initial Package Choices

### Backend

```bash
npm install fastify ws node-pty better-sqlite3 zod
npm install -D typescript tsx @types/node @types/ws
```

**ARM build note:** `node-pty` and `better-sqlite3` are native modules.
They require build tools on the Pi (`build-essential`, `python3`, `make`, `g++`).
Test the install on target Pi hardware in Milestone 0 before committing to this stack.

Optional SSH support (Milestone 6 only):

```bash
npm install ssh2
```

### Frontend

```bash
npm create vite@latest web -- --template react-ts
npm install @xterm/xterm @xterm/addon-fit
```

Optional UI:

```bash
npm install lucide-react
```

### PWA

```bash
npm install vite-plugin-pwa workbox-window
```

### No Mobile Native Packages

No Capacitor. No React Native. PWA is the mobile path.

---

## 17. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Browser disconnect kills session | tmux owns process, not the client |
| Node server restart kills session | tmux sessions survive; reconcile on startup |
| Mobile browser suspends WebSocket | PWA reconnect on visibility change + tmux persistence |
| Public exposure of shell | Tailscale/VPN + auth + HTTPS from day one |
| Terminal resize breaks TUI | Debounce resize; add presets; tmux handles multi-client resize |
| Mobile keyboard lacks terminal keys | Custom key bar in React PWA |
| Command injection RCE | Command allowlist + ID-only API + cwd roots + strict validation |
| Terminal output overwhelms browser | Binary frames + per-client backpressure + scrollback limits |
| node-pty / better-sqlite3 build fails on ARM | Spike on target Pi in Milestone 0; pin Node LTS |
| tmux session orphaned after DB reset | Reconciliation on startup; stale cleanup policy |
| Stale controller after mobile disconnect | Dropped single-writer for MVP; tmux handles multi-client natively |
| SSH instability (future milestone) | ControlMaster + keepalive + reconnect loop + backoff |
| ANSI escape abuse (title injection, clipboard) | xterm.js safety options; disable dangerous OSC sequences |
| Safari/iOS WebSocket quirks | Tested reconnect; visibility change handling; exponential backoff |
| SQLite corruption on Pi power loss | WAL mode; periodic backup; schema-on-startup self-heal |
| Two clients kill same session | Per-session locking; idempotent kill |
| Dashboard shows stale status | Periodic health check + tmux has-session + pid checks |

---

## 18. Multi-Client Input Policy (MVP: Shared)

**Dropped custom single-writer policy for MVP.** tmux handles multi-client attach natively —
all attached clients can type. This is how tmux works by default and it's fine for personal use.

If exclusive control is needed later (e.g., multi-user scenarios), add it in Milestone 7:

- Controller lease with TTL.
- Explicit acquire/release protocol messages.
- Server-enforced input rejection for viewers.
- Or: read-only tmux attach for viewers, single shared-bridge fanout.

But this is not justified for the MVP. Do not build it until there's a demonstrated need.

---

## 19. Recommended Build Order

Build in this order:

1. **ARM spike** — verify node-pty + better-sqlite3 build on Pi.
2. **Terminal bridge** — node-pty → tmux attach → binary WebSocket → xterm.js, with HTTPS + auth.
3. **tmux persistence** — sessions survive disconnects; snapshot on reconnect.
4. **Session API** — create/list/kill/restart with allowlist, validation, lock, state machine.
5. **Dashboard** — React UI: session list, terminal view, actions.
6. **Multi-Pi** — local daemon per Pi, dashboard routes to Tailscale hosts, health checks.
7. **PWA polish** — mobile key bar, responsive, wake-lock, reconnect, service worker.
8. **Quality-of-life** — snippets, auto-restart, logs panel, rate limits.
9. **(Optional) SSH gateway** — central mode with SSH connection management.
10. **(Optional) Advanced protocol** — compression, control mode, controller policy.

---

## 20. First Working Prototype Definition

The first prototype is complete when:

- The server runs on a Pi with HTTPS + auth.
- A browser can open the dashboard.
- A user can create a session from the allowlist (e.g., `claude`).
- The server creates a tmux session with validated command + cwd.
- The browser attaches via xterm.js with binary output frames.
- Keyboard input reaches the coding agent.
- Terminal output renders correctly.
- Browser refresh does not kill the session.
- Reopening the browser can reattach (with snapshot + live output).
- Ctrl-C, Enter, arrows, and resize work.
- No unauthenticated access is possible.
- No raw commands can be submitted from the client.

---

## 21. Final Recommendation

Start with:

```text
Web MVP (with security from day one):
React + xterm.js + Vite (PWA)
Node.js + Fastify + ws + node-pty
tmux
SQLite (schema-on-startup)
Tailscale + Caddy HTTPS
Command + CWD allowlist + input validation
Binary WebSocket frames for terminal I/O
```

Architecture:

```text
One Node.js daemon per Pi.
No SSH between hosts.
Dashboard routes browser to the right Pi over Tailscale.
tmux owns the agent process.
node-pty only bridges the current viewer.
```

Mobile path:

```text
Same React PWA.
No Capacitor. No native wrapper.
Custom key bar in HTML.
Same WebSocket backend.
```

This path minimizes duplicated work, eliminates SSH complexity,
keeps security built-in from the start, and keeps the hardest part —
terminal emulation — inside xterm.js.

---

## Appendix A: Changes from v1

This section summarizes what changed from the original plan and why.

| v1 Plan | v2 Change | Reason |
|---|---|---|
| Central gateway + SSH recommended first | Local daemon per Pi is MVP; SSH is optional milestone | SSH is a known footgun for terminal streaming; local daemon eliminates an entire class of bugs |
| Security hardening in Milestone 4 | Security from Milestone 0 | Remote shell endpoint without auth is an RCE gateway; retrofit is painful |
| Raw `command` field in API | `commandId` allowlist only | Command injection risk; even private networks can have compromised devices |
| JSON-only WebSocket protocol | Hybrid binary + JSON | Terminal output is high bandwidth; JSON parsing is wasteful; binary is hard to retrofit |
| No protocol versioning or error codes | Versioned envelope + structured error codes | Without versioning, protocol evolution requires breaking changes; without structured errors, clients can't handle failures |
| No heartbeat | ping/pong every 30s | Zombie WebSocket connections accumulate without keep-alive |
| No backpressure | Per-client queue limit + scrollback cap | Terminal output can overwhelm browser memory and server buffers |
| Single-writer policy in MVP | Dropped for MVP | tmux already handles multi-client; custom policy adds complexity without demonstrated need |
| Capacitor for mobile | PWA | Capacitor costs App Store review + 2 build targets; iOS kills background WebSockets regardless |
| Express | Fastify | Better TypeScript support, built-in schema validation, better performance |
| 9 milestones (0-8) | 8 milestones (0-7) | Eliminated Capacitor milestones; merged web+mobile polish; pushed SSH to optional |
| `apps/` + `shared/` monorepo | Flat structure | YAGNI — don't create directories for things that aren't built yet |
| No testing strategy | Added §13 testing strategy | Terminal behavior regressions are invisible without tests |
| No operational model | Added §14 ops model | Pi deployment needs systemd, health checks, logging, backup, resource limits |
| No crash recovery | Added §9.4 reconciliation | Server restart must rediscover existing tmux sessions |
| No error handling strategy | Session state machine + idempotency + per-session locks | Race conditions without locks; stale state without state machine |
| Session model missing fields | Added tmuxSessionName, pid, exitCode, attachedClients, restartPolicy, env, updatedAt | Conflating "tmux alive" and "agent alive" causes bugs; missing fields require schema migrations later |