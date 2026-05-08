// Main entry point — Fastify server + WebSocket + REST API

import Fastify from 'fastify';
import { existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { config } from './config.js';
import { authMiddleware } from './auth.js';
import * as sessionManager from './sessions.js';
import { setupWebSocket, broadcastSessionUpdateExternal, broadcastSessionObjectExternal } from './ws.js';
import { getCommandLabels } from './allowlist.js';
import { startHealthCheck, stopHealthCheck, reconcileOnStartup } from './sessions.js';
import { logEvent, setLogEnabled } from './eventLog.js';
import { z } from 'zod';
import type { Session } from './SessionStore.js';

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
  return { status: 'ok', tmux: tmuxAvailable, uptime: process.uptime(), version: '0.2.0', authRequired: config.authRequired };
});

// List sessions
server.get('/api/sessions', async () => {
  return sessionManager.listSessions();
});

// Get session
server.get('/api/sessions/:sessionId', async (req, reply) => {
  const { sessionId } = req.params as { sessionId: string };
  const session = sessionManager.getSession(sessionId);
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
  resumeFrom: z.string().optional(), // agentSessionId to resume from
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

  const existing = sessionManager.getSession(sessionId);
  if (!existing) {
    reply.code(404).send({ error: 'SESSION_NOT_FOUND', message: `Session not found: ${sessionId}` });
    return;
  }

  const result = sessionManager.updateSession(sessionId, {
    title: body.title,
    restartPolicy: body.restartPolicy as any,
  });

  return result;
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

  broadcastSessionObjectExternal(result as any as Session);
  return result;
});

// Restart session (clean restart — creates a new agent process)
server.post('/api/sessions/:sessionId/restart', async (req, reply) => {
  const { sessionId } = req.params as { sessionId: string };

  const result = sessionManager.restartSession(sessionId);
  if ('error' in result) {
    const status = result.error === 'SESSION_ALREADY_RUNNING' ? 409 : 400;
    reply.code(status).send(result);
    return;
  }

  broadcastSessionUpdateExternal(sessionId);
  return result;
});

// Resume agent session (resume using agent's native --resume flag)
server.post('/api/sessions/:sessionId/resume', async (req, reply) => {
  const { sessionId } = req.params as { sessionId: string };

  const result = sessionManager.resumeAgentSession(sessionId);
  if ('error' in result) {
    const status = result.error === 'SESSION_ALREADY_RUNNING' ? 409
      : result.error === 'RATE_LIMITED' ? 429
      : 400;
    reply.code(status).send(result);
    return;
  }

  broadcastSessionUpdateExternal(sessionId);
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
// REMOTE_AGENT_TUI_WEB_DIR overrides the web assets directory (for packaged installs)
const webDistPath = process.env.REMOTE_AGENT_TUI_WEB_DIR || resolve(__dirname, '..', '..', 'web', 'dist');
if (existsSync(webDistPath)) {
  logger.info('Serving static files from', { path: webDistPath });
  try {
    const fastifyStatic = await import('@fastify/static');
    server.register(fastifyStatic.default || fastifyStatic, {
      root: webDistPath,
      prefix: '/',
      wildcard: false,
      setHeaders(res: any, filePath: string) {
        // Avoid stale PWA/app-shell assets after .deb upgrades. Hashed JS/CSS
        // can still be cached by browser defaults, but index.html and service
        // worker files must revalidate so clients pick up new bundles.
        if (
          filePath.endsWith('index.html') ||
          filePath.endsWith('sw.js') ||
          filePath.endsWith('manifest.webmanifest') ||
          /workbox-.*\.js$/.test(filePath)
        ) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          res.setHeader('Pragma', 'no-cache');
          res.setHeader('Expires', '0');
        }
      },
    });
  } catch {
    logger.warn('@fastify/static not available, static serving disabled');
  }
}

// ── Startup ──
async function start() {
  logger.info('Starting Remote Agent TUI Manager', { port: config.port, env: process.env.NODE_ENV });

  // Initialize event log
  setLogEnabled(true);
  logger.info('Event log initialized');

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
  await server.close();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();