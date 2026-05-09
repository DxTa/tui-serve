// PTY Bridge — spawns `tmux attach-session` via node-pty
// Primary: node-pty (creates proper pseudoterminal for tmux attach)
// Fallback: tmux capture-pane polling + send-keys (works without TTY/native modules)

import { execSync } from 'child_process';
import * as tmux from './tmux.js';
import { config } from './config.js';

// Local logger to avoid circular dependency
function log(level: string, msg: string, data?: Record<string, unknown>) {
  console.log(JSON.stringify({ level, action: `pty.${msg}`, timestamp: new Date().toISOString(), ...data }));
}

export interface IPtyProcess {
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
}

// Per-session tracking
const activeBridges = new Map<string, Set<IPtyProcess>>();

export function getAttachedCount(sessionId: string): number {
  return activeBridges.get(sessionId)?.size ?? 0;
}

export function registerBridge(sessionId: string, pty: IPtyProcess): void {
  if (!activeBridges.has(sessionId)) activeBridges.set(sessionId, new Set());
  activeBridges.get(sessionId)!.add(pty);
}

export function unregisterBridge(sessionId: string, pty: IPtyProcess): void {
  activeBridges.get(sessionId)?.delete(pty);
  if (activeBridges.get(sessionId)?.size === 0) activeBridges.delete(sessionId);
}

export function killAllBridgesForSession(sessionId: string): void {
  const bridges = activeBridges.get(sessionId);
  if (bridges) {
    for (const pty of bridges) {
      try { pty.kill(); } catch {}
    }
    activeBridges.delete(sessionId);
  }
}

// ── Module loading ──

let ptyModule: any = null;
let useFallback = false;

// Load node-pty asynchronously
async function loadPtyModule(): Promise<void> {
  try {
    ptyModule = await import('node-pty');
    log('info', 'node-pty loaded successfully');
  } catch {
    if (config.enablePollingPtyFallback) {
      log('warn', 'node-pty NOT available, using polling fallback');
      useFallback = true;
      return;
    }
    log('error', 'node-pty NOT available and polling fallback disabled');
    useFallback = false;
  }
}

// Start loading immediately
const loadPromise = loadPtyModule();

export async function waitForPtyReady(): Promise<void> {
  await loadPromise;
}

// ── Factory ──

export function createPtyBridge(
  tmuxSessionName: string,
  cols = 80,
  rows = 24,
): IPtyProcess {
  if (!useFallback && ptyModule) {
    try {
      return createNodePtyBridge(tmuxSessionName, cols, rows);
    } catch (err) {
      if (config.enablePollingPtyFallback) {
        log('warn', 'node-pty spawn failed, falling back to polling', { error: String(err) });
        return createPollingBridge(tmuxSessionName, cols, rows);
      }
      throw err;
    }
  }
  if (config.enablePollingPtyFallback) return createPollingBridge(tmuxSessionName, cols, rows);
  throw new Error('node-pty unavailable; set TUI_SERVE_ENABLE_POLLING_PTY_FALLBACK=1 to allow polling fallback');
}

// ── node-pty bridge (primary) ──

function createNodePtyBridge(tmuxSessionName: string, cols: number, rows: number): IPtyProcess {
  log('info', 'creating node-pty bridge', { session: tmuxSessionName, cols, rows });

  const pty = ptyModule.spawn('tmux', ['attach-session', '-t', tmuxSessionName], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.env.HOME || '/tmp',
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  const dataListeners: Array<(data: string) => void> = [];
  const exitListeners: Array<(code: number | null) => void> = [];

  pty.onData((data: string) => {
    for (const cb of dataListeners) cb(data);
  });

  pty.onExit(({ exitCode }: { exitCode: number }) => {
    log('info', 'node-pty exited', { session: tmuxSessionName, exitCode });
    for (const cb of exitListeners) cb(exitCode);
  });

  return {
    write: (data: string | Buffer) => {
      try { pty.write(typeof data === 'string' ? data : data.toString('utf-8')); } catch {}
    },
    resize: (newCols: number, newRows: number) => {
      try { pty.resize(newCols, newRows); } catch {}
    },
    kill: () => { try { pty.kill(); } catch {} },
    onData: (cb) => dataListeners.push(cb),
    onExit: (cb) => exitListeners.push(cb),
  };
}

// ── Polling bridge (fallback — no TTY needed) ──

function createPollingBridge(tmuxSessionName: string, cols: number, rows: number): IPtyProcess {
  log('info', 'creating polling bridge', { session: tmuxSessionName, cols, rows });

  let running = true;
  let lastSnapshot = '';
  const dataListeners: Array<(data: string) => void> = [];
  const exitListeners: Array<(code: number | null) => void> = [];

  // Resize the tmux window to match
  tmux.resizeWindow(tmuxSessionName, cols, rows);

  // Poll capture-pane every 150ms for responsive output
  const pollInterval = setInterval(() => {
    if (!running) return;

    if (!tmux.hasSession(tmuxSessionName)) {
      clearInterval(pollInterval);
      for (const cb of exitListeners) cb(null);
      return;
    }

    const snapshot = tmux.capturePane(tmuxSessionName, 2000);
    if (snapshot !== lastSnapshot) {
      // Send a full-screen refresh: clear + rewrite
      // This is safe for xterm.js — it handles \x1b[2J (clear) + \x1b[H (home)
      for (const cb of dataListeners) cb('\x1b[2J\x1b[H' + snapshot);
      lastSnapshot = snapshot;
    }
  }, 150);

  return {
    write: (data: string | Buffer) => {
      if (!running || !tmux.hasSession(tmuxSessionName)) return;
      const str = typeof data === 'string' ? data : data.toString('utf-8');

      // Map common keys to tmux send-keys syntax
      const esc = (s: string) => s.replace(/'/g, "'\\''");
      const target = esc(tmuxSessionName);

      try {
        if (str === '\x03') {
          execSync(`tmux send-keys -t '${target}' C-c`, { timeout: 5000 });
        } else if (str === '\x04') {
          execSync(`tmux send-keys -t '${target}' C-d`, { timeout: 5000 });
        } else if (str === '\x1b') {
          execSync(`tmux send-keys -t '${target}' Escape`, { timeout: 5000 });
        } else if (str === '\r') {
          execSync(`tmux send-keys -t '${target}' Enter`, { timeout: 5000 });
        } else if (str === '\t') {
          execSync(`tmux send-keys -t '${target}' Tab`, { timeout: 5000 });
        } else if (str === '\x7f') {
          execSync(`tmux send-keys -t '${target}' BSpace`, { timeout: 5000 });
        } else if (str === '\x1b[A') {
          execSync(`tmux send-keys -t '${target}' Up`, { timeout: 5000 });
        } else if (str === '\x1b[B') {
          execSync(`tmux send-keys -t '${target}' Down`, { timeout: 5000 });
        } else if (str === '\x1b[D') {
          execSync(`tmux send-keys -t '${target}' Left`, { timeout: 5000 });
        } else if (str === '\x1b[C') {
          execSync(`tmux send-keys -t '${target}' Right`, { timeout: 5000 });
        } else {
          // Regular text — send literally with -l flag
          execSync(`tmux send-keys -t '${target}' -l '${esc(str)}'`, { timeout: 5000 });
        }
      } catch {}
    },
    resize: (newCols: number, newRows: number) => {
      tmux.resizeWindow(tmuxSessionName, newCols, newRows);
    },
    kill: () => {
      running = false;
      clearInterval(pollInterval);
    },
    onData: (cb) => dataListeners.push(cb),
    onExit: (cb) => exitListeners.push(cb),
  };
}