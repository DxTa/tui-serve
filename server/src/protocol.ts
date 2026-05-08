// Protocol types and helpers for the WebSocket hybrid protocol
// Binary (0x00) for terminal I/O, JSON (0x01) for control messages

export const PROTOCOL_VERSION = 1;

// Frame type prefixes
export const FRAME_BINARY = 0x00;
export const FRAME_CONTROL = 0x01;

// Error codes
export enum ErrorCode {
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
  SESSION_ALREADY_RUNNING = 'SESSION_ALREADY_RUNNING',
  SESSION_NOT_STOPPED = 'SESSION_NOT_STOPPED',
  INVALID_SESSION_ID = 'INVALID_SESSION_ID',
  INVALID_COMMAND_ID = 'INVALID_COMMAND_ID',
  INVALID_CWD = 'INVALID_CWD',
  AUTH_REQUIRED = 'AUTH_REQUIRED',
  ATTACH_FAILED = 'ATTACH_FAILED',
  KILL_CONFIRM_REQUIRED = 'KILL_CONFIRM_REQUIRED',
  PROTOCOL_VERSION = 'PROTOCOL_VERSION',
  RATE_LIMITED = 'RATE_LIMITED',
  RESUME_NOT_AVAILABLE = 'RESUME_NOT_AVAILABLE',
  CRASH_LOOP = 'CRASH_LOOP',
  INTERNAL = 'INTERNAL',
}

// Session status
export type SessionStatus = 'starting' | 'running' | 'stopped' | 'crashed' | 'killed' | 'unknown';

// ── Client → Server messages ──

export interface ClientEnvelope {
  v: number;
  type: string;
  sessionId?: string;
  requestId?: string;
  [key: string]: unknown;
}

export interface AttachMessage extends ClientEnvelope {
  type: 'attach';
  sessionId: string;
}

export interface InputMessage extends ClientEnvelope {
  type: 'input';
  sessionId: string;
  data: string;
}

export interface ResizeMessage extends ClientEnvelope {
  type: 'resize';
  sessionId: string;
  cols: number;
  rows: number;
}

export interface DetachMessage extends ClientEnvelope {
  type: 'detach';
  sessionId: string;
}

export interface KillMessage extends ClientEnvelope {
  type: 'kill';
  sessionId: string;
  confirm: boolean;
}

export interface RestartMessage extends ClientEnvelope {
  type: 'restart';
  sessionId: string;
}

export interface PingMessage extends ClientEnvelope {
  type: 'ping';
}

export interface AuthMessage extends ClientEnvelope {
  type: 'auth';
  token: string;
}

export type ClientMessage = AttachMessage | InputMessage | ResizeMessage | DetachMessage | KillMessage | RestartMessage | PingMessage | AuthMessage;

// ── Server → Client messages ──

export interface ServerEnvelope {
  v: number;
  type: string;
  sessionId?: string;
  requestId?: string;
  [key: string]: unknown;
}

export interface PingMessage extends ServerEnvelope {
  type: 'ping';
}

export interface PongMessage extends ServerEnvelope {
  type: 'pong';
}

export interface AttachedMessage extends ServerEnvelope {
  type: 'attached';
  sessionId: string;
}

export interface SnapshotMessage extends ServerEnvelope {
  type: 'snapshot';
  sessionId: string;
  data: string;
}

export interface StatusMessage extends ServerEnvelope {
  type: 'status';
  sessionId: string;
  status: SessionStatus;
  pid: number | null;
  exitCode: number | null;
}

export interface SessionUpdateMessage extends ServerEnvelope {
  type: 'session_update';
  sessionId: string;
  [key: string]: unknown;
}

export interface ErrorMessage extends ServerEnvelope {
  type: 'error';
  code: ErrorCode;
  message: string;
}

export interface KillAckMessage extends ServerEnvelope {
  type: 'kill_ack';
  sessionId: string;
}

export interface DetachAckMessage extends ServerEnvelope {
  type: 'detach_ack';
  sessionId: string;
}

export type ServerMessage = PingMessage | PongMessage | AttachedMessage | SnapshotMessage | StatusMessage | SessionUpdateMessage | ErrorMessage | KillAckMessage | DetachAckMessage;

// ── Binary frame helpers ──

// Layout: [0x00] [1 byte sessionId length] [sessionId UTF-8] [raw terminal data]
const SESSION_ID_LEN_SIZE = 1;
const MAX_SESSION_ID_LEN = 255;

export function buildBinaryFrame(sessionId: string, data: Buffer): Buffer {
  const sessionIdBuf = Buffer.from(sessionId, 'utf-8');
  if (sessionIdBuf.length > MAX_SESSION_ID_LEN) {
    throw new Error(`sessionId too long: ${sessionIdBuf.length}`);
  }
  const header = Buffer.alloc(1 + SESSION_ID_LEN_SIZE + sessionIdBuf.length);
  header[0] = FRAME_BINARY;
  header[1] = sessionIdBuf.length;
  sessionIdBuf.copy(header, 2);
  return Buffer.concat([header, data]);
}

export function parseBinaryFrame(buf: Buffer): { sessionId: string; data: Buffer } | null {
  if (buf.length < 3) return null;
  if (buf[0] !== FRAME_BINARY) return null;
  const sessionIdLen = buf[1];
  if (buf.length < 2 + sessionIdLen) return null;
  const sessionId = buf.subarray(2, 2 + sessionIdLen).toString('utf-8');
  const data = buf.subarray(2 + sessionIdLen);
  return { sessionId, data };
}

export function parseMessage(raw: Buffer): { type: 'binary'; sessionId: string; data: Buffer } | { type: 'control'; message: ClientMessage } | null {
  if (raw.length === 0) return null;

  if (raw[0] === FRAME_BINARY) {
    const parsed = parseBinaryFrame(raw);
    if (!parsed) return null;
    return { type: 'binary', sessionId: parsed.sessionId, data: parsed.data };
  }

  if (raw[0] === FRAME_CONTROL) {
    try {
      const json = JSON.parse(raw.subarray(1).toString('utf-8'));
      return { type: 'control', message: json as ClientMessage };
    } catch {
      return null;
    }
  }

  // Fallback: try parsing entire buffer as JSON (for dev convenience)
  try {
    const json = JSON.parse(raw.toString('utf-8'));
    return { type: 'control', message: json as ClientMessage };
  } catch {
    return null;
  }
}

export function buildControlMessage(msg: ServerMessage): Buffer {
  const json = JSON.stringify({ ...msg, v: PROTOCOL_VERSION });
  const prefix = Buffer.from([FRAME_CONTROL]);
  return Buffer.concat([prefix, Buffer.from(json, 'utf-8')]);
}