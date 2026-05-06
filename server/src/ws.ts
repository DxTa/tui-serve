// WebSocket handler — hybrid binary/JSON protocol per §6
// Handles terminal I/O, session attach/detach, heartbeat

import type { WebSocket } from 'ws';
import { WebSocketServer } from 'ws';
import type { FastifyInstance } from 'fastify';
import { authenticateWs } from './auth.js';
import * as sessionManager from './sessions.js';
import * as db from './db.js';
import * as tmux from './tmux.js';
import { createPtyBridge, registerBridge, unregisterBridge, type IPtyProcess } from './ptyBridge.js';
import {
  PROTOCOL_VERSION,
  FRAME_BINARY,
  FRAME_CONTROL,
  ErrorCode,
  buildBinaryFrame,
  buildControlMessage,
  parseMessage,
  type ClientMessage,
  type ServerMessage,
} from './protocol.js';
// Local logger to avoid circular dependency
const logger = {
  info(msg: string, data?: Record<string, unknown>) {
    console.log(JSON.stringify({ level: 'info', action: `ws.${msg}`, timestamp: new Date().toISOString(), ...data }));
  },
  warn(msg: string, data?: Record<string, unknown>) {
    console.warn(JSON.stringify({ level: 'warn', action: `ws.${msg}`, timestamp: new Date().toISOString(), ...data }));
  },
  error(msg: string, data?: Record<string, unknown>) {
    console.error(JSON.stringify({ level: 'error', action: `ws.${msg}`, timestamp: new Date().toISOString(), ...data }));
  },
};

interface ClientState {
  ws: WebSocket;
  sessionId: string | null;
  pty: IPtyProcess | null;
  lastActivity: number;
  authenticated: boolean;
}

const clients = new Map<WebSocket, ClientState>();

export function setupWebSocket(server: FastifyInstance): WebSocketServer {
  const wss = new WebSocketServer({ server: server.server, path: '/ws' });

  wss.on('connection', (ws: WebSocket, req) => {
    const client: ClientState = {
      ws,
      sessionId: null,
      pty: null,
      lastActivity: Date.now(),
      authenticated: false,
    };
    clients.set(ws, client);

    // Extract auth token from query string or first message
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    if (token && authenticateWs(token)) {
      client.authenticated = true;
    }

    if (!client.authenticated) {
      // Will wait for first message to authenticate
      logger.info('ws.client.connected', { auth: 'pending' });
    } else {
      logger.info('ws.client.connected', { auth: 'ok' });
    }

    ws.on('message', (raw: Buffer) => {
      client.lastActivity = Date.now();

      const parsed = parseMessage(raw);
      if (!parsed) return;

      if (parsed.type === 'binary') {
        // Binary input from client → forward to PTY
        if (!client.authenticated) {
          sendError(ws, ErrorCode.AUTH_REQUIRED, 'Authentication required');
          return;
        }
        if (client.pty && client.sessionId === parsed.sessionId) {
          client.pty.write(parsed.data);
        }
        return;
      }

      // JSON control message
      const msg = parsed.message as ClientMessage;

      // First message may be auth
      if (!client.authenticated) {
        if ((msg as any).type === 'auth' && (msg as any).token) {
          if (authenticateWs((msg as any).token as string)) {
            client.authenticated = true;
            logger.info('ws.client.authenticated');
            return;
          }
        }
        sendError(ws, ErrorCode.AUTH_REQUIRED, 'Authentication required');
        ws.close(4001, 'Unauthorized');
        return;
      }

      // Protocol version check
      if (msg.v && msg.v !== PROTOCOL_VERSION) {
        sendError(ws, ErrorCode.PROTOCOL_VERSION, `Unsupported protocol version: ${msg.v}`);
        return;
      }

      handleControlMessage(ws, client, msg);
    });

    ws.on('close', () => {
      logger.info('ws.client.disconnected', { sessionId: client.sessionId });
      cleanupClient(client);
      clients.delete(ws);
    });

    ws.on('error', (err) => {
      logger.error('ws.client.error', { error: String(err) });
    });
  });

  // Heartbeat: check every 60s, close connections with no activity for >70s
  const heartbeatInterval = setInterval(() => {
    const now = Date.now();
    for (const [ws, client] of clients) {
      if (now - client.lastActivity > 70000) {
        logger.info('ws.heartbeat.timeout', { sessionId: client.sessionId });
        ws.close(4002, 'Heartbeat timeout');
      } else if (now - client.lastActivity > 60000) {
        // Send ping
        sendControl(ws, { v: PROTOCOL_VERSION, type: 'ping' });
      }
    }
  }, 30000);

  wss.on('close', () => clearInterval(heartbeatInterval));

  return wss;
}

function handleControlMessage(ws: WebSocket, client: ClientState, msg: ClientMessage): void {
  switch (msg.type) {
    case 'ping':
      sendControl(ws, { v: PROTOCOL_VERSION, type: 'pong', requestId: msg.requestId });
      break;

    case 'attach':
      handleAttach(ws, client, msg.sessionId!, msg.requestId);
      break;

    case 'input':
      handleInput(client, msg.sessionId!, (msg as any).data);
      break;

    case 'resize':
      handleResize(client, msg.sessionId!, (msg as any).cols, (msg as any).rows);
      break;

    case 'detach':
      handleDetach(ws, client, msg.sessionId!, msg.requestId);
      break;

    case 'kill':
      handleKill(ws, client, msg.sessionId!, (msg as any).confirm, msg.requestId);
      break;

    case 'restart':
      handleRestart(ws, client, msg.sessionId!, msg.requestId);
      break;

    default:
      sendError(ws, ErrorCode.INTERNAL, `Unknown message type: ${(msg as any).type}`);
  }
}

function handleAttach(ws: WebSocket, client: ClientState, sessionId: string, requestId?: string): void {
  // Clean up any existing attachment
  if (client.pty) {
    cleanupPty(client);
  }

  const session = db.getSession(sessionId);
  if (!session) {
    sendError(ws, ErrorCode.SESSION_NOT_FOUND, `Session not found: ${sessionId}`, requestId);
    return;
  }

  if (!tmux.hasSession(session.tmuxSessionName)) {
    sendError(ws, ErrorCode.SESSION_NOT_FOUND, `tmux session not found: ${session.tmuxSessionName}`, requestId);
    return;
  }

  // Create PTY bridge
  let pty: IPtyProcess;
  try {
    pty = createPtyBridge(session.tmuxSessionName);
  } catch (err) {
    sendError(ws, ErrorCode.ATTACH_FAILED, `Failed to attach: ${err}`, requestId);
    return;
  }

  client.pty = pty;
  client.sessionId = sessionId;
  registerBridge(session.tmuxSessionName, pty);

  // Send attached ack
  sendControl(ws, { v: PROTOCOL_VERSION, type: 'attached', sessionId, requestId });

  // Send snapshot
  const snapshot = tmux.capturePane(session.tmuxSessionName);
  if (snapshot) {
    sendControl(ws, { v: PROTOCOL_VERSION, type: 'snapshot', sessionId, data: snapshot });
  }

  // Forward PTY output to client as binary frames
  pty.onData((data: string) => {
    if (ws.readyState === ws.OPEN) {
      const frame = buildBinaryFrame(sessionId, Buffer.from(data, 'utf-8'));
      ws.send(frame);
    }
  });

  pty.onExit((code) => {
    logger.info('pty.exited', { sessionId, code });
    sendControl(ws, {
      v: PROTOCOL_VERSION,
      type: 'status',
      sessionId,
      status: code === 0 ? 'stopped' : 'crashed',
      pid: null,
      exitCode: code,
    });
    cleanupPty(client);
  });

  // Update attached clients count
  const currentCount = db.getSession(sessionId)?.attachedClients ?? 0;
  db.updateSession(sessionId, { attachedClients: currentCount + 1, lastAttachedAt: new Date().toISOString() });

  // Broadcast session update
  broadcastSessionUpdate(sessionId);

  logger.info('ws.client.attached', { sessionId });
}

function handleInput(client: ClientState, sessionId: string, data: string): void {
  if (client.pty && client.sessionId === sessionId) {
    client.pty.write(data);
  }
}

function handleResize(client: ClientState, sessionId: string, cols: number, rows: number): void {
  if (client.pty && client.sessionId === sessionId) {
    client.pty.resize(cols, rows);
  }
  // Also resize the tmux window
  const session = db.getSession(sessionId);
  if (session) {
    tmux.resizeWindow(session.tmuxSessionName, cols, rows);
  }
}

function handleDetach(ws: WebSocket, client: ClientState, sessionId: string, requestId?: string): void {
  cleanupPty(client);
  sendControl(ws, { v: PROTOCOL_VERSION, type: 'detach_ack', sessionId, requestId });

  // Update attached clients count
  const session = db.getSession(sessionId);
  if (session) {
    const newCount = Math.max(0, session.attachedClients - 1);
    db.updateSession(sessionId, { attachedClients: newCount });
    broadcastSessionUpdate(sessionId);
  }

  logger.info('ws.client.detached', { sessionId });
}

function handleKill(ws: WebSocket, client: ClientState, sessionId: string, confirm: boolean, requestId?: string): void {
  const result = sessionManager.killSession(sessionId, confirm);
  if ('error' in result) {
    sendError(ws, result.error, result.message, requestId);
    return;
  }

  sendControl(ws, { v: PROTOCOL_VERSION, type: 'kill_ack', sessionId, requestId });

  // Clean up the client's PTY if they were attached to this session
  if (client.sessionId === sessionId) {
    cleanupPty(client);
  }

  broadcastSessionUpdate(sessionId);
  logger.info('ws.session.killed', { sessionId });
}

function handleRestart(ws: WebSocket, client: ClientState, sessionId: string, requestId?: string): void {
  const result = sessionManager.restartSession(sessionId);
  if ('error' in result) {
    sendError(ws, result.error, result.message, requestId);
    return;
  }

  // Send status update
  sendControl(ws, {
    v: PROTOCOL_VERSION,
    type: 'status',
    sessionId,
    status: result.status,
    pid: result.pid,
    exitCode: result.exitCode,
  });

  broadcastSessionUpdate(sessionId);
  logger.info('ws.session.restarted', { sessionId });
}

function cleanupPty(client: ClientState): void {
  if (client.pty) {
    try { client.pty.kill(); } catch {}
    if (client.sessionId) {
      const session = db.getSession(client.sessionId);
      if (session) {
        unregisterBridge(session.tmuxSessionName, client.pty);
      }
    }
    client.pty = null;
  }
  client.sessionId = null;
}

function cleanupClient(client: ClientState): void {
  cleanupPty(client);
  if (client.sessionId) {
    const session = db.getSession(client.sessionId);
    if (session) {
      const newCount = Math.max(0, session.attachedClients - 1);
      db.updateSession(client.sessionId, { attachedClients: newCount });
      broadcastSessionUpdate(client.sessionId);
    }
  }
}

function sendControl(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(buildControlMessage(msg));
  }
}

function sendError(ws: WebSocket, code: ErrorCode, message: string, requestId?: string): void {
  sendControl(ws, { v: PROTOCOL_VERSION, type: 'error', code, message, requestId } as any);
}

function broadcastSessionUpdate(sessionId: string): void {
  const session = db.getSession(sessionId);
  if (!session) return;

  const msg: ServerMessage = {
    v: PROTOCOL_VERSION,
    type: 'session_update',
    sessionId,
    ...session,
  } as any;

  for (const [ws, client] of clients) {
    if (client.authenticated && ws.readyState === ws.OPEN) {
      ws.send(buildControlMessage(msg));
    }
  }
}

// Export for broadcast from REST API
export function broadcastSessionUpdateExternal(sessionId: string): void {
  broadcastSessionUpdate(sessionId);
}