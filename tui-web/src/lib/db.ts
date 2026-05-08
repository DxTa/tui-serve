// Dexie.js database — frontend local store for session metadata
// Browser-side IndexedDB with reactive React queries

import Dexie, { type EntityTable } from 'dexie';

export interface Session {
  id: string;                     // matches tmux session name
  hostId: string;
  title: string;
  commandId: string;              // 'pi' | 'claude' | 'opencode' | 'codex' | 'shell'
  command: string;                // resolved shell command
  cwd: string;
  tmuxSessionName: string;
  status: SessionStatus;
  pid: number | null;
  exitCode: number | null;
  attachedClients: number;
  restartPolicy: 'manual' | 'on-crash';
  env: string;                    // JSON
  agentType: string;              // same as commandId but explicit
  agentSessionId: string | null;  // UUID from the agent's own session system
  crashCount: number;
  lastCrashAt: string | null;
  lastExitCode: number | null;
  isTombstone: boolean;           // true if session no longer exists in tmux
  createdAt: string;
  updatedAt: string;
  lastAttachedAt: string | null;
  lastServerSync: string;         // when we last got data from server
}

export type SessionStatus = 'starting' | 'running' | 'stopped' | 'crashed' | 'killed' | 'unknown' | 'disconnected';

const db = new Dexie('PiWebDB') as Dexie & {
  sessions: EntityTable<Session, 'id'>;
};

db.version(1).stores({
  sessions: 'id, status, commandId, createdAt, lastServerSync',
});

export { db };