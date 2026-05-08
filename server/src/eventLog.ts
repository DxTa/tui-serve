// Append-only JSONL event log for debugging, forensics, and recovery
// Not a database — just a chronological sequence of state transitions

import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.REMOTE_AGENT_TUI_DATA_DIR || resolve(__dirname, '..', 'data');
const LOG_PATH = resolve(dataDir, 'events.jsonl');

let logEnabled = true;

export type EventName =
  | 'created'
  | 'status_changed'
  | 'detected_crashed'
  | 'resumed'
  | 'resume_failed'
  | 'killed'
  | 'deleted'
  | 'agent_id_extracted'
  | 'attached'
  | 'detached'
  | 'health_check';

export interface LogEntry {
  timestamp: string;
  sessionId: string;
  event: EventName;
  data?: Record<string, unknown>;
}

export function logEvent(sessionId: string, event: EventName, data?: Record<string, unknown>): void {
  if (!logEnabled) return;

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    sessionId,
    event,
    data,
  };

  try {
    // Ensure directory exists
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n');
  } catch (err) {
    // Best-effort logging — never throw
    console.error('eventLog: write failed', err);
  }
}

export function setLogEnabled(enabled: boolean): void {
  logEnabled = enabled;
}

export function getLogPath(): string {
  return LOG_PATH;
}