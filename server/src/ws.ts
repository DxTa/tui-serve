// WebSocket handler — hybrid binary/JSON protocol per §6
// Handles terminal I/O, session attach/detach, heartbeat

import type { WebSocket } from 'ws';
import { WebSocketServer } from 'ws';
import type { FastifyInstance } from 'fastify';
import { authenticateWs } from './auth.js';
import * as sessionManager from './sessions.js';
import { getStore } from './sessions.js';
import * as tmux from './tmux.js';
import { createPtyBridge, registerBridge, unregisterBridge, type IPtyProcess } from './ptyBridge.js';
import {
  PROTOCOL_VERSION,
  ErrorCode,
  buildBinaryFrame,
  buildControlMessage,
  parseMessage,
  type ClientMessage,
  type ServerMessage,
} from './protocol.js';
import { logEvent } from './eventLog.js';
import type { Session } from './SessionStore.js';
import { config } from './config.js';
import crypto from 'node:crypto';

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

const OUTPUT_FLUSH_MS = 4;
const OUTPUT_MAX_BUFFER_BYTES = 16 * 1024;

type ParticipantCapability = 'view' | 'input' | 'resize' | 'kill' | 'restart' | 'edit_metadata';

interface ClientState {
  id: string;
  clientId: string | null;
  participantId: string | null;
  ws: WebSocket;
  sessionId: string | null;
  pty: IPtyProcess | null;
  lastActivity: number;
  authenticated: boolean;
  capabilities: Set<ParticipantCapability>;
  subscribedToDashboard: boolean;
  subscribedSessionIds: Set<string>;
  outputBuffer: Buffer[];
  outputBufferBytes: number;
  outputFlushTimer: ReturnType<typeof setTimeout> | null;
}

const sessionConnections = new Map<string, Set<ClientState>>();

function randomId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

const clients = new Map<WebSocket, ClientState>();

export function setupWebSocket(server: FastifyInstance): WebSocketServer {
  const wss = new WebSocketServer({ server: server.server, path: '/ws' });

  wss.on('connection', (ws: WebSocket) => {
    if (clients.size >= config.maxWsConnections) {
      sendError(ws, ErrorCode.RATE_LIMITED, 'Too many WebSocket connections');
      ws.close(1013, 'Too many connections');
      return;
    }
    const client: ClientState = {
      id: randomId('conn'),
      clientId: null,
      participantId: null,
      ws,
      sessionId: null,
      pty: null,
      lastActivity: Date.now(),
      authenticated: false,
      capabilities: new Set(),
      subscribedToDashboard: true,
      subscribedSessionIds: new Set(),
      outputBuffer: [],
      outputBufferBytes: 0,
      outputFlushTimer: null,
    };
    clients.set(ws, client);

    // Prefer first-message auth. URL query tokens are intentionally ignored.
    if (authenticateWs(undefined)) {
      client.authenticated = true;
    }

    const authTimeout = setTimeout(() => {
      if (!client.authenticated && ws.readyState === ws.OPEN) {
        sendError(ws, ErrorCode.AUTH_REQUIRED, 'Authentication required');
        ws.close(4001, 'Unauthorized');
      }
    }, Math.min(5000, config.heartbeatIntervalMs));

    if (!client.authenticated) {
      logger.info('ws.client.connected', { auth: 'pending', connectionId: client.id });
    } else {
      logger.info('ws.client.connected', { auth: 'ok', connectionId: client.id });
    }

    ws.on('message', (raw: Buffer) => {
      client.lastActivity = Date.now();

      const parsed = parseMessage(raw);
      if (!parsed) return;

      if (parsed.type === 'binary') {
        if (!client.authenticated) {
          sendError(ws, ErrorCode.AUTH_REQUIRED, 'Authentication required');
          return;
        }
        handleInput(client, parsed.sessionId, parsed.data.toString('utf-8'));
        return;
      }

      const msg = parsed.message as ClientMessage;

      // Auth can arrive even when local no-token mode already marked the socket
      // authenticated. Still consume identity fields for participant continuity.
      if ((msg as any).type === 'auth') {
        const token = (msg as any).token as string | undefined;
        if (!client.authenticated && !authenticateWs(token)) {
          sendError(ws, ErrorCode.AUTH_REQUIRED, 'Authentication required');
          ws.close(4001, 'Unauthorized');
          return;
        }
        client.authenticated = true;
        client.clientId = typeof (msg as any).clientId === 'string' ? (msg as any).clientId : client.clientId;
        clearTimeout(authTimeout);
        logger.info('ws.client.authenticated', { connectionId: client.id, clientId: client.clientId });
        return;
      }

      if (!client.authenticated) {
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
      clearTimeout(authTimeout);
      logger.info('ws.client.disconnected', { connectionId: client.id, clientId: client.clientId, sessionId: client.sessionId, participantId: client.participantId });
      cleanupClient(client);
      clients.delete(ws);
    });

    ws.on('error', (err) => {
      logger.error('ws.client.error', { error: String(err) });
    });
  });

  // Heartbeat
  const heartbeatInterval = setInterval(() => {
    const now = Date.now();
    for (const [ws, client] of clients) {
      if (now - client.lastActivity > config.heartbeatIntervalMs + 10000) {
        logger.info('ws.heartbeat.timeout', { sessionId: client.sessionId });
        ws.close(4002, 'Heartbeat timeout');
      } else if (now - client.lastActivity > config.heartbeatIntervalMs) {
        sendControl(ws, { v: PROTOCOL_VERSION, type: 'ping' });
      }
    }
  }, Math.max(1000, Math.floor(config.heartbeatIntervalMs / 2)));

  wss.on('close', () => clearInterval(heartbeatInterval));

  return wss;
}

function handleControlMessage(ws: WebSocket, client: ClientState, msg: ClientMessage): void {
  switch (msg.type) {
    case 'ping':
      sendControl(ws, { v: PROTOCOL_VERSION, type: 'pong', requestId: msg.requestId });
      break;

    case 'subscribe_dashboard':
      client.subscribedToDashboard = true;
      break;

    case 'unsubscribe_dashboard':
      client.subscribedToDashboard = false;
      break;

    case 'subscribe_session':
      client.subscribedSessionIds.add(msg.sessionId!);
      break;

    case 'unsubscribe_session':
      client.subscribedSessionIds.delete(msg.sessionId!);
      break;

    case 'attach':
      handleAttach(ws, client, msg.sessionId!, msg.requestId, (msg as any).mode, (msg as any).requestedCapabilities);
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
      void handleKill(ws, client, msg.sessionId!, (msg as any).confirm, msg.requestId);
      break;

    case 'restart':
      void handleRestart(ws, client, msg.sessionId!, msg.requestId);
      break;

    default:
      sendError(ws, ErrorCode.INTERNAL, `Unknown message type: ${(msg as any).type}`);
  }
}

function handleAttach(
  ws: WebSocket,
  client: ClientState,
  sessionId: string,
  requestId?: string,
  mode: 'controller' | 'viewer' | 'auto' = 'auto',
  requestedCapabilities?: ParticipantCapability[],
): void {
  if (client.sessionId === sessionId && client.pty) {
    sendControl(ws, { v: PROTOCOL_VERSION, type: 'attached', sessionId, requestId });
    return;
  }

  // Release any existing attachment before attaching this socket to another session.
  // Without decrementing here, session switches can leave stale viewer counts.
  releaseAttachment(client, 'reattach');

  const session = sessionManager.getSession(sessionId);
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
  client.participantId = randomId('participant');
  client.capabilities = resolveCapabilities(mode, requestedCapabilities);
  registerBridge(session.tmuxSessionName, pty);
  let connections = sessionConnections.get(sessionId);
  if (!connections) {
    connections = new Set();
    sessionConnections.set(sessionId, connections);
  }
  connections.add(client);
  client.subscribedSessionIds.add(sessionId);
  if (mode !== 'viewer' && connections.size === 1) {
    client.capabilities.add('resize');
  }

  // Send attached ack
  sendControl(ws, { v: PROTOCOL_VERSION, type: 'attached', sessionId, requestId });

  // Send snapshot
  const snapshot = tmux.capturePane(session.tmuxSessionName, config.snapshotLines);
  if (snapshot) {
    sendControl(ws, { v: PROTOCOL_VERSION, type: 'snapshot', sessionId, data: snapshot });
  }

  // Forward PTY output to client as binary frames.
  // Coalesce tiny PTY chunks (common while typing fast) into short batches to
  // reduce WS frame overhead and client write pressure without visible latency.
  pty.onData((data: string) => {
    if (ws.readyState !== ws.OPEN) return;

    const chunk = Buffer.from(data, 'utf-8');
    client.outputBuffer.push(chunk);
    client.outputBufferBytes += chunk.length;

    if (client.outputBufferBytes >= OUTPUT_MAX_BUFFER_BYTES) {
      flushClientOutput(client);
      return;
    }

    if (!client.outputFlushTimer) {
      client.outputFlushTimer = setTimeout(() => flushClientOutput(client), OUTPUT_FLUSH_MS);
    }
  });

  pty.onExit((code) => {
    // Ignore stale exit callbacks from an old PTY after this socket reattached.
    if (client.pty !== pty || client.sessionId !== sessionId) return;

    flushClientOutput(client);
    logger.info('pty.exited', { sessionId, code });
    sendControl(ws, {
      v: PROTOCOL_VERSION,
      type: 'status',
      sessionId,
      status: code === 0 ? 'stopped' : 'crashed',
      pid: null,
      exitCode: code,
    });
    releaseAttachment(client, 'pty_exit', sessionId);
  });

  // Update attached clients count from live registry.
  const store = getStore();
  const currentCount = connections.size;
  store.updateSession(sessionId, { attachedClients: currentCount, lastAttachedAt: new Date().toISOString() });
  logEvent(sessionId, 'attached', { clientCount: currentCount });

  // Broadcast session and participant updates
  broadcastSessionUpdate(sessionId);
  broadcastParticipantUpdate(sessionId);

  logger.info('ws.client.attached', {
    connectionId: client.id,
    clientId: client.clientId,
    participantId: client.participantId,
    sessionId,
    capabilities: [...client.capabilities],
    attachedClients: connections.size,
  });
}

function handleInput(client: ClientState, sessionId: string, data: string): void {
  if (!client.capabilities.has('input')) {
    logger.warn('ws.input.rejected', { connectionId: client.id, participantId: client.participantId, sessionId, reason: 'missing_input_capability' });
    return;
  }
  if (client.pty && client.sessionId === sessionId) {
    client.pty.write(data);
  }
}

function handleResize(client: ClientState, sessionId: string, cols: number, rows: number): void {
  if (client.sessionId !== sessionId) {
    logger.warn('ws.resize.rejected', { connectionId: client.id, participantId: client.participantId, sessionId, attachedSessionId: client.sessionId, reason: 'foreign_session' });
    return;
  }
  if (!client.capabilities.has('resize')) {
    logger.warn('ws.resize.rejected', { connectionId: client.id, participantId: client.participantId, sessionId, reason: 'missing_resize_capability' });
    return;
  }
  if (client.pty) {
    client.pty.resize(cols, rows);
  }
  const session = sessionManager.getSession(sessionId);
  if (session) {
    tmux.resizeWindow(session.tmuxSessionName, cols, rows);
  }
}

function handleDetach(ws: WebSocket, client: ClientState, sessionId: string, requestId?: string): void {
  releaseAttachment(client, 'detach', sessionId);
  sendControl(ws, { v: PROTOCOL_VERSION, type: 'detach_ack', sessionId, requestId });

  logger.info('ws.client.detached', { sessionId });
}

async function handleKill(ws: WebSocket, client: ClientState, sessionId: string, confirm: boolean, requestId?: string): Promise<void> {
  if (client.sessionId !== sessionId || !client.capabilities.has('kill')) {
    sendError(ws, ErrorCode.CAPABILITY_REQUIRED, 'Kill capability required', requestId);
    logger.warn('ws.kill.rejected', { connectionId: client.id, participantId: client.participantId, sessionId, reason: 'missing_kill_capability' });
    return;
  }

  const result = await sessionManager.killSession(sessionId, confirm);
  if ('error' in result) {
    sendError(ws, result.error, result.message, requestId);
    return;
  }

  sendControl(ws, { v: PROTOCOL_VERSION, type: 'kill_ack', sessionId, requestId });

  // Clean up the client's attachment if they were attached to this session.
  // The session may already be removed from the store, so this mainly clears
  // per-socket state and unregisters/kills the PTY bridge idempotently.
  releaseAttachment(client, 'kill', sessionId);

  broadcastSessionUpdate(sessionId);
  logger.info('ws.session.killed', { sessionId });
}

async function handleRestart(ws: WebSocket, client: ClientState, sessionId: string, requestId?: string): Promise<void> {
  if (client.sessionId !== sessionId || !client.capabilities.has('restart')) {
    sendError(ws, ErrorCode.CAPABILITY_REQUIRED, 'Restart capability required', requestId);
    logger.warn('ws.restart.rejected', { connectionId: client.id, participantId: client.participantId, sessionId, reason: 'missing_restart_capability' });
    return;
  }

  const result = await sessionManager.restartSession(sessionId);
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

export function resolveCapabilities(mode: 'controller' | 'viewer' | 'auto', requestedCapabilities?: ParticipantCapability[]): Set<ParticipantCapability> {
  if (mode === 'viewer') return new Set(['view']);

  const capabilities = new Set<ParticipantCapability>(['view', 'input']);
  for (const capability of requestedCapabilities || []) {
    if (capability === 'view' || capability === 'input') capabilities.add(capability);
    if (mode === 'controller' && (capability === 'kill' || capability === 'restart' || capability === 'edit_metadata')) capabilities.add(capability);
  }
  return capabilities;
}

function ensureResizeOwner(sessionId: string): void {
  const connections = sessionConnections.get(sessionId);
  if (!connections || connections.size === 0) return;
  if ([...connections].some((client) => client.capabilities.has('resize'))) return;

  const nextOwner = [...connections].find((client) => client.capabilities.has('input'));
  if (nextOwner) {
    nextOwner.capabilities.add('resize');
    logger.info('ws.resize.promoted', { connectionId: nextOwner.id, participantId: nextOwner.participantId, sessionId });
  }
}

function cleanupPty(client: ClientState): void {
  flushClientOutput(client);
  if (client.pty) {
    try { client.pty.kill(); } catch {}
    if (client.sessionId) {
      const session = sessionManager.getSession(client.sessionId);
      if (session) {
        unregisterBridge(session.tmuxSessionName, client.pty);
      }
    }
    client.pty = null;
  }
}

function releaseAttachment(client: ClientState, reason: string, expectedSessionId?: string): void {
  const sessionId = client.sessionId;
  if (!sessionId) return;
  if (expectedSessionId && sessionId !== expectedSessionId) return;

  cleanupPty(client);
  client.sessionId = null;
  client.participantId = null;
  client.capabilities = new Set();

  const connections = sessionConnections.get(sessionId);
  connections?.delete(client);
  client.subscribedSessionIds.delete(sessionId);
  ensureResizeOwner(sessionId);
  const newCount = connections?.size ?? 0;
  if (connections && connections.size === 0) sessionConnections.delete(sessionId);

  const session = sessionManager.getSession(sessionId);
  if (!session) return;

  const store = getStore();
  store.updateSession(sessionId, { attachedClients: newCount });
  broadcastSessionUpdate(sessionId);
  broadcastParticipantUpdate(sessionId);
  logEvent(sessionId, 'detached', { clientCount: newCount, reason });
}

function cleanupClient(client: ClientState): void {
  releaseAttachment(client, 'close');
}

function flushClientOutput(client: ClientState): void {
  if (client.outputFlushTimer) {
    clearTimeout(client.outputFlushTimer);
    client.outputFlushTimer = null;
  }
  if (!client.sessionId || client.outputBufferBytes === 0 || client.ws.readyState !== client.ws.OPEN) {
    client.outputBuffer = [];
    client.outputBufferBytes = 0;
    return;
  }

  const payload = client.outputBuffer.length === 1
    ? client.outputBuffer[0]
    : Buffer.concat(client.outputBuffer, client.outputBufferBytes);
  client.outputBuffer = [];
  client.outputBufferBytes = 0;
  if (!sendRaw(client.ws, buildBinaryFrame(client.sessionId, payload))) {
    logger.warn('ws.output.backpressure_disconnect', { sessionId: client.sessionId, bufferedAmount: client.ws.bufferedAmount });
    client.ws.close(1013, 'WebSocket backpressure');
  }
}

function sendRaw(ws: WebSocket, payload: Buffer): boolean {
  if (ws.readyState !== ws.OPEN) return false;
  if (ws.bufferedAmount > config.wsBackpressureLimitBytes) {
    logger.warn('ws.backpressure.drop', { bufferedAmount: ws.bufferedAmount, limit: config.wsBackpressureLimitBytes });
    return false;
  }
  ws.send(payload);
  return true;
}

function sendControl(ws: WebSocket, msg: ServerMessage): void {
  sendRaw(ws, buildControlMessage(msg));
}

function sendError(ws: WebSocket, code: ErrorCode, message: string, requestId?: string): void {
  sendControl(ws, { v: PROTOCOL_VERSION, type: 'error', code, message, requestId } as any);
}

function broadcastSessionUpdate(sessionId: string): void {
  const session = sessionManager.getSession(sessionId);
  if (!session) return;

  broadcastSessionObject(session);
  broadcastDashboardUpdate([sessionId]);
}

function broadcastParticipantUpdate(sessionId: string): void {
  const participants = [...(sessionConnections.get(sessionId) || [])].map((client) => ({
    id: client.participantId || client.id,
    clientId: client.clientId,
    capabilities: [...client.capabilities],
  }));
  const msg: ServerMessage = { v: PROTOCOL_VERSION, type: 'participant_update', sessionId, participants } as any;
  broadcastToSessionSubscribers(sessionId, msg);
}

function broadcastDashboardUpdate(changedSessionIds?: string[]): void {
  const msg: ServerMessage = { v: PROTOCOL_VERSION, type: 'dashboard_update', changedSessionIds } as any;
  for (const [ws, client] of clients) {
    if (client.authenticated && client.subscribedToDashboard && ws.readyState === ws.OPEN) {
      sendRaw(ws, buildControlMessage(msg));
    }
  }
}

function broadcastToSessionSubscribers(sessionId: string, msg: ServerMessage): void {
  for (const [ws, client] of clients) {
    if (
      client.authenticated &&
      ws.readyState === ws.OPEN &&
      (client.sessionId === sessionId || client.subscribedSessionIds.has(sessionId))
    ) {
      sendRaw(ws, buildControlMessage(msg));
    }
  }
}

function broadcastSessionObject(session: Session): void {
  const msg: ServerMessage = {
    v: PROTOCOL_VERSION,
    type: 'session_update',
    sessionId: session.id,
    ...session,
  } as any;

  broadcastToSessionSubscribers(session.id, msg);
}

// Export for broadcast from REST API
export function broadcastSessionUpdateExternal(sessionId: string): void {
  broadcastSessionUpdate(sessionId);
}

// Broadcast a session object directly (useful when session has been killed)
export function broadcastSessionObjectExternal(session: Session): void {
  broadcastSessionObject(session);
}