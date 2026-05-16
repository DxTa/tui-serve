// Main entry point — Fastify server + WebSocket + REST API

import Fastify from 'fastify';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'fs';
import { resolve as pathResolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { config } from './config.js';
import { authMiddleware } from './auth.js';
import { assertSafeBindAuthConfig } from './securityConfig.js';
import * as sessionManager from './sessions.js';
import { setupWebSocket, broadcastSessionUpdateExternal, broadcastSessionObjectExternal } from './ws.js';
import { getCommandLabels } from './allowlist.js';
import { startHealthCheck, stopHealthCheck, reconcileOnStartup } from './sessions.js';
import { logEvent, setLogEnabled } from './eventLog.js';
import { createSessionRequestSchema, killSessionRequestSchema, updateSessionRequestSchema } from '@tui-serve/shared';
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

server.addHook('onRequest', async (_req, reply) => {
  reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'no-referrer');
});

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
server.post('/api/sessions', async (req, reply) => {
  const parsed = createSessionRequestSchema.safeParse(req.body);
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
  const parsed = updateSessionRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400).send({ error: 'INVALID_INPUT', message: parsed.error.message });
    return;
  }

  const existing = sessionManager.getSession(sessionId);
  if (!existing) {
    reply.code(404).send({ error: 'SESSION_NOT_FOUND', message: `Session not found: ${sessionId}` });
    return;
  }

  const result = sessionManager.updateSession(sessionId, parsed.data);

  return result;
});

// Kill session
server.post('/api/sessions/:sessionId/kill', async (req, reply) => {
  const { sessionId } = req.params as { sessionId: string };
  const parsed = killSessionRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.code(400).send({ error: 'INVALID_INPUT', message: parsed.error.message });
    return;
  }

  const result = sessionManager.killSession(sessionId, parsed.data.confirm ?? false);
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

// List subdirectories of a given path (for working directory autocomplete)
server.get('/api/fs/ls', async (req, reply) => {
  const { path: dirPath } = req.query as { path?: string };
  if (!dirPath || typeof dirPath !== 'string') {
    reply.code(400).send({ error: 'INVALID_INPUT', message: 'Missing or invalid path parameter' });
    return;
  }

  // Resolve the path to remove . and .. segments
  const resolvedPath = pathResolve(dirPath);

  // Security: verify the path falls within at least one command's allowedCwdRoots
  const allAllowedRoots = config.commands.flatMap((c) => c.allowedCwdRoots);
  const isAllowed = allAllowedRoots.some((root) => {
    const resolvedRoot = pathResolve(root);
    return resolvedPath === resolvedRoot || resolvedPath.startsWith(resolvedRoot + '/');
  });

  if (!isAllowed) {
    reply.code(403).send({ error: 'FORBIDDEN', message: 'Path is outside allowed directory roots' });
    return;
  }

  // Check the path exists and is a directory
  if (!existsSync(resolvedPath)) {
    reply.code(404).send({ error: 'NOT_FOUND', message: 'Directory not found' });
    return;
  }

  try {
    const stat = statSync(resolvedPath);
    if (!stat.isDirectory()) {
      reply.code(400).send({ error: 'NOT_DIRECTORY', message: 'Path is not a directory' });
      return;
    }
  } catch {
    reply.code(404).send({ error: 'NOT_FOUND', message: 'Directory not found' });
    return;
  }

  try {
    const entries = readdirSync(resolvedPath, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
    return { directories };
  } catch (err: any) {
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      reply.code(403).send({ error: 'PERMISSION_DENIED', message: 'Cannot read directory' });
      return;
    }
    reply.code(500).send({ error: 'READ_ERROR', message: 'Failed to read directory' });
    return;
  }
});

// ── Serve static files (production) ──
// TUI_SERVE_WEB_DIR overrides the web assets directory (for packaged installs)
const webDistPath = process.env.TUI_SERVE_WEB_DIR || pathResolve(__dirname, '..', '..', 'web', 'dist');
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
          filePath.endsWith('registerSW.js') ||
          filePath.endsWith('manifest.webmanifest') ||
          /workbox-.*\.js$/.test(filePath)
        ) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          res.setHeader('Pragma', 'no-cache');
          res.setHeader('Expires', '0');
          return;
        }

        if (/[/\\]assets[/\\].+\.(?:js|css|woff2?|png|jpe?g|svg|webp)$/.test(filePath)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    });

    server.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && request.url.startsWith('/assets/')) {
        reply.code(404).type('text/plain; charset=utf-8').send('Static asset not found');
        return;
      }

      if (
        request.method === 'GET' &&
        !request.url.startsWith('/api/') &&
        !request.url.startsWith('/ws') &&
        !/\.[a-z0-9]+(?:[?#].*)?$/i.test(request.url)
      ) {
        reply.type('text/html; charset=utf-8').send(readFileSync(pathResolve(webDistPath, 'index.html'), 'utf-8'));
        return;
      }

      reply.code(404).send({ error: 'NOT_FOUND', message: `Route ${request.method}:${request.url} not found` });
    });
  } catch {
    logger.warn('@fastify/static not available, static serving disabled');
  }
}

// ── Startup ──
async function start() {
  logger.info('Starting TUI Serve Manager', { port: config.port, bindHost: config.bindHost, authRequired: config.authRequired, env: process.env.NODE_ENV });

  assertSafeBindAuthConfig({
    bindHost: config.bindHost,
    authToken: config.authToken,
    nodeEnv: process.env.NODE_ENV,
    insecureAllowNetworkNoAuthForTests: process.env.TUI_SERVE_INSECURE_ALLOW_NETWORK_NO_AUTH_FOR_TESTS === '1',
  });

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
    await server.listen({ port: config.port, host: config.bindHost });
    logger.info('Server listening', { port: config.port, bindHost: config.bindHost, authRequired: config.authRequired });
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