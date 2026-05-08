// SessionStore interface + TmuxSessionStore implementation
// tmux is the single source of runtime truth for session state.
// Metadata is stored in tmux @pi-web-* custom options.

import * as tmux from './tmux.js';
import type { SessionStatus } from './protocol.js';

// ── Types ──

export interface Session {
  id: string;
  hostId: string;
  title: string;
  commandId: string;
  command: string;
  cwd: string;
  tmuxSessionName: string;
  status: SessionStatus;
  pid: number | null;
  exitCode: number | null;
  attachedClients: number;
  restartPolicy: 'manual' | 'on-crash';
  env: string; // JSON
  agentType: string;
  agentSessionId: string | null;
  crashCount: number;
  lastCrashAt: string | null;
  lastExitCode: number | null;
  createdAt: string;
  updatedAt: string;
  lastAttachedAt: string | null;
}

export interface CreateSessionInput {
  id: string;
  hostId?: string;
  title?: string;
  commandId: string;
  command: string;
  cwd: string;
  tmuxSessionName?: string;
  restartPolicy?: 'manual' | 'on-crash';
  env?: Record<string, string>;
}

export interface SessionStore {
  listSessions(): Session[];
  getSession(id: string): Session | null;
  createSession(input: CreateSessionInput): Session;
  deleteSession(id: string): boolean;
  updateSession(id: string, updates: Partial<Pick<Session, 'title' | 'restartPolicy' | 'attachedClients' | 'lastAttachedAt'>>): void;
  updateSessionStatus(id: string, status: SessionStatus, pid?: number | null, exitCode?: number | null): void;
  setAgentSessionId(id: string, agentSessionId: string): void;
  incrementCrashCount(id: string): void;
  setLastExitCode(id: string, exitCode: number): void;
  close(): void;
}

// ── Helper: read @pi-web-* options from tmux ──

interface TmuxOptions {
  title?: string;
  commandId?: string;
  command?: string;
  agentType?: string;
  agentSessionId?: string;
  restartPolicy?: string;
  env?: string;
  crashCount?: string;
  lastCrashAt?: string;
  lastExitCode?: string;
  createdAt?: string;
  updatedAt?: string;
  lastAttachedAt?: string;
  hostId?: string;
}

const PI_WEB_PREFIX = '@pi-web-';

const OPTIONS_MAP: Record<string, string> = {
  title: `${PI_WEB_PREFIX}title`,
  commandId: `${PI_WEB_PREFIX}commandId`,
  command: `${PI_WEB_PREFIX}command`,
  agentType: `${PI_WEB_PREFIX}agentType`,
  agentSessionId: `${PI_WEB_PREFIX}agentSessionId`,
  restartPolicy: `${PI_WEB_PREFIX}restartPolicy`,
  env: `${PI_WEB_PREFIX}env`,
  crashCount: `${PI_WEB_PREFIX}crashCount`,
  lastCrashAt: `${PI_WEB_PREFIX}lastCrashAt`,
  lastExitCode: `${PI_WEB_PREFIX}lastExitCode`,
  createdAt: `${PI_WEB_PREFIX}createdAt`,
  updatedAt: `${PI_WEB_PREFIX}updatedAt`,
  lastAttachedAt: `${PI_WEB_PREFIX}lastAttachedAt`,
  hostId: `${PI_WEB_PREFIX}hostId`,
};

function parseTmuxOptions(raw: string): TmuxOptions {
  const result: TmuxOptions = {};
  for (const line of raw.split('\n')) {
    const match = line.match(/^@pi-web-(\w+)\s+(.*)$/);
    if (match) {
      const key = match[1] as keyof TmuxOptions;
      let value: string = match[2].trim();
      // tmux wraps values containing spaces in quotes
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }
      (result as any)[key] = value;
    }
  }
  return result;
}

// ── Shell names that indicate agent has exited ──

const SHELL_NAMES = new Set(['bash', 'zsh', 'sh', 'fish', 'dash', 'ksh', 'csh', 'tcsh']);

function isShell(command: string): boolean {
  return SHELL_NAMES.has(command);
}

// ── TmuxSessionStore implementation ──

// In-memory counters that are not persisted in tmux (attachedClients is WS-level)
const attachedClientsMap = new Map<string, number>();

export class TmuxSessionStore implements SessionStore {
  listSessions(): Session[] {
    const sessions: Session[] = [];
    let tmuxNames: string[];
    try {
      tmuxNames = tmux.listSessions();
    } catch {
      return [];
    }

    for (const name of tmuxNames) {
      const session = this.buildSessionFromTmux(name);
      if (session) sessions.push(session);
    }
    return sessions;
  }

  getSession(id: string): Session | null {
    const tmuxName = id; // id === tmuxSessionName
    if (!tmux.hasSession(tmuxName)) return null;
    return this.buildSessionFromTmux(tmuxName);
  }

  createSession(input: CreateSessionInput): Session {
    const tmuxName = input.tmuxSessionName || input.id;

    // Create tmux session
    tmux.createSession(tmuxName, input.cwd, input.command, input.env);

    // Set @pi-web-* options
    const now = new Date().toISOString();
    tmux.setSessionOption(tmuxName, 'title', input.title || input.commandId);
    tmux.setSessionOption(tmuxName, 'commandId', input.commandId);
    tmux.setSessionOption(tmuxName, 'command', input.command);
    tmux.setSessionOption(tmuxName, 'agentType', input.commandId); // agentType = commandId by default
    tmux.setSessionOption(tmuxName, 'hostId', input.hostId || 'local');
    tmux.setSessionOption(tmuxName, 'restartPolicy', input.restartPolicy || 'manual');
    tmux.setSessionOption(tmuxName, 'env', JSON.stringify(input.env || {}));
    tmux.setSessionOption(tmuxName, 'crashCount', '0');
    tmux.setSessionOption(tmuxName, 'createdAt', now);
    tmux.setSessionOption(tmuxName, 'updatedAt', now);

    // Set shell trap to capture exit code
    tmux.setExitTrap(tmuxName);

    // Initialize attachedClients
    attachedClientsMap.set(input.id, 0);

    // Try to get PID after a short delay
    setTimeout(() => {
      const pid = tmux.getSessionPid(tmuxName);
      if (pid) {
        // PID is readable; no need to update tmux option since we derive status live
      }
    }, 2000);

    const session = this.buildSessionFromTmux(tmuxName);
    if (!session) {
      throw new Error(`tmux session disappeared immediately after creation: ${tmuxName}`);
    }

    return session;
  }

  deleteSession(id: string): boolean {
    const tmuxName = id;
    if (tmux.hasSession(tmuxName)) {
      try { tmux.killSession(tmuxName); } catch {}
    }
    attachedClientsMap.delete(id);
    return true;
  }

  updateSession(id: string, updates: Partial<Pick<Session, 'title' | 'restartPolicy' | 'attachedClients' | 'lastAttachedAt'>>): void {
    const tmuxName = id;
    if (!tmux.hasSession(tmuxName)) return;

    if (updates.title !== undefined) {
      tmux.setSessionOption(tmuxName, 'title', updates.title);
    }
    if (updates.restartPolicy !== undefined) {
      tmux.setSessionOption(tmuxName, 'restartPolicy', updates.restartPolicy);
    }
    if (updates.attachedClients !== undefined) {
      attachedClientsMap.set(id, updates.attachedClients);
    }
    if (updates.lastAttachedAt !== undefined) {
      tmux.setSessionOption(tmuxName, 'lastAttachedAt', updates.lastAttachedAt ?? '');
    }
    tmux.setSessionOption(tmuxName, 'updatedAt', new Date().toISOString());
  }

  updateSessionStatus(id: string, status: SessionStatus, pid?: number | null, exitCode?: number | null): void {
    // Status is derived from tmux state, but we update metadata
    const tmuxName = id;
    if (!tmux.hasSession(tmuxName)) return;

    // Update exit code if provided
    if (exitCode !== undefined && exitCode !== null) {
      tmux.setSessionOption(tmuxName, 'lastExitCode', String(exitCode));
    }
    tmux.setSessionOption(tmuxName, 'updatedAt', new Date().toISOString());
  }

  setAgentSessionId(id: string, agentSessionId: string): void {
    const tmuxName = id;
    if (!tmux.hasSession(tmuxName)) return;
    tmux.setSessionOption(tmuxName, 'agentSessionId', agentSessionId);
  }

  incrementCrashCount(id: string): void {
    const tmuxName = id;
    if (!tmux.hasSession(tmuxName)) return;
    const current = this.getOption(tmuxName, 'crashCount');
    const newCount = parseInt(current || '0', 10) + 1;
    tmux.setSessionOption(tmuxName, 'crashCount', String(newCount));
    tmux.setSessionOption(tmuxName, 'lastCrashAt', new Date().toISOString());
  }

  setLastExitCode(id: string, exitCode: number): void {
    const tmuxName = id;
    if (!tmux.hasSession(tmuxName)) return;
    tmux.setSessionOption(tmuxName, 'lastExitCode', String(exitCode));
  }

  close(): void {
    // No-op for tmux store (no DB connection to close)
  }

  // ── Private helpers ──

  private getOption(tmuxName: string, key: string): string | undefined {
    try {
      const result = tmux.getSessionOption(tmuxName, key);
      return result || undefined;
    } catch {
      return undefined;
    }
  }

  private buildSessionFromTmux(tmuxName: string): Session | null {
    if (!tmux.hasSession(tmuxName)) return null;

    const pid = tmux.getSessionPid(tmuxName);
    const foregroundCmd = tmux.getForegroundCommand(tmuxName);
    const opts = this.readAllOptions(tmuxName);

    // Derive status from tmux state
    const agentType = opts.agentType || opts.commandId || 'shell';
    let status: SessionStatus = 'running';

    if (foregroundCmd && isShell(foregroundCmd) && agentType !== 'shell') {
      // tmux may report the shell even while the agent is a child process
      // (e.g. `zsh -c pi`). Only mark crashed when no matching agent
      // command exists in the pane process tree.
      const agentStillRunning = tmux.hasDescendantCommand(pid, agentType);
      status = agentStillRunning ? 'running' : 'crashed';
    } else if (pid === null) {
      status = 'starting';
    }

    // Check @pi-web-lastExitCode for clean exits
    if (status === 'crashed') {
      const lastExitCode = opts.lastExitCode ? parseInt(opts.lastExitCode, 10) : null;
      if (lastExitCode === 0) {
        status = 'stopped';
      }
    }

    return {
      id: tmuxName,
      hostId: opts.hostId || 'local',
      title: opts.title || tmuxName,
      commandId: opts.commandId || 'shell',
      command: opts.command || '',
      cwd: tmux.getSessionCwd(tmuxName) || '',
      tmuxSessionName: tmuxName,
      status,
      pid,
      exitCode: opts.lastExitCode ? parseInt(opts.lastExitCode, 10) : null,
      attachedClients: attachedClientsMap.get(tmuxName) ?? 0,
      restartPolicy: (opts.restartPolicy as 'manual' | 'on-crash') || 'manual',
      env: opts.env || '{}',
      agentType: opts.agentType || opts.commandId || 'shell',
      agentSessionId: opts.agentSessionId || null,
      crashCount: parseInt(opts.crashCount || '0', 10),
      lastCrashAt: opts.lastCrashAt || null,
      lastExitCode: opts.lastExitCode ? parseInt(opts.lastExitCode, 10) : null,
      createdAt: opts.createdAt || new Date().toISOString(),
      updatedAt: opts.updatedAt || new Date().toISOString(),
      lastAttachedAt: opts.lastAttachedAt || null,
    };
  }

  private readAllOptions(tmuxName: string): TmuxOptions {
    try {
      const raw = tmux.getSessionOptions(tmuxName);
      return parseTmuxOptions(raw);
    } catch {
      return {};
    }
  }
}