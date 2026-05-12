// Session manager — ties together SessionStore (tmux authority), tmux, allowlist, ptyBridge
// Implements session state machine with tmux as single source of truth

import { TmuxSessionStore, type Session, type CreateSessionInput } from './SessionStore.js';
import * as tmux from './tmux.js';
import * as allowlist from './allowlist.js';
import { killAllBridgesForSession } from './ptyBridge.js';
import { extractSessionId, extractSessionIdAfter, getResumeCommand, supportsResume, type AgentType } from './agentSessionId.js';
import { logEvent } from './eventLog.js';
import { PROTOCOL_VERSION, ErrorCode, type SessionStatus } from './protocol.js';

// Local logger to avoid circular dependency
const logger = {
  info(msg: string, data?: Record<string, unknown>) {
    console.log(JSON.stringify({ level: 'info', action: `sessions.${msg}`, timestamp: new Date().toISOString(), ...data }));
  },
  warn(msg: string, data?: Record<string, unknown>) {
    console.warn(JSON.stringify({ level: 'warn', action: `sessions.${msg}`, timestamp: new Date().toISOString(), ...data }));
  },
  error(msg: string, data?: Record<string, unknown>) {
    console.error(JSON.stringify({ level: 'error', action: `sessions.${msg}`, timestamp: new Date().toISOString(), ...data }));
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

// The session store instance (tmux-backed)
const store = new TmuxSessionStore();

// Health check interval
let healthCheckTimer: ReturnType<typeof setInterval> | null = null;

export function getStore(): TmuxSessionStore {
  return store;
}

export function scheduleAgentSessionRefresh(sessionId: string, reason = 'manual'): void {
  const session = store.getSession(sessionId);
  if (!session || session.agentType !== 'pi') return;

  const requestedAtMs = Date.now();
  const previousAgentSessionId = session.agentSessionId || undefined;
  const delays = [1500, 4000, 9000];

  for (const delay of delays) {
    setTimeout(() => {
      const current = store.getSession(sessionId);
      if (!current || current.agentType !== 'pi') return;
      if (previousAgentSessionId && current.agentSessionId && current.agentSessionId !== previousAgentSessionId) return;

      const nextAgentSessionId = extractSessionIdAfter(current.agentType, current.cwd, requestedAtMs, previousAgentSessionId);
      if (!nextAgentSessionId) return;

      store.setAgentSessionId(sessionId, nextAgentSessionId);
      logger.info('session.agentId.refreshed', { sessionId, reason, previousAgentSessionId, nextAgentSessionId, delay });
      logEvent(sessionId, 'agent_id_extracted', { agentSessionId: nextAgentSessionId, source: reason, previousAgentSessionId });
    }, delay);
  }
}

export function startHealthCheck(intervalMs = 30000): void {
  if (healthCheckTimer) clearInterval(healthCheckTimer);
  healthCheckTimer = setInterval(() => checkAllSessions(), intervalMs);
  logger.info('healthCheck.started', { intervalMs });
}

export function stopHealthCheck(): void {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}

// ── Health check: detect crashed agents, broadcast changes ──

// Shell commands that indicate the agent has exited
const SHELL_COMMANDS = new Set(['bash', 'zsh', 'sh', 'fish', 'dash', 'ksh', 'csh', 'tcsh']);

function checkAllSessions(): void {
  const sessions = store.listSessions();
  for (const session of sessions) {
    const foregroundCmd = tmux.getForegroundCommand(session.tmuxSessionName);
    const isShell = foregroundCmd ? SHELL_COMMANDS.has(foregroundCmd) : false;

    if (session.status === 'running' || session.status === 'starting') {
      if (isShell && session.agentType !== 'shell') {
        // tmux may report shell while the agent still runs as a child process.
        // Only treat as exited if no expected agent command is in the pane process tree.
        if (tmux.hasDescendantCommand(session.pid, session.agentType)) continue;

        const lastExitCode = tmux.getSessionOption(session.tmuxSessionName, 'lastExitCode');
        const exitCode = lastExitCode ? parseInt(lastExitCode, 10) : null;
        const newStatus: SessionStatus = exitCode === 0 ? 'stopped' : 'crashed';

        logger.info('healthCheck: agent exited', {
          sessionId: session.id,
          foregroundCmd,
          newStatus,
          exitCode,
        });

        store.updateSessionStatus(session.id, newStatus, null, exitCode);
        store.incrementCrashCount(session.id);
        logEvent(session.id, 'detected_crashed', {
          foregroundCmd,
          exitCode,
          newStatus,
          crashCount: session.crashCount + 1,
        });

        // On crash detection, try to extract agentSessionId if missing.
        // This is critical for resume to work — without agentSessionId,
        // the resume feature can't build the correct --session command.
        if (!session.agentSessionId && session.commandId !== 'shell') {
          try {
            const agentSessionId = extractSessionId(session.agentType, session.cwd, session.createdAt);
            if (agentSessionId) {
              store.setAgentSessionId(session.id, agentSessionId);
              logger.info('healthCheck: agentSessionId extracted on crash', { sessionId: session.id, agentSessionId });
            }
          } catch (err) {
            logger.warn('healthCheck: agentSessionId extraction failed on crash', { sessionId: session.id, error: String(err) });
          }
        }
      }
    }
  }
}

// ── Reconciliation on startup (simplified — just verify tmux state) ──

export function reconcileOnStartup(): void {
  logger.info('reconcile: verifying tmux state');
  const tmuxNames = tmux.listSessions();

  // Check that all tmux sessions still have valid @pi-web-* options
  for (const name of tmuxNames) {
    const commandId = tmux.getSessionOption(name, 'commandId');
    if (!commandId) {
      // This tmux session was not created by us — log it but don't touch it
      logger.info('reconcile: external tmux session found', { tmuxSessionName: name });
    }
  }

  logEvent('system', 'health_check', { tmuxSessionCount: tmuxNames.length });
}

// ── CRUD operations ──

export function createSession(opts: { id?: string; title?: string; commandId: string; cwd: string; resumeFrom?: string }): Session | { error: ErrorCode; message: string } {
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
  if (store.getSession(sessionId)) {
    return { error: ErrorCode.INVALID_SESSION_ID, message: `Session already exists: ${sessionId}` };
  }

  // Validate cwd
  if (!allowlist.validateCwd(commandId, opts.cwd)) {
    return { error: ErrorCode.INVALID_CWD, message: `Invalid cwd: ${opts.cwd}. Not in allowed roots for command: ${commandId}` };
  }

  const command = allowlist.resolveCommand(commandId)!
  const tmuxSessionName = sessionId;

  // If resumeFrom is provided, use the agent's resume command instead of raw command
  // resumeFrom should be the agentSessionId (e.g. UUID from pi/claude/codex)
  let effectiveCommand = command;
  if (opts.resumeFrom && commandId !== 'shell') {
    const resumeCmd = getResumeCommand(commandId, opts.resumeFrom, opts.cwd);
    if (resumeCmd) {
      effectiveCommand = resumeCmd;
      logger.info('session.resuming', { sessionId, commandId, agentSessionId: opts.resumeFrom, resumeCmd });
    } else {
      logger.warn('session.resumeNotAvailable', { commandId, agentSessionId: opts.resumeFrom });
    }
  }

  // Check for tmux session name collision
  if (tmux.hasSession(tmuxSessionName)) {
    return { error: ErrorCode.INVALID_SESSION_ID, message: `tmux session already exists: ${tmuxSessionName}` };
  }

  // Create session via store (creates tmux session + sets @pi-web-* options)
  let session: Session;
  try {
    session = store.createSession({
      id: sessionId,
      title: opts.title || commandId,
      commandId,
      command: effectiveCommand,
      cwd: opts.cwd,
      tmuxSessionName,
      env: {},
    });
  } catch (err) {
    return { error: ErrorCode.ATTACH_FAILED, message: `Failed to create session: ${err}` };
  }

  // If resuming, set the agentSessionId from the resumeFrom param
  if (opts.resumeFrom) {
    store.setAgentSessionId(sessionId, opts.resumeFrom);
  }

  logger.info('session.created', { sessionId, commandId, cwd: opts.cwd });
  logEvent(sessionId, 'created', { commandId, cwd: opts.cwd, tmuxSessionName });

  // Extract agent session ID after a delay (agent needs time to initialize)
  // Skip if we already set it from resumeFrom
  if (commandId !== 'shell' && !opts.resumeFrom) {
    // Retry extraction up to 3 times with increasing delays.
    // Agents can take several seconds to write their session file,
    // especially under load.
    const maxAttempts = 3;
    const attempt = (attemptNum: number, delayMs: number) => {
      setTimeout(() => {
        try {
          // Check if already set (by a previous attempt or health check)
          const current = store.getSession(sessionId);
          if (current?.agentSessionId) return;

          const agentSessionId = extractSessionId(commandId, opts.cwd, session.createdAt);
          if (agentSessionId) {
            store.setAgentSessionId(sessionId, agentSessionId);
            logger.info('session.agentId.extracted', { sessionId, agentSessionId, attempt: attemptNum });
            logEvent(sessionId, 'agent_id_extracted', { agentSessionId, attempt: attemptNum });
          } else if (attemptNum < maxAttempts) {
            attempt(attemptNum + 1, delayMs * 2);
          } else {
            logger.warn('session.agentId.extraction_exhausted', { sessionId, attempts: maxAttempts });
          }
        } catch (err) {
          logger.warn('session.agentId.extraction_failed', { sessionId, error: String(err), attempt: attemptNum });
          if (attemptNum < maxAttempts) {
            attempt(attemptNum + 1, delayMs * 2);
          }
        }
      }, delayMs);
    };
    attempt(1, 3000);
  }

  // Try to get the PID after a short delay
  setTimeout(() => {
    const pid = tmux.getSessionPid(tmuxSessionName);
    if (pid) {
      // PID is derived live from tmux, no need to store
    }
  }, 2000);

  return session;
}

export function killSession(sessionId: string, confirm: boolean): Session | { error: ErrorCode; message: string } {
  if (!confirm) {
    return { error: ErrorCode.KILL_CONFIRM_REQUIRED, message: 'Kill requires confirm: true' };
  }

  return withLock(sessionId, async () => {
    const session = store.getSession(sessionId);
    if (!session) {
      return { error: ErrorCode.SESSION_NOT_FOUND, message: `Session not found: ${sessionId}` };
    }

    // Capture latest agent session id before killing tmux. Some sessions may have
    // been created before delayed extraction completed or before extractor fixes.
    // If an id already exists, keep it: `pi --session <id>` appends to that file.
    if (!session.agentSessionId && session.commandId !== 'shell') {
      try {
      const agentSessionId = extractSessionId(session.commandId, session.cwd, session.createdAt);
        if (agentSessionId) {
          session.agentSessionId = agentSessionId;
          store.setAgentSessionId(sessionId, agentSessionId);
          logger.info('session.agentId.extracted_on_kill', { sessionId, agentSessionId });
          logEvent(sessionId, 'agent_id_extracted', { agentSessionId, source: 'kill' });
        }
      } catch (err) {
        logger.warn('session.agentId.extraction_on_kill_failed', { sessionId, error: String(err) });
      }
    }

    // Kill all PTY bridges first
    killAllBridgesForSession(session.tmuxSessionName);

    // Kill tmux session (idempotent)
    if (tmux.hasSession(session.tmuxSessionName)) {
      try { tmux.killSession(session.tmuxSessionName); } catch {}
    }

    // Remove from store
    store.deleteSession(sessionId);

    logger.info('session.killed', { sessionId });
    logEvent(sessionId, 'killed');

    return session;
  }) as any;
}

export function restartSession(sessionId: string): Session | { error: ErrorCode; message: string } {
  const session = store.getSession(sessionId);
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

  // Re-create tmux session
  try {
    tmux.createSession(session.tmuxSessionName, session.cwd, session.command);
  } catch (err) {
    return { error: ErrorCode.ATTACH_FAILED, message: `Failed to restart tmux session: ${err}` };
  }

  // Re-set options
  tmux.setSessionOption(session.tmuxSessionName, 'title', session.title);
  tmux.setSessionOption(session.tmuxSessionName, 'commandId', session.commandId);
  tmux.setSessionOption(session.tmuxSessionName, 'command', session.command);
  tmux.setSessionOption(session.tmuxSessionName, 'agentType', session.agentType);
  tmux.setSessionOption(session.tmuxSessionName, 'agentSessionId', session.agentSessionId || '');
  tmux.setSessionOption(session.tmuxSessionName, 'restartPolicy', session.restartPolicy);
  tmux.setSessionOption(session.tmuxSessionName, 'env', session.env);
  tmux.setSessionOption(session.tmuxSessionName, 'createdAt', session.createdAt);
  tmux.setSessionOption(session.tmuxSessionName, 'updatedAt', new Date().toISOString());
  tmux.setExitTrap(session.tmuxSessionName);

  logger.info('session.restarted', { sessionId });
  logEvent(sessionId, 'resumed', { method: 'restart' });

  return store.getSession(sessionId)!;
}

// ── Agent resume (using agent's native --resume/--session flag) ──

export function resumeAgentSession(sessionId: string): Session | { error: ErrorCode; message: string } {
  return withLock(sessionId, async () => {
    const session = store.getSession(sessionId);
    if (!session) {
      return { error: ErrorCode.SESSION_NOT_FOUND, message: `Session not found: ${sessionId}` };
    }

    // Pre-resume guards
    const foregroundCmd = tmux.getForegroundCommand(session.tmuxSessionName);
    const SHELL_COMMANDS_LIST = ['bash', 'zsh', 'sh', 'fish', 'dash', 'ksh', 'csh', 'tcsh'];

    // Guard 1: foreground must be a shell (agent has exited)
    if (!foregroundCmd || !SHELL_COMMANDS_LIST.includes(foregroundCmd)) {
      return { error: ErrorCode.SESSION_ALREADY_RUNNING as ErrorCode, message: `Cannot resume: agent process still running (${foregroundCmd})` };
    }

    // Guard 2: must have agent session ID
    if (!session.agentSessionId) {
      return { error: ErrorCode.INTERNAL, message: 'Cannot resume: no agentSessionId available' };
    }

    // Guard 3: must support resume
    if (!supportsResume(session.agentType)) {
      return { error: ErrorCode.INTERNAL, message: `Agent type ${session.agentType} does not support resume` };
    }

    // Guard 4: crash loop protection
    if (session.crashCount >= 3) {
      const lastCrash = session.lastCrashAt ? new Date(session.lastCrashAt) : null;
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      if (lastCrash && lastCrash > fiveMinutesAgo) {
        return { error: ErrorCode.RATE_LIMITED, message: `Crash loop detected (${session.crashCount} crashes). Manual intervention required.` };
      }
    }

    // Build and send the resume command
    const resumeCmd = getResumeCommand(session.agentType, session.agentSessionId, session.cwd);
    if (!resumeCmd) {
      return { error: ErrorCode.INTERNAL, message: 'Failed to build resume command' };
    }

    logger.info('session.resuming', { sessionId, agentType: session.agentType, agentSessionId: session.agentSessionId, resumeCmd });

    // Send resume command to tmux
    try {
      tmux.sendKeys(session.tmuxSessionName, resumeCmd);
      tmux.sendKeys(session.tmuxSessionName, 'Enter');
    } catch (err) {
      logEvent(sessionId, 'resume_failed', { error: String(err) });
      return { error: ErrorCode.ATTACH_FAILED, message: `Failed to send resume command: ${err}` };
    }

    // Verify after 5 seconds
    setTimeout(() => {
      const newForeground = tmux.getForegroundCommand(session.tmuxSessionName);
      if (newForeground && !SHELL_COMMANDS_LIST.includes(newForeground)) {
        logger.info('session.resume.verified', { sessionId, newForeground });
        logEvent(sessionId, 'resumed', { agentType: session.agentType, verified: true });
      } else {
        logger.warn('session.resume.verification_failed', { sessionId, newForeground });
        logEvent(sessionId, 'resume_failed', { newForeground, reason: 'agent_not_started' });
      }
    }, 5000);

    return store.getSession(sessionId)!;
  }) as any;
}

export function listSessions(): Session[] {
  return store.listSessions().filter((session) => session.commandId !== 'shell');
}

export function getSession(sessionId: string): Session | null {
  return store.getSession(sessionId);
}

export function deleteSession(sessionId: string): boolean {
  const session = store.getSession(sessionId);
  if (session && tmux.hasSession(session.tmuxSessionName)) {
    try { tmux.killSession(session.tmuxSessionName); } catch {}
    killAllBridgesForSession(session.tmuxSessionName);
  }
  logEvent(sessionId, 'deleted');
  return store.deleteSession(sessionId);
}

export function updateSession(sessionId: string, updates: Partial<Pick<Session, 'title' | 'restartPolicy'>>): Session | null {
  const session = store.getSession(sessionId);
  if (!session) return null;
  store.updateSession(sessionId, updates);
  return store.getSession(sessionId);
}