// Session manager — ties together DB, tmux, allowlist, ptyBridge
// Implements session state machine per plan §5.3

import * as db from './db.js';
import * as tmux from './tmux.js';
import * as allowlist from './allowlist.js';
import { killAllBridgesForSession } from './ptyBridge.js';
import { PROTOCOL_VERSION, ErrorCode, type SessionStatus } from './protocol.js';
// Local logger to avoid circular dependency
const logger = {
  info(msg: string, data?: Record<string, unknown>) {
    console.log(JSON.stringify({ level: 'info', action: `sessions.${msg}`, timestamp: new Date().toISOString(), ...data }));
  },
  warn(msg: string, data?: Record<string, unknown>) {
    console.warn(JSON.stringify({ level: 'warn', action: `sessions.${msg}`, timestamp: new Date().toISOString(), ...data }));
  },
};

// Per-session lock to prevent concurrent mutations
const sessionLocks = new Map<string, Promise<void>>();

async function withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionLocks.get(sessionId) ?? Promise.resolve();
  const next = prev.then(() => fn(), (err) => { throw err; });
  sessionLocks.set(sessionId, next.then(() => {}, () => {}));
  return next;
}

// Health check interval
let healthCheckTimer: ReturnType<typeof setInterval> | null = null;

export function startHealthCheck(intervalMs = 30000): void {
  if (healthCheckTimer) clearInterval(healthCheckTimer);
  healthCheckTimer = setInterval(() => checkAllSessions(), intervalMs);
}

export function stopHealthCheck(): void {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}

function checkAllSessions(): void {
  const sessions = db.listSessions();
  for (const session of sessions) {
    if (session.status === 'killed') continue;

    const exists = tmux.hasSession(session.tmuxSessionName);
    if (!exists && (session.status === 'running' || session.status === 'starting')) {
      // tmux session disappeared — agent probably exited
      const exitCode = getExitCode(session);
      const newStatus: SessionStatus = exitCode === 0 ? 'stopped' : 'crashed';
      logger.info('healthCheck: session disappeared', { sessionId: session.id, newStatus, exitCode });
      db.updateSessionStatus(session.id, newStatus, null, exitCode);
    } else if (exists && session.status === 'running') {
      // Check if agent process is still alive
      const pid = tmux.getSessionPid(session.tmuxSessionName);
      if (pid !== session.pid && pid !== null) {
        db.updateSessionStatus(session.id, 'running', pid);
      }
    }
  }
}

function getExitCode(session: db.Session): number | null {
  // We can't reliably get the exit code of the tmux process after it's gone
  // This is best-effort; null means unknown
  return null;
}

// ── Reconciliation on startup ──

export function reconcileOnStartup(): void {
  logger.info('SessionManager: reconciling DB with tmux sessions');
  const tmuxSessions = tmux.listSessions();
  const dbSessions = db.listSessions();

  for (const session of dbSessions) {
    if (tmuxSessions.includes(session.tmuxSessionName)) {
      if (session.status !== 'running') {
        const pid = tmux.getSessionPid(session.tmuxSessionName);
        logger.info('reconcile: session found in tmux, updating DB', { sessionId: session.id, pid });
        db.updateSessionStatus(session.id, 'running', pid);
      }
    } else if (session.status === 'running' || session.status === 'starting') {
      logger.info('reconcile: session not in tmux, marking stopped', { sessionId: session.id });
      db.updateSessionStatus(session.id, 'stopped', null, null);
    }
  }

  // Detect orphan tmux sessions
  const dbTmuxNames = new Set(dbSessions.map((s) => s.tmuxSessionName));
  for (const tmuxName of tmuxSessions) {
    if (!dbTmuxNames.has(tmuxName)) {
      logger.warn('reconcile: orphan tmux session found', { tmuxSessionName: tmuxName });
    }
  }
}

// ── CRUD operations ──

export function createSession(opts: { id?: string; title?: string; commandId: string; cwd: string }): db.Session | { error: ErrorCode; message: string } {
  const commandId = opts.commandId;

  // Validate commandId
  if (!allowlist.validateCommandId(commandId)) {
    return { error: ErrorCode.INVALID_COMMAND_ID, message: `Invalid commandId: ${commandId}` };
  }

  // Validate and generate sessionId
  const sessionId = opts.id || `${commandId}-${Date.now().toString(36)}`;
  if (!allowlist.validateSessionId(sessionId)) {
    return { error: ErrorCode.INVALID_SESSION_ID, message: `Invalid sessionId: ${sessionId}. Must match ^[a-z0-9][a-z0-9-]{0,63}$` };
  }

  // Check for duplicate
  if (db.getSession(sessionId)) {
    return { error: ErrorCode.INVALID_SESSION_ID, message: `Session already exists: ${sessionId}` };
  }

  // Validate cwd
  if (!allowlist.validateCwd(commandId, opts.cwd)) {
    return { error: ErrorCode.INVALID_CWD, message: `Invalid cwd: ${opts.cwd}. Not in allowed roots for command: ${commandId}` };
  }

  const command = allowlist.resolveCommand(commandId)!;
  const tmuxSessionName = sessionId;

  // Check for tmux session name collision
  if (tmux.hasSession(tmuxSessionName)) {
    return { error: ErrorCode.INVALID_SESSION_ID, message: `tmux session already exists: ${tmuxSessionName}` };
  }

  // Create the tmux session
  try {
    tmux.createSession(tmuxSessionName, opts.cwd, command);
  } catch (err) {
    return { error: ErrorCode.ATTACH_FAILED, message: `Failed to create tmux session: ${err}` };
  }

  // Insert into DB
  const session = db.insertSession({
    id: sessionId,
    title: opts.title || commandId,
    commandId,
    command,
    cwd: opts.cwd,
    tmuxSessionName,
  });

  logger.info('session.created', { sessionId, commandId, cwd: opts.cwd });

  // Try to get the PID after a short delay
  setTimeout(() => {
    const pid = tmux.getSessionPid(tmuxSessionName);
    if (pid) {
      db.updateSessionStatus(sessionId, 'running', pid);
    }
  }, 2000);

  return session;
}

export function killSession(sessionId: string, confirm: boolean): db.Session | { error: ErrorCode; message: string } {
  if (!confirm) {
    return { error: ErrorCode.KILL_CONFIRM_REQUIRED, message: 'Kill requires confirm: true' };
  }

  return withLock(sessionId, async () => {
    const session = db.getSession(sessionId);
    if (!session) {
      return { error: ErrorCode.SESSION_NOT_FOUND, message: `Session not found: ${sessionId}` };
    }

    // Kill all PTY bridges first
    killAllBridgesForSession(session.tmuxSessionName);

    // Kill tmux session (idempotent)
    if (tmux.hasSession(session.tmuxSessionName)) {
      try { tmux.killSession(session.tmuxSessionName); } catch {}
    }

    // Update DB
    db.updateSessionStatus(sessionId, 'killed', null, null);
    logger.info('session.killed', { sessionId });

    return db.getSession(sessionId)!;
  }) as any;
}

export function restartSession(sessionId: string): db.Session | { error: ErrorCode; message: string } {
  const session = db.getSession(sessionId);
  if (!session) {
    return { error: ErrorCode.SESSION_NOT_FOUND, message: `Session not found: ${sessionId}` };
  }

  if (session.status === 'running') {
    return { error: ErrorCode.SESSION_ALREADY_RUNNING, message: `Session is already running: ${sessionId}` };
  }

  if (session.status !== 'stopped' && session.status !== 'crashed') {
    return { error: ErrorCode.SESSION_NOT_STOPPED, message: `Cannot restart session in state: ${session.status}` };
  }

  // Kill old tmux session if it still exists
  if (tmux.hasSession(session.tmuxSessionName)) {
    try { tmux.killSession(session.tmuxSessionName); } catch {}
  }

  // Re-create
  try {
    tmux.createSession(session.tmuxSessionName, session.cwd, session.command);
  } catch (err) {
    return { error: ErrorCode.ATTACH_FAILED, message: `Failed to restart tmux session: ${err}` };
  }

  db.updateSessionStatus(sessionId, 'running', tmux.getSessionPid(session.tmuxSessionName), null);
  logger.info('session.restarted', { sessionId });

  return db.getSession(sessionId)!;
}

export function listSessions(): db.Session[] {
  return db.listSessions();
}

export function getSession(sessionId: string): db.Session | null {
  return db.getSession(sessionId);
}

export function deleteSession(sessionId: string): boolean {
  // Clean up tmux if still running
  const session = db.getSession(sessionId);
  if (session && tmux.hasSession(session.tmuxSessionName)) {
    try { tmux.killSession(session.tmuxSessionName); } catch {}
    killAllBridgesForSession(session.tmuxSessionName);
  }
  return db.deleteSession(sessionId);
}

export function updateSession(sessionId: string, updates: Partial<Pick<db.Session, 'title' | 'restartPolicy'>>): db.Session | null {
  const session = db.getSession(sessionId);
  if (!session) return null;
  db.updateSession(sessionId, updates);
  return db.getSession(sessionId);
}