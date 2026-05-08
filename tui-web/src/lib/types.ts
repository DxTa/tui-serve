// Type definitions for the frontend

import type { SessionStatus as SharedSessionStatus } from '@tui-serve/shared';

export type SessionStatus = SharedSessionStatus | 'disconnected';
export type ConnectionState = 'connected' | 'reconnecting' | 'disconnected';

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
  env: string;
  agentType: string;
  agentSessionId: string | null;
  crashCount: number;
  lastCrashAt: string | null;
  lastExitCode: number | null;
  createdAt: string;
  updatedAt: string;
  lastAttachedAt: string | null;
}

export interface Host {
  id: string;
  name: string;
  address: string;
  port: number;
}

export interface CommandInfo {
  id: string;
  label: string;
  requiresConfirmation: boolean;
  allowedCwdRoots?: string[];
}

export interface HealthStatus {
  status: string;
  tmux: boolean;
  uptime: number;
  version: string;
  authRequired: boolean;
}