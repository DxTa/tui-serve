// Protocol types and helpers for the WebSocket hybrid protocol
// Binary (0x00) for terminal I/O, JSON (0x01) for control messages

export { PROTOCOL_VERSION, type ClientMessage, type ServerMessage, type SessionStatus } from '@tui-serve/shared';
import { clientMessageSchema, serverMessageSchema, PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '@tui-serve/shared';

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
      const parsed = clientMessageSchema.safeParse(json);
      if (!parsed.success) return null;
      return { type: 'control', message: parsed.data as ClientMessage };
    } catch {
      return null;
    }
  }

  // Fallback: try parsing entire buffer as JSON (for dev convenience)
  try {
    const json = JSON.parse(raw.toString('utf-8'));
    const parsed = clientMessageSchema.safeParse(json);
    if (!parsed.success) return null;
    return { type: 'control', message: parsed.data as ClientMessage };
  } catch {
    return null;
  }
}

export function buildControlMessage(msg: ServerMessage): Buffer {
  const withVersion = { ...msg, v: PROTOCOL_VERSION };
  const parsed = serverMessageSchema.safeParse(withVersion);
  if (!parsed.success) throw new Error(`Invalid server message: ${parsed.error.message}`);
  const json = JSON.stringify(withVersion);
  const prefix = Buffer.from([FRAME_CONTROL]);
  return Buffer.concat([prefix, Buffer.from(json, 'utf-8')]);
}