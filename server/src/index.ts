// Main entry point — Fastify server + WebSocket + REST API

import Fastify from 'fastify';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { config } from './config.js';
import { authMiddleware } from './auth.js';
import { initDb, listSessions, getSession, updateSession, deleteSession, closeDb } from './db.js';
import * as sessionManager from './sessions.js';
import { setupWebSocket, broadcastSessionUpdateExternal } from './ws.js';
import { getCommandLabels } from './allowlist.js';
import { startHealthCheck, stopHealthCheck, reconcileOnStartup } from './sessions.js';
import { z } from 'zod';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Structured logger ──
export const logger = {
  info(action: string, data?: Record<string, unknown>) {
    console.log(JSON.stringify({ level: 'info', action, timestamp: new Date().toISOString(), ...data }));
  },
  warn(action: string, data?: Record<string, unknown>) {
    console.warn(JSON.stringify({ level: 'warn', action, timestamp: new Date().toISOString(), ...data }));
  },
  error(action: string, data?: Record<string, unknown>) {
    console.error(JSON.stringify({ level: 'error', action, timestamp: new Date().toISOString(), ...data }));
  },
};

// ── Create Fastify server ──
const server = Fastify({ logger: false });

// Register auth hook
server.addHook('onRequest', authMiddleware);

// ── REST API Routes ──

// Health check (no auth required)
server.get('/api/health', async () => {
  let tmuxAvailable = false;
  try {
    execSync('which tmux', { timeout: 3000 });
    tmuxAvailable = true;
  } catch {
    tmuxAvailable = false;
  }
  return { status: 'ok', tmux: tmuxAvailable, uptime: process.uptime(), version: '0.1.0' };
});

// List sessions
server.get('/api/sessions', async () => {
  return sessionManager.listSessions();
});

// Get session
server.get('/api/sessions/:sessionId', async (req, reply) => {
  const { sessionId } = req.params as { sessionId: string };
  const session = getSession(sessionId);
  if (!session) {
    reply.code(404).send({ error: 'SESSION_NOT_FOUND', message: `Session not found: ${sessionId}` });
    return;
  }
  return session;
});

// Create session
const createSessionSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).optional(),
  title: z.string().max(100).optional(),
  commandId: z.string().min(1),
  cwd: z.string().min(1),
});

server.post('/api/sessions', async (req, reply) => {
  const parsed = createSessionSchema.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400).send({ error: 'INVALID_INPUT', message: parsed.error.message });
    return;
  }

  const result = sessionManager.createSession(parsed.data);
  if ('error' in result) {
    const status = result.error === 'SESSION_NOT_FOUND' ? 404 : 400;
    reply.code(status).send(result);
    return;
  }

  reply.code(201).send(result);
  broadcastSessionUpdateExternal(result.id);
});

// Update session (title, restartPolicy)
server.patch('/api/sessions/:sessionId', async (req, reply) => {
  const { sessionId } = req.params as { sessionId: string };
  const body = req.body as { title?: string; restartPolicy?: string };

  const existing = getSession(sessionId);
  if (!existing) {
    reply.code(404).send({ error: 'SESSION_NOT_FOUND', message: `Session not found: ${sessionId}` });
    return;
  }

  updateSession(sessionId, {
    title: body.title,
    restartPolicy: body.restartPolicy as any,
  });

  return getSession(sessionId);
});

// Kill session
server.post('/api/sessions/:sessionId/kill', async (req, reply) => {
  const { sessionId } = req.params as { sessionId: string };
  const body = req.body as { confirm?: boolean };

  const result = sessionManager.killSession(sessionId, body.confirm ?? false);
  if ('error' in result) {
    const status = result.error === 'KILL_CONFIRM_REQUIRED' ? 400 : 404;
    reply.code(status).send(result);
    return;
  }

  return result;
});

// Restart session
server.post('/api/sessions/:sessionId/restart', async (req, reply) => {
  const { sessionId } = req.params as { sessionId: string };

  const result = sessionManager.restartSession(sessionId);
  if ('error' in result) {
    const status = result.error === 'SESSION_ALREADY_RUNNING' ? 409 : 400;
    reply.code(status).send(result);
    return;
  }

  return result;
});

// Delete session
server.delete('/api/sessions/:sessionId', async (req, reply) => {
  const { sessionId } = req.params as { sessionId: string };
  const deleted = sessionManager.deleteSession(sessionId);
  reply.code(deleted ? 204 : 404).send();
});

// List hosts
server.get('/api/hosts', async () => {
  return config.hosts;
});

// List available commands (for the create session form)
server.get('/api/commands', async () => {
  return getCommandLabels();
});

// ── Serve static files (production) ──
const webDistPath = resolve(__dirname, '..', '..', 'web', 'dist');
if (existsSync(webDistPath)) {
  logger.info('Serving static files from', { path: webDistPath });
  try {
    const fastifyStatic = await import('@fastify/static');
    server.register(fastifyStatic.default || fastifyStatic, {
      root: webDistPath,
      prefix: '/',
      wildcard: false,
    });
  } catch {
    logger.warn('@fastify/static not available, static serving disabled');
  }
}

// ── Startup ──
async function start() {
  logger.info('Starting Remote Agent TUI Manager', { port: config.port, env: process.env.NODE_ENV });

  // Initialize database
  initDb();
  logger.info('Database initialized');

  // Reconcile sessions with tmux
  reconcileOnStartup();

  // Start health check loop
  startHealthCheck(config.healthCheckIntervalMs);

  // Setup WebSocket
  setupWebSocket(server);

  // Start listening
  try {
    await server.listen({ port: config.port, host: '0.0.0.0' });
    logger.info('Server listening', { port: config.port });
  } catch (err) {
    logger.error('Failed to start server', { error: String(err) });
    process.exit(1);
  }
}

// ── Graceful shutdown ──
async function shutdown(signal: string) {
  logger.info('Shutting down', { signal });
  stopHealthCheck();
  closeDb();
  await server.close();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();