// SQLite database for session metadata
// Schema-on-startup, WAL mode for crash resilience

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { SessionStatus } from './protocol.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

/** Default data directory — can be overridden via REMOTE_AGENT_TUI_DATA_DIR env var (for packaged installs) */
const DEFAULT_DATA_DIR = resolve(__dirname, '..', 'data');

function getDataDir(): string {
  return process.env.REMOTE_AGENT_TUI_DATA_DIR || DEFAULT_DATA_DIR;
}

const DB_PATH = resolve(getDataDir(), 'sessions.db');

let db: Database.Database;

export function initDb(dbPath?: string): Database.Database {
  const path = dbPath ?? DB_PATH;
  // Ensure directory exists
  mkdirSync(dirname(path), { recursive: true });

  db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  // Schema-on-startup
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      hostId TEXT NOT NULL DEFAULT 'local',
      title TEXT NOT NULL DEFAULT '',
      commandId TEXT NOT NULL,
      command TEXT NOT NULL,
      cwd TEXT NOT NULL,
      tmuxSessionName TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'starting',
      pid INTEGER,
      exitCode INTEGER,
      attachedClients INTEGER NOT NULL DEFAULT 0,
      restartPolicy TEXT NOT NULL DEFAULT 'manual',
      env TEXT NOT NULL DEFAULT '{}',
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      lastAttachedAt TEXT
    );
    
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
    CREATE INDEX IF NOT EXISTS idx_sessions_hostId ON sessions(hostId);
  `);

  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

function rowToSession(row: Record<string, unknown>): Session {
  return {
    id: row.id as string,
    hostId: (row.hostId as string) || 'local',
    title: (row.title as string) || '',
    commandId: row.commandId as string,
    command: row.command as string,
    cwd: row.cwd as string,
    tmuxSessionName: row.tmuxSessionName as string,
    status: row.status as SessionStatus,
    pid: row.pid as number | null,
    exitCode: row.exitCode as number | null,
    attachedClients: (row.attachedClients as number) || 0,
    restartPolicy: (row.restartPolicy as 'manual' | 'on-crash') || 'manual',
    env: (row.env as string) || '{}',
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
    lastAttachedAt: row.lastAttachedAt as string | null,
  };
}

export function insertSession(input: CreateSessionInput): Session {
  const now = new Date().toISOString();
  const tmuxName = input.tmuxSessionName || input.id;
  const stmt = getDb().prepare(`
    INSERT INTO sessions (id, hostId, title, commandId, command, cwd, tmuxSessionName, status, restartPolicy, env, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?)
  `);
  stmt.run(
    input.id,
    input.hostId || 'local',
    input.title || input.commandId,
    input.commandId,
    input.command,
    input.cwd,
    tmuxName,
    input.restartPolicy || 'manual',
    JSON.stringify(input.env || {}),
    now,
    now,
  );
  return getSession(input.id)!;
}

export function getSession(id: string): Session | null {
  const row = getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToSession(row) : null;
}

export function listSessions(): Session[] {
  const rows = getDb().prepare('SELECT * FROM sessions ORDER BY createdAt DESC').all() as Record<string, unknown>[];
  return rows.map(rowToSession);
}

export function updateSessionStatus(id: string, status: SessionStatus, pid?: number | null, exitCode?: number | null): void {
  const updates: string[] = ['status = ?', 'updatedAt = ?'];
  const values: unknown[] = [status, new Date().toISOString()];

  if (pid !== undefined) {
    updates.push('pid = ?');
    values.push(pid);
  }
  if (exitCode !== undefined) {
    updates.push('exitCode = ?');
    values.push(exitCode);
  }

  values.push(id);
  getDb().prepare(`UPDATE sessions SET ${updates.join(', ')} WHERE id = ?`).run(...values);
}

export function updateSession(id: string, updates: Partial<Pick<Session, 'title' | 'restartPolicy' | 'attachedClients' | 'lastAttachedAt'>>): void {
  const sets: string[] = ['updatedAt = ?'];
  const values: unknown[] = [new Date().toISOString()];

  if (updates.title !== undefined) { sets.push('title = ?'); values.push(updates.title); }
  if (updates.restartPolicy !== undefined) { sets.push('restartPolicy = ?'); values.push(updates.restartPolicy); }
  if (updates.attachedClients !== undefined) { sets.push('attachedClients = ?'); values.push(updates.attachedClients); }
  if (updates.lastAttachedAt !== undefined) { sets.push('lastAttachedAt = ?'); values.push(updates.lastAttachedAt); }

  values.push(id);
  getDb().prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteSession(id: string): boolean {
  const result = getDb().prepare('DELETE FROM sessions WHERE id = ?').run(id);
  return result.changes > 0;
}

export function deleteSessionsByStatus(status: SessionStatus): number {
  const result = getDb().prepare('DELETE FROM sessions WHERE status = ?').run(status);
  return result.changes;
}

export function closeDb(): void {
  if (db) db.close();
}